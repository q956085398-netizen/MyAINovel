import { useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

/** 应用设置（工单 #24 起，spec 个性化设置.md）：全部存前端应用状态
 *  （localStorage 单键 gongbi.settings），不进创作目录、Rust 不参与。
 *  默认值＝现状（浅色、素纸、既有排版），升级无感。
 *  组件经 useSettings 订阅；设置变化同时驱动 CSS 变量/根属性等副作用。 */

export type ThemeMode = "light" | "dark" | "system";

/** 内置六套编辑器纹理（§三）；素纸＝默认＝现行米白，等价于没开。 */
export type BuiltinBackground =
  | "素纸"
  | "宣纸"
  | "羊皮"
  | "豆沙绿"
  | "竹青"
  | "暮山";

export const BUILTIN_BACKGROUNDS: BuiltinBackground[] = [
  "素纸",
  "宣纸",
  "羊皮",
  "豆沙绿",
  "竹青",
  "暮山",
];

/** 编辑器背景：内置纹理，或自定义本地图片（只记路径、不拷贝——
 *  背景是装修不是数据，与「封面」的纪律相反）。 */
export type EditorBackground =
  | { kind: "builtin"; id: BuiltinBackground }
  | { kind: "image"; path: string };

/** 正文字体（§四）：四选一；「跟随系统」＝不动字体栈。 */
export type BodyFont = "system" | "宋" | "黑" | "楷";

/** 自动保存间隔档位（工单 #28，spec 拆书保存与模板 §二）：秒。 */
export const AUTOSAVE_OPTIONS = [1, 2, 3, 5, 10] as const;
export const DEFAULT_AUTOSAVE_SEC = 3;

/** 拆书·章前缀缺省（工单 #30，spec 拆书保存与模板 §六）：{n}＝章号占位。
 *  书 yaml 已有自定义 `章前缀` 键时继续优先生效（Rust 侧同规则回退默认）。 */
export const DEFAULT_CHAPTER_PREFIX = "第{n}章";

export interface AppSettings {
  /** 主题三态（§二）：浅｜深｜跟随系统；跟随＝监听系统深浅偏好。 */
  theme: ThemeMode;
  /** 编辑器背景（§三）：只铺拆书/书写两个编辑器，沉浸式。 */
  background: EditorBackground;
  /** 排版三件套（§四）：两个编辑器共用；null＝未设置＝各编辑器现状。 */
  font: BodyFont;
  fontSize: number | null;
  lineHeight: number | null;
  /** 自动保存间隔（秒）：拆书/书写两编辑器共用，停笔防抖落盘。 */
  autosaveSec: number;
  /** 拆书·章前缀（全局缺省）：开下一章/章标题识别用；空值回退默认。 */
  chapterPrefix: string;
}

const KEY = "gongbi.settings";

const DEFAULTS: AppSettings = {
  theme: "light",
  background: { kind: "builtin", id: "素纸" },
  font: "system",
  fontSize: null,
  lineHeight: null,
  autosaveSec: DEFAULT_AUTOSAVE_SEC,
  chapterPrefix: DEFAULT_CHAPTER_PREFIX,
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
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

export type ResolvedTheme = "light" | "dark";

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 三态解析：跟随系统时看系统深浅偏好，显式选浅/深则锁死手选。 */
export function resolvedTheme(mode: ThemeMode = cache.theme): ResolvedTheme {
  return mode === "system" ? (systemDark() ? "dark" : "light") : mode;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
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
