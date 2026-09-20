import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeSettingsTab,
  resolveThemeMode,
} from "../src/settingsState.ts";

test("旧设置升级到朱砂纸墨且保留自定义编辑器背景", () => {
  const settings = normalizeSettings({
    theme: "dark",
    background: { kind: "image", path: "D:\\纸纹\\夜色.webp" },
    font: "楷",
    fontSize: 18,
  });

  assert.equal(settings.palette, "cinnabar");
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.background, {
    kind: "image",
    path: "D:\\纸纹\\夜色.webp",
  });
  assert.equal(settings.font, "楷");
  assert.equal(settings.fontSize, 18);
  assert.equal(settings.autosaveSec, 3);
});

test("损坏字段逐项回退，不抹掉仍然有效的旧字段", () => {
  const settings = normalizeSettings({
    palette: "不存在的配色",
    theme: "午夜",
    background: { kind: "builtin", id: "宣纸" },
    align: "diagonal",
    firstLineIndent: 99,
    autosaveSec: 0,
    chapterPrefix: 42,
  });

  assert.equal(settings.palette, DEFAULT_SETTINGS.palette);
  assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
  assert.deepEqual(settings.background, { kind: "builtin", id: "宣纸" });
  assert.equal(settings.align, DEFAULT_SETTINGS.align);
  assert.equal(settings.firstLineIndent, DEFAULT_SETTINGS.firstLineIndent);
  assert.equal(settings.autosaveSec, DEFAULT_SETTINGS.autosaveSec);
  assert.equal(settings.chapterPrefix, DEFAULT_SETTINGS.chapterPrefix);
});

test("只有跟随系统会响应系统明暗变化", () => {
  assert.equal(resolveThemeMode("system", true), "dark");
  assert.equal(resolveThemeMode("system", false), "light");
  assert.equal(resolveThemeMode("light", true), "light");
  assert.equal(resolveThemeMode("dark", false), "dark");
});

test("设置页只接受四个一级页签，旧值回到外观", () => {
  for (const tab of ["appearance", "editor", "ai", "library"] as const) {
    assert.equal(normalizeSettingsTab(tab), tab);
  }
  assert.equal(normalizeSettingsTab("providers"), "appearance");
  assert.equal(normalizeSettingsTab(null), "appearance");
});
