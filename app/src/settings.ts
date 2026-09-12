import { useSyncExternalStore } from "react";

/** 应用设置（工单 #24 起，spec 个性化设置.md）：全部存前端应用状态
 *  （localStorage 单键 gongbi.settings），不进创作目录、Rust 不参与。
 *  默认值＝现状（浅色、素纸、既有排版），升级无感。
 *  组件经 useSettings 订阅；设置变化同时驱动 CSS 变量/根属性等副作用。 */

export type ThemeMode = "light" | "dark" | "system";

export interface AppSettings {
  /** 主题三态（§二）：浅｜深｜跟随系统；跟随＝监听系统深浅偏好。 */
  theme: ThemeMode;
}

const KEY = "gongbi.settings";

const DEFAULTS: AppSettings = {
  theme: "light",
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
}

export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const settings = useSyncExternalStore(subscribe, getSettings);
  return [settings, updateSettings];
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

/** 应用启动时调用：初始应用主题＋监听系统深浅变化（仅在「跟随系统」时生效）。
 *  系统切档也广播订阅——编辑器要跟着重配深色。 */
export function initSettings() {
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (cache.theme !== "system") return;
    applyTheme();
    listeners.forEach((l) => l());
  });
}
