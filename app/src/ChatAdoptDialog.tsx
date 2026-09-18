import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  CardDraft,
  ChatPersona,
  InspirationCard,
  NoteDraft,
  NoteEntry,
  ProjectEntry,
} from "./types";
import { errMsg, oneLinePreview, stripBookMarks } from "./util";

/** 一段被勾选的对话：说话人（我＝作者；AI 那条记人物名）＋原文。 */
export interface ChatExcerptEntry {
  speaker: string;
  content: string;
}

interface ChatAdoptDialogProps {
  mode: "矛盾" | "故事卡";
  persona: ChatPersona;
  entries: ChatExcerptEntry[];
  libraryRoot: string | null;
  onClose: () => void;
}

/** 把勾选的对话拼成摘录正文：每行带说话人标记（spec §六）。
 *  连续同一说话人的多条各自成行，不合并——改不改是人的事。 */
function excerptText(entries: ChatExcerptEntry[]): string {
  return entries.map((e) => `${e.speaker}：${e.content.trim()}`).join("\n\n");
}

/** 标题预填＝对话首行前若干字（人改）。 */
function prefillTitle(entries: ChatExcerptEntry[]): string {
  const first = entries.find((e) => e.content.trim())?.content ?? "";
  return oneLinePreview(first, 12);
}

/** 人物对话的采纳闸（工单 #16，spec §六）：勾选一段对话 → 预填 → 人确认
 *  落盘。「存为矛盾」按《书名》解析项目（按名引用，找不到就报错让人裁决）；
 *  「存为故事卡」落灵感库，来源预填「人物对话·《书名》/人名」。 */
export default function ChatAdoptDialog({
  mode,
  persona,
  entries,
  libraryRoot,
  onClose,
}: ChatAdoptDialogProps) {
  const body0 = excerptText(entries);
  const [title, setTitle] = useState(prefillTitle(entries));
  const [body, setBody] = useState(body0);
  const [core, setCore] = useState(oneLinePreview(body0.replace(/^[^：]*：/, ""), 40));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (busy || done) return;
    if (!title.trim()) {
      setError(mode === "矛盾" ? "给这个矛盾起个名（＝文件名）。" : "给这张故事卡起个名。");
      return;
    }
    if (!libraryRoot) {
      setError("还没打开库文件夹，存不了。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = title.trim();
      if (mode === "矛盾") {
        // 《书名》按名解析项目（与卡片关联同款口径），不猜。
        const projects = await invoke<ProjectEntry[]>("scan_projects", { root: libraryRoot });
        const target = projects.find((p) => p.title === stripBookMarks(persona.project));
        if (!target) {
          throw new Error(`${persona.project}对应的项目找不到了（改名了？去构思板块确认）。`);
        }
        // 同名报错让人裁决，不靠后端续号（spec §六；续号会静默绕过采纳闸）。
        const existing = await invoke<NoteEntry[]>("scan_notes", {
          project: target.dir,
          kind: "矛盾",
        });
        if (existing.some((n) => n.name === name)) {
          throw new Error(`已有同名矛盾「${name}」：换个名，或去矛盾页把两份合并。`);
        }
        const draft: NoteDraft = {
          kind: "矛盾",
          name,
          core: null,
          types: [],
          source: null,
          links: [],
          status: "池中",
          group: null,
          aliases: [],
          category: null,
          emotionGoal: null,
          startChapter: null,
          endChapter: null,
          body: body.trim(),
        };
        await invoke<NoteEntry>("save_note", { project: target.dir, draft, prevPath: null });
        setDone(`已存为矛盾「${name}」（构思/矛盾/，状态：池中）。`);
      } else {
        const cards = await invoke<InspirationCard[]>("scan_inspirations", { root: libraryRoot });
        if (cards.some((c) => c.category === "故事卡" && c.title === name)) {
          throw new Error(`已有同名故事卡「${name}」：换个名，或去灵感库把两份合并。`);
        }
        const draft: CardDraft = {
          category: "故事卡",
          title: name,
          tags: [],
          source: `人物对话·${persona.project}/${persona.person}`,
          links: [],
          core: core.trim() || null,
          body: body.trim(),
        };
        await invoke("save_inspiration_card", { root: libraryRoot, draft, prevPath: null });
        setDone(`已存为故事卡「${name}」（灵感库）。`);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h3>
          {mode === "矛盾" ? "存为矛盾" : "存为故事卡"}
          <span className="hint">
            {" "}
            （来自与{persona.person}的对话 · {persona.project}）
          </span>
        </h3>
        {done ? (
          <>
            <p>{done}</p>
            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span>{mode === "矛盾" ? "矛盾名（＝文件名）" : "卡片标题"}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </label>
            {mode === "故事卡" && (
              <label className="field">
                <span>一句话核心</span>
                <input
                  value={core}
                  placeholder="人物＋困境＋爽点预期"
                  onChange={(e) => setCore(e.target.value)}
                />
              </label>
            )}
            <label className="field">
              <span>
                正文（对话摘录预填，可改{mode === "故事卡" ? "；来源会记「人物对话·"
                  + persona.project + "/" + persona.person + "」" : ""}）
              </span>
              <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            {error && <div className="error-box">{error}</div>}
            <div className="dialog-actions">
              <button className="btn" disabled={busy} onClick={onClose}>
                取消
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void confirm()}>
                {busy ? "正在保存…" : "确认落盘"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
