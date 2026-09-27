import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteEntry } from "./types";
import { characterDetailRows, membershipSummary, type Membership } from "./characterProfile";
import { errMsg } from "./util";
import ContentSurface from "./ContentSurface";
import PendingZone from "./PendingZone";
import CharacterImage from "./CharacterImage";

interface Props {
  project: string;
  notes: NoteEntry[];
  loading: boolean;
  error: string | null;
  switching: string | null;
  onNew: () => void;
  onEdit: (note: NoteEntry) => void;
  onTogglePending: (path: string, pending: boolean) => void;
  onChat?: (name: string) => void;
  onRelations?: (name: string) => void;
  onOrganizations?: () => void;
}

/** 人物档案读模型：组织摘要每次从社会网读取，不写回人物文件。 */
export default function CharacterArchive(props: Props) {
  const { project, notes, loading, error, switching, onNew, onEdit, onTogglePending, onChat, onRelations, onOrganizations } = props;
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    invoke<{ memberships: Membership[] }>("read_social_workspace", { project })
      .then((data) => { if (active) { setMemberships(data.memberships); setSocialError(null); } })
      .catch((e) => { if (active) { setMemberships([]); setSocialError(errMsg(e)); } });
    return () => { active = false; };
  }, [project, notes]);

  function toggle(path: string) {
    setCollapsed((old) => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }
  function cards(items: NoteEntry[]) {
    return <div className="card-list">{items.map((note) => (
      <ContentSurface key={note.path} identity={note.path} title={note.name} pending={note.pending}
        expanded={!collapsed.has(note.path)} onToggleExpanded={() => toggle(note.path)}
        onEdit={() => onEdit(note)}
        badges={note.aliases.map((a) => <span key={a} className="tag">别名：{a}</span>)}
        actions={<>
          <button className="btn small" onClick={() => onEdit(note)}>编辑</button>
          <button className="btn small" disabled={switching === note.path} onClick={() => onTogglePending(note.path, !note.pending)}>{note.pending ? "整理完成" : "待打磨"}</button>
          {onRelations && <button className="btn small" onClick={() => onRelations(note.name)}>人物关系</button>}
          {onOrganizations && <button className="btn small" onClick={onOrganizations}>组织归属</button>}
          {onChat && <button className="btn small" onClick={() => onChat(note.name)}>跟 TA 聊</button>}
        </>}>
        <CharacterImage image={note.character?.image} path={note.path} name={note.name} />
        {characterDetailRows(note.character).map(([label, value]) => <p className="field-line" key={label}><span className="field-label">{label}</span>{value}</p>)}
        {memberships.filter((m) => m.person === note.name).map((m, index) => <p className="field-line" key={`membership-${index}`}><span className="field-label">组织关系</span>{membershipSummary(m)}</p>)}
        {note.group && <p className="hint">旧分组：{note.group}（未升级记录，组织关系以上述社会网为准）</p>}
        {note.body && <div className="card-body">{note.body}</div>}
      </ContentSurface>
    ))}</div>;
  }
  const pending = notes.filter((n) => n.pending);
  return <div className="note-pane map-archive">
    <div className="pane-head"><div><h2>人物档案</h2><p className="hint">结构摘要可留空，小传、外貌、说话方式与人物弧自由写在正文。</p></div><button className="btn primary" onClick={onNew}>新建人物</button></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {socialError && <div className="error-box" role="alert">组织关系读取失败：{socialError}。人物文字仍可编辑。</div>}
    {loading && <p className="hint">正在读取……</p>}
    <PendingZone label="待打磨的人物" count={pending.length} hint="整理完成后回到原位置。">{cards(pending)}</PendingZone>
    {cards(notes.filter((n) => !n.pending))}
    {!loading && !error && notes.length === 0 && <p className="hint">还没有人物，从一个名字或一段小传开始。</p>}
  </div>;
}
