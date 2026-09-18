import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Bridge, BridgeDraft, NoteEntry } from "./types";
import { emptyBridgeDraft } from "./types";
import { errMsg } from "./util";
import MarkdownEditor from "./MarkdownEditor";

type Filter = "待安排" | "全部" | "已安排";

interface BridgeLibraryProps {
  project: string;
  units: NoteEntry[];
  onChanged: () => void;
}

/** 桥段草案的停靠处：安排前后仍是一张卡、一份文件。 */
export default function BridgeLibrary({ project, units, onChanged }: BridgeLibraryProps) {
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
  );

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

function BridgeCard({
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
  onEdit: () => void;
  onArrange: (unit: string) => void;
  onUnarrange: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const [targetUnit, setTargetUnit] = useState("");
  const siblings = bridge.unit
    ? allBridges.filter((item) => item.unit === bridge.unit).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
    : [];
  const index = siblings.findIndex((item) => item.path === bridge.path);
  const warnings = rangeWarnings(bridge, allBridges, units, siblings, index);

  return (
    <article className="bridge-card">
      <div className="bridge-card-head">
        <div>
          <span className="memo-mark">桥段</span>
          <h3>{bridge.name}</h3>
        </div>
        {bridge.unit ? <span className="tag">{bridge.unit} · 第 {bridge.order ?? "？"} 段</span> : <span className="pending-mark">待安排</span>}
      </div>
      {(bridge.body || bridge.emotionCurve || bridge.keyTurn) && (
        <p className="bridge-summary">{bridge.body || bridge.emotionCurve || bridge.keyTurn}</p>
      )}
      <div className="bridge-meta">
        {bridge.emotionCurve && <span>情绪：{bridge.emotionCurve}</span>}
        {bridge.keyTurn && <span>转折：{bridge.keyTurn}</span>}
        {bridge.expectationHook && <span>钩子：{bridge.expectationHook}</span>}
      </div>
      {(bridge.startChapter || bridge.endChapter) && <p className="hint">章节区间：{bridge.startChapter ?? "？"} ~ {bridge.endChapter ?? "？"}</p>}
      {warnings.map((warning) => <p className="soft-warning" key={warning}>{warning}</p>)}
      <div className="bridge-actions">
        <button className="btn small" onClick={onEdit}>编辑</button>
        {bridge.unit ? (
          <>
            <button className="btn small" disabled={index <= 0} onClick={() => onMove(-1)}>上移</button>
            <button className="btn small" disabled={index < 0 || index >= siblings.length - 1} onClick={() => onMove(1)}>下移</button>
            <button className="text-danger" onClick={onUnarrange}>取消安排</button>
          </>
        ) : units.length > 0 ? (
          <span className="bridge-arrange">
            <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value)} aria-label={`安排「${bridge.name}」到单元`}>
              <option value="">选择既有单元…</option>
              {units.map((unit) => <option key={unit.path} value={unit.name}>{unit.name}</option>)}
            </select>
            <button className="btn small" disabled={!targetUnit} onClick={() => onArrange(targetUnit)}>安排进单元</button>
          </span>
        ) : (
          <span className="hint">还没有单元；先在「单元」里展开一个矛盾。</span>
        )}
      </div>
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

function BridgeDialog({
  project,
  initial,
  prevPath,
  onClose,
  onSaved,
}: {
  project: string;
  initial: BridgeDraft;
  prevPath: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<BridgeDraft>({ ...initial });
  const [busy, setBusy] = useState(false);
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
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide bridge-dialog">
        <h2>{prevPath ? "编辑桥段" : "新建桥段草案"}</h2>
        <label>桥段名<input autoFocus value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="如：夜探旧宅" /></label>
        <label>情绪曲线<input value={draft.emotionCurve ?? ""} onChange={(e) => set("emotionCurve", e.target.value || null)} placeholder="如：压抑 → 犹疑 → 痛快" /></label>
        <label>关键转折<input value={draft.keyTurn ?? ""} onChange={(e) => set("keyTurn", e.target.value || null)} placeholder="如：众目睽睽下拿出洗冤证据" /></label>
        <label>期待钩子<input value={draft.expectationHook ?? ""} onChange={(e) => set("expectationHook", e.target.value || null)} /></label>
        <label>章节拍安排<textarea rows={2} value={draft.beatPlan ?? ""} onChange={(e) => set("beatPlan", e.target.value || null)} placeholder="如：第5章代入＋信息差；第6章拉扯" /></label>
        <label>章节区间（可晚补）<span className="range-inputs"><input value={draft.startChapter ?? ""} onChange={(e) => set("startChapter", number(e.target.value))} placeholder="起章" inputMode="numeric" /><span className="range-sep">~</span><input value={draft.endChapter ?? ""} onChange={(e) => set("endChapter", number(e.target.value))} placeholder="止章" inputMode="numeric" /></span></label>
        {draft.startChapter && draft.endChapter && draft.startChapter > draft.endChapter && <p className="soft-warning">章节区间倒置：会保存为提示，不会阻止写作。</p>}
        <label>自由备注、片段和待解决问题<MarkdownEditor value={draft.body} onChange={(body) => set("body", body)} height="220px" /></label>
        <p className="hint">所属单元和次序由「安排进单元」操作维护；这里的提示均可留空。</p>
        <div className="dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存桥段"}</button></div>
      </div>
    </div>
  );
}
