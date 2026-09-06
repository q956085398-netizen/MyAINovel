import { useState } from "react";
import "./App.css";
import BookLibrary from "./BookLibrary";
import Ideation from "./Ideation";
import Writing from "./Writing";

const SECTIONS = ["拆书", "构思", "书写"] as const;
type Section = (typeof SECTIONS)[number];

function App() {
  const [section, setSection] = useState<Section>("拆书");

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
        {section === "拆书" && <BookLibrary />}
        {section === "构思" && <Ideation />}
        {section === "书写" && <Writing />}
      </main>
    </div>
  );
}

export default App;
