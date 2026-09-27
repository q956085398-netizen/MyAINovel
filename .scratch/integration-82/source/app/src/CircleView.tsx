import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Circle, Vocabulary } from "./types";
import { errMsg, splitList } from "./util";
import MarkdownEditor from "./MarkdownEditor";
import VocabInput from "./VocabInput";
import {
  normalizeReaderPrompts,
  type ReaderPrompt,
} from "./ideationGuidance";

interface CircleViewProps {
  project: string;
  /** 词表提示（库根「词表.yaml」＋库内已用词）；只提示不校验。 */
  vocab: Vocabulary | null;
}

/** 类型圈：这本书的读者遐想清单（约 4~6 类），整本书的内容只在圈内。
 *  frontmatter 的类型列表是机器可读的那份，正文按类型逐条写遐想笔记。 */
export default function CircleView({ project, vocab }: CircleViewProps) {
  const [typesText, setTypesText] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptKey = `gongbi.reader-prompts.${project}`;
  const promptHiddenKey = `${promptKey}.hidden`;
  const [prompts, setPrompts] = useState<ReaderPrompt[]>(() => {
    try {
      return normalizeReaderPrompts(JSON.parse(localStorage.getItem(promptKey) ?? "null"));
    } catch {
      return normalizeReaderPrompts(null);
    }
  });
  const [promptsHidden, setPromptsHidden] = useState(
    () => localStorage.getItem(promptHiddenKey) === "1",
  );

  function savePrompts(next: ReaderPrompt[]) {
    localStorage.setItem(promptKey, JSON.stringify(next));
    setPrompts(next);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const circle = await invoke<Circle>("read_circle", { project });
        if (cancelled) return;
        setTypesText(circle.types.join("、"));
        setBody(circle.body);
      } catch (e) {
        if (!cancelled) setError(`读取读者遐想失败：${errMsg(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await invoke("save_circle", {
        project,
        circle: { types: splitList(typesText), body },
      });
      setDirty(false);
    } catch (e) {
      window.alert(`读者遐想保存失败：${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>读者遐想（类型圈）</h2>
          <p className="hint">
            这本书的读者遐想清单（约 4~6 类）：全书内容只在圈内、不在圈外。
            类型挂词表提示（只提示不校验）；正文按类型逐条写「想看到什么」。
          </p>
        </div>
        <button
          className="btn primary"
          disabled={saving || loading || !dirty}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : dirty ? "保存" : "已保存"}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {loading ? (
        <p className="hint">正在读取……</p>
      ) : (
        <>
          {!promptsHidden && prompts.length > 0 && (
            <div className="reader-prompt-guide">
              <div className="reader-prompt-head">
                <div>
                  <strong>可删的思考提示</strong>
                  <p className="hint">改写成适合这本书的问题，也可以移除或暂时跳过。</p>
                </div>
                <button
                  className="link-like"
                  onClick={() => {
                    localStorage.setItem(promptHiddenKey, "1");
                    setPromptsHidden(true);
                  }}
                >
                  暂时跳过
                </button>
              </div>
              {prompts.map((prompt, index) => (
                <div className="reader-prompt-row" key={prompt.id}>
                  <span>{prompt.label}</span>
                  <textarea
                    value={prompt.text}
                    rows={2}
                    onChange={(event) => {
                      const next = prompts.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, text: event.target.value } : item,
                      );
                      savePrompts(next);
                    }}
                  />
                  <button
                    className="link-like danger"
                    onClick={() => savePrompts(prompts.filter((item) => item.id !== prompt.id))}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="field">
            类型（多个用、隔开）
            <VocabInput
              value={typesText}
              onChange={(v) => {
                setTypesText(v);
                setDirty(true);
              }}
              words={vocab?.types ?? []}
              placeholder="如：掉马甲、打脸、情报装逼"
            />
          </label>
          <label className="field">
            遐想笔记
            <MarkdownEditor
              value={body}
              onChange={(v) => {
                setBody(v);
                setDirty(true);
              }}
              height="420px"
            />
          </label>
          <p className="hint">文件：构思/类型圈.md（frontmatter 的类型列表＋自由正文）。</p>
        </>
      )}
    </div>
  );
}
