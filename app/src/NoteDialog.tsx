import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteDraft, NoteEntry, NoteKind, Vocabulary } from "./types";
import {
  CONTRADICTION_STATUS_VALUES,
  OPENING_STATUS_VALUES,
  WORLDVIEW_CATEGORIES,
} from "./types";
import { errMsg, splitList } from "./util";
import MarkdownEditor from "./MarkdownEditor";
import VocabInput from "./VocabInput";

const KIND_LABELS: Record<NoteKind, { name: string; placeholder: string }> = {
  矛盾: { name: "矛盾名", placeholder: "如：通缉身份（标题即文件名）" },
  单元: { name: "单元名", placeholder: "如：初入京城" },
  人物: { name: "人名", placeholder: "如：陈平安" },
  世界观: { name: "词条", placeholder: "如：京城" },
  开头: { name: "版本名", placeholder: "如：第一版" },
};

interface NoteDialogProps {
  project: string;
  initial: NoteDraft;
  /** 编辑既有笔记时的文件位置；null 为新建。 */
  prevPath: string | null;
  /** 词表提示（类型输入用）；加载失败传 null，输入不受影响。 */
  vocab: Vocabulary | null;
  onClose: () => void;
  onSaved: (entry: NoteEntry) => void;
  onDeleted: (path: string) => void;
}

/** 构思笔记编辑框（矛盾/单元/人物/世界观/开头五类共用）：标题即文件名，
 *  保存写入 构思/<类别>/<标题>.md，frontmatter 中文键、未知键保留。 */
export default function NoteDialog({
  project,
  initial,
  prevPath,
  vocab,
  onClose,
  onSaved,
  onDeleted,
}: NoteDialogProps) {
  const kind = initial.kind;
  const labels = KIND_LABELS[kind];

  const [name, setName] = useState(initial.name);
  const [core, setCore] = useState(initial.core ?? "");
  const [typesText, setTypesText] = useState(initial.types.join("、"));
  const [source, setSource] = useState(initial.source ?? "");
  const [linksText, setLinksText] = useState(initial.links.join("\n"));
  const [status, setStatus] = useState(initial.status ?? "");
  const [group, setGroup] = useState(initial.group ?? "");
  const [aliasesText, setAliasesText] = useState(initial.aliases.join("、"));
  const [category, setCategory] = useState(initial.category ?? "");
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    const draft: NoteDraft = {
      kind,
      name: name.trim(),
      core: core.trim() || null,
      types: splitList(typesText),
      source: source.trim() || null,
      links: linksText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      status: status.trim() || null,
      group: group.trim() || null,
      aliases: splitList(aliasesText),
      category: category.trim() || null,
      body,
    };
    if (!draft.name) {
      window.alert(`${labels.name}不能为空。`);
      return;
    }
    setBusy(true);
    try {
      const entry = await invoke<NoteEntry>("save_note", { project, draft, prevPath });
      onSaved(entry);
    } catch (e) {
      window.alert(`笔记保存失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!prevPath || busy) return;
    if (!window.confirm(`确定删除这篇${kind}？\n${prevPath}\n删除的是文件，不可恢复。`)) return;
    setBusy(true);
    try {
      await invoke("delete_note", { path: prevPath });
      onDeleted(prevPath);
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
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
        <h2>
          {prevPath ? "编辑" : "新建"}
          {kind}
        </h2>
        <label>
          {labels.name}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={labels.placeholder}
            autoFocus
          />
        </label>

        {kind === "矛盾" && (
          <>
            <label>
              一句话核心（人物＋困境＋爽点预期）
              <input
                value={core}
                onChange={(e) => setCore(e.target.value)}
                placeholder="如：主角以谋士身份混入新朝，靠情报拿捏大人物"
              />
            </label>
            <label>
              类型（多个用、隔开）
              <VocabInput
                value={typesText}
                onChange={setTypesText}
                words={vocab?.types ?? []}
                placeholder="如：情报装逼、掉马甲"
              />
            </label>
            <label>
              来源
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="如：灵感库/故事卡/某卡"
              />
            </label>
            <label>
              关联（一行一条：卡片标题或书名，只是出处备注）
              <textarea
                className="links-input"
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                rows={2}
              />
            </label>
            <label>
              状态（约定值，也可自由输入）
              <VocabInput
                value={status}
                onChange={setStatus}
                words={CONTRADICTION_STATUS_VALUES}
                placeholder="池中 / 已成单元 / 弃用"
              />
            </label>
          </>
        )}

        {kind === "单元" && (
          <>
            <label>
              核心矛盾
              <input
                value={core}
                onChange={(e) => setCore(e.target.value)}
                placeholder="如：主角要在京城立足，却背着通缉身份"
              />
            </label>
            <label>
              类型（多个用、隔开）
              <VocabInput
                value={typesText}
                onChange={setTypesText}
                words={vocab?.types ?? []}
                placeholder="如：掉马甲、打脸"
              />
            </label>
          </>
        )}

        {kind === "人物" && (
          <>
            <label>
              分组（阵营/组织）
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="如：主角阵营"
              />
            </label>
            <label>
              别名（多个用、隔开）
              <input
                value={aliasesText}
                onChange={(e) => setAliasesText(e.target.value)}
                placeholder="如：小陈、陈公子"
              />
            </label>
          </>
        )}

        {kind === "世界观" && (
          <label>
            类别（约定值，也可自由输入）
            <VocabInput
              value={category}
              onChange={setCategory}
              words={WORLDVIEW_CATEGORIES}
              placeholder="力量体系 / 地理 / 势力 / 其他"
            />
          </label>
        )}

        {kind === "开头" && (
          <label>
            状态（约定值，也可自由输入）
            <VocabInput
              value={status}
              onChange={setStatus}
              words={OPENING_STATUS_VALUES}
              placeholder="备选 / 选定"
            />
          </label>
        )}

        <label>
          {kind === "单元" ? "正文（桥段安排按次序写）" : "正文"}
          <MarkdownEditor value={body} onChange={setBody} height="240px" />
        </label>
        <p className="hint">
          保存写入 构思/{kind}/{name.trim() || "标题"}.md；同名自动续号，
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
