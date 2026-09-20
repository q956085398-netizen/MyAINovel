import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Icon, ICON_SIZE_DENSE } from "./icons";
import OptionToggle from "./OptionToggle";
import { ProviderSettingsForm } from "./ProviderSettingsDialog";
import {
  AUTOSAVE_OPTIONS,
  BUILTIN_BACKGROUNDS,
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  INDENT_OPTIONS,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_STEP,
  PROSE_ALIGNS,
  useSettings,
  type BuiltinBackground,
  type ThemeMode,
  type ThemePalette,
} from "./settings";
import { settingsTabForEntry, type SettingsTab } from "./settingsState";
import type { AiConfig } from "./types";
import { errMsg } from "./util";

const TAB_KEY = "gongbi.settingsTab";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "editor", label: "编辑器" },
  { id: "ai", label: "AI" },
  { id: "library", label: "库与数据" },
];

const PALETTES: {
  value: ThemePalette;
  label: string;
  description: string;
  colors: [string, string, string];
}[] = [
  {
    value: "cinnabar",
    label: "朱砂纸墨",
    description: "温暖沉静，重点动作带手稿批注般的朱砂感。",
    colors: ["#292823", "#f3efe7", "#ae432e"],
  },
  {
    value: "bamboo",
    label: "竹青松烟",
    description: "灰青纸面与低饱和竹青，适合梳理复杂构思。",
    colors: ["#18302e", "#e8ece9", "#2f6f68"],
  },
  {
    value: "indigo",
    label: "靛青月白",
    description: "冷月白与克制靛蓝，更安静、更偏阅读。",
    colors: ["#1e2735", "#f1eee9", "#334f78"],
  },
];

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const INDENT_TOGGLE_OPTIONS = INDENT_OPTIONS.map((n) => ({
  value: n as number,
  label: n === 0 ? "关" : `${n} 字符`,
}));

