import {
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  INDENT_OPTIONS,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_STEP,
  PROSE_ALIGNS,
  useSettings,
  type BodyFont,
  type ProseAlign,
} from "./settings";

const SIZE_CHOICES = Array.from(
  { length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 },
  (_, i) => FONT_SIZE_MIN + i,
);

const LINE_HEIGHT_CHOICES = Array.from(
  { length: Math.round((LINE_HEIGHT_MAX - LINE_HEIGHT_MIN) / LINE_HEIGHT_STEP) + 1 },
  (_, i) => Number((LINE_HEIGHT_MIN + i * LINE_HEIGHT_STEP).toFixed(1)),
);

/** 排版工具栏（工单 #33，spec 个性化设置.md §四）：拆书/书写编辑器顶部的
 *  字体/字号/行距/对齐/首行缩进即时控件，与设置面板「排版」小节同源
 *  （同一 gongbi.settings 键，两处任改一处全局生效）。全部是视图层显示
 *  效果，不改动 md 内容——写进文档的格式只有导出选项「段首缩进」。 */
export default function TypographyToolbar() {
  const [settings, update] = useSettings();
  return (
    <div className="typo-toolbar" role="toolbar" aria-label="排版">
      <label className="typo-field" title="正文字体（宋/黑/楷/跟随系统）">
        字体
        <select
          className="select small"
          value={settings.font}
          onChange={(e) => update({ font: e.target.value as BodyFont })}
        >
          {FONT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="typo-field" title="字号；「默认」＝各编辑器自己的现状">
        字号
        <select
          className="select small"
          value={settings.fontSize ?? ""}
          onChange={(e) =>
            update({ fontSize: e.target.value === "" ? null : Number(e.target.value) })
          }
        >
          <option value="">默认</option>
          {SIZE_CHOICES.map((s) => (
            <option key={s} value={s}>
              {s}px
            </option>
          ))}
        </select>
      </label>
      <label className="typo-field" title="行距；「默认」＝各编辑器自己的现状">
        行距
        <select
          className="select small"
          value={settings.lineHeight ?? ""}
          onChange={(e) =>
            update({ lineHeight: e.target.value === "" ? null : Number(e.target.value) })
          }
        >
          <option value="">默认</option>
          {LINE_HEIGHT_CHOICES.map((h) => (
            <option key={h} value={h}>
              {h.toFixed(1)}
            </option>
          ))}
        </select>
      </label>
      <span className="typo-field" title="对齐方式（只影响显示，默认两端对齐）">
        对齐
        <span className="display-toggle" role="radiogroup" aria-label="对齐方式">
          {PROSE_ALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={settings.align === a.value ? "active" : ""}
              onClick={() => update({ align: a.value as ProseAlign })}
            >
              {a.label}
            </button>
          ))}
        </span>
      </span>
      <label className="typo-field" title="段首缩进几个字符（只影响显示，默认 2 字符）">
        首行缩进
        <select
          className="select small"
          value={settings.firstLineIndent}
          onChange={(e) => update({ firstLineIndent: Number(e.target.value) })}
        >
          {INDENT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "关" : `${n} 字符`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
