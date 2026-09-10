import { useState } from "react";
import type { LegendItem } from "./types";
import { emptyLegendItem } from "./types";
import { errMsg, moveItem } from "./util";

interface RelationshipLegendDialogProps {
  legend: LegendItem[];
  /** 保存整份图例（顺序即列表顺序）；返回后由上层重读画布。 */
  onSave: (legend: LegendItem[]) => Promise<void>;
  onClose: () => void;
}

/** 关系图例（工单 #8 §二）：画布级的类型集合——可命名、有序、可绑定方向。
 *  顺序即列表顺序（上下移调序）；色留空时保存按位置补色。 */
export default function RelationshipLegendDialog({
  legend,
  onSave,
  onClose,
}: RelationshipLegendDialogProps) {
  const [items, setItems] = useState<LegendItem[]>(legend);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patch(index: number, next: Partial<LegendItem>) {
    setItems((cur) => cur.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(items);
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
      <div className="dialog wide">
        <h2>关系图例</h2>
        <p className="hint">
          边按名引用图例项。删掉一项不会动已有关系——那些边照画兜底样式，只在画布下方提示。
        </p>
        <table className="trope-table legend-table">
          <thead>
            <tr>
              <th>顺序</th>
              <th>名称</th>
              <th>颜色</th>
              <th>方向</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td className="legend-order">
                  <button
                    className="btn small"
                    disabled={i === 0}
                    title="上移"
                    onClick={() => setItems(moveItem(items, i, i - 1))}
                  >
                    ↑
                  </button>
                  <button
                    className="btn small"
                    disabled={i === items.length - 1}
                    title="下移"
                    onClick={() => setItems(moveItem(items, i, i + 1))}
                  >
                    ↓
                  </button>
                </td>
                <td>
                  <input
                    value={item.name}
                    placeholder="师徒、敌对……"
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="color"
                    value={item.color || "#7f8c8d"}
                    onChange={(e) => patch(i, { color: e.target.value })}
                  />
                </td>
                <td>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={item.directed}
                      onChange={(e) => patch(i, { directed: e.target.checked })}
                    />
                    有向
                  </label>
                </td>
                <td>
                  <button
                    className="btn small danger"
                    title="删掉这一项"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}
                  >
                    删
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => setItems([...items, emptyLegendItem(items.length)])}
          >
            加一项
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "正在保存…" : "保存图例"}
          </button>
        </div>
      </div>
    </div>
  );
}
