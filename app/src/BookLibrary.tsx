import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BookEntry, SearchHit } from "./types";
import { errMsg, tropeSpanLabel } from "./util";
import { useDisplayMode } from "./displayMode";
import DisplayToggle from "./DisplayToggle";
import CoverArt, { pickAndSetCover } from "./CoverArt";

/** 与 Rust 侧 search::MAX_HITS 对应，达上限时提示截断。 */
const MAX_HITS = 200;

const layoutLabel: Record<BookEntry["layout"], string> = {
  scattered: "散文件",
  "folder-book": "一书一文件夹",
};

function formatCount(n: number): string {
  return n.toLocaleString("zh-Hans-CN");
}

/** 片段里高亮命中词（大小写不敏感的首次出现）。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface BookLibraryProps {
  libraryPath: string | null;
  onChooseFolder: () => void;
  /** 新建空库：选空文件夹即设为当前库（工单 #21）。 */
  onCreateLibrary: () => void;
  onOpen: (book: BookEntry) => void;
}

export default function BookLibrary({
  libraryPath,
  onChooseFolder,
  onCreateLibrary,
  onOpen,
}: BookLibraryProps) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [tropeType, setTropeType] = useState("");
  const [tropeSolution, setTropeSolution] = useState("");

  // 新建书（工单 #20）：只填书名，建后直进拆书编辑器。
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);

  // 展示模式（工单 #22）：封面网格（默认）｜书名列表（现有表格）。
  const [display, setDisplay] = useDisplayMode("books");

  const scan = useCallback(async (path: string) => {
    setScanning(true);
    setError(null);
    try {
      setBooks(await invoke<BookEntry[]>("scan_library", { root: path }));
    } catch (e) {
      setBooks([]);
      setError(`扫描失败：${errMsg(e)}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (libraryPath) void scan(libraryPath);
  }, [libraryPath, scan]);

  async function runSearch() {
    const q = query.trim();
    if (!libraryPath || !q || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      setHits(await invoke<SearchHit[]>("search_library", { root: libraryPath, query: q }));
    } catch (e) {
      setHits(null);
      setSearchError(`搜索失败：${errMsg(e)}`);
    } finally {
      setSearching(false);
    }
  }

  function openByPath(primaryMd: string) {
    const book = books.find((b) => b.primaryMd === primaryMd);
    if (book) onOpen(book);
  }

  /** 新建书：建 《书名》/＋模板初始稿（工单 #29），成功直进编辑器。 */
  async function create() {
    if (!libraryPath || busy) return;
    const title = newTitle.trim();
    if (!title) {
      window.alert("书名不能为空。");
      return;
    }
    setBusy(true);
    try {
      const book = await invoke<BookEntry>("create_book", { root: libraryPath, title });
      setCreating(false);
      setNewTitle("");
      onOpen(book);
    } catch (e) {
      window.alert(`新建书失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 拆书模板（工单 #29）：库根 拆书模板.md 不存在先落默认模板，再以
   *  同一拆书编辑器打开编辑（同一套保存网），返回回书库。 */
  async function openTemplate() {
    if (!libraryPath) return;
    try {
      const template = await invoke<BookEntry>("open_book_template", { root: libraryPath });
      onOpen(template);
    } catch (e) {
      window.alert(`打开拆书模板失败：${errMsg(e)}`);
    }
  }

  /** 桥段跨书筛选（设计共识 §五）：按类型/解法回答「某类型有多少种解法」。 */
  const tropeEntries = useMemo(
    () =>
      books.flatMap((b) =>
        b.tropes.map((t) => ({ book: b, trope: t })),
      ),
    [books],
  );
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { trope } of tropeEntries) {
      for (const ty of trope.types) counts.set(ty, (counts.get(ty) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [tropeEntries]);

  const filteredTropes = useMemo(() => {
    const q = tropeSolution.trim().toLowerCase();
    return tropeEntries.filter(
      ({ trope }) =>
        (tropeType === "" || trope.types.includes(tropeType)) &&
        (q === "" || (trope.solution ?? "").toLowerCase().includes(q)),
    );
  }, [tropeEntries, tropeType, tropeSolution]);

  const filteredSolutions = useMemo(
    () => new Set(filteredTropes.map(({ trope }) => trope.solution).filter(Boolean)).size,
    [filteredTropes],
  );

  const scatteredCount = books.filter((b) => b.layout === "scattered").length;
  const folderCount = books.length - scatteredCount;
  const totalTropes = tropeEntries.length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>拆书书库</h1>
          {libraryPath && (
            <p className="library-path" title={libraryPath}>
              {libraryPath}
            </p>
          )}
        </div>
        <div className="page-actions">
          {libraryPath && (
            <>
              <button className="btn" disabled={scanning} onClick={() => void scan(libraryPath)}>
                刷新
              </button>
              <button className="btn" disabled={scanning} onClick={() => void openTemplate()}>
                拆书模板
              </button>
              <button className="btn primary" onClick={() => setCreating(true)}>
                新建书
              </button>
            </>
          )}
          <button className="btn" onClick={onChooseFolder}>
            打开库文件夹
          </button>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      {!libraryPath && (
        <div className="empty-state">
          <p>还没有打开拆书库。</p>
          <p className="hint">
            库文件夹可以直接指向现有的 Obsidian vault 子目录；
            <br />
            根目录散文件与一书一文件夹两种布局都认，不会搬动或改写你的文件。
          </p>
          <div className="empty-state-actions">
            <button className="btn primary" onClick={onChooseFolder}>
              打开库文件夹
            </button>
            <button className="btn" onClick={onCreateLibrary}>
              新建空库
            </button>
          </div>
        </div>
      )}

      {libraryPath && scanning && <div className="empty-state">正在扫描……</div>}

      {libraryPath && !scanning && !error && books.length === 0 && (
        <div className="empty-state">
          <p>这个文件夹里没有找到拆书稿（.md）。</p>
          <p className="hint">确认选中的是存放拆书 .md 文件的那一层目录，或者直接新建一本。</p>
          <div className="empty-state-actions">
            <button className="btn primary" onClick={() => setCreating(true)}>
              新建书
            </button>
          </div>
        </div>
      )}

      {libraryPath && books.length > 0 && (
        <>
          <form
            className="search-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="全文搜索拆书稿与标注：点评、金手指、桥段、解法……"
            />
            <button className="btn" type="submit" disabled={searching || !query.trim()}>
              {searching ? "搜索中…" : "搜索"}
            </button>
            {hits && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setHits(null);
                  setSearchError(null);
                }}
              >
                清除
              </button>
            )}
          </form>
          {searchError && <div className="error-box">{searchError}</div>}

          {hits ? (
            <div className="search-results">
              <p className="stats">
                「{query.trim()}」命中 {formatCount(hits.length)} 行
                {hits.length >= MAX_HITS && `（已达上限，仅显示前 ${MAX_HITS} 条）`}
              </p>
              {hits.length === 0 && <p className="hint">没有找到匹配的内容。</p>}
              <ul>
                {hits.map((h, i) => (
                  <li
                    key={`${h.primaryMd}-${h.line}-${i}`}
                    className="hit-row"
                    title="打开这本书"
                    onClick={() => openByPath(h.primaryMd)}
                  >
                    <span className="hit-book">{h.bookName}</span>
                    <span className="hit-line">第 {formatCount(h.line)} 行</span>
                    <span className="hit-snippet">
                      <Highlight text={h.snippet} query={query.trim()} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="list-bar">
                <p className="stats">
                  共 {formatCount(books.length)} 本 · 散文件 {formatCount(scatteredCount)} ·
                  一书一文件夹 {formatCount(folderCount)} · 桥段 {formatCount(totalTropes)}
                </p>
                <DisplayToggle mode={display} onChange={setDisplay} />
              </div>
              {display === "grid" ? (
                <div className="cover-grid">
                  {books.map((b) => (
                    <div
                      key={b.primaryMd}
                      className="cover-card"
                      title="打开拆书稿"
                      onClick={() => onOpen(b)}
                    >
                      <CoverArt
                        name={b.name}
                        cover={b.cover}
                        onSetCover={() =>
                          void pickAndSetCover(b.coverDir, () => {
                            if (libraryPath) void scan(libraryPath);
                          })
                        }
                      />
                      <div className="cover-name" title={b.name}>
                        {b.name}
                      </div>
                      <div className="cover-stats">
                        章 {formatCount(b.chapterCount)} · 字 {formatCount(b.wordCount)} · 桥段{" "}
                        {b.tropes.length}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <table className="book-table">
                  <thead>
                    <tr>
                      <th>书名</th>
                      <th>成绩</th>
                      <th>布局</th>
                      <th className="num">章数</th>
                      <th className="num">字数</th>
                      <th className="num">桥段</th>
                    </tr>
                  </thead>
                  <tbody>
                    {books.map((b) => (
                      <tr key={b.primaryMd} title="打开拆书稿" onClick={() => onOpen(b)}>
                        <td className="book-name">
                          <div>
                            {b.name}
                            {b.meta.goldenFinger && (
                              <span className="cell-sub" title="金手指">
                                {" "}
                                · {b.meta.goldenFinger}
                              </span>
                            )}
                          </div>
                          {b.meta.summary && (
                            <div className="cell-sub cell-sub-block" title={b.meta.summary}>
                              {b.meta.summary}
                            </div>
                          )}
                        </td>
                        <td>{b.meta.trackRecord ?? "—"}</td>
                        <td>{layoutLabel[b.layout]}</td>
                        <td className="num">{formatCount(b.chapterCount)}</td>
                        <td className="num">{formatCount(b.wordCount)}</td>
                        <td className="num">{b.tropes.length || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {totalTropes > 0 && (
                <section className="trope-filter">
                  <h2>桥段筛选</h2>
                  <div className="trope-filter-controls">
                    <label>
                      类型
                      <select value={tropeType} onChange={(e) => setTropeType(e.target.value)}>
                        <option value="">全部（{formatCount(totalTropes)}）</option>
                        {typeCounts.map(([ty, n]) => (
                          <option key={ty} value={ty}>
                            {ty}（{n}）
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grow">
                      解法包含
                      <input
                        value={tropeSolution}
                        onChange={(e) => setTropeSolution(e.target.value)}
                        placeholder="如：扫地僧"
                      />
                    </label>
                  </div>
                  <p className="stats">
                    {tropeType ? (
                      <>
                        「{tropeType}」共 {formatCount(filteredTropes.length)} 个桥段、
                        {formatCount(filteredSolutions)} 种解法
                      </>
                    ) : (
                      <>共 {formatCount(filteredTropes.length)} 个桥段</>
                    )}
                  </p>
                  <ul className="trope-list">
                    {filteredTropes.map(({ book, trope }, i) => (
                      <li
                        key={`${book.primaryMd}-${trope.startChapter}-${trope.endChapter}-${i}`}
                        className="trope-item"
                      >
                        <button
                          className="link-like"
                          title="打开拆书稿"
                          onClick={() => onOpen(book)}
                        >
                          {book.name}
                        </button>
                        <span
                          className="trope-span"
                          title="按正文里第几个章标题计，非正文章号"
                        >
                          {tropeSpanLabel(trope)}
                        </span>
                        {trope.types.map((ty) => (
                          <span key={ty} className="tag">
                            {ty}
                          </span>
                        ))}
                        {trope.solution && <span className="trope-solution">{trope.solution}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}

      {creating && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <div className="dialog">
            <h2>新建书</h2>
            <label>
              书名
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="如：大魏读书人"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            </label>
            <p className="hint">
              会建 《书名》/ 并放一份初始 拆书.md——内容来自库根「拆书模板」
              （书库页顶部可编辑），其中 {`{书名}`} 替换为所填书名；
              yaml 与附件随标注/贴图懒生成。同名书已存在时报错，不自动续号。
            </p>
            <div className="dialog-actions">
              <button className="btn" disabled={busy} onClick={() => setCreating(false)}>
                取消
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void create()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
