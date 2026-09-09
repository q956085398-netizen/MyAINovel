import { useState } from "react";
import type { Expectation } from "./types";
import {
  EXPECTATION_HORIZONS,
  EXPECTATION_KINDS,
  EXPECTATION_KIND_EXPECT,
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

/** 名字＋类别＋档位弹窗（看板新建待埋 / 从正文记为三线共用）。 */
export function ExpectationFormDialog({
  title,
  hint,
  initial,
  initialKind,
  initialHorizon,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  hint?: string;
  initial: string;
  initialKind: string;
  initialHorizon: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, kind: string, horizon: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [kind, setKind] = useState(initialKind);
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
              if (e.key === "Enter" && name.trim()) onSubmit(name.trim(), kind, horizon);
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        <label>
          类别
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {EXPECTATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
                {k === EXPECTATION_KIND_EXPECT
                  ? "（读者想知道结果）"
                  : "（主角下一步去哪里）"}
              </option>
            ))}
          </select>
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
            onClick={() => onSubmit(name.trim(), kind, horizon)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 兑现三线弹窗：选中正文后，挑一条线、填阶段/终结与说明。 */
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
        <h2>兑现三线</h2>
        <p className="foreshadow-quote block">「{quote}」</p>
        {sorted.length === 0 ? (
          <p className="hint">这本书还没有三线。先在正文里选中文字右键「记为三线」。</p>
        ) : (
          <>
            <label>
              兑现哪条线
              <select value={name} onChange={(e) => setName(e.target.value)}>
                {sorted.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}（{e.kind}·{e.horizon}·{e.state}）
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
