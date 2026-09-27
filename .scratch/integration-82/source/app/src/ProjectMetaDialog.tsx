import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlotLine, ProjectMeta } from "./types";
import { errMsg } from "./util";

interface ProjectMetaDialogProps {
  project: string;
  initial: ProjectMeta;
  /** 文件夹名（书名留空时按它显示）。 */
  fallbackTitle: string;
  /** 项目.yaml 解析失败时的警告（保存会整文件覆盖）。 */
  warning?: string;
  onClose: () => void;
  onSaved: (meta: ProjectMeta) => void;
}

/** 项目资料（项目.yaml）：书名、章前缀、情节线、地图。文件懒生成；
 *  保存以现有 yaml 为底合并，手补的未知键不丢。 */
export default function ProjectMetaDialog({
  project,
  initial,
  fallbackTitle,
  warning,
  onClose,
  onSaved,
}: ProjectMetaDialogProps) {
  const [title, setTitle] = useState(initial.title ?? "");
  const [prefix, setPrefix] = useState(initial.chapterPrefix ?? "");
  const [lines, setLines] = useState<PlotLine[]>(initial.plotLines);
  const [mapsText, setMapsText] = useState(initial.maps.join("\n"));
  const [busy, setBusy] = useState(false);

  function updateLine(index: number, patch: Partial<PlotLine>) {
    setLines((list) => list.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function save() {
    if (busy) return;
    const meta: ProjectMeta = {
      title: title.trim() || null,
      chapterPrefix: prefix.trim() || null,
      plotLines: lines
        .map((l) => ({ ...l, name: l.name.trim(), color: l.color?.trim() || null }))
        .filter((l) => l.name),
      maps: mapsText
        .split("\n")
        .map((m) => m.trim())
        .filter(Boolean),
    };
    setBusy(true);
    try {
      await invoke("save_project_meta", { project, meta });
      onSaved(meta);
    } catch (e) {
      window.alert(`项目资料保存失败：${errMsg(e)}`);
    } finally {
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
        <h2>项目资料</h2>
        {warning && <div className="error-box">{warning}</div>}
        <label>
          书名
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`留空＝文件夹名「${fallbackTitle}」`}
            autoFocus
          />
        </label>
        <label>
          章前缀
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="留空＝第{n}章（{n} 为章号占位）"
          />
        </label>
        <div className="field">
          情节线（排布视图的行；名＋色可选）
          {lines.map((line, i) => (
            <div key={i} className="line-row">
              <input
                value={line.name}
                onChange={(e) => updateLine(i, { name: e.target.value })}
                placeholder="主线"
              />
              <input
                value={line.color ?? ""}
                onChange={(e) => updateLine(i, { color: e.target.value })}
                placeholder="#c0392b"
              />
              <button
                className="btn small"
                onClick={() => setLines((list) => list.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => setLines((list) => [...list, { name: "", color: null }])}
          >
            + 添加情节线
          </button>
        </div>
        <label>
          地图（一行一个；排布按名引用，世界观「地理」词条也算）
          <textarea
            className="links-input"
            value={mapsText}
            onChange={(e) => setMapsText(e.target.value)}
            placeholder={"京城\n江南\n北境"}
            rows={4}
          />
        </label>
        <p className="hint">保存写入 项目.yaml；未知键原样保留，可在 Obsidian 里手改。</p>
        <div className="dialog-actions">
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
