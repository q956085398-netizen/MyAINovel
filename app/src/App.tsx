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
import RailProjectPanel from "./RailProjectPanel";
import Writing from "./Writing";
import SettingsDialog from "./SettingsDialog";
import { getSettings, initSettings } from "./settings";
import type { Glyph } from "./icons";
import {
  BookMarked,
  BookOpen,
  Icon,
  Layers,
  MessageCircle,
  PenLine,
  Settings,
  Sparkles,
} from "./icons";
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
  WritingLocate,
} from "./types";

// 灵感库独立侧栏导航（工单 #37）：拆书板块的书库/灵感库子页签取消，
// 灵感库升为一级板块，顺序 拆书 → 灵感库 → 构思 → 书写。
const SECTIONS = ["拆书", "灵感库", "构思", "书写"] as const;
type Section = (typeof SECTIONS)[number];

// 板块图标（工单 #35，方向乙）：一处映射，侧栏导航四项共用。
const SECTION_ICONS: Record<Section, Glyph> = {
  拆书: BookOpen,
  灵感库: Sparkles,
  构思: Layers,
  书写: PenLine,
};

const PATH_KEY = "gongbi.libraryPath";
// 上次工作入口（工单 #56 / T01）：重启后恢复——板块、拆书稿。
const SECTION_KEY = "gongbi.section";
const LAST_BOOK_KEY = "gongbi.lastBook";

function isSection(v: string | null): v is Section {
  return !!v && (SECTIONS as readonly string[]).includes(v);
}

// 主题初始化（工单 #24）：根元素挂 data-theme＋系统深浅监听，一次即可。
initSettings();

