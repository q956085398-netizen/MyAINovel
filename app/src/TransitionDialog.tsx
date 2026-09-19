import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MapStructure, MapTransition } from "./types";
import { errMsg, splitList } from "./util";

interface TransitionDialogProps {
  project: string;
  /** 正在编辑的转场；null 为新建。 */
  initial: MapTransition | null;
  /** 编辑时在结构表「转场」里的下标；新建为 null。 */
  index: number | null;
  mapNames: string[];
  /** 当前结构表整份带回：保存＝只改转场数组的读-合-写。 */
  structure: MapStructure;
  onClose: () => void;
  onSaved: () => void;
}

/** 跨地图转场编辑框（工单 #65 / T15）：起止两张地图之间的叙事承接；
 *  地域之间的相邻/通道是「地域连接」，不在这里（spec 地图与地域 §一）。 */
export default function TransitionDialog({
  project,
  initial,
  index,
  mapNames,
  structure,
  onClose,
  onSaved,
}: TransitionDialogProps) {
  const [from, setFrom] = useState(initial?.from ?? mapNames[0] ?? "");
  const [to, setTo] = useState(initial?.to ?? mapNames[1] ?? "");
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [advanceText, setAdvanceText] = useState((initial?.advancePeople ?? []).join("、"));
  const [cluesText, setCluesText] = useState((initial?.clues ?? []).join("、"));
  const [unresolvedText, setUnresolvedText] = useState((initial?.unresolved ?? []).join("、"));
  const [returnCondition, setReturnCondition] = useState(initial?.returnCondition ?? "");
  const [unitsText, setUnitsText] = useState((initial?.units ?? []).join("、"));
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    if (!from || !to) {
      window.alert("转场需要起、止两张地图。");
      return;
    }
    if (from === to) {
      window.alert("转场的起止地图不能相同（同一张地图内部移动是地域连接，不是转场）。");
      return;
    }
    const transition: MapTransition = {
      from,
      to,
      reason: reason.trim() || null,
      advancePeople: splitList(advanceText),
      clues: splitList(cluesText),
      unresolved: splitList(unresolvedText),
      returnCondition: returnCondition.trim() || null,
      units: splitList(unitsText),
      extra: initial?.extra ?? {},
    };
    const transitions = [...structure.transitions];
    if (index === null) {
      transitions.push(transition);
    } else {
      transitions[index] = transition;
    }
    setBusy(true);
    try {
      await invoke("save_map_structure", {
        project,
        table: { ...structure, transitions },
      });
      onSaved();
    } catch (e) {
      window.alert(`转场保存失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (index === null || busy) return;
    if (!window.confirm(`确定删除「${from} → ${to}」这条转场？`)) return;
    const transitions = structure.transitions.filter((_, i) => i !== index);
    setBusy(true);
    try {
      await invoke("save_map_structure", {
        project,
        table: { ...structure, transitions },
      });
      onSaved();
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog">
        <h2>{initial ? "编辑转场" : "新建转场"}</h2>
        <div className="form-row">
          <label>
            起地图
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {mapNames.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            止地图
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {mapNames.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          离开原因（为什么必须走）
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="如：主角必须寻找失踪的师父"
          />
        </label>
        <label>
          先行人物（多个用、隔开）
          <input
            value={advanceText}
            onChange={(e) => setAdvanceText(e.target.value)}
            placeholder="如：师姐"
          />
        </label>
        <label>
          提前线索（多个用、隔开）
          <input
            value={cluesText}
            onChange={(e) => setCluesText(e.target.value)}
            placeholder="如：仙界来客"
          />
        </label>
        <label>
          随行未解问题（多个用、隔开）
          <input
            value={unresolvedText}
            onChange={(e) => setUnresolvedText(e.target.value)}
            placeholder="如：师父失踪"
          />
        </label>
        <label>
          返回条件（读者等着的回头路）
          <input
            value={returnCondition}
            onChange={(e) => setReturnCondition(e.target.value)}
            placeholder="如：找到跨界通道"
          />
        </label>
        <label>
          单元（多个用、隔开）
          <input
            value={unitsText}
            onChange={(e) => setUnitsText(e.target.value)}
            placeholder="转场前后涉及的单元"
          />
        </label>
        <p className="hint">保存写入 构思/地图结构.yaml 的「转场」表（整表读-合-写，未知字段保留）。</p>
        <div className="dialog-actions">
          {initial && (
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>
              删除
            </button>
          )}
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
