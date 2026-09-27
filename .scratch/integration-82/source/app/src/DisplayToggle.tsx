import type { DisplayMode } from "./displayMode";

/** 展示模式切换（工单 #22，spec 书库新建与展示 §四）：两档——
 *  封面网格（默认）｜书名列表（现有表格）。 */
export default function DisplayToggle({
  mode,
  onChange,
}: {
  mode: DisplayMode;
  onChange: (mode: DisplayMode) => void;
}) {
  const item = (value: DisplayMode, label: string) => (
    <button
      type="button"
      className={mode === value ? "active" : ""}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="display-toggle" role="group" aria-label="展示模式">
      {item("grid", "封面网格")}
      {item("list", "书名列表")}
    </div>
  );
}
