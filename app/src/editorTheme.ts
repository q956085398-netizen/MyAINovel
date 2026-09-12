import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { resolvedTheme } from "./settings";

interface EditorThemeOptions {
  fontSize: string;
  /** 正文底部留白（滚动到末尾时不贴底）。 */
  paddingBottom: string;
}

/** 两个编辑器（拆书 EditorPage 与构思 MarkdownEditor）共用的基础主题：
 *  行高、字体、滚动区；尺寸差异由各自的参数给。 */
export function baseEditorTheme({ fontSize, paddingBottom }: EditorThemeOptions) {
  return EditorView.theme({
    "&": { height: "100%", fontSize },
    ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
    ".cm-content": { paddingBottom },
  });
}

/** 深色下的 markdown 高亮（工单 #24）：basicSetup 的默认高亮是浅色组且
 *  fallback 语义——给出自带高亮即整体替换；标题/链接/强调翻亮。 */
const darkHighlight = HighlightStyle.define([
  { tag: t.heading, color: "#e0a088" },
  { tag: t.link, color: "#8fb7d9" },
  { tag: t.url, color: "#6f9fc2" },
  { tag: t.emphasis, color: "#e5c07e", fontStyle: "italic" },
  { tag: t.strong, color: "#f0d9a8", fontWeight: "bold" },
  { tag: t.strikethrough, color: "#8a8274", textDecoration: "line-through" },
  { tag: t.meta, color: "#8a8274" },
  { tag: t.processingInstruction, color: "#8a8274" },
  { tag: t.keyword, color: "#c792ea" },
]);

/** 深色编辑器主题（工单 #24）：dark 标记让 CM 用原生 &dark 底组
 *  （选区/光标等），行号槽与当前行随暖色深色调；字色由容器
 *  var(--ink) 继承。 */
const darkEditorTheme = EditorView.theme(
  {
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#9a9282",
      borderRight: "1px solid #3b382e",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.045)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.06)" },
  },
  { dark: true },
);

/** 编辑器外观（工单 #24 起）：随设置/主题变化，编辑器经 Compartment 重配
 *  （订阅见 settings.ts）。浅色＝空扩展（现状）。 */
export function editorAppearance() {
  return resolvedTheme() === "dark"
    ? [darkEditorTheme, syntaxHighlighting(darkHighlight)]
    : [];
}
