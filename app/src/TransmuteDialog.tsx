import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InspirationCard, NoteEntry, ProjectEntry } from "./types";
import { errMsg } from "./util";

interface TransmuteDialogProps {
  libraryPath: string;
  card: InspirationCard;
  onClose: () => void;
  /** 没有项目时：关掉对话框并切到「构思」板块去新建。 */
  onGoIdeation: () => void;
  /** 转生成功：上层刷新卡片列表，并跳到该项目的「单元」页。 */
  onDone: (project: ProjectEntry) => void;
}

/** 故事卡转生单元草稿（工单 #9，docs/spec/故事卡转生.md）：选目标项目 →
 *  建 构思/单元/<卡片标题>.md（核心矛盾＝一句话核心、类型＝标签、正文给骨架），
 *  卡片「关联」记去向「《书名》/单元名」。转生即断链，改卡片不同步。 */
export default function TransmuteDialog({
  libraryPath,
  card,
  onClose,
  onGoIdeation,
  onDone,
}: TransmuteDialogProps) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<ProjectEntry[]>("scan_projects", { root: libraryPath })
      .then((list) => {
        if (!alive) return;
        setProjects(list);
        setTarget(list[0]?.dir ?? "");
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
    const project = projects?.find((p) => p.dir === target);
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke<NoteEntry>("transmute_story_card", {
        root: libraryPath,
        cardPath: card.path,
        project: target,
      });
      onDone(project);
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
        <h2>转生为单元草稿</h2>
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
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {projects.map((p) => (
                <option key={p.dir} value={p.dir}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">
          会新建到 构思/单元/ 下：核心矛盾＝一句话核心、类型＝标签，正文只给
          「桥段安排」骨架。卡片留在灵感库，并在「关联」里记下去向「《书名》/单元名」。
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
            <button className="btn primary" disabled={busy || !target} onClick={() => void transmute()}>
              {busy ? "正在转生…" : "转生"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
