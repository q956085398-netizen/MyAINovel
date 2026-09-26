import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Confluence, NoteEntry } from "./types";
import { relationStyle } from "./types";
import { characterDetailRows } from "./characterProfile";
import { nodeId, nodeLabel, ORG_FIELDS, type Placement, type SocialCanvasData, type SocialEdge, type SocialWorkspace, type Organization } from "./socialCanvasTypes";
import { errMsg, oneLinePreview } from "./util";
import NoteDialog from "./NoteDialog";
import OrganizationDialog from "./OrganizationDialog";
import SocialEdgeDialog from "./SocialEdgeDialog";
import RelationshipLegendDialog from "./RelationshipLegendDialog";
import RelationshipCanvas, { PromoteDialog } from "./RelationshipCanvas";
import "./SocialCanvas.css";

interface Props {
  project: string; focusName?: string; onChanged: () => void; onUpgrade: () => void;
  onAiCommand: (names: string[]) => void; onChat?: (name: string) => void; onPromoted: () => void;
}
interface Drag {
  id: string; pointer: number; startX: number; startY: number; origin: Placement; next: Placement; moved: boolean;
}

/** 社会网与档案的引用视图；手工位置和固定状态是唯一的画布写入。 */
export default function SocialCanvas(props: Props) {
  const { project, focusName, onChanged, onUpgrade, onAiCommand, onChat, onPromoted } = props;
  const [data, setData] = useState<SocialCanvasData | null>(null);
  const [persons, setPersons] = useState<NoteEntry[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<string[]>(focusName ? [focusName.startsWith("组织:") ? focusName : `人物:${focusName}`] : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [undo, setUndo] = useState<Placement[] | null>(null);
  const [dragPosition, setDragPosition] = useState<Placement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [edgeDialog, setEdgeDialog] = useState<{ index: number | null; edge: SocialEdge } | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [personEditor, setPersonEditor] = useState<NoteEntry | null>(null);
  const [organizationEditor, setOrganizationEditor] = useState<Organization | null>(null);
  const [promote, setPromote] = useState(false);
  const [confluence, setConfluence] = useState<Confluence | null>(null);
  const marker = useId().replace(/:/g, "");

  const load = useCallback(async () => {
    if (lock.current || drag.current) return;
    lock.current = true; setBusy(true);
    try {
      const [next, notes, workspace] = await Promise.all([
        invoke<SocialCanvasData>("read_social_canvas", { project }),
        invoke<NoteEntry[]>("scan_notes", { project, kind: "人物" }),
        invoke<SocialWorkspace>("read_social_workspace", { project }),
      ]);
      setData(next); setPersons(notes); setOrganizations(workspace.organizations);
      setSelected((current) => current.filter((id) => next.nodes.some((node) => nodeId(node) === id)));
      setUndo(null); setError(null);
    } catch (e) { setData(null); setError(`读取社会画布失败：${errMsg(e)}`); }
    finally { lock.current = false; setBusy(false); }
  }, [project]);
  useEffect(() => { void load(); }, [load]);

  async function mutate(action: () => Promise<SocialCanvasData>, previous: Placement[] | null = null) {
    if (lock.current || drag.current) throw new Error("正在保存或拖动，请稍后再试");
    lock.current = true; setBusy(true); setError(null);
    try {
      const next = await action();
      setData(next); setUndo(previous); onChanged();
    } catch (e) { setError(`未保存：${errMsg(e)}。请刷新核对后重试。`); throw e; }
    finally { lock.current = false; setBusy(false); setDragPosition(null); }
  }
  function savePositions(placements: Placement[]) {
    if (!data) return Promise.reject(new Error("画布未载入"));
    return mutate(() => invoke<SocialCanvasData>("save_social_layout", { project, placements, expected: data.fingerprint }));
  }
  // 按钮的失败已由 mutate 展示；对话框则保留拒绝结果，在框内显示。
  function run(action: Promise<unknown>) { void action.catch(() => {}); }
  function toggle(id: string) { setSelected((old) => old.includes(id) ? old.filter((item) => item !== id) : [...old, id]); }
  const writable = Boolean(data?.upgraded && !data.recoveryNeeded && !busy);
  const selectedPersons = (data?.nodes ?? []).filter((node) => node.kind === "人物" && selected.includes(nodeId(node))).map((node) => node.name);

  function pointerPoint(e: ReactPointerEvent<SVGGElement>) {
    const svg = e.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
  }
  function startDrag(e: ReactPointerEvent<SVGGElement>, position: Placement) {
    if (!writable || e.button !== 0 || drag.current) return;
    const point = pointerPoint(e);
    if (!point) return;
    e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: nodeId(position.node), pointer: e.pointerId, startX: point.x, startY: point.y, origin: position, next: position, moved: false };
  }
  function moveDrag(e: ReactPointerEvent<SVGGElement>) {
    const current = drag.current;
    if (!current || current.pointer !== e.pointerId) return;
    const point = pointerPoint(e);
    if (!point) return;
    const dx = point.x - current.startX, dy = point.y - current.startY;
    if (Math.hypot(dx, dy) < 4 && !current.moved) return;
    current.moved = true;
    current.next = { ...current.origin, x: Math.min(100000, Math.max(60, current.origin.x + dx)), y: Math.min(100000, Math.max(60, current.origin.y + dy)) };
    setDragPosition(current.next);
  }
  function endDrag(e: ReactPointerEvent<SVGGElement>, cancel = false) {
    const current = drag.current;
    if (!current || current.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (cancel) { setDragPosition(null); return; }
    if (!current.moved) { toggle(current.id); return; }
    if (data) run(savePositions(data.placements.map((p) => nodeId(p.node) === current.id ? current.next : p)));
  }
  function edited() {
    setPersonEditor(null); setOrganizationEditor(null); void load(); onChanged();
  }
  if (data && !data.upgraded) return <div>
    <div className="hint-box"><p>当前使用旧人物关系。预览升级后，可在同一画布整理人物与组织，并保存位置。</p><button className="btn" onClick={onUpgrade}>前往组织与归属，预览升级</button></div>
    <RelationshipCanvas {...props} />
  </div>;

  const positions = new Map((data?.placements ?? []).map((p) => [nodeId(p.node), p]));
  if (dragPosition) positions.set(nodeId(dragPosition.node), dragPosition);
  const livePositions = (data?.placements ?? []).filter((p) => data?.nodes.some((node) => nodeId(node) === nodeId(p.node)));
  const width = Math.max(850, ...livePositions.map((p) => p.x + 110));
  const height = Math.max(500, ...livePositions.map((p) => p.y + 100));
  const known = new Set((data?.nodes ?? []).map(nodeId));
  const missing = (data?.edges ?? []).map((edge, index) => ({ edge, index })).filter(({ edge }) => !known.has(nodeId(edge.from)) || !known.has(nodeId(edge.to)));
  const kinds = [...new Set((data?.edges ?? []).map((e) => e.kind))];
  const color = (kind: string) => relationStyle(kind, data?.legend ?? []).color;

  return <div className="note-pane social-canvas-pane">
    <div className="pane-head"><div><h2>社会关系画布</h2><p className="hint">圆形是人物，方形是组织。拖动摆放，点击可多选，双击或 F2 编辑档案；固定后「整理画布」保留其位置。</p></div>
      <div className="page-actions"><button className="btn" disabled={busy} onClick={() => void load()}>刷新</button>
        <button className="btn" disabled={!writable} onClick={() => setLegendOpen(true)}>图例</button>
        <button className="btn primary" disabled={!writable || !data?.nodes.length} onClick={() => {
          if (!data) return;
          const nodes = data.nodes.filter((n) => selected.includes(nodeId(n)));
          setEdgeDialog({ index: null, edge: { from: nodes[0] ?? data.nodes[0], to: nodes[1] ?? data.nodes[1] ?? data.nodes[0], kind: "", directed: false, note: null, secret: false } });
        }}>连一条关系</button></div>
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {data?.recoveryNeeded && <div className="error-box">上次升级未完成，请在「组织与归属」恢复升级后再编辑。<button className="btn" onClick={onUpgrade}>前往恢复</button></div>}
    <div className="rel-toolbar"><span className="hint" role="status">{busy ? "正在读取或保存…" : data ? `已保存 · 选中 ${selected.length} 个节点` : "画布未载入"}</span><div className="page-actions">
      <button className="btn small" disabled={!writable || !selected.length} onClick={() => {
        if (!data) return;
        const pin = data.placements.some((p) => selected.includes(nodeId(p.node)) && !p.pinned);
        run(savePositions(data.placements.map((p) => selected.includes(nodeId(p.node)) ? { ...p, pinned: pin } : p)));
      }}>{data?.placements.some((p) => selected.includes(nodeId(p.node)) && !p.pinned) ? "固定选中" : "取消固定"}</button>
      <button className="btn small" disabled={!writable || !data?.nodes.length} onClick={() => data && run(mutate(() => invoke("arrange_social_canvas", { project, all: false, expected: data.fingerprint })))}>整理画布</button>
      <button className="btn small" disabled={!writable || !data?.nodes.length} onClick={() => data && run(mutate(() => invoke("arrange_social_canvas", { project, all: true, expected: data.fingerprint }), data.placements))}>全部重排</button>
      <button className="btn small" disabled={!writable || !undo} onClick={() => undo && run(savePositions(undo))}>撤销重排</button>
    </div></div>
    {data && <>
      <div className="social-canvas-body">
        <div className="social-canvas-scroll">
          <svg className="social-graph" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-label="人物与组织的社会关系画布">
            <defs>{kinds.map((kind, i) => <marker key={kind} id={`${marker}-${i}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill={color(kind)} /></marker>)}</defs>
            {data.edges.map((edge, index) => {
              if (!known.has(nodeId(edge.from)) || !known.has(nodeId(edge.to))) return null;
              const a = positions.get(nodeId(edge.from))!, b = positions.get(nodeId(edge.to))!;
              const same = nodeId(edge.from) === nodeId(edge.to);
              const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
              // 同对节点的多条边分开弯曲，以便分别选择与阅读。
              const siblings = data.edges.slice(0, index).filter((e) => (nodeId(e.from) === nodeId(edge.from) && nodeId(e.to) === nodeId(edge.to)) || (nodeId(e.to) === nodeId(edge.from) && nodeId(e.from) === nodeId(edge.to))).length;
              const offset = siblings === 0 ? 0 : (siblings % 2 ? 1 : -1) * Math.ceil(siblings / 2) * 52;
              const ux = distance > 0 ? dx / distance : 1, uy = distance > 0 ? dy / distance : 0;
              const cx = (a.x + b.x) / 2 - uy * offset, cy = (a.y + b.y) / 2 + ux * offset;
              const path = same ? `M ${a.x - 24} ${a.y - 20} C ${a.x - 90} ${a.y - 105} ${a.x + 90} ${a.y - 105} ${a.x + 24} ${a.y - 20}`
                : `M ${a.x + ux * 40} ${a.y + uy * 40} Q ${cx} ${cy} ${b.x - ux * 43} ${b.y - uy * 43}`;
              return <g key={index} className="social-edge">
                <path d={path} fill="none" stroke={color(edge.kind)} strokeWidth="2" strokeDasharray={edge.secret ? "6 5" : undefined} markerEnd={edge.directed ? `url(#${marker}-${kinds.indexOf(edge.kind)})` : undefined} />
                <path d={path} className="social-edge-hit" role="button" tabIndex={0} aria-label={`编辑关系：${nodeLabel(edge.from)} ${edge.kind} ${nodeLabel(edge.to)}`} aria-disabled={!writable}
                  onClick={() => writable && setEdgeDialog({ index, edge })} onKeyDown={(e) => { if (writable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEdgeDialog({ index, edge }); } }} />
                <text className="rel-edge-label" x={same ? a.x : (a.x + b.x) / 2 - uy * offset / 2} y={same ? a.y - 84 : (a.y + b.y) / 2 + ux * offset / 2 - 5} textAnchor="middle">{edge.kind}{edge.secret ? " ？" : ""}</text>
              </g>;
            })}
            {data.nodes.map((node) => {
              const id = nodeId(node), p = positions.get(id)!;
              const note = node.kind === "人物" ? persons.find((item) => item.name === node.name) : undefined;
              const org = node.kind === "组织" ? organizations.find((item) => item.draft.name === node.name) : undefined;
              const summary = note?.character?.identity ?? org?.draft.purpose ?? "";
              const editArchive = () => {
                if (busy || data.recoveryNeeded) return;
                setSelected((old) => old.includes(id) ? old : [...old, id]);
                if (note) setPersonEditor(note);
                if (org) setOrganizationEditor(org);
              };
              return <g key={id} transform={`translate(${p.x}, ${p.y})`} className={`social-node ${selected.includes(id) ? "on" : ""}`} role="button" tabIndex={0} aria-label={`${nodeLabel(node)}${p.pinned ? "，已固定" : ""}`} aria-pressed={selected.includes(id)}
                onPointerDown={(e) => startDrag(e, p)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={(e) => endDrag(e, true)} onLostPointerCapture={(e) => endDrag(e, true)}
                onDoubleClick={editArchive}
                onKeyDown={(e) => {
                  if (e.key === "F2") { e.preventDefault(); editArchive(); }
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(id); }
                  const delta: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
                  if (writable && delta[e.key]) { e.preventDefault(); const [dx, dy] = delta[e.key]; run(savePositions(data.placements.map((item) => nodeId(item.node) === id ? { ...item, x: Math.min(100000, Math.max(60, item.x + dx)), y: Math.min(100000, Math.max(60, item.y + dy)) } : item))); }
                }}>
                <title>{nodeLabel(node)}{summary ? `：${summary}` : ""}。方向键移动，空格选中，双击或 F2 编辑档案。</title>
                {node.kind === "人物" ? <circle r="34" /> : <rect x="-40" y="-30" width="80" height="60" rx="8" />}
                <text textAnchor="middle" dominantBaseline="middle">{oneLinePreview(node.name, 5)}</text>
                <text className="social-node-caption" textAnchor="middle" y="53">{oneLinePreview(summary || node.name, 14)}</text>
                {p.pinned && <text className="social-node-pin" x="28" y="-32">固定</text>}
              </g>;
            })}
          </svg>
        </div>
        <aside className="social-details" aria-label="选中节点详情">
          {!selected.length && <p className="hint">选中节点查看档案与关系。方向键可移动聚焦节点，空格选中。</p>}
          {data.nodes.filter((n) => selected.includes(nodeId(n))).map((node) => {
            const id = nodeId(node);
            const person = node.kind === "人物" ? persons.find((p) => p.name === node.name) : undefined;
            const org = node.kind === "组织" ? organizations.find((o) => o.draft.name === node.name) : undefined;
            return <article className="rel-side-card" key={id}><h3>{nodeLabel(node)}</h3><div className="page-actions">
              <button className="btn small" disabled={busy || data.recoveryNeeded} onClick={() => { if (person) setPersonEditor(person); if (org) setOrganizationEditor(org); }}>编辑档案</button>
              {person && onChat && <button className="btn small" onClick={() => onChat(person.name)}>跟 TA 聊</button>}
            </div>
              {person && characterDetailRows(person.character).map(([label, value]) => <p className="field-line" key={label}><span className="field-label">{label}</span>{value}</p>)}
              {org && ORG_FIELDS.map(([field, label]) => org.draft[field] && <p className="field-line" key={field}><span className="field-label">{label}</span>{org.draft[field]}</p>)}
              <div className="card-body">{person?.body ?? org?.draft.body}</div>
              <ul className="rel-side-edges">{data.edges.map((edge, index) => (nodeId(edge.from) === id || nodeId(edge.to) === id) && <li key={index}>
                <button className="link-like" disabled={!writable} onClick={() => setEdgeDialog({ index, edge })}>{nodeLabel(edge.from)} {edge.directed ? "→" : "—"} {nodeLabel(edge.to)} · {edge.kind}{edge.secret ? " · 秘密" : ""}</button>
                {edge.note && <p>{edge.note}</p>}
              </li>)}</ul>
            </article>;
          })}
        </aside>
      </div>
      {!data.nodes.length && <p className="hint">还没有人物或组织，先在名单或组织页建立档案。</p>}
      {missing.length > 0 && <div className="hint-box"><h3>失效引用（关系仍保留）</h3>{missing.map(({ edge, index }) => <p key={index}><button className="link-like" disabled={!writable} onClick={() => setEdgeDialog({ index, edge })}>{nodeLabel(edge.from)} {edge.directed ? "→" : "—"} {nodeLabel(edge.to)} · {edge.kind}</button></p>)}</div>}
      {kinds.some((kind) => !data.legend.some((item) => item.name === kind)) && <p className="hint">图例外类型（使用缺省颜色）：{kinds.filter((kind) => !data.legend.some((item) => item.name === kind)).join("、")}</p>}
      <div className="page-actions social-story-actions">
        <button className="btn small" disabled={selectedPersons.length < 2 || busy || data.recoveryNeeded} onClick={() => setPromote(true)}>提为矛盾</button>
        <button className="btn small" disabled={selectedPersons.length < 2 || busy} onClick={() => { void invoke<Confluence>("character_confluence", { project, names: selectedPersons }).then(setConfluence).catch((e) => setError(errMsg(e))); }}>人物交汇</button>
        <button className="btn small" disabled={selectedPersons.length < 2 || busy} onClick={() => onAiCommand(selectedPersons)}>AI 梳理人物关系</button>
      </div>
    </>}
    {edgeDialog && data && <SocialEdgeDialog initial={edgeDialog.edge} nodes={data.nodes} onClose={() => setEdgeDialog(null)}
      onSave={async (next) => { await mutate(() => invoke("edit_social_edge", { project, index: edgeDialog.index, next, expected: data.fingerprint })); setEdgeDialog(null); }}
      onDelete={edgeDialog.index === null ? undefined : async () => { await mutate(() => invoke("edit_social_edge", { project, index: edgeDialog.index, next: null, expected: data.fingerprint })); setEdgeDialog(null); }} />}
    {legendOpen && data && <RelationshipLegendDialog legend={data.legend} onClose={() => setLegendOpen(false)} onSave={async (legend, sources) => {
      await mutate(() => invoke("save_social_legend", { project, legend, sources, expected: data.fingerprint })); setLegendOpen(false);
    }} />}
    {personEditor && <NoteDialog project={project} initial={personEditor} prevPath={personEditor.path} vocab={null} onClose={() => setPersonEditor(null)} onSaved={edited} onDeleted={edited} />}
    {organizationEditor && <OrganizationDialog project={project} initial={organizationEditor.draft} expected={organizationEditor.fingerprint} path={organizationEditor.path} onClose={() => setOrganizationEditor(null)} onSaved={edited} />}
    {promote && <PromoteDialog names={selectedPersons} project={project} onClose={() => setPromote(false)} onDone={() => { setPromote(false); onPromoted(); onChanged(); }} />}
    {confluence && <div className="dialog-overlay"><div className="dialog wide" role="dialog" aria-modal="true" aria-label="人物交汇"><h2>人物交汇</h2>
      {confluence.edges.map((edge, i) => <p key={i}>{edge.from} · {edge.kind} · {edge.to}{edge.secret ? " · 秘密" : ""}{edge.note ? `：${edge.note}` : ""}</p>)}
      <h3>共同出现的单元</h3>{confluence.units.length ? confluence.units.map((unit) => <p key={unit.name}>{unit.name} · {unit.persons.join("、")}</p>) : <p className="hint">还没有共同提及的单元。</p>}
      <div className="dialog-actions"><button autoFocus className="btn" onClick={() => setConfluence(null)}>关闭</button></div>
    </div></div>}
  </div>;
}
