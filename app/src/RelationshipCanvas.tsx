import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Confluence,
  LegendItem,
  NoteEntry,
  Relationship,
  RelationshipTable,
  RelationshipView,
} from "./types";
import { RELATION_FALLBACK_COLOR, relationPaletteColor, relationStyle } from "./types";
import { errMsg, oneLinePreview } from "./util";
import NoteDialog from "./NoteDialog";
import RelationshipDialog from "./RelationshipDialog";
import RelationshipLegendDialog from "./RelationshipLegendDialog";

interface RelationshipCanvasProps {
  project: string;
  /** 从灵感库「关联」跳来的人名：打开时选中这个节点（工单 #8 §五步 2）。 */
  focusName?: string;
  /** 「AI 梳理」：材料由后端按选中人名现读组装，只出报告（#15 纪律）。 */
  onAiCommand: (names: string[]) => void;
  /** 「跟 TA 聊」：进人物对话（工单 #16），一人一会话。 */
  onChat?: (name: string) => void;
  /** 建了矛盾之后：切到「矛盾」页去看（与「矛盾提为单元」同款跳转）。 */
  onPromoted: () => void;
  onChanged: () => void;
}

/** 未分组的归一堆，排最后。 */
const NO_GROUP = "未分组";

const NODE_R = 22;
/** 簇的最小半径与每个节点要占的弧长（够摆下名字标签）。 */
const RING_MIN = 74;
const RING_STEP = 62;
const PAD = 48;
const BAND_GAP = 40;

interface Positioned {
  name: string;
  x: number;
  y: number;
}

interface Band {
  group: string;
  cx: number;
  cy: number;
  r: number;
  /** 分组的色（按簇序取色板）：环上的节点用它描边，一眼看出阵营。 */
  color: string;
  nodes: Positioned[];
}

interface Layout {
  nodes: Map<string, Positioned>;
  bands: Band[];
  width: number;
  height: number;
}

/** 确定性布局（工单 #8 §三）：按「分组」分簇、簇内环形——纯函数派生，
 *  坐标不落盘，每次打开一样（没有力导向的随机，也没有缓存的失效）。 */
function layout(persons: NoteEntry[]): Layout {
  const order: string[] = [];
  const buckets = new Map<string, string[]>();
  for (const p of persons) {
    const group = (p.group ?? "").trim() || NO_GROUP;
    if (!buckets.has(group)) {
      buckets.set(group, []);
      order.push(group);
    }
    buckets.get(group)!.push(p.name);
  }
  // 「未分组」排最后；其余按首见次序（＝名单视图的文件序，稳）。
  const groups = order.filter((g) => g !== NO_GROUP);
  if (order.includes(NO_GROUP)) groups.push(NO_GROUP);

  const sizes = groups.map((g) => buckets.get(g)!.length);
  const radii = sizes.map((n) =>
    Math.max(RING_MIN, Math.ceil((n * RING_STEP) / (2 * Math.PI))),
  );
  const width = Math.max(2 * Math.max(...radii, RING_MIN)) + 2 * PAD;
  const height =
    radii.reduce((sum, r) => sum + 2 * r, 0) + BAND_GAP * Math.max(0, groups.length - 1) + 2 * PAD;

  const nodes = new Map<string, Positioned>();
  const bands: Band[] = [];
  let y = PAD;
  groups.forEach((group, gi) => {
    const r = radii[gi];
    const cx = width / 2;
    const cy = y + r;
    const names = [...buckets.get(group)!].sort((a, b) => a.localeCompare(b, "zh"));
    const items: Positioned[] = names.map((name, i) => {
      // 单人簇摆正中；其余从正上方起顺时针均分。
      const angle = names.length === 1 ? null : -Math.PI / 2 + (i * 2 * Math.PI) / names.length;
      const pos = {
        name,
        x: angle === null ? cx : cx + r * Math.cos(angle),
        y: angle === null ? cy : cy + r * Math.sin(angle),
      };
      nodes.set(name, pos);
      return pos;
    });
    bands.push({ group, cx, cy, r, color: relationPaletteColor(gi), nodes: items });
    y += 2 * r + BAND_GAP;
  });
  return { nodes, bands, width, height };
}

