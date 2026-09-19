import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MapDraft, MapEntry } from "./types";
import { PLACE_SCALES } from "./types";
import { errMsg, splitList } from "./util";
import { dirName } from "./editorRender";
import MarkdownEditor from "./MarkdownEditor";
import VocabInput from "./VocabInput";

interface MapDialogProps {
  project: string;
  initial: MapDraft;
  /** 编辑既有地图时的文件位置；null 为新建。 */
  prevPath: string | null;
  onClose: () => void;
  onSaved: (entry: MapEntry) => void;
  onDeleted: (path: string) => void;
}

/** 地图档案编辑框（工单 #65 / T15）：整体故事空间的完整档案。
 *  保存写入 构思/地图/<名>.md，frontmatter 中文键、未知键（如背景图）保留。 */
export default function MapDialog({
  project,
  initial,
  prevPath,
  onClose,
  onSaved,
  onDeleted,
}: MapDialogProps) {
  const [name, setName] = useState(initial.name);
  const [scale, setScale] = useState(initial.scale ?? "");
  const [boundary, setBoundary] = useState(initial.boundary ?? "");
  const [erasText, setErasText] = useState(initial.eras.join("、"));
  const [role, setRole] = useState(initial.role ?? "");
  const [stageGoal, setStageGoal] = useState(initial.stageGoal ?? "");
  const [centralConflict, setCentralConflict] = useState(initial.centralConflict ?? "");
  const [coreSecret, setCoreSecret] = useState(initial.coreSecret ?? "");
  const [localMainline, setLocalMainline] = useState(initial.localMainline ?? "");
  const [entryCondition, setEntryCondition] = useState(initial.entryCondition ?? "");
  const [exitCondition, setExitCondition] = useState(initial.exitCondition ?? "");
  const [peopleText, setPeopleText] = useState(initial.people.join("、"));
  const [orgsText, setOrgsText] = useState(initial.organizations.join("、"));
  const [unitsText, setUnitsText] = useState(initial.units.join("、"));
  const [milestonesText, setMilestonesText] = useState(initial.milestones.join("、"));
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    const draft: MapDraft = {
      name: name.trim(),
      scale: scale.trim() || null,
      boundary: boundary.trim() || null,
      eras: splitList(erasText),
      role: role.trim() || null,
      stageGoal: stageGoal.trim() || null,
      centralConflict: centralConflict.trim() || null,
      coreSecret: coreSecret.trim() || null,
      localMainline: localMainline.trim() || null,
      entryCondition: entryCondition.trim() || null,
      exitCondition: exitCondition.trim() || null,
      people: splitList(peopleText),
      organizations: splitList(orgsText),
      units: splitList(unitsText),
      milestones: splitList(milestonesText),
      body,
    };
    if (!draft.name) {
      window.alert("地图名不能为空。");
      return;
    }
    setBusy(true);
    try {
      const entry = await invoke<MapEntry>("save_map", { project, draft, prevPath });
      onSaved(entry);
    } catch (e) {
      window.alert(`地图保存失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!prevPath || busy) return;
    if (
      !window.confirm(
        `确定删除地图「${name.trim() || initial.name}」？\n${prevPath}\n` +
          "删除的是档案文件；结构表里指向它的包含、关系与转场不会自动清理（照常显示缺省节点）。",
      )
    )
      return;
    setBusy(true);
    try {
      await invoke("delete_map_place", { path: prevPath });
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
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog wide">
        <h2>{prevPath ? "编辑地图" : "新建地图"}</h2>
        <label>
          地图名（标题即文件名）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：大墟"
            autoFocus
          />
        </label>
        <label>
          整体尺度（只提示，可自由输入）
          <VocabInput
            value={scale}
            onChange={setScale}
            words={PLACE_SCALES}
            placeholder="地点 / 村落 / 城镇 / 城市 / 区域 / 国家 / 世界 / 异界"
          />
        </label>
        <label>
          边界（这个世界到哪儿为止）
          <input
            value={boundary}
            onChange={(e) => setBoundary(e.target.value)}
            placeholder="如：四周环海，唯一陆桥通外界"
          />
        </label>
        <label>
          时代（多个用、隔开；在「历史」页签按时代查看）
          <input
            value={erasText}
            onChange={(e) => setErasText(e.target.value)}
            placeholder="如：上古、今朝"
          />
        </label>
        <label>
          作用（这张地图在全书里的位置）
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="如：核心 / 过场 / 终局舞台"
          />
        </label>
        <label>
          阶段目标
          <input
            value={stageGoal}
            onChange={(e) => setStageGoal(e.target.value)}
            placeholder="如：主角在大墟之外建立自己的力量"
          />
        </label>
        <label>
          中心矛盾
          <input
            value={centralConflict}
            onChange={(e) => setCentralConflict(e.target.value)}
            placeholder="如：大墟的真相与外部秩序冲突"
          />
        </label>
        <label>
          核心秘密
          <input
            value={coreSecret}
            onChange={(e) => setCoreSecret(e.target.value)}
            placeholder="如：大墟本身就是封印"
          />
        </label>
        <label>
          当地主线
          <input
            value={localMainline}
            onChange={(e) => setLocalMainline(e.target.value)}
            placeholder="如：每次远行后回到大墟揭开一层秘密"
          />
        </label>
        <div className="form-row">
          <label>
            进入条件
            <input
              value={entryCondition}
              onChange={(e) => setEntryCondition(e.target.value)}
              placeholder="什么把人物带进来"
            />
          </label>
          <label>
            离开条件
            <input
              value={exitCondition}
              onChange={(e) => setExitCondition(e.target.value)}
              placeholder="什么允许人物离开"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            人物（多个用、隔开）
            <input
              value={peopleText}
              onChange={(e) => setPeopleText(e.target.value)}
              placeholder="如：主角、师姐"
            />
          </label>
          <label>
            组织（多个用、隔开）
            <input
              value={orgsText}
              onChange={(e) => setOrgsText(e.target.value)}
              placeholder="如：巡山司"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            单元（多个用、隔开）
            <input
              value={unitsText}
              onChange={(e) => setUnitsText(e.target.value)}
              placeholder="发生在这张地图的单元"
            />
          </label>
          <label>
            主线里程碑（多个用、隔开）
            <input
              value={milestonesText}
              onChange={(e) => setMilestonesText(e.target.value)}
              placeholder="如：封印松动"
            />
          </label>
        </div>
        <label>
          正文（氛围、来历、尚未解决的问题……）
          <MarkdownEditor
            value={body}
            onChange={setBody}
            height="200px"
            resolveDir={prevPath ? dirName(prevPath) : undefined}
          />
        </label>
        <p className="hint">
          保存写入 构思/地图/{name.trim() || "地图名"}.md；同名自动续号，在 Obsidian
          里手补的字段（如背景图）不会丢。
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
