import { useState } from "react";
import type { LegendItem, Relationship } from "./types";
import { errMsg } from "./util";

interface RelationshipDialogProps {
  legend: LegendItem[];
  /** 人物名单（人名）——两端都从这里选。 */
  persons: string[];
  /** 编辑既有边时的初值；null＝新连一条。 */
  initial: Relationship | null;
  /** 新连一条时预选的两端（画布上选中的节点，没选就取名单头两个）。 */
  defaultFrom?: string;
  defaultTo?: string;
  onSubmit: (edge: Relationship) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

/** 连一条关系（工单 #8 §四）：起/止选人、选图例里的类型、可选描述与秘密。
 *  无向边的「止」仍要写——文件里一条记录就是一条边，画布按图例方向画线。 */
export default function RelationshipDialog({
  legend,
  persons,
  initial,
  defaultFrom,
  defaultTo,
  onSubmit,
  onDelete,
  onClose,
}: RelationshipDialogProps) {
  const [from, setFrom] = useState(initial?.from ?? defaultFrom ?? persons[0] ?? "");
  const [to, setTo] = useState(initial?.to ?? defaultTo ?? persons[1] ?? persons[0] ?? "");
  const [kind, setKind] = useState(initial?.kind ?? legend[0]?.name ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [secret, setSecret] = useState(initial?.secret ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ sourceRow: initial?.sourceRow, from, to, kind, note: note.trim() || null, secret });
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
        <h2>{initial ? "改这条关系" : "连一条关系"}</h2>
        <label>
          起
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {persons.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          止
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {persons.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          类型
          {legend.length === 0 ? (
            <span className="hint">图例是空的——先在「图例」里加一个类型。</span>
          ) : (
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {legend.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                  {l.directed ? "（有向）" : "（无向）"}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          描述（可选）
          <textarea
            rows={2}
            value={note}
            placeholder="这段关系是怎么回事……"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="check-line">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
          秘密（这段关系里有还没解开的秘密，画布上画虚线加问号）
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="dialog-actions">
          {onDelete && (
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => {
                void onDelete().catch((e) => setError(errMsg(e)));
              }}
            >
              删掉这条
            </button>
          )}
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy || !from || !to || !kind}
            onClick={() => void submit()}
          >
            {busy ? "正在保存…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
