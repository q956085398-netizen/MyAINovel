import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InspirationCard, NoteEntry, ProjectEntry } from "./types";
import { errMsg } from "./util";

/** 转生落点：故事卡→单元（工单 #9）、角色卡→人物（工单 #8 §五）。 */
export type TransmuteTarget = "单元" | "人物";

interface TransmuteDialogProps {
  libraryPath: string;
  card: InspirationCard;
  target: TransmuteTarget;
  onClose: () => void;
  /** 没有项目时：关掉对话框并切到「构思」板块去新建。 */
  onGoIdeation: () => void;
  /** 转生成功：上层刷新卡片列表，并跳到该项目的对应页签。 */
  onDone: (project: ProjectEntry, target: TransmuteTarget) => void;
}

const COPY: Record<
  TransmuteTarget,
  { title: string; command: string; landing: string; fields: string }
> = {
  单元: {
    title: "转生为单元草稿",
    command: "transmute_story_card",
    landing: "构思/单元/",
    fields: "核心矛盾＝一句话核心、类型＝标签，正文只给「桥段安排」骨架",
  },
  人物: {
    title: "转生为人物",
    command: "transmute_character_card",
    landing: "构思/人物/",
    fields: "小传正文＝卡片正文，分组/别名留空（分组在人物页里填，关系在画布上连）",
  },
};

/** 卡片转生：选目标项目 → 建草稿（预填卡片已有字段、不生成内容）→
 *  卡片「关联」记去向「《书名》/名字」。转生即断链，改卡片不同步。 */
export default function TransmuteDialog({
  libraryPath,
  card,
  target,
  onClose,
  onGoIdeation,
  onDone,
}: TransmuteDialogProps) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[target];

  useEffect(() => {
    let alive = true;
    invoke<ProjectEntry[]>("scan_projects", { root: libraryPath })
      .then((list) => {
        if (!alive) return;
        setProjects(list);
        setPick(list[0]?.dir ?? "");
      })
      .catch((e) => {
        if (!alive) return;
        setProjects([]);
        setError(`读取项目失败：${errMsg(e)}`);
      });
    return () => {
      alive = false;
    };
  }, [libraryPath]);

  async function transmute() {
    const project = projects?.find((p) => p.dir === pick);
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke<NoteEntry>(copy.command, {
        root: libraryPath,
        cardPath: card.path,
        project: pick,
      });
      onDone(project, target);
    } catch (e) {
      setError(`转生失败：${errMsg(e)}`);
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
      <div className="dialog">
        <h2>{copy.title}</h2>
        <p className="hint">
          {card.title}
          {card.core && ` —— ${card.core}`}
        </p>
        {projects === null ? (
          <p className="hint">正在读取项目……</p>
        ) : projects.length === 0 ? (
          <p className="hint">
            还没有构思项目。先去「构思」板块新建一个项目（一本书），再回来转生。
          </p>
        ) : (
          <label>
            目标项目
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              {projects.map((p) => (
                <option key={p.dir} value={p.dir}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">
          会新建到 {copy.landing} 下：{copy.fields}。卡片留在灵感库，并在「关联」里记下去向
          「《书名》/{target === "单元" ? "单元名" : "人名"}」。
        </p>
        {error && <div className="error-box">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          {projects !== null && projects.length === 0 ? (
            <button
              className="btn primary"
              onClick={() => {
                onClose();
                onGoIdeation();
              }}
            >
              去构思板块新建
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !pick} onClick={() => void transmute()}>
              {busy ? "正在转生…" : "转生"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
