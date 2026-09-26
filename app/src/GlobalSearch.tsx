import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./util";
import SearchHighlight from "./SearchHighlight";
import type { GlobalSearchHit, GlobalSearchReport } from "./globalSearchNavigation";
import "./GlobalSearch.css";

interface Props {
  root: string | null;
  onClose: () => void;
  onOpen: (hit: GlobalSearchHit, query: string) => Promise<void>;
}
function FullResult({ root, hit, query }: { root: string; hit: GlobalSearchHit; query: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <details onToggle={(event) => {
    if (!event.currentTarget.open || text !== null) return;
    void invoke<string>("global_search_preview", { root, path: hit.path, name: hit.title })
      .then(setText).catch((e) => setError(errMsg(e)));
  }}>
    <summary>展开全文</summary>
    {error ? <p role="alert">{error}</p> : <pre><SearchHighlight text={text ?? "正在读取……"} query={query} /></pre>}
  </details>;
}

/** 全应用一个入口；局部筛选保持原样。查询失效时丢弃迟到的响应。 */
export default function GlobalSearch({ root, onClose, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<GlobalSearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [selected, setSelected] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLElement | null>(null);

  useEffect(() => {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => { if (origin.current?.isConnected) origin.current.focus(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setReport(null); setError(null); setSelected(0);
    if (!root || !query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void invoke<GlobalSearchReport>("global_search", { root, query }).then((result) => {
        if (!cancelled) { setReport(result); setLoading(false); }
      }).catch((e) => { if (!cancelled) { setError(errMsg(e)); setLoading(false); } });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [root, query]);
  // 类型分组；每组保持扫描次序，与键盘导航使用同一份列表。
  const kinds = [...new Set(report?.hits.map((hit) => hit.kind))];
  const hits = kinds.flatMap((kind) => report?.hits.filter((hit) => hit.kind === kind) ?? []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>(`[data-result-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  async function openHit(hit: GlobalSearchHit) {
    if (opening) return;
    setOpening(true); setError(null);
    try { await onOpen(hit, query); onClose(); }
    catch (e) { setError(errMsg(e)); setOpening(false); }
  }
  return <div className="dialog-overlay global-search-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !opening) onClose();
  }}>
    <div className="dialog wide global-search" role="dialog" aria-modal="true" aria-labelledby="global-search-title" ref={dialog}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!opening) onClose(); }
        if (event.target === input.current && !event.nativeEvent.isComposing) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setSelected((index) => Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
          }
          if (event.key === "Enter" && hits[selected]) { event.preventDefault(); void openHit(hits[selected]); }
        }
        if (event.key === "Tab") {
          const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled),summary") ?? [])];
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="pane-head"><h2 id="global-search-title">搜索创作内容</h2><button className="btn small" disabled={opening} onClick={onClose}>关闭 · Esc</button></div>
      <label className="global-search-label">标题、结构字段或正文
        <input ref={input} placeholder="输入中文或关键词，回车打开" value={query} disabled={opening || !root} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="hint" aria-live="polite">{!root ? "请先打开库文件夹。" : loading ? "正在本地搜索……" : report ? `${hits.length} 个结果${report.truncated ? "，结果过多，请缩小查询范围" : ""}` : "Ctrl+K 打开 · ↑↓ 选择 · Enter 跳转"}</p>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="global-search-results" aria-busy={loading}>
        {report?.warnings.length ? <details className="hint"><summary>{report.warnings.length} 个文件或目录读取提示</summary>{report.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
        {report && hits.length === 0 && <p className="hint">没有找到匹配的创作内容。</p>}
        {hits.map((hit, index) => <section key={`${hit.path}:${hit.kind}:${hit.title}`}>
          {(index === 0 || hits[index - 1].kind !== hit.kind) && <h3>{hit.kind}</h3>}
          <article className={`global-search-result ${index === selected ? "selected" : ""}`} data-result-index={index}>
            <button className="global-search-open" disabled={opening} onFocus={() => setSelected(index)} onClick={() => void openHit(hit)}>
              <strong><SearchHighlight text={hit.title} query={query} /></strong>
              <span className="hint">{hit.projectTitle ?? "灵感库"} · {hit.category ?? hit.kind}</span>
              {hit.matches.slice(0, 3).map((match, i) => <span className="global-search-snippet" key={i}><span className="field-label">{match.field}{match.line > 0 ? ` · 第 ${match.line} 行` : ""}</span><span><SearchHighlight text={match.snippet} query={query} /></span></span>)}
            </button>
            {root && <FullResult key={`${root}:${query}:${hit.path}:${hit.title}`} root={root} hit={hit} query={query} />}
          </article>
        </section>)}
      </div>
    </div>
  </div>;
}
