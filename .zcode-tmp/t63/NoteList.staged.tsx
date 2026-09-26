import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteDraft, NoteEntry, NoteKind, Vocabulary } from "./types";
import { emptyNoteDraft } from "./types";
import { errMsg, oneLinePreview } from "./util";
import NoteDialog from "./NoteDialog";
import GeoUpgradeDialog from "./GeoUpgradeDialog";
import PendingZone from "./PendingZone";
import { usePendingToggle } from "./pendingToggle";
import { createPowerSystemDraft, POWER_SYSTEM_CATEGORY } from "./powerSystem";

interface NoteListProps {
  project: string;
  kind: NoteKind;
  vocab: Vocabulary | null;
  /** 保存/删除/提为单元后：让项目页刷新计数。 */
  onChanged: () => void;
  /** 矛盾提为单元成功后：切到单元页。 */
  onPromoted: (unit: NoteEntry) => void;
  /** 板块 AI 命令（目前只给矛盾页「矛盾梳理」）：材料由后端组装，只出报告。 */
  onAiCommand?: () => void;
  /** 人物页专属：「跟 TA 聊」进人物对话（工单 #16）。 */
  onChat?: (name: string) => void;
  /** 首页进入力量体系时按类别筛看；仍编辑同一份世界观词条。 */
  worldviewCategory?: string;
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
  人物: "一人一文件、文件名即人名；小传写在这里，关系连在「画布」视图（类型/方向/秘密）。",
  世界观: "自由设定词条，类别只作提示；力量体系可从可删提示或空白正文开始。地图与地域在「地图」页编辑。",
  开头: "开篇构思的多版本形态：每版一文件，标「备选/选定」；多份「选定」应用会提醒你。",
};

/** 卡片标题行里的类别/标签徽章；紧凑卡与待打磨便笺同一份。 */
function NoteBadges({ kind, note }: { kind: NoteKind; note: NoteEntry }) {
  return (
    <>
      {kind === "矛盾" && note.status && <span className="card-cat">{note.status}</span>}
      {kind === "开头" && note.status && <span className="card-cat">{note.status}</span>}
      {kind === "世界观" && note.category && <span className="card-cat">{note.category}</span>}
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
    </>
  );
}

/** 一句话核心／来源等字段行；便笺与紧凑卡共用。 */
function NoteCoreLines({ kind, note }: { kind: NoteKind; note: NoteEntry }) {
  if (!note.core && !(kind === "矛盾" && (note.source || note.links.length > 0))) {
    return null;
  }
  return (
    <>
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
    </>
  );
}

/** 构思笔记列表（五类共用）：一笔记一文件，点击编辑。
 *  待打磨的笔记以完整便笺集中在本页顶部（工单 #64）：便笺只是状态
 *  视图，内容仍是那一份文件；整理完成即回原类别与原排序位置。 */
