import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { BookEntry, SearchHit, TropeSpan } from "./types";
import { errMsg } from "./util";

const PATH_KEY = "gongbi.libraryPath";
/** 与 Rust 侧 search::MAX_HITS 对应，达上限时提示截断。 */
const MAX_HITS = 200;

const layoutLabel: Record<BookEntry["layout"], string> = {
  scattered: "散文件",
  "folder-book": "一书一文件夹",
};

function formatCount(n: number): string {
  return n.toLocaleString("zh-Hans-CN");
}

function spanLabel(t: TropeSpan): string {
  return t.startChapter === t.endChapter
    ? `第${t.startChapter}章`
    : `第${t.startChapter}~${t.endChapter}章`;
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
  onOpen: (book: BookEntry) => void;
}

export default function BookLibrary({ onOpen }: BookLibraryProps) {
  const [libraryPath, setLibraryPath] = useState<string | null>(
    () => localStorage.getItem(PATH_KEY),
  );
  const [books, setBooks] = useState<BookEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [tropeType, setTropeType] = useState("");
  const [tropeSolution, setTropeSolution] = useState("");

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

  async function chooseFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择拆书库文件夹",
    });
    if (typeof picked === "string") {
      localStorage.setItem(PATH_KEY, picked);
      setLibraryPath(picked);
    }
  }

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
            <button className="btn" disabled={scanning} onClick={() => void scan(libraryPath)}>
              刷新
            </button>
          )}
          <button className="btn primary" onClick={() => void chooseFolder()}>
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
        </div>
      )}

      {libraryPath && scanning && <div className="empty-state">正在扫描……</div>}

      {libraryPath && !scanning && !error && books.length === 0 && (
        <div className="empty-state">
          <p>这个文件夹里没有找到拆书稿（.md）。</p>
          <p className="hint">确认选中的是存放拆书 .md 文件的那一层目录。</p>
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
              placeholder="全文搜索：书名、金手指、桥段、点评……"
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
              <p className="stats">
                共 {formatCount(books.length)} 本 · 散文件 {formatCount(scatteredCount)} ·
                一书一文件夹 {formatCount(folderCount)} · 桥段 {formatCount(totalTropes)}
              </p>
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
                        {b.name}
                        {b.meta.goldenFinger && (
                          <span className="cell-sub" title="金手指">
                            {" "}
                            · {b.meta.goldenFinger}
                          </span>
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
                        <span className="trope-span">{spanLabel(trope)}</span>
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
    </div>
  );
}
