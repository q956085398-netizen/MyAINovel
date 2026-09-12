import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BUILTIN_BACKGROUNDS,
  useSettings,
  type BuiltinBackground,
  type ThemeMode,
} from "./settings";
import { errMsg } from "./util";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 设置面板（工单 #24 骨架，spec 个性化设置.md §五）：侧栏底部齿轮打开。
 *  条目：主题／编辑器背景／排版／库位置。 */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
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

        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
