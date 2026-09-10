import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ArrangementCheck, ArrangementItem, PlotLine } from "./types";
import { PACE_VALUES, UPGRADE_BATTLE_VALUES } from "./types";
import { errMsg } from "./util";
import VocabInput from "./VocabInput";

/** 未定义颜色的情节线按首见顺序从这里取色（spec「排布视图的行定义」）。 */
const AUTO_COLORS = [
  "#c0392b",
  "#2e7d32",
  "#1565c0",
  "#6a1b9a",
  "#ef6c00",
  "#00838f",
  "#4e342e",
  "#ad1457",
];

function lineColors(plotLines: PlotLine[], items: ArrangementItem[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const line of plotLines) {
    if (line.name && line.color) colors.set(line.name, line.color);
  }
  let next = 0;
  const assign = (name: string) => {
    if (name && !colors.has(name)) {
      colors.set(name, AUTO_COLORS[next % AUTO_COLORS.length]);
      next += 1;
    }
  };
  for (const item of items) assign(item.line?.trim() ?? "");
  for (const line of plotLines) assign(line.name);
  return colors;
}

interface ArrangementViewProps {
  project: string;
  /** 项目里已有的单元名（按名引用；失效只提示不自动改）。 */
  unitNames: string[];
  /** 项目.yaml 的情节线定义（名＋色；未给色的自动补）。 */
  plotLines: PlotLine[];
  /** 项目.yaml 的「地图」＋世界观「地理」词条名。 */
  mapNames: string[];
  initial: ArrangementItem[];
  onSaved: () => void;
  /** 板块 AI 命令「排布体检」：材料由后端组装，只出报告不改文件（工单 #15）。 */
  onAiCommand?: () => void;
}

/** 排布（俗称大纲）：有序列表即全书次序；每项引用一个单元，属性只放
 *  排布时才定的四样（线/地图/升级战斗/节奏）。体检是派生视图，只提示不拦截。 */
