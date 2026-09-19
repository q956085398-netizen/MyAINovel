import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GeoUpgradePreview, GeoUpgradeTarget, NoteEntry } from "./types";
import { errMsg } from "./util";

interface GeoUpgradeDialogProps {
  project: string;
  source: NoteEntry;
  onClose: () => void;
  onUpgraded: () => void;
}

/** 旧世界观「地理」词条的显式升级闸：先只读预览，再确认落盘。 */
export default function GeoUpgradeDialog({
  project,
  source,
  onClose,
  onUpgraded,
}: GeoUpgradeDialogProps) {
  const [target, setTarget] = useState<GeoUpgradeTarget>("地图");
  const [preview, setPreview] = useState<GeoUpgradePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    void invoke<GeoUpgradePreview>("preview_geo_upgrade", {
      project,
      source: source.path,
      target,
    })
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(`无法升级：${errMsg(reason)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [project, source.path, target]);

  async function confirm() {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await invoke("confirm_geo_upgrade", { project, source: source.path, target });
      onUpgraded();
    } catch (reason) {
      setError(`升级失败：${errMsg(reason)}`);
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog">
        <h2>升级地理词条</h2>
        <p>
          「{source.name}」会从旧世界观词条升级为独立空间实体。请先选择它在故事里的尺度：
        </p>
        <label>
          升级为
          <select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value as GeoUpgradeTarget)}>
            <option value="地图">地图（整体故事空间）</option>
            <option value="地域">地域（地图内部的局部区域）</option>
          </select>
        </label>
        {error && <div className="error-box">{error}</div>}
        {!error && !preview && <p className="hint">正在检查目标位置……</p>}
        {preview && (
          <div className="hint-box">
            <p>将创建：{preview.targetPath}</p>
            <p>旧词条会移入可恢复备份：{preview.backupPath}</p>
            <p>词条正文与手补字段会保留。取消不会改动任何文件。</p>
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!preview || busy} onClick={() => void confirm()}>
            {busy ? "正在升级…" : "确认升级"}
          </button>
        </div>
      </div>
    </div>
  );
}
