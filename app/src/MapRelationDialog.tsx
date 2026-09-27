import { useState } from "react";
import type { MapRelation, RegionRelation } from "./types";
import { errMsg } from "./util";

type Relation = MapRelation | RegionRelation;

interface Props {
  title: string;
  names: string[];
  kinds: string[];
  initial: Relation;
  onClose: () => void;
  onSave: (relation: Relation) => Promise<void>;
  onDelete?: () => Promise<void>;
}

/** 地图/地域空间关系共用的轻量编辑框；图例仅提供建议，允许保留自定义类型。 */
export default function MapRelationDialog({
  title,
  names,
  kinds,
  initial,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [kind, setKind] = useState(initial.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    if (!from.trim() || !to.trim() || !kind.trim()) {
      setError("起点、终点和关系类型都要填写。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...initial, from: from.trim(), to: to.trim(), kind: kind.trim() });
    } catch (e) {
      setError(`保存失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!onDelete || busy || !window.confirm(`删除这条空间关系「${from} · ${kind} · ${to}」？`)) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(`删除失败：${errMsg(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="form-row">
          <label>
            起点
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            终点
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </div>
        <label>
          关系类型
          <input list="map-relation-kinds" value={kind} onChange={(e) => setKind(e.target.value)} autoFocus />
          <datalist id="map-relation-kinds">
            {kinds.map((item) => <option key={item} value={item} />)}
          </datalist>
        </label>
        <p className="hint">图例只是提示；可直接输入其他关系类型。</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="dialog-actions">
          {onDelete && <button className="btn danger" disabled={busy} onClick={() => void remove()}>删除关系</button>}
          <button className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || names.length === 0} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  );
}
