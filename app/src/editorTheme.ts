import { useEffect, type RefObject } from "react";
import { Compartment, RangeSetBuilder, type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import {
  getSettings,
  resolvedTheme,
  subscribeSettings,
  type BodyFont,
  type ProseAlign,
} from "./settings";

/** 排版三件套（工单 #26，spec 个性化设置.md §四）：两个编辑器共用，
 *  未设置的项不产生规则＝各编辑器现状（拆书 15px／书写 17px、行距 1.9）。 */
const FONT_STACKS: Record<Exclude<BodyFont, "system">, string> = {
  宋: '"Source Han Serif SC", "Noto Serif SC", "SimSun", serif',
  黑: '"Source Han Sans SC", "Noto Sans SC", "SimHei", "Microsoft YaHei", sans-serif',
  楷: '"KaiTi", "STKaiti", "Source Han Serif SC", serif',
};

function typographyRules(
  font: BodyFont,
  fontSize: number | null,
  lineHeight: number | null,
  align: ProseAlign,
  firstLineIndent: number,
): Record<string, Record<string, string>> {
  const spec: Record<string, Record<string, string>> = {};
  if (font !== "system") spec["&"] = { fontFamily: FONT_STACKS[font] };
  if (fontSize != null) {
    spec["&"] = { ...spec["&"], fontSize: `${fontSize}px` };
  }
  // 对齐（v2 工单 #33）：挂在 .cm-content 上随行继承；标题/列表等一并生效（Word 同款语义）。
  spec[".cm-content"] = { ...spec[".cm-content"], textAlign: align };
  if (lineHeight != null) {
    spec[".cm-content"] = { ...spec[".cm-content"], lineHeight: String(lineHeight) };
  }
  // 首行缩进（v2 工单 #33）：量挂 CSS 变量，行装饰只加类名（见 proseIndentExtension）。
  if (firstLineIndent > 0) {
    spec["&"] = { ...spec["&"], "--editor-prose-indent": `${firstLineIndent}em` };
  } else {
    spec["&"] = { ...spec["&"], "--editor-prose-indent": "0" };
  }
  return spec;
}

/** 首行缩进的散文行装饰（工单 #33）：只给 markdown 语法树的顶层「段落」行
 *  挂类名——标题/列表/引用（callout 卡片行也是引用）/代码块/表格不缩进；
 *  缩进量来自主题注入的 --editor-prose-indent（App.css 消费）。 */
const proseLineDeco = Decoration.line({ class: "cm-prose" });

function proseLines(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.text.trim()) {
        // 从行首向上走到顶层块节点：段落才缩进（列表项内的段落也跳过）。
        // 只在段落起始行缩进——硬换行的段落（无空行断段）后续行不再缩进。
        let node = tree.resolveInner(line.from, 1);
        while (node.parent && node.parent.name !== "Document") node = node.parent;
        if (node.name === "Paragraph" && node.from === line.from) {
          builder.add(line.from, line.from, proseLineDeco);
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function proseIndentExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = proseLines(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = proseLines(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

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
 *  （订阅见 useEditorAppearance）。浅色＋素纸＋默认排版＝空扩展（现状）。
 *  深色判定：主题深色，或选了深色纹理「暮山」（浅主题下暮山也配浅字）。
 *  typography=false 时只跟深色不跟排版（spec §四：排版三件套归拆书/
 *  书写两个主编辑器，构思便签编辑器不随）。 */
export interface EditorAppearanceOptions {
  typography?: boolean;
}

export function editorAppearance({ typography = true }: EditorAppearanceOptions = {}): Extension[] {
  const { background, font, fontSize, lineHeight, align, firstLineIndent } = getSettings();
  const dark =
    resolvedTheme() === "dark" ||
    (background.kind === "builtin" && background.id === "暮山");
  if (!typography) {
    return dark ? [darkEditorTheme, syntaxHighlighting(darkHighlight)] : [];
  }
  // 排版五项（§四）：对齐/缩进默认两端＋2字符，规则恒非空（v2 起总有主题）。
  const rules = typographyRules(font, fontSize, lineHeight, align, firstLineIndent);
  return [
    ...(dark ? [darkEditorTheme, syntaxHighlighting(darkHighlight)] : []),
    EditorView.theme(rules),
    proseIndentExtension(),
  ];
}

/** 订阅设置变化 → 编辑器外观 Compartment 重配（各编辑器共用一个订阅形状）。 */
export function useEditorAppearance(
  viewRef: RefObject<EditorView | null>,
  compartment: Compartment,
  options?: EditorAppearanceOptions,
) {
  useEffect(
    () =>
      subscribeSettings(() => {
        viewRef.current?.dispatch({
          effects: compartment.reconfigure(editorAppearance(options)),
        });
      }),
    // viewRef/compartment 是模块级或挂载期稳定引用；options 为字面量或缺省。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}
