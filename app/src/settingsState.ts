export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type ThemePalette = "cinnabar" | "bamboo" | "indigo";

export type BuiltinBackground =
  | "素纸"
  | "宣纸"
  | "羊皮"
  | "豆沙绿"
  | "竹青"
  | "暮山";

export type EditorBackground =
  | { kind: "builtin"; id: BuiltinBackground }
  | { kind: "image"; path: string };

export type BodyFont = "system" | "宋" | "黑" | "楷";
export type ProseAlign = "left" | "center" | "right" | "justify";
export type SettingsTab = "appearance" | "editor" | "ai" | "library";

export interface AppSettings {
  palette: ThemePalette;
  theme: ThemeMode;
  background: EditorBackground;
  font: BodyFont;
  fontSize: number | null;
  lineHeight: number | null;
  align: ProseAlign;
  firstLineIndent: number;
  autosaveSec: number;
  chapterPrefix: string;
}

export const BUILTIN_BACKGROUNDS: BuiltinBackground[] = [
  "素纸",
  "宣纸",
  "羊皮",
  "豆沙绿",
  "竹青",
  "暮山",
];

export const DEFAULT_SETTINGS: AppSettings = {
  palette: "cinnabar",
  theme: "light",
  background: { kind: "builtin", id: "素纸" },
  font: "system",
  fontSize: null,
  lineHeight: null,
  align: "justify",
  firstLineIndent: 2,
  autosaveSec: 3,
  chapterPrefix: "第{n}章",
};

const PALETTES = new Set<ThemePalette>(["cinnabar", "bamboo", "indigo"]);
const THEMES = new Set<ThemeMode>(["light", "dark", "system"]);
const FONTS = new Set<BodyFont>(["system", "宋", "黑", "楷"]);
const ALIGNS = new Set<ProseAlign>(["left", "center", "right", "justify"]);
const AUTOSAVE_OPTIONS = new Set([1, 2, 3, 5, 10]);
const INDENTS = new Set([0, 1, 2, 3, 4]);
const SETTINGS_TABS = new Set<SettingsTab>(["appearance", "editor", "ai", "library"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBackground(value: unknown): EditorBackground {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS.background };
  if (
    value.kind === "builtin" &&
    typeof value.id === "string" &&
    BUILTIN_BACKGROUNDS.includes(value.id as BuiltinBackground)
  ) {
    return { kind: "builtin", id: value.id as BuiltinBackground };
  }
  if (value.kind === "image" && typeof value.path === "string" && value.path.trim()) {
    return { kind: "image", path: value.path };
  }
  return { ...DEFAULT_SETTINGS.background };
}

/** 兼容旧的无 palette 设置，并逐项隔离损坏字段。 */
export function normalizeSettings(value: unknown): AppSettings {
  const source = isRecord(value) ? value : {};
  return {
    palette: PALETTES.has(source.palette as ThemePalette)
      ? (source.palette as ThemePalette)
      : DEFAULT_SETTINGS.palette,
    theme: THEMES.has(source.theme as ThemeMode)
      ? (source.theme as ThemeMode)
      : DEFAULT_SETTINGS.theme,
    background: normalizeBackground(source.background),
    font: FONTS.has(source.font as BodyFont)
      ? (source.font as BodyFont)
      : DEFAULT_SETTINGS.font,
    fontSize:
      source.fontSize === null ||
      (typeof source.fontSize === "number" && source.fontSize >= 12 && source.fontSize <= 28)
        ? source.fontSize
        : DEFAULT_SETTINGS.fontSize,
    lineHeight:
      source.lineHeight === null ||
      (typeof source.lineHeight === "number" && source.lineHeight >= 1.2 && source.lineHeight <= 2.6)
        ? source.lineHeight
        : DEFAULT_SETTINGS.lineHeight,
    align: ALIGNS.has(source.align as ProseAlign)
      ? (source.align as ProseAlign)
      : DEFAULT_SETTINGS.align,
    firstLineIndent: INDENTS.has(source.firstLineIndent as number)
      ? (source.firstLineIndent as number)
      : DEFAULT_SETTINGS.firstLineIndent,
    autosaveSec: AUTOSAVE_OPTIONS.has(source.autosaveSec as number)
      ? (source.autosaveSec as number)
      : DEFAULT_SETTINGS.autosaveSec,
    chapterPrefix:
      typeof source.chapterPrefix === "string"
        ? source.chapterPrefix
        : DEFAULT_SETTINGS.chapterPrefix,
  };
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
}

export function normalizeSettingsTab(value: unknown): SettingsTab {
  return SETTINGS_TABS.has(value as SettingsTab) ? (value as SettingsTab) : "appearance";
}
