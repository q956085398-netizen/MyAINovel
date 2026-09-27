import { useState } from "react";
import type { Foreshadow } from "./types";
import {
  FORESHADOW_RECOVERY_FINAL,
  FORESHADOW_RECOVERY_KINDS,
  FORESHADOW_STATE_DONE,
  FORESHADOW_STATE_DROPPED,
} from "./types";

/** 单输入框弹窗（新建待埋 / 从正文标注共用）。 */
export function ForeshadowNameDialog({
  title,
  label,
  hint,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  label: string;
  hint?: string;
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
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
          {label}
          <input
            value={name}
            autoFocus
            placeholder="如：黄铜钥匙的下落"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onSubmit(name.trim());
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        {hint && <p className="hint">{hint}</p>}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => onSubmit(name.trim())}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 回收伏笔弹窗：选中正文后，挑一条伏笔、填阶段/终结与说明。 */
export function ForeshadowCollectDialog({
  quote,
  foreshadows,
  busy,
  onCancel,
  onSubmit,
}: {
  quote: string;
  foreshadows: Foreshadow[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, kind: string, note: string) => void;
}) {
  // 已收/弃用的排后面，默认选第一条还能收的。
  const sorted = [...foreshadows].sort((a, b) => {
    const rank = (f: Foreshadow) =>
      f.state === FORESHADOW_STATE_DONE || f.state === FORESHADOW_STATE_DROPPED ? 1 : 0;
    return rank(a) - rank(b) || a.name.localeCompare(b.name, "zh");
  });
  const [name, setName] = useState(sorted[0]?.name ?? "");
  const [kind, setKind] = useState<string>(FORESHADOW_RECOVERY_KINDS[0]);
  const [note, setNote] = useState("");

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog">
        <h2>回收伏笔</h2>
        <p className="foreshadow-quote block">「{quote}」</p>
        {sorted.length === 0 ? (
          <p className="hint">这本书还没有伏笔。先在正文里选中文字右键「设为伏笔」。</p>
        ) : (
          <>
            <label>
              回收哪条伏笔
              <select value={name} onChange={(e) => setName(e.target.value)}>
                {sorted.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}（{f.state}）
                  </option>
                ))}
              </select>
            </label>
            <label>
              回收类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {FORESHADOW_RECOVERY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                    {k === FORESHADOW_RECOVERY_FINAL
                      ? "（收干净，状态→已收）"
                      : "（收一半，状态→部分收）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              说明（可留空）
              <input
                value={note}
                placeholder="如：揭晓了钥匙的来历"
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
