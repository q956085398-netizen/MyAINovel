import { useState } from "react";
import type { Expectation } from "./types";
import { expectationKindLabel } from "./types";
import {
  EXPECTATION_HORIZONS,
  EXPECTATION_PAYOFF_FINAL,
  EXPECTATION_PAYOFF_KINDS,
  EXPECTATION_STATE_DONE,
  EXPECTATION_STATE_DROPPED,
} from "./types";

const HORIZON_LABELS: Record<string, string> = {
  短: "短（几章内，约一个桥段）",
  中: "中（一个单元内，约 20 章）",
  长: "长（跨多个单元，全书主线）",
};

const HORIZON_OPTIONS = EXPECTATION_HORIZONS.map((value) => ({
  value,
  label: HORIZON_LABELS[value],
}));

/** 名字＋类别＋档位弹窗（看板新建待埋 / 从正文记为期待线共用）。
 *  v2（工单 #36）：类别不再弹窗里选——入口已一步定类别（期待感/目标页签、
 *  右键「记为期待感/记为目标」），传 fixedKind 锁死，弹窗只填名字＋档位。 */
export function ExpectationFormDialog({
  title,
  hint,
  initial,
  fixedKind,
  initialHorizon,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  hint?: string;
  initial: string;
  /** 类别（期待｜目标）：随入口固定，弹窗内不再可改。 */
  fixedKind: string;
  initialHorizon: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, kind: string, horizon: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [horizon, setHorizon] = useState(initialHorizon);
  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog">
        <h2>{title}</h2>
        <label>
          线名
          <input
            value={name}
            autoFocus
            placeholder="如：主角何时亮出金手指"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onSubmit(name.trim(), fixedKind, horizon);
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        <label>
          档位
          <select value={horizon} onChange={(e) => setHorizon(e.target.value)}>
            {HORIZON_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {hint && <p className="hint">{hint}</p>}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => onSubmit(name.trim(), fixedKind, horizon)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 兑现期待线弹窗：选中正文后，挑一条线、填阶段/终结与说明。 */
export function ExpectationFulfillDialog({
  quote,
  expectations,
  busy,
  onCancel,
  onSubmit,
}: {
  quote: string;
  expectations: Expectation[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, kind: string, note: string) => void;
}) {
  // 已兑现/弃用的排后面，默认选第一条还能兑现的。
  const sorted = [...expectations].sort((a, b) => {
    const rank = (e: Expectation) =>
      e.state === EXPECTATION_STATE_DONE || e.state === EXPECTATION_STATE_DROPPED ? 1 : 0;
    return rank(a) - rank(b) || a.name.localeCompare(b.name, "zh");
  });
  const [name, setName] = useState(sorted[0]?.name ?? "");
  const [kind, setKind] = useState<string>(EXPECTATION_PAYOFF_KINDS[0]);
  const [note, setNote] = useState("");

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog">
        <h2>兑现期待线</h2>
        <p className="foreshadow-quote block">「{quote}」</p>
        {sorted.length === 0 ? (
          <p className="hint">
            这本书还没有期待线。先在正文里选中文字右键「记为期待感」或「记为目标」。
          </p>
        ) : (
          <>
            <label>
              兑现哪条线
              <select value={name} onChange={(e) => setName(e.target.value)}>
                {sorted.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}（{expectationKindLabel(e.kind)}·{e.horizon}·{e.state}）
                  </option>
                ))}
              </select>
            </label>
            <label>
              兑现类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {EXPECTATION_PAYOFF_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                    {k === EXPECTATION_PAYOFF_FINAL
                      ? "（收干净，状态→已兑现）"
                      : "（收一半，状态→部分兑现）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              说明（可留空）
              <input
                value={note}
                placeholder="如：只露了金手指的一角"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </>
        )}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || !name}
            onClick={() => onSubmit(name, kind, note)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