function App() {
  const [section, setSection] = useState<Section>(() => {
    const saved = localStorage.getItem(SECTION_KEY);
    return isSection(saved) ? saved : "拆书";
  });
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
  // 窄轨「当前项目」飞出面板（工单 #56 / T01）：点开现扫，点外关。
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  // 书写页是否停在正文上：进入正文后窄轨退场（低干扰），返回项目列表即回。
  const [manuscript, setManuscript] = useState(false);
  // 灵感库 → 构思项目的跳转请求（故事卡转生的去向、「关联」里的项目引用）；
  // 携带刚扫到的项目快照，不依赖构思板块自己的列表是否新鲜。
  const [ideationJump, setIdeationJump] = useState<{
    project: ProjectEntry;
    tab?: ProjectTab;
    /** 落到某个人物（「《书名》/人名」关联）：人物页签切到画布并选中该节点。 */
    focus?: string;
  } | null>(null);
  // 构思（伏笔看板）→ 书写的跳转请求：打开该项目的这一章并选中引文；
  // locate 为空时＝「继续工作」（写作页自己回到上次章节）。消费后清空。
  const [writingJump, setWritingJump] = useState<{
    projectDir: string;
    locate: WritingLocate | null;
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
        // destroy 要 capabilities 里的 core:window:allow-destroy；被拒时症状只是「点 X 没反应」，
        // 所以失败必须喊出来（不 catch 的话 rejection 会被无声吞掉）。
        getCurrentWindow().destroy().catch((e) => console.error("关窗失败：", e));
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

  /** 打开拆书稿（用户点击或重启恢复）：顺手记住，下次重启回到这里。 */
  const openBookAndRemember = useCallback((book: BookEntry) => {
    localStorage.setItem(LAST_BOOK_KEY, book.primaryMd);
    setOpenBook(book);
  }, []);

  const closeBook = useCallback(() => {
    localStorage.removeItem(LAST_BOOK_KEY);
    setOpenBook(null);
  }, []);

  /** 切板块（工单 #56 / T01）：记住上次板块，重启恢复；顺手收起飞出面板。 */
  const switchSection = useCallback((s: Section) => {
    localStorage.setItem(SECTION_KEY, s);
    setSection(s);
    setProjectPanelOpen(false);
  }, []);

  /** 从灵感库跳书：切到拆书板块并打开拆书稿。 */
  const openBookFromInspiration = useCallback(
    (book: BookEntry) => {
      openBookAndRemember(book);
      switchSection("拆书");
    },
    [openBookAndRemember, switchSection],
  );

  /** 从灵感库跳构思项目（卡片转生的去向）：切到构思板块并打开该项目。 */
  const openProjectFromInspiration = useCallback(
    (project: ProjectEntry, tab?: ProjectTab, focus?: string) => {
      switchSection("构思");
      setIdeationJump({ project, tab, focus });
    },
    [switchSection],
  );

  const consumeIdeationJump = useCallback(() => setIdeationJump(null), []);

  /** 伏笔看板点章：切到书写板块，打开该章并选中引文。 */
  const openChapterFromIdeation = useCallback(
    (projectDir: string, ordinal: number, quote: string) => {
      switchSection("书写");
      setWritingJump({ projectDir, locate: { ordinal, quote } });
    },
    [switchSection],
  );

  const consumeWritingJump = useCallback(() => setWritingJump(null), []);

  /** 窄轨「继续工作」（工单 #56 / T01）：交给书写板块的跳转机制处理——
   *  locate 空＝写作页回到上次的章节与进度；已在那本书时也只是重开一次，
   *  内容已落盘，重开无损失。 */
  const resumeWriting = useCallback(
    (project: ProjectEntry) => {
      setProjectPanelOpen(false);
      setWritingJump({ projectDir: project.dir, locate: null });
      switchSection("书写");
    },
    [switchSection],
  );

  /** 飞出面板待办点开：跳到构思对应看板。 */
  const openBoardFromPanel = useCallback(
    (project: ProjectEntry, tab: ProjectTab) => {
      setProjectPanelOpen(false);
      switchSection("构思");
      setIdeationJump({ project, tab });
    },
    [switchSection],
  );

  /** 飞出面板 Esc 关闭。 */
  useEffect(() => {
    if (!projectPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectPanelOpen]);

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
  // 进入正文（书写页开着章节）时窄轨退场（工单 #56 / T01 的 C 低干扰结构）：
  // 返回在写作页头部、切换章节在章节列表、保存状态在状态条，都仍可及。
  const railCollapsed = section === "书写" && manuscript;

  return (
    <div className={`app ${railCollapsed ? "rail-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="主导航">
        <div className="rail-brand" title="工笔">
          工
        </div>
        <nav className="rail-nav">
          {SECTIONS.map((s) => (
            <button
              key={s}
              className={`rail-item ${section === s ? "active" : ""}`}
              title={s}
              aria-label={s}
              aria-current={section === s ? "page" : undefined}
              onClick={() => switchSection(s)}
            >
              <Icon as={SECTION_ICONS[s]} />
            </button>
          ))}
        </nav>
        <button
          className={`rail-item rail-project ${projectPanelOpen ? "active" : ""}`}
          title="当前项目"
          aria-label="当前项目"
          aria-expanded={projectPanelOpen}
          onClick={() => setProjectPanelOpen((v) => !v)}
        >
          <Icon as={BookMarked} />
        </button>
        <div className="rail-bottom">
          <button
            className={`rail-item ${aiOpen ? "active" : ""}`}
            title="AI 助手"
            aria-label="AI 助手"
            aria-pressed={aiOpen}
            onClick={() => setAiOpen((v) => !v)}
          >
            <Icon as={MessageCircle} />
          </button>
          <button
            className="rail-item"
            title="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon as={Settings} />
          </button>
        </div>
        {projectPanelOpen && !railCollapsed && (
          <>
            <div className="rail-flyout-backdrop" onClick={() => setProjectPanelOpen(false)} />
            <RailProjectPanel
              libraryPath={libraryPath}
              onChooseFolder={chooseLibraryFolder}
              onResume={resumeWriting}
              onOpenBoard={openBoardFromPanel}
              onGoIdeation={() => switchSection("构思")}
            />
          </>
        )}
      </aside>
      <main className="main">
        <div className={`section-wrap ${section === "拆书" ? "" : "hidden"}`}>
          {openBook ? (
            <EditorPage
              key={openBook.primaryMd}
              book={openBook}
              libraryPath={libraryPath}
              active={section === "拆书"}
              onBack={closeBook}
              onAiCommand={handleAiCommand}
              registerBridge={registerBridge}
            />
          ) : (
            <BookLibrary
              libraryPath={libraryPath}
              onChooseFolder={chooseLibraryFolder}
              onCreateLibrary={createLibraryFolder}
              onOpen={openBookAndRemember}
              restoreMd={localStorage.getItem(LAST_BOOK_KEY)}
            />
          )}
        </div>
        <div className={`section-wrap ${section === "灵感库" ? "" : "hidden"}`}>
          <InspirationLibrary
            libraryPath={libraryPath}
            onChooseFolder={chooseLibraryFolder}
            onCreateLibrary={createLibraryFolder}
            onOpenBook={openBookFromInspiration}
            onOpenProject={openProjectFromInspiration}
            onGoIdeation={() => switchSection("构思")}
          />
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
            onManuscriptChange={setManuscript}
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
