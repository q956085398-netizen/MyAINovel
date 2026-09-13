import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AUTOSAVE_OPTIONS,
  BUILTIN_BACKGROUNDS,
  useSettings,
  type BuiltinBackground,
  type BodyFont,
  type ThemeMode,
} from "./settings";
import { errMsg } from "./util";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const FONT_OPTIONS: { value: BodyFont; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "宋", label: "宋" },
  { value: "黑", label: "黑" },
  { value: "楷", label: "楷" },
];

/** 设置面板（工单 #24 骨架，spec 个性化设置.md §五）：侧栏底部齿轮打开。
 *  条目：主题／编辑器背景／排版／库位置。库位置＝当前路径＋更改（沿用
 *  打开库逻辑）＋新建（选空文件夹设为当前库，工单 #21 动作）。 */
export default function SettingsDialog({
  libraryPath,
  onChooseFolder,
  onCreateLibrary,
  onClose,
}: {
  libraryPath: string | null;
  onChooseFolder: () => void;
  onCreateLibrary: () => void;
  onClose: () => void;
}) {
  const [settings, update] = useSettings();

  /** 自定义背景图（§三）：只记路径存应用状态、不拷进创作目录；
   *  图多在库外，选完顺手做 asset 路径授权。 */
  async function pickBackgroundImage() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      await invoke("grant_asset_scope", { path: picked });
      update({ background: { kind: "image", path: picked } });
    } catch (e) {
      window.alert(`选背景图失败：${errMsg(e)}`);
    }
  }

  const bgButton = (id: BuiltinBackground, label: string) => {
    const active =
      settings.background.kind === "builtin" && settings.background.id === id;
    return (
      <button
        key={id}
        type="button"
        className={`btn small ${active ? "primary" : ""}`}
        onClick={() => update({ background: { kind: "builtin", id } })}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog settings-dialog">
        <h2>设置</h2>

        <section className="settings-section">
          <h3>主题</h3>
          <p className="hint">全局配色（侧栏、列表、看板、AI 侧栏、对话框一起换）。</p>
          <div className="display-toggle" role="radiogroup" aria-label="主题">
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={settings.theme === o.value ? "active" : ""}
                onClick={() => update({ theme: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="hint">
            「跟随系统」时随系统深浅偏好自动切换；显式选浅色/深色则锁定手选。
          </p>
        </section>

        <section className="settings-section">
          <h3>编辑器背景</h3>
          <p className="hint">
            只铺拆书/书写两个编辑器（沉浸式，正文直接写在背景上）；管理页不铺。
            深色模式下浅色纹理自动换深色调。
          </p>
          <div className="settings-chip-row">
            {bgButton("素纸", "素纸（默认）")}
            {BUILTIN_BACKGROUNDS.filter((id) => id !== "素纸").map((id) => bgButton(id, id))}
            <button
              type="button"
              className={`btn small ${
                settings.background.kind === "image" ? "primary" : ""
              }`}
              onClick={() => void pickBackgroundImage()}
            >
              自定义图片…
            </button>
          </div>
          {settings.background.kind === "image" && (
            <p className="hint" title={settings.background.path}>
              当前背景图：{settings.background.path}（只记路径，不拷进库里）
            </p>
          )}
        </section>

        <section className="settings-section">
          <h3>排版</h3>
          <p className="hint">
            拆书与书写两个编辑器共用；与书写板块的打字机滚动/沉浸模式互不影响。
            未调整时保持各编辑器现状。
          </p>
          <div className="settings-field">
            <span className="settings-label">字体</span>
            <div className="display-toggle" role="radiogroup" aria-label="正文字体">
              {FONT_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={settings.font === o.value ? "active" : ""}
                  onClick={() => update({ font: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-field">
            <span className="settings-label">字号</span>
            <input
              type="range"
              min={12}
              max={28}
              step={1}
              value={settings.fontSize ?? 16}
              onChange={(e) => update({ fontSize: Number(e.target.value) })}
            />
            <span className="settings-value">
              {settings.fontSize != null ? `${settings.fontSize}px` : "默认"}
            </span>
            <button
              type="button"
              className="btn small"
              disabled={settings.fontSize == null}
              onClick={() => update({ fontSize: null })}
            >
              恢复默认
            </button>
          </div>
          <div className="settings-field">
            <span className="settings-label">行距</span>
            <input
              type="range"
              min={1.2}
              max={2.6}
              step={0.1}
              value={settings.lineHeight ?? 1.9}
              onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            />
            <span className="settings-value">
              {settings.lineHeight != null ? settings.lineHeight.toFixed(1) : "默认"}
            </span>
            <button
              type="button"
              className="btn small"
              disabled={settings.lineHeight == null}
              onClick={() => update({ lineHeight: null })}
            >
              恢复默认
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3>自动保存</h3>
          <p className="hint">
            拆书与书写两个编辑器共用：停笔满所选间隔自动落盘，返回/切板块/关窗时立即保存。
          </p>
          <div className="display-toggle" role="radiogroup" aria-label="自动保存间隔">
            {AUTOSAVE_OPTIONS.map((sec) => (
              <button
                key={sec}
                type="button"
                className={settings.autosaveSec === sec ? "active" : ""}
                onClick={() => update({ autosaveSec: sec })}
              >
                {sec} 秒
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>拆书 · 章前缀</h3>
          <p className="hint">
            「开下一章」与章标题识别的模板，{`{n}`} 为章号占位；留空用默认「第{"{n}"}章」。
            某本书 yaml 里已自定义的章前缀继续优先。
          </p>
          <input
            className="settings-input"
            value={settings.chapterPrefix}
            placeholder="第{n}章"
            onChange={(e) => update({ chapterPrefix: e.target.value })}
          />
        </section>

        <section className="settings-section">
          <h3>库位置</h3>
          <p className="hint" title={libraryPath ?? undefined}>
            {libraryPath ?? "还没有库——选一个文件夹开始，或新建一个空库。"}
          </p>
          <div className="settings-chip-row">
            <button type="button" className="btn small" onClick={onChooseFolder}>
              更改
            </button>
            <button type="button" className="btn small" onClick={onCreateLibrary}>
              新建
            </button>
          </div>
        </section>

        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
