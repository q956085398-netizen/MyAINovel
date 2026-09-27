import { useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  BUILTIN_BACKGROUNDS,
  normalizeSettings,
  resolveThemeMode,
  type AppSettings,
  type BodyFont,
  type BuiltinBackground,
  type EditorBackground,
  type ProseAlign,
  type ResolvedTheme,
  type ThemeMode,
  type ThemePalette,
} from "./settingsState";

export {
  BUILTIN_BACKGROUNDS,
  type AppSettings,
  type BodyFont,
  type BuiltinBackground,
  type EditorBackground,
  type ProseAlign,
  type ResolvedTheme,
  type ThemeMode,
  type ThemePalette,
};

/** 应用设置（工单 #24 起，spec 个性化设置.md）：全部存前端应用状态
 *  （localStorage 单键 gongbi.settings），不进创作目录、Rust 不参与。
 *  默认值＝现状（浅色、素纸、既有排版），升级无感。
 *  组件经 useSettings 订阅；设置变化同时驱动 CSS 变量/根属性等副作用。 */

export const FONT_OPTIONS: { value: BodyFont; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "宋", label: "宋" },
  { value: "黑", label: "黑" },
  { value: "楷", label: "楷" },
];

/** 对齐（§四 v2，工单 #33）：视图层显示效果，不改动 md 内容；
 *  默认两端对齐（中文小说排版习惯）。 */
export const PROSE_ALIGNS: { value: ProseAlign; label: string }[] = [
  { value: "justify", label: "两端" },
  { value: "left", label: "左对齐" },
  { value: "center", label: "居中" },
  { value: "right", label: "右对齐" },
];

/** 首行缩进档位（§四 v2，工单 #33）：字符数，0＝关；默认 2（同只影响显示）。 */
export const INDENT_OPTIONS = [0, 1, 2, 3, 4] as const;

/** 字号/行距的滑选范围（工具栏下拉与设置面板滑杆共用一套边界）。 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const LINE_HEIGHT_MIN = 1.2;
export const LINE_HEIGHT_MAX = 2.6;
export const LINE_HEIGHT_STEP = 0.1;

/** 自动保存间隔档位（工单 #28，spec 拆书保存与模板 §二）：秒。 */
export const AUTOSAVE_OPTIONS = [1, 2, 3, 5, 10] as const;
export const DEFAULT_AUTOSAVE_SEC = 3;

/** 拆书·章前缀缺省（工单 #30，spec 拆书保存与模板 §六）：{n}＝章号占位。
 *  书 yaml 已有自定义 `章前缀` 键时继续优先生效（Rust 侧同规则回退默认）。 */
export const DEFAULT_CHAPTER_PREFIX = "第{n}章";

const KEY = "gongbi.settings";

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeSettings(null);
  }
}

let cache: AppSettings = load();
const listeners = new Set<() => void>();

export function getSettings(): AppSettings {
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 编辑器等需要随设置/主题变化重配的订阅口（含「跟随系统」切档）。 */
export const subscribeSettings = subscribe;

export function updateSettings(patch: Partial<AppSettings>) {
  cache = { ...cache, ...patch };
  localStorage.setItem(KEY, JSON.stringify(cache));
  listeners.forEach((l) => l());
  applyTheme();
  applyBackground();
}

export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const settings = useSyncExternalStore(subscribe, getSettings);
  return [settings, updateSettings];
}

/** 当前自动保存间隔（毫秒）：存坏/缺省回退默认——防抖计时永远拿得到数。 */
export function autosaveIntervalMs(): number {
  const sec = Number(cache.autosaveSec);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : DEFAULT_AUTOSAVE_SEC * 1000;
}

/** 当前拆书·章前缀（全局缺省）：空值回退默认；Rust 侧对空模板同规则。 */
export function chapterPrefixOrDefault(): string {
  const prefix = cache.chapterPrefix?.trim();
  return prefix ? prefix : DEFAULT_CHAPTER_PREFIX;
}

// --- 主题应用（§二）：根元素挂 data-theme，变量组按主题重定义 ---

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 三态解析：跟随系统时看系统深浅偏好，显式选浅/深则锁死手选。 */
export function resolvedTheme(mode: ThemeMode = cache.theme): ResolvedTheme {
  return resolveThemeMode(mode, systemDark());
}

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.dataset.palette = cache.palette;
}

/** 编辑器背景应用（§三）：根元素挂 data-editor-bg，纹理样式在 App.css；
 * 自定义图只把 asset 协议 URL 写进 --editor-bg-image（记路径不拷贝，
 * 图在库外——路径授权在选图时做）。 */
function applyBackground() {
  const root = document.documentElement;
  const bg = cache.background;
  root.dataset.editorBg = bg.kind === "builtin" ? bg.id : "image";
  if (bg.kind === "image") {
    root.style.setProperty("--editor-bg-image", `url("${convertFileSrc(bg.path)}")`);
  } else {
    root.style.removeProperty("--editor-bg-image");
  }
}

/** 应用启动时调用：初始应用主题/背景＋监听系统深浅变化（仅在「跟随系统」时生效）。
 *  系统切档也广播订阅——编辑器要跟着重配深色。 */
export function initSettings() {
  applyTheme();
  applyBackground();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (cache.theme !== "system") return;
    applyTheme();
    listeners.forEach((l) => l());
  });
}
