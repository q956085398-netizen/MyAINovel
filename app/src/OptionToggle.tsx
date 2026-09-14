/** 单选切换条（工单 #33）：设置面板「排版」小节与编辑器排版工具栏共用，
 *  同一组选项不在两处各写一遍；样式沿用 display-toggle。 */
export default function OptionToggle<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  /** 无障碍分组名。 */
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <span className="display-toggle" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