export default function ArrangementView({
  project,
  unitNames,
  plotLines,
  mapNames,
  initial,
  onSaved,
  onAiCommand,
}: ArrangementViewProps) {
  const [items, setItems] = useState<ArrangementItem[]>(initial);
  const [check, setCheck] = useState<ArrangementCheck | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newUnit, setNewUnit] = useState("");

  // 父组件重读盘上排布（切页/刷新）后，用新列表重置本地状态；
  // 同一引用重复传入不会触发（setState 按 Object.is 跳过）。
  useEffect(() => {
    setItems(initial);
    setDirty(false);
  }, [initial]);

  const unarranged = unitNames.filter((n) => !items.some((i) => i.unit === n));
  const colors = lineColors(plotLines, items);

  const runCheck = useCallback(async () => {
    try {
      setCheck(await invoke<ArrangementCheck>("check_arrangement", { project, items }));
      setError(null);
    } catch (e) {
      setCheck(null);
      setError(`体检失败：${errMsg(e)}`);
    }
  }, [project, items]);

  // 体检读盘＋现算，改动后略等再跑，避免每敲一个字打一次 IPC。
  useEffect(() => {
    const timer = window.setTimeout(() => void runCheck(), 250);
    return () => window.clearTimeout(timer);
  }, [runCheck]);

  function update(index: number, patch: Partial<ArrangementItem>) {
    setItems((list) => list.map((it, i) => (i === index ? { ...it, ...patch } : it)));
    setDirty(true);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    setItems((list) => {
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  }

  function removeAt(index: number) {
    setItems((list) => list.filter((_, i) => i !== index));
    setDirty(true);
  }

  function add() {
    const unit = newUnit.trim();
    if (!unit) return;
    setItems((list) => [
      ...list,
      { unit, line: null, map: null, upgradeBattle: null, pace: null },
    ]);
    setNewUnit("");
    setDirty(true);
  }

  async function save(): Promise<boolean> {
    if (saving) return false;
    const empty = items.findIndex((i) => !i.unit.trim());
    if (empty >= 0) {
      window.alert(`第 ${empty + 1} 项还没选单元——每项都要按名引用一个单元。`);
      return false;
    }
    setSaving(true);
    try {
      await invoke("save_arrangement", { project, items });
      setDirty(false);
      onSaved();
      return true;
    } catch (e) {
      window.alert(`排布保存失败：${errMsg(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** AI 体检读盘上排布：有未保存的改动先落盘，存不下就不跑（材料别是旧稿）。 */
  async function runAiCheck() {
    if (!onAiCommand) return;
    if (dirty && !(await save())) return;
    onAiCommand();
  }

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>排布</h2>
          <p className="hint">
            有序列表即全书次序：每项按名引用一个单元；线/地图/升级战斗/节奏在排布时才定
            （升级:战斗按 2:1 体检，节奏看张弛交替——只提示不拦截）。
          </p>
        </div>
        <div className="page-actions">
          {onAiCommand && (
            <button
              className="btn"
              disabled={saving}
              title="AI 读类型圈与排布给节奏建议（只出报告，不改 排布.yaml；有改动先保存）"
              onClick={() => void runAiCheck()}
            >
              AI 排布体检
            </button>
          )}
          <button className="btn primary" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? "保存中…" : dirty ? "保存排布" : "已保存"}
          </button>
        </div>
      </div>

      <div className="arrange-add">
        <select value={newUnit} onChange={(e) => setNewUnit(e.target.value)}>
          <option value="">选择单元…</option>
          {unarranged.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!newUnit} onClick={add}>
          加到末尾
        </button>
        <span className="hint">
          {unitNames.length === 0
            ? "还没有单元——先去「单元」页把矛盾展开成单元。"
            : unarranged.length === 0
              ? "所有单元都已排布。"
              : `还有 ${unarranged.length} 个单元没排：${unarranged.join("、")}`}
        </span>
      </div>

      {error && <div className="error-box">{error}</div>}

      {items.length === 0 ? (
        <div className="empty-state">
          <p>排布还是空的。</p>
          <p className="hint">从上面选一个单元加到末尾，或直接在 Obsidian 里编辑 构思/排布.yaml。</p>
        </div>
      ) : (
        <table className="arrange-table">
          <thead>
            <tr>
              <th>#</th>
              <th>单元</th>
              <th>线</th>
              <th>地图</th>
              <th>升级战斗</th>
              <th>节奏</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const missing = !unitNames.includes(item.unit);
              const color = item.line ? colors.get(item.line.trim()) : undefined;
              return (
                <tr key={i} className={missing ? "row-warn" : ""}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <VocabInput
                      value={item.unit}
                      onChange={(v) => update(i, { unit: v })}
                      words={unitNames}
                      placeholder="单元名"
                    />
                    {missing && <span className="cell-warn">单元不存在</span>}
                  </td>
                  <td>
                    <div className="line-cell">
                      <span
                        className="line-dot"
                        title={item.line ? `情节线「${item.line}」` : "未定情节线"}
                        style={{ background: color ?? "transparent" }}
                      />
                      <VocabInput
                        value={item.line ?? ""}
                        onChange={(v) => update(i, { line: v || null })}
                        words={plotLines.map((l) => l.name)}
                        placeholder="主线"
                      />
                    </div>
                  </td>
                  <td>
                    <VocabInput
                      value={item.map ?? ""}
                      onChange={(v) => update(i, { map: v || null })}
                      words={mapNames}
                      placeholder="京城"
                    />
                  </td>
                  <td>
                    <VocabInput
                      value={item.upgradeBattle ?? ""}
                      onChange={(v) => update(i, { upgradeBattle: v || null })}
                      words={UPGRADE_BATTLE_VALUES}
                      placeholder="升级 / 战斗"
                    />
                  </td>
                  <td>
                    <VocabInput
                      value={item.pace ?? ""}
                      onChange={(v) => update(i, { pace: v || null })}
                      words={PACE_VALUES}
                      placeholder="紧绷 / 舒缓"
                    />
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn small"
                      title="上移"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="btn small"
                      title="下移"
                      disabled={i === items.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button className="btn small" title="移出排布" onClick={() => removeAt(i)}>
                      移除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {check && (
        <div className="check-panel">
          <h3>体检（只提示）</h3>
          <p>{check.ratioHint}</p>
          {check.paceHints.map((h) => (
            <p key={h} className="hint">
              {h}
            </p>
          ))}
          {check.refHints.map((h) => (
            <p key={h} className="hint">
              {h}
            </p>
          ))}
          {check.missingUnits.length > 0 && (
            <p className="hint">排布引用了不存在的单元：{check.missingUnits.join("、")}</p>
          )}
          {check.unarrangedUnits.length > 0 && (
            <p className="hint">还没排布的单元：{check.unarrangedUnits.join("、")}</p>
          )}
          {check.mapCounts.length > 0 && (
            <p className="hint">
              地图分布：
              {check.mapCounts.map((m) => `${m.map} ${m.count}`).join(" · ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
