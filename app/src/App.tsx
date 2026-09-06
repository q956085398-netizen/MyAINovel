import { useState } from "react";
import "./App.css";
import BookLibrary from "./BookLibrary";
import EditorPage from "./EditorPage";
import Ideation from "./Ideation";
import Writing from "./Writing";
import type { BookEntry } from "./types";

const SECTIONS = ["拆书", "构思", "书写"] as const;
type Section = (typeof SECTIONS)[number];

function App() {
  const [section, setSection] = useState<Section>("拆书");
  const [openBook, setOpenBook] = useState<BookEntry | null>(null);

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
          {openBook ? (
            <EditorPage key={openBook.primaryMd} book={openBook} onBack={() => setOpenBook(null)} />
          ) : (
            <BookLibrary onOpen={setOpenBook} />
          )}
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
