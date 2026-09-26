import { useState } from "react";

/** 首页可选入口；开关是应用展示偏好，不写入世界观内容。 */
export default function PowerSystemHome({ project, onOpen }: {
  project: string;
  onOpen: () => void;
}) {
  const key = `gongbi.power-system-entry.${project}`;
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem(key) !== "hidden"; } catch { return true; }
  });

  function changeVisible(next: boolean) {
    setVisible(next);
    try { localStorage.setItem(key, next ? "visible" : "hidden"); } catch { /* 本次仍可开关。 */ }
  }

  return (
    <div className="note-pane">
      <details>
        <summary>首页可选入口</summary>
        <label className="check-label">
          <input type="checkbox" checked={visible} onChange={(event) => changeVisible(event.target.checked)} />
          显示力量体系入口
        </label>
      </details>
      {visible && (
        <div className="hint-box">
          <h3>力量体系／修炼体系</h3>
          <p>这套力量靠什么让读者期待下一阶段？可用自由正文，也可从可删的思考提示开始。</p>
          <div className="page-actions">
            <button className="btn" onClick={onOpen}>查看力量体系</button>
            <button className="link-like" onClick={() => changeVisible(false)}>关闭入口</button>
          </div>
        </div>
      )}
    </div>
  );
}
