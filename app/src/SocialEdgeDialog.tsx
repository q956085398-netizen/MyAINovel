import { useEffect, useState } from "react";
import { nodeId, nodeLabel, type SocialEdge, type SocialNode } from "./socialCanvasTypes";
import { errMsg } from "./util";

export default function SocialEdgeDialog({ initial, nodes, onSave, onDelete, onClose }: {
  initial: SocialEdge; nodes: SocialNode[]; onSave: (edge: SocialEdge) => Promise<void>;
  onDelete?: () => Promise<void>; onClose: () => void;
}) {
  const [edge, setEdge] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);
  async function perform(remove = false) {
    if (busy) return;
    setBusy(true); setError(null);
    try { if (remove) await onDelete?.(); else await onSave({ ...edge, kind: edge.kind.trim(), note: edge.note?.trim() || null }); }
    catch (e) { setError(errMsg(e)); setBusy(false); }
  }
  const options = [...new Map([...nodes, edge.from, edge.to].map((node) => [nodeId(node), node])).values()];
  return <div className="dialog-overlay"><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="social-edge-title"
    onSubmit={(e) => { e.preventDefault(); void perform(); }}>
    <h2 id="social-edge-title">{onDelete ? "编辑关系" : "连一条关系"}</h2>
    {error && <div className="error-box" role="alert">{error}</div>}
    {(["from", "to"] as const).map((side) => <label key={side}>{side === "from" ? "起点" : "终点"}
      <select autoFocus={side === "from"} disabled={busy} value={nodeId(edge[side])} onChange={(e) => setEdge({ ...edge, [side]: options.find((node) => nodeId(node) === e.target.value)! })}>
        {options.map((node) => <option key={nodeId(node)} value={nodeId(node)}>{nodeLabel(node)}{nodes.some((n) => nodeId(n) === nodeId(node)) ? "" : " · 引用失效"}</option>)}
      </select>
    </label>)}
    <label>类型<input required disabled={busy} value={edge.kind} onChange={(e) => setEdge({ ...edge, kind: e.target.value })} /></label>
    <label>方向<select disabled={busy} value={edge.directed ? "有向" : "无向"} onChange={(e) => setEdge({ ...edge, directed: e.target.value === "有向" })}><option>有向</option><option>无向</option></select></label>
    <label>描述<textarea disabled={busy} value={edge.note ?? ""} onChange={(e) => setEdge({ ...edge, note: e.target.value })} /></label>
    <label className="check-row"><input type="checkbox" disabled={busy} checked={edge.secret} onChange={(e) => setEdge({ ...edge, secret: e.target.checked })} />含未解的秘密</label>
    <div className="dialog-actions">
      {onDelete && <button type="button" className="btn danger" disabled={busy} onClick={() => { if (window.confirm("删除这条关系？")) void perform(true); }}>删除关系</button>}
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy || !edge.kind.trim()}>保存</button>
    </div>
  </form></div>;
}
