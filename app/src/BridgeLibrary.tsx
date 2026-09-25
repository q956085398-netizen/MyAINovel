import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Bridge, BridgeDraft, NoteEntry, Vocabulary } from "./types";
import { emptyBridgeDraft } from "./types";
import { errMsg } from "./util";
import MarkdownEditor from "./MarkdownEditor";
import VocabInput from "./VocabInput";
import { CONTENT_SURFACE_STORAGE_KEY, readCollapsedCardPaths, serializeCollapsedCardPaths } from "./contentSurfaceState";

type Filter = "待安排" | "全部" | "已安排";

interface BridgeLibraryProps {
  project: string;
  units: NoteEntry[];
  unitOrder: string[];
  vocab: Vocabulary | null;
  onChanged: () => void;
}

/** 桥段草案的停靠处：安排前后仍是一张卡、一份文件。 */
export default function BridgeLibrary({ project, units, unitOrder, vocab, onChanged }: BridgeLibraryProps) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [filter, setFilter] = useState<Filter>("待安排");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: BridgeDraft; prevPath: string | null } | null>(null);

  async function load() {
    try {
      setBridges(await invoke<Bridge[]>("scan_bridges", { project }));
      setError(null);
    } catch (e) {
      setError(`读取桥段库失败：${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [project]);

  const unarrangedCount = bridges.filter((bridge) => !bridge.unit).length;
  const shown = bridges.filter((bridge) =>
    filter === "全部" ? true : filter === "待安排" ? !bridge.unit : Boolean(bridge.unit),
  ).sort((left, right) => {
    if (!left.unit || !right.unit) return left.unit === right.unit ? 0 : left.unit ? 1 : -1;
    const leftRank = unitOrder.indexOf(left.unit);
    const rightRank = unitOrder.indexOf(right.unit);
    const byUnit = leftRank < 0 && rightRank < 0
      ? left.unit.localeCompare(right.unit, "zh-Hans-CN")
      : (leftRank < 0 ? Infinity : leftRank) - (rightRank < 0 ? Infinity : rightRank);
    return byUnit || (left.order ?? Infinity) - (right.order ?? Infinity);
  });

  async function arrange(bridge: Bridge, unit: string) {
    if (!unit) return;
    try {
      await invoke<Bridge>("arrange_bridge", { project, path: bridge.path, unit });
      await load();
      onChanged();
    } catch (e) {
      window.alert(`安排桥段失败：${errMsg(e)}`);
    }
  }

  async function unarrange(bridge: Bridge) {
    try {
      await invoke<Bridge>("unarrange_bridge", { project, path: bridge.path });
      await load();
      onChanged();
    } catch (e) {
      window.alert(`取消安排失败：${errMsg(e)}`);
    }
  }

  async function move(bridge: Bridge, direction: -1 | 1) {
    try {
      await invoke<Bridge[]>("move_bridge", { project, path: bridge.path, direction });
      await load();
    } catch (e) {
      window.alert(`调整桥段次序失败：${errMsg(e)}`);
    }
  }

  if (loading) return <p className="hint">正在读取桥段库……</p>;

  return (
    <div className="bridge-library">
      <div className="pane-head">
        <div>
          <h2>桥段库</h2>
          <p className="hint">待安排 {unarrangedCount} 个；桥段安排进单元后仍是同一张卡。</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ draft: emptyBridgeDraft(), prevPath: null })}>
          新建桥段草案
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}

      <div className="bridge-filter" role="tablist" aria-label="桥段筛选">
        {(["待安排", "全部", "已安排"] as const).map((item) => (
          <button
            className={`subtab ${filter === item ? "active" : ""}`}
            key={item}
            onClick={() => setFilter(item)}
          >
            {item}{item === "待安排" ? `（${unarrangedCount}）` : ""}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty-state">
          <p>{filter === "待安排" ? "还没有待安排的桥段草案。" : "这个筛选下还没有桥段。"}</p>
          <p className="hint">先记住人物、事件、情绪或转折；还不知道归属哪个单元也没关系。</p>
        </div>
      ) : (
        <div className="bridge-cards">
          {shown.map((bridge) => (
            <BridgeCard
              key={bridge.path}
              bridge={bridge}
              units={units}
              allBridges={bridges}
              onEdit={() => setEditing({ draft: bridge, prevPath: bridge.path })}
              onArrange={(unit) => void arrange(bridge, unit)}
              onUnarrange={() => void unarrange(bridge)}
              onMove={(direction) => void move(bridge, direction)}
            />
          ))}
        </div>
      )}

      {editing && (
        <BridgeDialog
          project={project}
          initial={editing.draft}
          vocab={vocab}
          prevPath={editing.prevPath}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

export function BridgeCard({
  bridge,
  units,
  allBridges,
  onEdit,
  onArrange,
  onUnarrange,
  onMove,
}: {
  bridge: Bridge;
  units: NoteEntry[];
  allBridges: Bridge[];
  onEdit?: () => void;
  onArrange?: (unit: string) => void;
  onUnarrange?: () => void;
  onMove?: (direction: -1 | 1) => void;
}) {
  const [targetUnit, setTargetUnit] = useState("");
  const [collapsed, setCollapsed] = useState(() => readCollapsedCardPaths(
    window.localStorage.getItem(CONTENT_SURFACE_STORAGE_KEY), "bridges",
  ).has(bridge.path));
  function toggleCollapsed() {
    const paths = readCollapsedCardPaths(window.localStorage.getItem(CONTENT_SURFACE_STORAGE_KEY), "bridges");
    if (collapsed) paths.delete(bridge.path); else paths.add(bridge.path);
    window.localStorage.setItem(CONTENT_SURFACE_STORAGE_KEY, serializeCollapsedCardPaths(
      window.localStorage.getItem(CONTENT_SURFACE_STORAGE_KEY), "bridges", paths,
    ));
    setCollapsed(!collapsed);
  }
  const siblings = bridge.unit
    ? allBridges.filter((item) => item.unit === bridge.unit).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
    : [];
  const index = siblings.findIndex((item) => item.path === bridge.path);
  const warnings = rangeWarnings(bridge, allBridges, units, siblings, index);

  return (
    <article className={`bridge-card ${onEdit ? "is-editable" : ""}`} onClick={(event) => {
      if (!onEdit || (event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
      if (window.getSelection()?.toString()) return;
      onEdit();
    }}>
      <div className="bridge-card-head">
        <div>
          <span className="memo-mark">桥段</span>
          <h3>{bridge.name}</h3>
        </div>
        <div className="bridge-card-controls">
          {bridge.unit ? <span className="tag">{bridge.unit} · 第 {bridge.order ?? "？"} 段</span> : <span className="pending-mark">待安排</span>}
          <button className="btn small" aria-expanded={!collapsed} onClick={toggleCollapsed}>{collapsed ? "展开" : "收起"}</button>
        </div>
      </div>
      {!collapsed && <>
      {bridge.typeSolutions.length > 0 && <div className="bridge-pairs">
        {bridge.typeSolutions.map((pair, pairIndex) => <p key={pairIndex}>
          {pair.typeName && <span>类型 {pair.typeName}</span>}
          {pair.typeName && pair.solution && <span aria-hidden="true">→</span>}
          {pair.solution && <span>解法 {pair.solution}</span>}
        </p>)}
      </div>}
      <div className="bridge-fields">
        {bridge.emotionCurve && <p>情绪曲线：{bridge.emotionCurve}</p>}
        {bridge.keyTurn && <p>关键转折：{bridge.keyTurn}</p>}
        {bridge.expectationHook && <p>期待钩子：{bridge.expectationHook}</p>}
        {bridge.beatPlan && <p>章节拍安排：{bridge.beatPlan}</p>}
        {bridge.priorDesire && <p>前置欲望或理由：{bridge.priorDesire}</p>}
        {bridge.progressionTrigger && <p>递进触发：{bridge.progressionTrigger}</p>}
        {bridge.payoffImage && <p>兑现画面：{bridge.payoffImage}</p>}
      </div>
      {bridge.body && <div className="bridge-body">{bridge.body}</div>}
      {(bridge.startChapter || bridge.endChapter) && <p className="hint">章节区间：{bridge.startChapter ?? "？"} ~ {bridge.endChapter ?? "？"}</p>}
      {warnings.map((warning) => <p className="soft-warning" key={warning}>{warning}</p>)}
      </>}
      {(onEdit || onMove || onUnarrange || onArrange) && <div className="bridge-actions">
        {onEdit && <button className="btn small" onClick={onEdit}>编辑</button>}
        {bridge.unit && onMove && onUnarrange ? (
          <>
            <button className="btn small" disabled={index <= 0} onClick={() => onMove(-1)}>上移</button>
            <button className="btn small" disabled={index < 0 || index >= siblings.length - 1} onClick={() => onMove(1)}>下移</button>
            <button className="text-danger" onClick={onUnarrange}>取消安排</button>
          </>
        ) : !bridge.unit && onArrange && units.length > 0 ? (
          <span className="bridge-arrange">
            <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value)} aria-label={`安排「${bridge.name}」到单元`}>
              <option value="">选择既有单元…</option>
              {units.map((unit) => <option key={unit.path} value={unit.name}>{unit.name}</option>)}
            </select>
            <button className="btn small" disabled={!targetUnit} onClick={() => onArrange(targetUnit)}>安排进单元</button>
          </span>
        ) : !bridge.unit && onArrange ? (
          <span className="hint">还没有单元；先在「单元」里展开一个矛盾。</span>
        ) : null}
      </div>}
    </article>
  );
}

function rangeWarnings(
  bridge: Bridge,
  allBridges: Bridge[],
  units: NoteEntry[],
  siblings: Bridge[],
  index: number,
): string[] {
  const warnings: string[] = [];
  const start = bridge.startChapter;
  const end = bridge.endChapter;
  if (start && end && start > end) warnings.push("章节区间倒置：只作提示，不影响保存或写作。");
  if (bridge.unit && !units.some((item) => item.name === bridge.unit)) {
    warnings.push(`所属单元「${bridge.unit}」已失效；桥段仍保留在桥段库。`);
  }
  if (!bridge.unit || !start || !end || start > end) return warnings;

  const unit = units.find((item) => item.name === bridge.unit);
  if (unit && ((unit.startChapter && start < unit.startChapter) || (unit.endChapter && end > unit.endChapter))) {
    warnings.push("章节区间越出所属单元：只作提示，不会阻止保存。" );
  }
  const overlaps = allBridges.some((other) =>
    other.path !== bridge.path && other.unit === bridge.unit && other.startChapter && other.endChapter
      && other.startChapter <= end && start <= other.endChapter,
  );
  if (overlaps) warnings.push("章节区间与同单元桥段重叠：只作提示，不会阻止保存。");
  const previous = index > 0 ? siblings[index - 1] : null;
  if (previous?.startChapter && start < previous.startChapter) {
    warnings.push("章节区间与桥段次序不一致：只作提示，不会自动重排。");
  }
  return warnings;
}

export function BridgeDialog({
  project,
  initial,
  vocab,
  prevPath,
  onClose,
  onSaved,
}: {
  project: string;
  initial: BridgeDraft;
  vocab: Vocabulary | null;
  prevPath: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<BridgeDraft>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [showPrompts, setShowPrompts] = useState(Boolean(initial.priorDesire || initial.progressionTrigger || initial.payoffImage));
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const set = <K extends keyof BridgeDraft>(key: K, value: BridgeDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const number = (raw: string) => {
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  async function save() {
    if (!draft.name.trim()) {
      window.alert("桥段名不能为空。");
      return;
    }
    setBusy(true);
    try {
      await invoke<Bridge>("save_bridge", { project, draft: { ...draft, name: draft.name.trim() }, prevPath });
      onSaved();
    } catch (e) {
      window.alert(`保存桥段失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay bridge-drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide bridge-dialog">
        <div className="bridge-drawer-head"><h2>{prevPath ? "编辑桥段" : "新建桥段草案"}</h2><button className="btn small" onClick={onClose}>关闭</button></div>
        <label>桥段名<input autoFocus value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="如：夜探旧宅" /></label>
        <fieldset className="bridge-pair-editor">
          <legend>类型 → 解法 <span className="hint">可留空；词表只提供提示</span></legend>
          {draft.typeSolutions.map((pair, index) => <div className="bridge-pair-row" key={index}>
            <label>类型<VocabInput value={pair.typeName} words={vocab?.types ?? []} placeholder="读者期待" onChange={(typeName) => set("typeSolutions", draft.typeSolutions.map((item, i) => i === index ? { ...item, typeName } : item))} /></label>
            <label>解法<VocabInput value={pair.solution} words={vocab?.solutions ?? []} placeholder="具体写法" onChange={(solution) => set("typeSolutions", draft.typeSolutions.map((item, i) => i === index ? { ...item, solution } : item))} /></label>
            <div className="bridge-pair-actions">
              <button className="btn small" type="button" disabled={index === 0} onClick={() => set("typeSolutions", draft.typeSolutions.map((item, i) => i === index - 1 ? pair : i === index ? draft.typeSolutions[index - 1] : item))}>上移</button>
              <button className="btn small" type="button" disabled={index === draft.typeSolutions.length - 1} onClick={() => set("typeSolutions", draft.typeSolutions.map((item, i) => i === index + 1 ? pair : i === index ? draft.typeSolutions[index + 1] : item))}>下移</button>
            <button className="btn small" type="button" onClick={() => set("typeSolutions", draft.typeSolutions.filter((_, i) => i !== index))}>删除这组</button>
            </div>
          </div>)}
          <button className="btn small" type="button" onClick={() => set("typeSolutions", [...draft.typeSolutions, { typeName: "", solution: "" }])}>＋ 添加类型—解法</button>
        </fieldset>
        <label>情绪曲线<input value={draft.emotionCurve ?? ""} onChange={(e) => set("emotionCurve", e.target.value || null)} placeholder="如：压抑 → 犹疑 → 痛快" /></label>
        <label>关键转折<input value={draft.keyTurn ?? ""} onChange={(e) => set("keyTurn", e.target.value || null)} placeholder="如：众目睽睽下拿出洗冤证据" /></label>
        <label>期待钩子<input value={draft.expectationHook ?? ""} onChange={(e) => set("expectationHook", e.target.value || null)} /></label>
        <label>章节拍安排<textarea rows={2} value={draft.beatPlan ?? ""} onChange={(e) => set("beatPlan", e.target.value || null)} placeholder="如：第5章代入＋信息差；第6章拉扯" /></label>
        <div className="bridge-prompt-toggle"><button className="btn small" type="button" onClick={() => setShowPrompts((value) => !value)}>{showPrompts ? "收起构思提示" : "展开可选构思提示"}</button><span className="hint">这些提示不检查缺项，可随时删除。</span></div>
        {showPrompts && <div className="bridge-prompt-fields">
          <label>前置欲望或理由<input value={draft.priorDesire ?? ""} onChange={(e) => set("priorDesire", e.target.value || null)} /></label>
          <label>递进触发<input value={draft.progressionTrigger ?? ""} onChange={(e) => set("progressionTrigger", e.target.value || null)} /></label>
          <label>兑现画面<input value={draft.payoffImage ?? ""} onChange={(e) => set("payoffImage", e.target.value || null)} /></label>
          <button className="btn small" type="button" onClick={() => { setDraft((current) => ({ ...current, priorDesire: null, progressionTrigger: null, payoffImage: null })); setShowPrompts(false); }}>删除这些提示内容</button>
        </div>}
        <label>章节区间（可晚补）<span className="range-inputs"><input value={draft.startChapter ?? ""} onChange={(e) => set("startChapter", number(e.target.value))} placeholder="起章" inputMode="numeric" /><span className="range-sep">~</span><input value={draft.endChapter ?? ""} onChange={(e) => set("endChapter", number(e.target.value))} placeholder="止章" inputMode="numeric" /></span></label>
        {draft.startChapter && draft.endChapter && draft.startChapter > draft.endChapter && <p className="soft-warning">章节区间倒置：会保存为提示，不会阻止写作。</p>}
        <label>自由备注、片段和待解决问题<MarkdownEditor value={draft.body} onChange={(body) => set("body", body)} height="220px" /></label>
        <p className="hint">所属单元和次序由「安排进单元」操作维护；这里的提示均可留空。</p>
        <div className="dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存桥段"}</button></div>
      </div>
    </div>
  );
}
