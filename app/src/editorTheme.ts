import { EditorView } from "@codemirror/view";

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