export default function SettingsPage({
  libraryPath,
  onChooseFolder,
  onCreateLibrary,
  onBack,
  requestedTab,
}: {
  libraryPath: string | null;
  onChooseFolder: () => void;
  onCreateLibrary: () => void;
  onBack: () => void;
  requestedTab: SettingsTab | null;
}) {
  const [settings, update] = useSettings();
  const [tab, setTab] = useState<SettingsTab>(() =>
    settingsTabForEntry(localStorage.getItem(TAB_KEY), requestedTab),
  );
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    if (requestedTab) selectTab(requestedTab);
  }, [requestedTab]);

  useEffect(() => {
    if (tab !== "ai" || aiConfig) return;
    void invoke<AiConfig>("load_ai_config")
      .then((config) => {
        setAiConfig(config);
        setAiError(null);
      })
      .catch((error) => setAiError(errMsg(error)));
  }, [aiConfig, tab]);

  function selectTab(next: SettingsTab) {
    localStorage.setItem(TAB_KEY, next);
    setTab(next);
  }

  async function pickBackgroundImage() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      await invoke("grant_asset_scope", { path: picked });
      update({ background: { kind: "image", path: picked } });
    } catch (error) {
      window.alert(`选背景图失败：${errMsg(error)}`);
    }
  }

  const bgButton = (id: BuiltinBackground, label: string) => {
    const active = settings.background.kind === "builtin" && settings.background.id === id;
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
    <section className="settings-page" aria-label="设置">
      <header className="settings-page-header">
        <button className="btn with-icon" onClick={onBack}>
          <Icon as={ArrowLeft} size={ICON_SIZE_DENSE} />
          返回
        </button>
        <div>
          <h1>设置</h1>
          <p>应用偏好只保存在本机，不会写进创作库。</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分类">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {tab === "appearance" && (
            <>
              <section className="settings-section">
                <h2>界面配色</h2>
                <p className="hint">配色与明暗模式相互独立；切换配色不会改变编辑器背景。</p>
                <div className="palette-grid" role="radiogroup" aria-label="界面配色">
                  {PALETTES.map((palette) => (
                    <button
                      key={palette.value}
                      className={`palette-option ${settings.palette === palette.value ? "active" : ""}`}
                      role="radio"
                      aria-checked={settings.palette === palette.value}
                      onClick={() => update({ palette: palette.value })}
                    >
                      <span className="palette-swatches" aria-hidden="true">
                        {palette.colors.map((color) => (
                          <i key={color} style={{ background: color }} />
                        ))}
                      </span>
                      <strong>{palette.label}</strong>
                      <span>{palette.description}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <h2>明暗模式</h2>
                <div className="display-toggle" role="radiogroup" aria-label="明暗模式">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={settings.theme === option.value ? "active" : ""}
                      onClick={() => update({ theme: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="hint">只有选择「跟随系统」时，系统深浅变化才会同步到工笔。</p>
              </section>

              <section className="settings-section">
                <h2>编辑器背景</h2>
                <p className="hint">只铺拆书与书写编辑器；自定义图片只记路径，不复制进库。</p>
                <div className="settings-chip-row">
                  {bgButton("素纸", "素纸（默认）")}
                  {BUILTIN_BACKGROUNDS.filter((id) => id !== "素纸").map((id) => bgButton(id, id))}
                  <button
                    className={`btn small ${settings.background.kind === "image" ? "primary" : ""}`}
                    onClick={() => void pickBackgroundImage()}
                  >
                    自定义图片…
                  </button>
                </div>
                {settings.background.kind === "image" && (
                  <p className="hint settings-path" title={settings.background.path}>
                    当前背景图：{settings.background.path}
                  </p>
                )}
              </section>
            </>
          )}

          {tab === "editor" && (
            <>
              <section className="settings-section">
                <h2>正文排版</h2>
                <p className="hint">拆书与书写编辑器共用；只改变显示，不改动 Markdown 正文。</p>
                <div className="settings-field">
                  <span className="settings-label">字体</span>
                  <div className="display-toggle" role="radiogroup" aria-label="正文字体">
                    {FONT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        className={settings.font === option.value ? "active" : ""}
                        onClick={() => update({ font: option.value })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-field">
                  <span className="settings-label">字号</span>
                  <input
                    type="range"
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    value={settings.fontSize ?? 16}
                    onChange={(event) => update({ fontSize: Number(event.target.value) })}
                  />
                  <span className="settings-value">{settings.fontSize == null ? "默认" : `${settings.fontSize}px`}</span>
                  <button className="btn small" disabled={settings.fontSize == null} onClick={() => update({ fontSize: null })}>恢复默认</button>
                </div>
                <div className="settings-field">
                  <span className="settings-label">行距</span>
                  <input
                    type="range"
                    min={LINE_HEIGHT_MIN}
                    max={LINE_HEIGHT_MAX}
                    step={LINE_HEIGHT_STEP}
                    value={settings.lineHeight ?? 1.9}
                    onChange={(event) => update({ lineHeight: Number(event.target.value) })}
                  />
                  <span className="settings-value">{settings.lineHeight == null ? "默认" : settings.lineHeight.toFixed(1)}</span>
                  <button className="btn small" disabled={settings.lineHeight == null} onClick={() => update({ lineHeight: null })}>恢复默认</button>
                </div>
                <div className="settings-field">
                  <span className="settings-label">对齐</span>
                  <OptionToggle label="对齐方式" value={settings.align} options={PROSE_ALIGNS} onChange={(align) => update({ align })} />
                </div>
                <div className="settings-field">
                  <span className="settings-label">首行缩进</span>
                  <OptionToggle label="首行缩进" value={settings.firstLineIndent} options={INDENT_TOGGLE_OPTIONS} onChange={(firstLineIndent) => update({ firstLineIndent })} />
                </div>
              </section>

              <section className="settings-section">
                <h2>保存与章节</h2>
                <div className="settings-field settings-field-stacked">
                  <span className="settings-label">自动保存</span>
                  <div className="display-toggle" role="radiogroup" aria-label="自动保存间隔">
                    {AUTOSAVE_OPTIONS.map((seconds) => (
                      <button key={seconds} className={settings.autosaveSec === seconds ? "active" : ""} onClick={() => update({ autosaveSec: seconds })}>{seconds} 秒</button>
                    ))}
                  </div>
                </div>
                <label className="settings-text-field">
                  <span>拆书 · 章前缀</span>
                  <input className="settings-input" value={settings.chapterPrefix} placeholder="第{n}章" onChange={(event) => update({ chapterPrefix: event.target.value })} />
                  <small>{`{n}`} 为章号占位；留空时实际使用默认「第{`{n}`}章」。</small>
                </label>
              </section>
            </>
          )}

          {tab === "ai" && (
            <section className="settings-section">
              {aiConfig && <ProviderSettingsForm initial={aiConfig} onSaved={setAiConfig} />}
              {!aiConfig && !aiError && <p className="hint">正在读取供应商设置…</p>}
              {aiError && <div className="error-box">读取供应商设置失败：{aiError}</div>}
              <div className="settings-note">
                <h3>上下文与隐私</h3>
                <p>普通对话只在你主动勾选时携带当前文档；固定 AI 命令只发送命令所需材料。供应商会收到你明确发送的内容。</p>
                <p className="hint">AI 助手预设将在后续工单中加入本页，不会重新放回对话侧栏。</p>
              </div>
            </section>
          )}

          {tab === "library" && (
            <section className="settings-section">
              <h2>当前库</h2>
              <p className="settings-library-path" title={libraryPath ?? undefined}>
                {libraryPath ?? "还没有库——选一个文件夹开始，或新建一个空库。"}
              </p>
              <div className="settings-chip-row">
                <button className="btn" onClick={onChooseFolder}>更改库位置</button>
                <button className="btn" onClick={onCreateLibrary}>新建空库</button>
              </div>
              <div className="settings-note">
                <h3>数据边界</h3>
                <p>创作内容仍以 Markdown、YAML 与附件为唯一来源；界面配色、编辑器背景和页签位置只保存在本机应用状态。</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
