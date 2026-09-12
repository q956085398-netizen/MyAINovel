import { useSettings, type ThemeMode } from "./settings";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 设置面板（工单 #24 骨架，spec 个性化设置.md §五）：侧栏底部齿轮打开。
 *  条目：主题／编辑器背景／排版／库位置——本片先交主题，其余条目随后补。 */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, update] = useSettings();

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

        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