/** 从 a 到 b 的线段，两端各缩掉节点半径（线不穿进圈里）。 */
function segment(a: Positioned, b: Positioned): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  const gap = NODE_R + 3;
  if (len <= gap * 2) return null;
  return {
    x1: a.x + ux * gap,
    y1: a.y + uy * gap,
    x2: b.x - ux * gap,
    y2: b.y - uy * gap,
  };
}

/** 人物关系画布（工单 #8，docs/spec/人物关系画布.md）：关系网住
 *  构思/人物关系.yaml，节点是人物文件的引用视图，坐标不落盘。 */
export default function RelationshipCanvas({
  project,
  focusName,
  onAiCommand,
  onChat,
  onPromoted,
  onChanged,
}: RelationshipCanvasProps) {
  const [view, setView] = useState<RelationshipView | null>(null);
  const [persons, setPersons] = useState<NoteEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [edgeDialog, setEdgeDialog] = useState<{ initial: Relationship | null; index: number | null } | null>(
    null,
  );
  const [legendOpen, setLegendOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [confluence, setConfluence] = useState<Confluence | null>(null);
  const [editing, setEditing] = useState<NoteEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextView, notes] = await Promise.all([
        invoke<RelationshipView>("read_relationships", { project }),
        invoke<NoteEntry[]>("scan_notes", { project, kind: "人物" }),
      ]);
      setView(nextView);
      setPersons(notes);
      setSelected((cur) => {
        const next = cur.filter((name) => notes.some((n) => n.name === name));
        // 「关联」跳来的那个人：只在还没选中任何节点时自动选中（不跟用户抢）。
        if (next.length === 0 && focusName && notes.some((n) => n.name === focusName)) {
          return [focusName];
        }
        return next;
      });
    } catch (e) {
      setView(null);
      setPersons([]);
      setError(`读取关系网失败：${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [project, focusName]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 存回整表（读-合-写在后端）：底稿是 view.edges（含失效引用），
   *  保存不会把画不出来的边悄悄丢掉。 */
  const save = useCallback(
    async (table: RelationshipTable) => {
      const nextView = await invoke<RelationshipView>("save_relationships", {
        project,
        table: { ...table, fingerprint: view?.fingerprint ?? null },
      });
      setView(nextView);
      onChanged();
      return nextView;
    },
    [project, onChanged, view?.fingerprint],
  );

  const layoutData = useMemo(() => layout(persons), [persons]);
  const personNames = useMemo(() => persons.map((p) => p.name), [persons]);
  const known = useMemo(() => new Set(personNames), [personNames]);

  /** 画得出来的边（两端人物都在）＋ 它们的下标（改/删要写回整表）。 */
  const drawnEdges = useMemo(() => {
    if (!view) return [];
    return view.edges
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => known.has(edge.from) && known.has(edge.to));
  }, [view, known]);

  const markerColors = useMemo(() => {
    const colors = (view?.legend ?? []).map((l) => l.color);
    colors.push(RELATION_FALLBACK_COLOR);
    return [...new Set(colors)];
  }, [view]);

  function toggle(name: string) {
    setSelected((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
  }

  async function removeEdge(index: number) {
    if (!view) return;
    const edges = view.edges.filter((_, i) => i !== index);
    await save({ legend: view.legend, edges });
    setEdgeDialog(null);
  }

  async function upsertEdge(edge: Relationship) {
    if (!view || !edgeDialog) return;
    const edges = [...view.edges];
    if (edgeDialog.index === null) {
      edges.push(edge);
    } else {
      edges[edgeDialog.index] = edge;
    }
    await save({ legend: view.legend, edges });
    setEdgeDialog(null);
  }

  async function saveLegend(legend: LegendItem[]) {
    if (!view) return;
    await save({ legend, edges: view.edges });
    setLegendOpen(false);
  }

  async function openConfluence() {
    try {
      setConfluence(await invoke<Confluence>("character_confluence", { project, names: selected }));
    } catch (e) {
      window.alert(`看人物交汇失败：${errMsg(e)}`);
    }
  }

  const selectedNotes = selected
    .map((name) => persons.find((p) => p.name === name))
    .filter((n): n is NoteEntry => Boolean(n));
  const multi = selected.length >= 2;
  /** 关系表读不懂：只读照旧，写盘一律停用（后端也会拒绝覆盖）。 */
  const broken = Boolean(view?.warning);

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>人物关系画布</h2>
          <p className="hint">
            节点是人物文件的引用，坐标不落盘（按「分组」分簇现算）；关系网存在
            构思/人物关系.yaml，边带类型、描述与秘密标记。关系网是剧情发生器——人物之间有足够关联，
            剧情之间才不会突兀。
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            disabled={broken}
            title={broken ? "文件读不懂，先修好再改（应用不覆盖读不懂的文件）" : "关系类型集合：可命名、有序、可绑定方向"}
            onClick={() => setLegendOpen(true)}
          >
            图例
          </button>
          <button
            className="btn"
            disabled={personNames.length < 2 || broken}
            title={
              broken
                ? "文件读不懂，先修好再改（应用不覆盖读不懂的文件）"
                : "在两个人之间连一条关系"
            }
            onClick={() => setEdgeDialog({ initial: null, index: null })}
          >
            连一条关系
          </button>
        </div>
      </div>

      {view?.warning && (
        <div className="error-box">
          关系表读不懂：{view.warning}
          <br />
          画布先按「缺省图例＋空表」显示，但改文件的按钮已停用——应用不覆盖读不懂的文件，
          请在 Obsidian 里修好再回来。
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="hint">正在读取……</p>}

      {view && persons.length === 0 && !loading && (
        <div className="empty-state">
          <p>还没有人物。</p>
          <p className="hint">
            先在「名单」里新建人物（或从灵感库的角色卡转生），再回来连线。
          </p>
        </div>
      )}

      {view && persons.length > 0 && (
        <>
          <div className="rel-toolbar">
            <span className="hint">
              选中 {selected.length} 人
              {selected.length > 0 && `：${selected.join("、")}`}
            </span>
            <div className="page-actions">
              <button
                className="btn small"
                disabled={!multi || broken}
                title={
                  broken
                    ? "关系表读不懂，先修好再提（预填要用现有的边）"
                    : "建一份矛盾草稿：涉及人物＋他们之间的边（不生成剧情内容）"
                }
                onClick={() => setPromoteOpen(true)}
              >
                提为矛盾
              </button>
              <button
                className="btn small"
                disabled={!multi || broken}
                title={
                  broken
                    ? "关系表读不懂，先修好再看（交汇要用现有的边）"
                    : "看他们之间的边与共同出现的单元"
                }
                onClick={() => void openConfluence()}
              >
                交汇
              </button>
              <button
                className="btn small"
                disabled={!multi || broken}
                title={
                  broken
                    ? "关系表读不懂，先修好再梳理（材料要用现有的边）"
                    : "AI 只做体检报告，不改任何文件"
                }
                onClick={() => onAiCommand(selected)}
              >
                AI 梳理
              </button>
              <button className="btn small" disabled={selected.length === 0} onClick={() => setSelected([])}>
                清空选择
              </button>
            </div>
          </div>

          <div className="rel-body">
            <svg
              className="rel-canvas"
              width={layoutData.width}
              height={layoutData.height}
              viewBox={`0 0 ${layoutData.width} ${layoutData.height}`}
            >
              <defs>
                {markerColors.map((color, i) => (
                  <marker
                    key={color}
                    id={`rel-arrow-${i}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
                  </marker>
                ))}
              </defs>

              {drawnEdges.map(({ edge, index }) => {
                const a = layoutData.nodes.get(edge.from);
                const b = layoutData.nodes.get(edge.to);
                if (!a || !b) return null;
                const seg = segment(a, b);
                if (!seg) return null;
                const style = relationStyle(edge.kind, view.legend);
                const mx = (seg.x1 + seg.x2) / 2;
                const my = (seg.y1 + seg.y2) / 2;
                return (
                  <g key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}>
                    <line
                      x1={seg.x1}
                      y1={seg.y1}
                      x2={seg.x2}
                      y2={seg.y2}
                      stroke={style.color}
                      strokeWidth={1.6}
                      strokeDasharray={edge.secret ? "6 4" : undefined}
                      markerEnd={
                        style.directed ? `url(#rel-arrow-${markerColors.indexOf(style.color)})` : undefined
                      }
                    />
                    <text
                      className="rel-edge-label"
                      x={mx}
                      y={my}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {edge.secret ? `${edge.kind}？` : edge.kind}
                    </text>
                  </g>
                );
              })}

              {layoutData.bands.map((band) => (
                <g key={band.group}>
                  <circle
                    className="rel-band"
                    cx={band.cx}
                    cy={band.cy}
                    r={band.r}
                    stroke={band.color}
                    strokeDasharray="3 5"
                  />
                  <text
                    className="rel-band-label"
                    x={band.cx}
                    y={band.cy - band.r - 10}
                    textAnchor="middle"
                    fill={band.color}
                  >
                    {band.group}
                  </text>
                  {band.nodes.map((node) => {
                    const on = selected.includes(node.name);
                    return (
                      <g
                        key={node.name}
                        className={`rel-node ${on ? "on" : ""}`}
                        onClick={() => toggle(node.name)}
                      >
                        <title>{node.name}</title>
                        <circle cx={node.x} cy={node.y} r={NODE_R} stroke={band.color} />
                        <text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle">
                          {node.name.length > 4 ? `${node.name.slice(0, 4)}…` : node.name}
                        </text>
                      </g>
                    );
                  })}
                </g>
              ))}
            </svg>

            <div className="rel-side">
              {selectedNotes.length === 0 ? (
                <p className="hint">点节点选中人物（可多选）：选中 2 人以上就能「提为矛盾」「交汇」「AI 梳理」。</p>
              ) : (
                selectedNotes.map((note) => (
                  <div key={note.path} className="rel-side-card">
                    <div className="card-title-row">
                      <strong>{note.name}</strong>
                      {note.group && <span className="card-cat">{note.group}</span>}
                      {onChat && (
                        <button
                          className="btn small"
                          title="开一个与 TA 的 AI 对话找灵感（小传＋关系＋读者遐想（类型圈）当人格底座）"
                          onClick={() => onChat(note.name)}
                        >
                          跟 TA 聊
                        </button>
                      )}
                      <button className="btn small" onClick={() => setEditing(note)}>
                        小传
                      </button>
                      <button className="btn small" onClick={() => toggle(note.name)}>
                        移除
                      </button>
                    </div>
                    {note.body && <p className="card-preview">{oneLinePreview(note.body, 80)}</p>}
                    <ul className="rel-side-edges">
                      {drawnEdges
                        .filter(({ edge }) => edge.from === note.name || edge.to === note.name)
                        .map(({ edge, index }) => {
                          const style = relationStyle(edge.kind, view.legend);
                          return (
                            <li key={index}>
                              <button
                                className="link-like"
                                disabled={broken}
                                title={broken ? "关系表读不懂，先修好再改" : "改这条关系"}
                                onClick={() => setEdgeDialog({ initial: edge, index })}
                              >
                                {edge.from} {style.directed ? "→" : "—"} {edge.to}（{edge.kind}
                                {edge.secret ? "·秘密" : ""}）
                              </button>
                              {edge.note && <span className="hint"> {oneLinePreview(edge.note, 40)}</span>}
                            </li>
                          );
                        })}
                      {drawnEdges.every(({ edge }) => edge.from !== note.name && edge.to !== note.name) && (
                        <li className="hint">（还没连过线——孤岛）</li>
                      )}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </div>

          {(view.missing.length > 0 || view.unknownKinds.length > 0) && (
            <div className="hint-box">
              {view.missing.length > 0 && (
                <p>
                  失效引用（画不出来，人物文件不在 构思/人物/ 下）：
                  {view.missing.map((e) => `${e.from}→${e.to}（${e.kind}）`).join("、")}
                </p>
              )}
              {view.unknownKinds.length > 0 && (
                <p>
                  图例外的类型（照画兜底样式，加进图例就能各自配色）：{view.unknownKinds.join("、")}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {confluence && (
        <div className="rel-confluence">
          <div className="card-title-row">
            <strong>人物交汇</strong>
            <button className="btn small" onClick={() => setConfluence(null)}>
              关掉
            </button>
          </div>
          <p className="hint">选中：{selected.join("、")}</p>
          <h4>他们之间的边</h4>
          {confluence.edges.length === 0 ? (
            <p className="hint">（他们之间还没连过线）</p>
          ) : (
            <ul className="rel-side-edges">
              {confluence.edges.map((e, i) => (
                <li key={i}>
                  {e.from} {relationStyle(e.kind, view?.legend ?? []).directed ? "→" : "—"} {e.to}（{e.kind}
                  {e.secret ? "·秘密" : ""}）
                  {e.note && <span className="hint"> {e.note}</span>}
                </li>
              ))}
            </ul>
          )}
          <h4>共同出现的单元</h4>
          {confluence.units.length === 0 ? (
            <p className="hint">（还没有单元同时提到其中两个人——现扫单元正文的人名，零结构）</p>
          ) : (
            <ul className="rel-side-edges">
              {confluence.units.map((u) => (
                <li key={u.name}>
                  {u.name}
                  <span className="hint">（提到：{u.persons.join("、")}）</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {edgeDialog && view && (
        <RelationshipDialog
          legend={view.legend}
          persons={personNames}
          initial={edgeDialog.initial}
          defaultFrom={selected[0]}
          defaultTo={selected[1]}
          onSubmit={upsertEdge}
          onDelete={edgeDialog.index === null ? undefined : () => removeEdge(edgeDialog.index!)}
          onClose={() => setEdgeDialog(null)}
        />
      )}

      {legendOpen && view && (
        <RelationshipLegendDialog
          legend={view.legend}
          onSave={saveLegend}
          onClose={() => setLegendOpen(false)}
        />
      )}

      {promoteOpen && (
        <PromoteDialog
          names={selected}
          project={project}
          onClose={() => setPromoteOpen(false)}
          onDone={() => {
            setPromoteOpen(false);
            onChanged();
            onPromoted();
          }}
        />
      )}

      {editing && (
        <NoteDialog
          key={editing.path}
          project={project}
          initial={editing}
          prevPath={editing.path}
          vocab={null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
            void load();
          }}
          onDeleted={() => {
            setEditing(null);
            onChanged();
            void load();
          }}
        />
      )}
    </div>
  );
}

interface PromoteDialogProps {
  names: string[];
  project: string;
  onClose: () => void;
  onDone: () => void;
}

/** 选中数人「提为矛盾」（工单 #8 §6.1）：只预填人名与边，不生成剧情内容。 */
function PromoteDialog({ names, project, onClose, onDone }: PromoteDialogProps) {
  const [name, setName] = useState(names.join("·"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("promote_characters", { project, names, name });
      onDone();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <h2>提为矛盾</h2>
        <p className="hint">
          选中：{names.join("、")}
        </p>
        <label>
          矛盾名（标题＝文件名）
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="hint">
          会新建 构思/矛盾/&lt;名字&gt;.md，正文只给一行「涉及人物」＋他们之间的边（带类型与秘密标记），
          状态「池中」。不写展开、不猜剧情——那是你自己的活。同名矛盾会报错，不自动续号。
        </p>
        {error && <div className="error-box">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? "正在建…" : "建矛盾草稿"}
          </button>
        </div>
      </div>
    </div>
  );
}
