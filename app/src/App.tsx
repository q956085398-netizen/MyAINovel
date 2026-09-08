import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import AiSidebar from "./AiSidebar";
import BookLibrary from "./BookLibrary";
import EditorPage from "./EditorPage";
import Ideation from "./Ideation";
import InspirationLibrary from "./InspirationLibrary";
import Writing from "./Writing";
import type { ProjectTab } from "./ProjectPage";
import type {
  AiSeed,
  BookEntry,
  DocSnapshot,
  EditorBridge,
  ProjectEntry,
  TropeSuggestion,
} from "./types";

const SECTIONS = ["拆书", "构思", "书写"] as const;
type Section = (typeof SECTIONS)[number];

const LIB_TABS = ["书库", "灵感库"] as const;
type LibTab = (typeof LIB_TABS)[number];

const PATH_KEY = "gongbi.libraryPath";

function App() {
  const [section, setSection] = useState<Section>("拆书");
  const [libTab, setLibTab] = useState<LibTab>("书库");
  const [openBook, setOpenBook] = useState<BookEntry | null>(null);
  // 库根路径为书库与灵感库共用，上提到这里统一选择与持久化。
  const [libraryPath, setLibraryPath] = useState<string | null>(() =>
    localStorage.getItem(PATH_KEY),
  );
  // AI 侧边栏：面板常驻挂载仅隐藏切换，编辑器经 bridge 提供文档上下文与采纳回写。
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSeed, setAiSeed] = useState<AiSeed | null>(null);
  // 灵感库 → 构思项目的跳转请求（故事卡转生的去向、「关联」里的项目引用）；
  // 携带刚扫到的项目快照，不依赖构思板块自己的列表是否新鲜。
  const [ideationJump, setIdeationJump] = useState<{
    project: ProjectEntry;
    tab?: ProjectTab;
  } | null>(null);
  const bridgeRef = useRef<EditorBridge | null>(null);

  const registerBridge = useCallback((bridge: EditorBridge | null) => {
    bridgeRef.current = bridge;
  }, []);

  const chooseLibraryFolder = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择库文件夹",
    });
    if (typeof picked === "string") {
      localStorage.setItem(PATH_KEY, picked);
      setLibraryPath(picked);
    }
  }, []);

  /** 从灵感库跳书：打开拆书稿并切到书库页。 */
  const openBookFromInspiration = useCallback((book: BookEntry) => {
    setOpenBook(book);
    setLibTab("书库");
  }, []);

  /** 从灵感库跳构思项目（故事卡转生的去向）：切到构思板块并打开该项目。 */
  const openProjectFromInspiration = useCallback((project: ProjectEntry, tab?: ProjectTab) => {
    setSection("构思");
    setIdeationJump({ project, tab });
  }, []);

  const consumeIdeationJump = useCallback(() => setIdeationJump(null), []);

  /** 编辑器三命令：种子进 AI 面板并展开。 */
  const handleAiCommand = useCallback((seed: AiSeed) => {
    setAiSeed(seed);
    setAiOpen(true);
  }, []);

  const getDoc = useCallback((): DocSnapshot | null => bridgeRef.current?.getDoc() ?? null, []);

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
                onBack={() => setOpenBook(null)}
                onAiCommand={handleAiCommand}
                registerBridge={registerBridge}
              />
            ) : (
              <BookLibrary
                libraryPath={libraryPath}
                onChooseFolder={chooseLibraryFolder}
                onOpen={setOpenBook}
              />
            )}
          </div>
          <div className={`section-wrap ${libTab === "灵感库" ? "" : "hidden"}`}>
            <InspirationLibrary
              libraryPath={libraryPath}
              onChooseFolder={chooseLibraryFolder}
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
            jump={ideationJump}
            onJumpConsumed={consumeIdeationJump}
          />
        </div>
        <div className={`section-wrap ${section === "书写" ? "" : "hidden"}`}>
          <Writing />
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
      />
    </div>
  );
}

export default App;
