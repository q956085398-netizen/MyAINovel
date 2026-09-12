import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { baseEditorTheme, editorAppearance, useEditorAppearance } from "./editorTheme";

const editorTheme = baseEditorTheme({ fontSize: "14px", paddingBottom: "2em" });

/** 外观随设置变化经 Compartment 重配；便签编辑器只跟深色不跟排版
 *  （spec 个性化设置.md §四：排版三件套归拆书/书写两个主编辑器）。 */
const appearanceCompartment = new Compartment();
const noteAppearance = { typography: false } as const;

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 容器高度（CSS 值），默认 320px。 */
  height?: string;
}

/** 构思面板的轻量 markdown 编辑器：受控值＋变更回调。拆书编辑器专属的
 *  保存/开章/截图/桥段等行为在 EditorPage，不在这里。 */
export default function MarkdownEditor({ value, onChange, height = "320px" }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 回调放 ref：编辑器的扩展只在挂载时装配一次，不因父组件重渲染重建。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEditorAppearance(viewRef, appearanceCompartment, noteAppearance);

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          markdown(),
          editorTheme,
          appearanceCompartment.of(editorAppearance(noteAppearance)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 只挂载一次；换笔记请由父组件用 key 重挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化（同一次挂载内）：整体替换文档。
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="md-editor" style={{ height }} ref={containerRef} />;
}
