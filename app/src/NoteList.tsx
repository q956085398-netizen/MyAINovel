import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteDraft, NoteEntry, NoteKind, Vocabulary } from "./types";
import { emptyNoteDraft } from "./types";
import { errMsg, oneLinePreview } from "./util";
import NoteDialog from "./NoteDialog";

interface NoteListProps {
  project: string;
  kind: NoteKind;
  vocab: Vocabulary | null;
  /** 保存/删除/提为单元后：让项目页刷新计数。 */
  onChanged: () => void;
  /** 矛盾提为单元成功后：切到单元页。 */
  onPromoted: (unit: NoteEntry) => void;
}

const KIND_HEADINGS: Record<NoteKind, string> = {
  矛盾: "矛盾池",
  单元: "单元设计",
  人物: "人物小传",
  世界观: "世界观词条",
  开头: "开头设计（一版一文件）",
};

const KIND_HINTS: Record<NoteKind, string> = {
  矛盾: "构思期尚模糊的剧情种子：一句话核心＋类型，展开后提为单元（矛盾留档、状态改「已成单元」）。",
  单元: "矛盾展开后的形态：约 4~5 个桥段的完整故事，桥段清单写在正文（自由文本）。",
  人物: "一人一文件、文件名即人名；关系网的边留给人物画布（工单 #8）。",
  世界观: "设定词条：类别（力量体系/地理/势力/其他）；地图＝「地理」类词条，排布按名引用。",
  开头: "开篇构思的多版本形态：每版一文件，标「备选/选定」；多份「选定」应用会提醒你。",
};

/** 构思笔记列表（五类共用）：一笔记一文件，点击编辑。 */
export default function NoteList({
  project,
  kind,
  vocab,
  onChanged,
  onPromoted,
}: NoteListProps) {
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: NoteDraft; prevPath: string | null } | null>(
    null,
  );
  const [promoting, setPromoting] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await invoke<NoteEntry[]>("scan_notes", { project, kind }));
    } catch (e) {
      setNotes([]);
      setError(`读取${kind}失败：${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [project, kind]);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function promote(note: NoteEntry) {
    if (promoting) return;
    if (
      !window.confirm(
        `把矛盾「${note.name}」提为单元？\n\n` +
          `会新建 构思/单元/${note.name}.md（核心矛盾与类型预填），` +
          `并把矛盾状态改成「已成单元」（矛盾留档，不删）。`,
      )
    ) {
      return;
    }
    setPromoting(note.path);
    try {
      const unit = await invoke<NoteEntry>("promote_contradiction", { path: note.path });
      onChanged();
      onPromoted(unit);
    } catch (e) {
      window.alert(`提为单元失败：${errMsg(e)}`);
    } finally {
      setPromoting(null);
    }
  }

  const selectedStatus =
    kind === "开头" && notes.filter((n) => n.status === "选定").length > 1
      ? notes.filter((n) => n.status === "选定").length
      : 0;

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>{KIND_HEADINGS[kind]}</h2>
          <p className="hint">{KIND_HINTS[kind]}</p>
        </div>
        <button
          className="btn primary"
          onClick={() => setEditing({ draft: emptyNoteDraft(kind), prevPath: null })}
        >
          新建{kind}
        </button>
      </div>

      {selectedStatus > 1 && (
        <div className="hint-box">有 {selectedStatus} 版开头都标着「选定」——只留一版是常态，回头看看。</div>
      )}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="hint">正在读取……</p>}

      {!loading && !error && notes.length === 0 && (
        <div className="empty-state">
          <p>还没有{kind}。</p>
          <p className="hint">新建一篇，或直接在 Obsidian 里往 构思/{kind}/ 丢 .md 文件。</p>
        </div>
      )}

      <div className="card-list">
        {notes.map((note) => (
          <div key={note.path} className="card-item">
            <div className="card-title-row">
              <button
                className="card-title"
                title="编辑这篇笔记"
                onClick={() => setEditing({ draft: note, prevPath: note.path })}
              >
                {note.name}
              </button>
              {kind === "矛盾" && note.status && <span className="card-cat">{note.status}</span>}
              {kind === "开头" && note.status && <span className="card-cat">{note.status}</span>}
              {kind === "世界观" && note.category && (
                <span className="card-cat">{note.category}</span>
              )}
              {kind === "人物" && note.group && <span className="card-cat">{note.group}</span>}
              {note.types.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
              {note.aliases.map((a) => (
                <span key={a} className="tag">
                  别名：{a}
                </span>
              ))}
            </div>

            {note.core && (
              <p className="card-core" title={kind === "单元" ? "核心矛盾" : "一句话核心"}>
                {kind === "单元" ? "核心矛盾" : "一句话核心"}：{note.core}
              </p>
            )}
            {kind === "矛盾" && note.source && (
              <p className="card-meta">
                <span className="card-source" title="来源">
                  来源：{note.source}
                </span>
                {note.links.map((l) => (
                  <span key={l} className="card-source">
                    {l}
                  </span>
                ))}
              </p>
            )}
            {note.body && (
              <p className="card-preview" title={note.body}>
                {oneLinePreview(note.body, 120)}
              </p>
            )}
            {kind === "矛盾" && (
              <div className="card-actions">
                <button
                  className="btn small"
                  disabled={promoting === note.path}
                  title="新建同名单元草稿，矛盾状态改「已成单元」"
                  onClick={() => void promote(note)}
                >
                  {promoting === note.path ? "正在提…" : "提为单元"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <NoteDialog
          key={editing.prevPath ?? "new"}
          project={project}
          initial={editing.draft}
          prevPath={editing.prevPath}
          vocab={vocab}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
            void scan();
          }}
          onDeleted={() => {
            setEditing(null);
            onChanged();
            void scan();
          }}
        />
      )}
    </div>
  );
}
