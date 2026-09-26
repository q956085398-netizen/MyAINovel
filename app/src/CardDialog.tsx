import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CardDraft, InspirationCard } from "./types";
import { CARD_CATEGORIES } from "./types";
import { errMsg } from "./util";

/** 标签输入分隔符：顿号/逗号/分号/空白，与 Rust 侧 push_split 同口径。 */
function splitTags(text: string): string[] {
  return text
    .split(/[、，,；;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

interface CardDialogProps {
  libraryPath: string;
  initial: CardDraft;
  /** 编辑既有卡片时的文件位置；null 为新建。 */
  prevPath: string | null;
  onClose: () => void;
  onSaved: (card: InspirationCard) => void;
  onDeleted: (path: string) => void;
}

/** 灵感卡片编辑：标题即文件名、类别即文件夹，保存写入
 *  「灵感库/<类别>/<标题>.md」（frontmatter 中文键，Rust 侧合并保留未知键）。 */
export default function CardDialog({
  libraryPath,
  initial,
  prevPath,
  onClose,
  onSaved,
  onDeleted,
}: CardDialogProps) {
  const [title, setTitle] = useState(initial.title);
  const [category, setCategory] = useState(initial.category);
  const [tagsText, setTagsText] = useState(initial.tags.join("、"));
  const [source, setSource] = useState(initial.source ?? "");
  const [linksText, setLinksText] = useState(initial.links.join("\n"));
  const [core, setCore] = useState(initial.core ?? "");
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    const draft: CardDraft = {
      category,
      title: title.trim(),
      tags: splitTags(tagsText),
      source: source.trim() || null,
      links: linksText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      // 一句话核心按内容落盘、不按类别清空：非故事卡里手写的这个键，
      // 经应用编辑一次就被删掉，违背「手补的字段不丢」。想清空就清空输入框。
      core: core.trim() || null,
      body,
    };
    if (!draft.title) {
      window.alert("卡片标题不能为空。");
      return;
    }
    setBusy(true);
    try {
      const card = await invoke<InspirationCard>("save_inspiration_card", {
        root: libraryPath,
        draft,
        prevPath,
      });
      onSaved(card);
    } catch (e) {
      window.alert(`卡片保存失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!prevPath || busy) return;
    if (!window.confirm(`确定删除这张卡片？\n${prevPath}\n删除的是文件，不可恢复。`)) return;
    setBusy(true);
    try {
      await invoke("delete_inspiration_card", { path: prevPath });
      onDeleted(prevPath);
    } catch (e) {
      window.alert(`卡片删除失败：${errMsg(e)}`);
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog wide">
        <h2>{prevPath ? "编辑卡片" : "新建卡片"}</h2>
        <label>
          标题
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题即文件名"
            autoFocus
          />
        </label>
        <label>
          类别
          <select value={category} onChange={(e) => setCategory(e.target.value as CardDraft["category"])}>
            {CARD_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          标签
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="顿号或逗号分隔，如：末世、掉马甲"
          />
        </label>
        {category === "故事卡" && (
          <label>
            一句话核心（人物＋困境＋爽点预期）
            <input
              value={core}
              onChange={(e) => setCore(e.target.value)}
              placeholder="如：外卖员得签到系统，末世囤物资被当扫地僧"
            />
          </label>
        )}
        <label>
          来源
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="如：拆《某书》第3~6章、龙空某帖"
          />
        </label>
        <label>
          关联（一行一条：灵感卡片标题或拆书稿书名，可点击跳转）
          <textarea
            className="links-input"
            value={linksText}
            onChange={(e) => setLinksText(e.target.value)}
            rows={2}
          />
        </label>
        <label>
          正文
          <textarea
            className="card-body-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="卡片正文，markdown 随意写"
            rows={10}
          />
        </label>
        <p className="hint">
          保存写入 灵感库/{category}/{title.trim() || "标题"}.md；同名卡片自动续号，
          在 Obsidian 里手补的字段不会丢。
        </p>
        <div className="dialog-actions">
          {prevPath && (
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>
              删除
            </button>
          )}
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
