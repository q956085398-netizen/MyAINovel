import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Circle, Vocabulary } from "./types";
import { errMsg, splitList } from "./util";
import MarkdownEditor from "./MarkdownEditor";
import VocabInput from "./VocabInput";
import {
  DEFAULT_IMAGINATION_PROMPTS,
  editPrompt,
  removePrompt,
  type IdeationPrompt,
} from "./ideationGuidance";

interface CircleViewProps {
  project: string;
  /** 词表提示（库根「词表.yaml」＋库内已用词）；只提示不校验。 */
  vocab: Vocabulary | null;
}

/** 类型圈：这本书的读者遐想清单（约 4~6 类），整本书的内容只在圈内。
 *  frontmatter 的类型列表是机器可读的那份，正文按类型逐条写遐想笔记。 */
export default function CircleView({ project, vocab }: CircleViewProps) {
  const promptStorageKey = `gongbi:reader-imagination-prompts:${project}`;
  const [prompts, setPrompts] = useState<IdeationPrompt[]>(() => {
    try {
      const saved = localStorage.getItem(promptStorageKey);
      return saved ? JSON.parse(saved) : DEFAULT_IMAGINATION_PROMPTS.map((item) => ({ ...item }));
    } catch {
      return DEFAULT_IMAGINATION_PROMPTS.map((item) => ({ ...item }));
    }
  });
  const [typesText, setTypesText] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const circle = await invoke<Circle>("read_circle", { project });
        if (cancelled) return;
        setTypesText(circle.types.join("、"));
        setBody(circle.body);
      } catch (e) {
        if (!cancelled) setError(`读取读者遐想（类型圈）失败：${errMsg(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    localStorage.setItem(promptStorageKey, JSON.stringify(prompts));
  }, [promptStorageKey, prompts]);

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
      window.alert(`读者遐想（类型圈）保存失败：${errMsg(e)}`);
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
            保留原「类型圈」文件与数据结构，用三个轻量方向帮助继续想：读者期待、题材刻板印象、独特吸引力。提示可跳过，不评价完成度。
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
          <section className="imagination-guidance">
            <div className="imagination-guidance-head">
              <div>
                <h3>想不到时，可以从这三个方向问自己</h3>
                <p className="hint">这些只是本机引导，不写进创作目录；可以改写、删掉或全部跳过。</p>
              </div>
              {prompts.length > 0 ? (
                <button className="btn" onClick={() => setPrompts([])}>跳过全部</button>
              ) : (
                <button
                  className="btn"
                  onClick={() => setPrompts(DEFAULT_IMAGINATION_PROMPTS.map((item) => ({ ...item })))}
                >
                  恢复引导
                </button>
              )}
            </div>
            {prompts.map((prompt) => (
              <div className="imagination-prompt" key={prompt.id}>
                <strong>{prompt.title}</strong>
                <textarea
                  value={prompt.text}
                  onChange={(event) => setPrompts((items) => editPrompt(items, prompt.id, event.target.value))}
                />
                <button className="btn" onClick={() => setPrompts((items) => removePrompt(items, prompt.id))}>
                  删除
                </button>
              </div>
            ))}
          </section>
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