export default function NoteList({
  project,
  kind,
  vocab,
  onChanged,
  onPromoted,
  onAiCommand,
  onChat,
  worldviewCategory,
}: NoteListProps) {
  const [categoryFilter, setCategoryFilter] = useState(worldviewCategory ?? "");
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: NoteDraft; prevPath: string | null } | null>(
    null,
  );
  const [promoting, setPromoting] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<NoteEntry | null>(null);

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

  /** 待打磨切换（工单 #64）：成功后通知项目页刷新计数并重扫本页。 */
  const { switching, toggle: togglePending } = usePendingToggle(
    useCallback(async () => {
      onChanged();
      await scan();
    }, [onChanged, scan]),
  );

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

  const visibleNotes = notes.filter((n) => !categoryFilter || n.category === categoryFilter);
  const polishing = visibleNotes.filter((n) => n.pending);
  const normal = visibleNotes.filter((n) => !n.pending);
  const powerSystem = kind === "世界观" && categoryFilter === POWER_SYSTEM_CATEGORY;

  const selectedStatus =
    kind === "开头" && notes.filter((n) => n.status === "选定").length > 1
      ? notes.filter((n) => n.status === "选定").length
      : 0;

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>{powerSystem ? "力量体系／修炼体系" : KIND_HEADINGS[kind]}</h2>
          <p className="hint">{KIND_HINTS[kind]}</p>
        </div>
        <div className="page-actions">
          {onAiCommand && (
            <button
              className="btn"
              title="AI 分拣这一池矛盾：能长成单元的、重复的、偏离类型圈的（只出报告，不改文件）"
              onClick={onAiCommand}
            >
              AI 矛盾梳理
            </button>
          )}
          {powerSystem && (
            <button className="btn" onClick={() => setEditing({ draft: createPowerSystemDraft(false), prevPath: null })}>
              从空白正文开始
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => setEditing({ draft: powerSystem ? createPowerSystemDraft(true) : emptyNoteDraft(kind), prevPath: null })}
          >
            {powerSystem ? "新建力量体系（带可删提示）" : `新建${kind}`}
          </button>
        </div>
      </div>

      {kind === "世界观" && (
        <div className="subtabs">
          <button className={`subtab ${!categoryFilter ? "active" : ""}`} onClick={() => setCategoryFilter("")}>全部词条</button>
          <button className={`subtab ${powerSystem ? "active" : ""}`} onClick={() => setCategoryFilter(POWER_SYSTEM_CATEGORY)}>力量体系</button>
        </div>
      )}

      <PendingZone
        label={`待打磨的${kind}`}
        count={polishing.length}
        hint="还在发酵；整理完成后回到下面的原位置。"
      >
        <div className="card-list">
          {polishing.map((note) => (
            <article key={note.path} className="card-item is-pending">
              <div className="card-title-row">
                <button
                  className="card-title"
                  title="编辑这篇笔记"
                  onClick={() => setEditing({ draft: note, prevPath: note.path })}
                >
                  {note.name}
                </button>
                <NoteBadges kind={kind} note={note} />
              </div>
              <NoteCoreLines kind={kind} note={note} />
              {note.body && <div className="card-body">{note.body}</div>}
              <div className="card-actions">
                <button
                  className="btn primary small"
                  disabled={switching === note.path}
                  title="解除待打磨：笔记回到原排序位置"
                  onClick={() => void togglePending(note.path, false)}
                >
                  整理完成
                </button>
                <button
                  className="btn small"
                  onClick={() => setEditing({ draft: note, prevPath: note.path })}
                >
                  编辑
                </button>
              </div>
            </article>
          ))}
        </div>
      </PendingZone>

      {selectedStatus > 1 && (
        <div className="hint-box">有 {selectedStatus} 版开头都标着「选定」——只留一版是常态，回头看看。</div>
      )}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="hint">正在读取……</p>}

      {!loading && !error && visibleNotes.length === 0 && (
        <div className="empty-state">
          <p>还没有{powerSystem ? "力量体系词条" : kind}。</p>
          <p className="hint">新建一篇，或直接在 Obsidian 里往 构思/{kind}/ 丢 .md 文件。</p>
        </div>
      )}

      <div className="card-list">
        {normal.map((note) => (
          <div key={note.path} className="card-item">
            <div className="card-title-row">
              <button
                className="card-title"
                title="编辑这篇笔记"
                onClick={() => setEditing({ draft: note, prevPath: note.path })}
              >
                {note.name}
              </button>
              <NoteBadges kind={kind} note={note} />
            </div>

            <NoteCoreLines kind={kind} note={note} />
            {note.body && (
              <p className="card-preview" title={note.body}>
                {oneLinePreview(note.body, 120)}
              </p>
            )}
            <div className="card-actions">
              <button
                className="btn small"
                disabled={switching === note.path}
                title="挪到本页顶部的待打磨区；文件与排序位置都不动"
                onClick={() => void togglePending(note.path, true)}
              >
                待打磨
              </button>
              {kind === "人物" && onChat && (
                <button
                  className="btn small"
                  title="开一个与 TA 的 AI 对话找灵感（小传＋关系＋类型圈当人格底座）"
                  onClick={() => onChat(note.name)}
                >
                  跟 TA 聊
                </button>
              )}
              {kind === "矛盾" && (
                <button
                  className="btn small"
                  disabled={promoting === note.path}
                  title="新建同名单元草稿，矛盾状态改「已成单元」"
                  onClick={() => void promote(note)}
                >
                  {promoting === note.path ? "正在提…" : "提为单元"}
                </button>
              )}
              {kind === "世界观" && note.category === "地理" && (
                <button
                  className="btn small"
                  title="先查看将创建与备份的文件位置，再决定是否升级为地图或地域"
                  onClick={() => setUpgrading(note)}
                >
                  升级为地图／地域
                </button>
              )}
            </div>
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
      {upgrading && (
        <GeoUpgradeDialog
          project={project}
          source={upgrading}
          onClose={() => setUpgrading(null)}
          onUpgraded={() => {
            setUpgrading(null);
            onChanged();
            void scan();
          }}
        />
      )}
    </div>
  );
}
