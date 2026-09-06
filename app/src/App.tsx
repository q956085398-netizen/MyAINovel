import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import BookLibrary from "./BookLibrary";
import EditorPage from "./EditorPage";
import Ideation from "./Ideation";
import InspirationLibrary from "./InspirationLibrary";
import Writing from "./Writing";
import type { BookEntry } from "./types";

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
              <EditorPage key={openBook.primaryMd} book={openBook} onBack={() => setOpenBook(null)} />
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
            />
          </div>
        </div>
        <div className={`section-wrap ${section === "构思" ? "" : "hidden"}`}>
          <Ideation />
        </div>
        <div className={`section-wrap ${section === "书写" ? "" : "hidden"}`}>
          <Writing />
        </div>
      </main>
    </div>
  );
}

export default App;
