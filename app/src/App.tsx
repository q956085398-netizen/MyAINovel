import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import AiSidebar from "./AiSidebar";
import BookLibrary from "./BookLibrary";
import EditorPage from "./EditorPage";
import Ideation from "./Ideation";
import InspirationLibrary from "./InspirationLibrary";
import Writing from "./Writing";
import SettingsDialog from "./SettingsDialog";
import { getSettings, initSettings } from "./settings";
import { flushAllSavers } from "./saveFlush";
import type { ProjectTab } from "./ProjectPage";
import type {
  AiSeed,
  BookEntry,
  DocSnapshot,
  EditorBridge,
  ProjectEntry,
  TropeSuggestion,
  WritingBridge,
} from "./types";

const SECTIONS = ["拆书", "构思", "书写"] as const;
type Section = (typeof SECTIONS)[number];

const LIB_TABS = ["书库", "灵感库"] as const;
type LibTab = (typeof LIB_TABS)[number];

const PATH_KEY = "gongbi.libraryPath";

// 主题初始化（工单 #24）：根元素挂 data-theme＋系统深浅监听，一次即可。
initSettings();

function App() {
  const [section, setSection] = useState<Section>("拆书");
  const [libTab, setLibTab] = useState<LibTab>("书库");
  const [openBook, setOpenBook] = useState<BookEntry | null>(null);
  // 库根路径为书库与灵感库共用，上提到这里统一选择与持久化。
  const [libraryPath, setLibraryPath] = useState<string | null>(() =>
    localStorage.getItem(PATH_KEY),
  );
  // 设置面板（工单 #24）：侧栏底部齿轮打开；设置存应用状态（localStorage）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  // AI 侧边栏：面板常驻挂载仅隐藏切换，编辑器经 bridge 提供文档上下文与采纳回写。
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSeed, setAiSeed] = useState<AiSeed | null>(null);
  // 灵感库 → 构思项目的跳转请求（故事卡转生的去向、「关联」里的项目引用）；
  // 携带刚扫到的项目快照，不依赖构思板块自己的列表是否新鲜。
  const [ideationJump, setIdeationJump] = useState<{
    project: ProjectEntry;
    tab?: ProjectTab;
    /** 落到某个人物（「《书名》/人名」关联）：人物页签切到画布并选中该节点。 */
    focus?: string;
  } | null>(null);
  // 构思（伏笔看板）→ 书写的跳转请求：打开该项目的这一章并选中引文。
  const [writingJump, setWritingJump] = useState<{
    projectDir: string;
    ordinal: number;
    quote: string;
  } | null>(null);
  const bridgeRef = useRef<EditorBridge | null>(null);
  // 写作页的桥（工单 #15）：拆书编辑器与写作页都可能挂着，按当前板块取用。
  const writingBridgeRef = useRef<WritingBridge | null>(null);

  const registerBridge = useCallback((bridge: EditorBridge | null) => {
    bridgeRef.current = bridge;
  }, []);

  const registerWritingBridge = useCallback((bridge: WritingBridge | null) => {
    writingBridgeRef.current = bridge;
  }, []);

  // 关窗兜底（工单 #28，spec 拆书保存与模板 §二）：拦下关窗→拆书/书写两
  // 编辑器静默落盘→再真正关闭。保存失败也放行——兜底是保险，不是闸。
  useEffect(() => {
    const unlistenP = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await flushAllSavers();
      } finally {
        void getCurrentWindow().destroy();
      }
    });
    return () => {
      void unlistenP.then((unlisten) => unlisten());
    };
  }, []);

  // 封面/背景图的本地加载走 asset 协议（工单 #23）：库位置用户自选，
  // 静态 scope 留空，打开/新建库时把库根现授权（递归覆盖库内路径）。
  useEffect(() => {
    if (!libraryPath) return;
    invoke("grant_asset_scope", { path: libraryPath }).catch((e) =>
      console.error("授权库目录图片访问失败：", e),
    );
  }, [libraryPath]);

  // 自定义背景图多在库外，重启后 asset 授权是运行时态会丢——启动补授权
  // （工单 #25：路径持久化在设置里，图本身不动）。
  useEffect(() => {
    const bg = getSettings().background;
    if (bg.kind !== "image") return;
    invoke("grant_asset_scope", { path: bg.path }).catch((e) =>
      console.error("授权背景图访问失败：", e),
    );
  }, []);

  const pickLibraryFolder = useCallback(
    (title: string) => open({ directory: true, multiple: false, title }),
    [],
  );

  const chooseLibraryFolder = useCallback(async () => {
    const picked = await pickLibraryFolder("选择库文件夹");
    if (typeof picked === "string") {
      localStorage.setItem(PATH_KEY, picked);
      setLibraryPath(picked);
    }
  }, [pickLibraryFolder]);

  /** 新建空库（工单 #21）：选一个空文件夹即设为当前库，零预建——
   *  词表/项目/灵感库全部首用时懒生成。与「打开库」动作同款，只有文案与
   *  意图不同（spec 书库新建与展示 §三）；选到非空文件夹时向人确认，
   *  不自动清洗、不改写任何既有文件。 */
  const createLibraryFolder = useCallback(async () => {
    const picked = await pickLibraryFolder("选择一个空文件夹作为新库");
    if (typeof picked !== "string") return;
    try {
      const empty = await invoke<boolean>("is_empty_dir", { path: picked });
      if (!empty) {
        const ok = window.confirm(
          `选中的文件夹不是空的，仍要把它作为库打开吗？\n\n${picked}\n\n不会改动、不会搬动里面的任何文件。`,
        );
        if (!ok) return;
      }
    } catch {
      // 判定失败不拦路：当作打开库处理，交给后续扫描。
    }
    localStorage.setItem(PATH_KEY, picked);
    setLibraryPath(picked);
  }, [pickLibraryFolder]);

  /** 从灵感库跳书：打开拆书稿并切到书库页。 */
  const openBookFromInspiration = useCallback((book: BookEntry) => {
    setOpenBook(book);
    setLibTab("书库");
  }, []);

  /** 从灵感库跳构思项目（卡片转生的去向）：切到构思板块并打开该项目。 */
  const openProjectFromInspiration = useCallback(
    (project: ProjectEntry, tab?: ProjectTab, focus?: string) => {
      setSection("构思");
      setIdeationJump({ project, tab, focus });
    },
    [],
  );

  const consumeIdeationJump = useCallback(() => setIdeationJump(null), []);

  /** 伏笔看板点章：切到书写板块，打开该章并选中引文。 */
  const openChapterFromIdeation = useCallback(
    (projectDir: string, ordinal: number, quote: string) => {
      setSection("书写");
      setWritingJump({ projectDir, ordinal, quote });
    },
    [],
  );

  const consumeWritingJump = useCallback(() => setWritingJump(null), []);

  /** 编辑器板块命令（拆书三条、构思两条、书写两条）：种子进 AI 面板并展开。 */
  const handleAiCommand = useCallback((seed: AiSeed) => {
    setAiSeed(seed);
    setAiOpen(true);
  }, []);

  /** 「携带当前文档」按当前板块取：拆书＝拆书稿，书写＝当前章；构思板没有文档。 */
  const getDoc = useCallback((): DocSnapshot | null => {
    if (section === "书写") return writingBridgeRef.current?.getDoc() ?? null;
    if (section === "拆书") return bridgeRef.current?.getDoc() ?? null;
    return null;
  }, [section]);

  /** 采纳润色＝替换写作页当前选区。不在书写板块时不认——
   *  三个板块常驻挂载，切走后写作页还在（隐藏），不许悄悄改到看不见的正文。 */
  const replaceSelection = useCallback(
    (text: string) => {
      if (section !== "书写") return false;
      return writingBridgeRef.current?.replaceSelection(text) ?? false;
    },
    [section],
  );

  const adoptCallout = useCallback((kind: "点评" | "小结", text: string, anchorLine: number) => {
    return bridgeRef.current?.adoptCallout(kind, text, anchorLine) ?? false;
  }, []);

  const adoptTrope = useCallback(
    (startLine: number, endLine: number, s: TropeSuggestion) => {
      bridgeRef.current?.adoptTrope(startLine, endLine, s);
    },
    [],
  );

  // 三个板块常驻挂载、仅隐藏切换，编辑器里的未保存内容不因切板块而丢。
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">工笔</div>
        <nav className="nav">
          {SECTIONS.map((s) => (
            <button
              key={s}
              className={`nav-item ${section === s ? "active" : ""}`}
              onClick={() => setSection(s)}
            >
              {s}
            </button>
          ))}
        </nav>
        <button
          className={`nav-item ai-toggle ${aiOpen ? "active" : ""}`}
          title="AI 助手侧边栏"
          onClick={() => setAiOpen((v) => !v)}
        >
          AI 助手
        </button>
        <button
          className="nav-item settings-toggle"
          title="设置"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙ 设置
        </button>
        <div className="sidebar-foot">拆书积累 · 灵感沉淀 · 构思写作</div>
      </aside>
      <main className="main">
        <div className={`section-wrap ${section === "拆书" ? "" : "hidden"}`}>
          <div className="subtabs">
            {LIB_TABS.map((t) => (
              <button
                key={t}
                className={`subtab ${libTab === t ? "active" : ""}`}
                onClick={() => setLibTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className={`section-wrap ${libTab === "书库" ? "" : "hidden"}`}>
            {openBook ? (
              <EditorPage
                key={openBook.primaryMd}
                book={openBook}
                libraryPath={libraryPath}
                active={section === "拆书" && libTab === "书库"}
                onBack={() => setOpenBook(null)}
                onAiCommand={handleAiCommand}
                registerBridge={registerBridge}
              />
            ) : (
              <BookLibrary
                libraryPath={libraryPath}
                onChooseFolder={chooseLibraryFolder}
                onCreateLibrary={createLibraryFolder}
                onOpen={setOpenBook}
              />
            )}
          </div>
          <div className={`section-wrap ${libTab === "灵感库" ? "" : "hidden"}`}>
          <InspirationLibrary
            libraryPath={libraryPath}
            onChooseFolder={chooseLibraryFolder}
            onCreateLibrary={createLibraryFolder}
            onOpenBook={openBookFromInspiration}
            onOpenProject={openProjectFromInspiration}
            onGoIdeation={() => setSection("构思")}
          />
          </div>
        </div>
        <div className={`section-wrap ${section === "构思" ? "" : "hidden"}`}>
          <Ideation
            libraryPath={libraryPath}
            onChooseFolder={chooseLibraryFolder}
            onCreateLibrary={createLibraryFolder}
            jump={ideationJump}
            onJumpConsumed={consumeIdeationJump}
            onOpenChapter={openChapterFromIdeation}
            onAiCommand={handleAiCommand}
          />
        </div>
        <div className={`section-wrap ${section === "书写" ? "" : "hidden"}`}>
          <Writing
            libraryPath={libraryPath}
            active={section === "书写"}
            onChooseFolder={chooseLibraryFolder}
            onCreateLibrary={createLibraryFolder}
            jump={writingJump}
            onJumpConsumed={consumeWritingJump}
            onAiCommand={handleAiCommand}
            registerBridge={registerWritingBridge}
          />
        </div>
      </main>
      <AiSidebar
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        libraryPath={libraryPath}
        seed={aiSeed}
        onSeedConsumed={() => setAiSeed(null)}
        getDoc={getDoc}
        adoptCallout={adoptCallout}
        adoptTrope={adoptTrope}
        replaceSelection={replaceSelection}
      />
      {settingsOpen && (
        <SettingsDialog
          libraryPath={libraryPath}
          onChooseFolder={chooseLibraryFolder}
          onCreateLibrary={createLibraryFolder}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
