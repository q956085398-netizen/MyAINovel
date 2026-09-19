import assert from "node:assert/strict";
import test from "node:test";

import {
  nextMenuIndex,
  saveChipInteractive,
  saveStatusLabel,
  saveStatusAfterEdit,
  type SaveStatus,
} from "../src/editorHeaderState.ts";

const ALL_STATUSES: SaveStatus[] = ["saved", "dirty", "saving", "error", "conflict"];

test("保存五态文案互不相同（均可辨认）", () => {
  const labels = ALL_STATUSES.map(saveStatusLabel);
  assert.equal(new Set(labels).size, ALL_STATUSES.length);
});

test("打字进入未保存；冲突未裁决时保持冲突", () => {
  assert.equal(saveStatusAfterEdit("saved"), "dirty");
  assert.equal(saveStatusAfterEdit("dirty"), "dirty");
  // 保存往返窗口里又打过字：仍算未保存，留给下一轮自动保存。
  assert.equal(saveStatusAfterEdit("saving"), "dirty");
  assert.equal(saveStatusAfterEdit("error"), "dirty");
  // 冲突挂着自动保存暂停：继续打字不悄悄改判成普通未保存。
  assert.equal(saveStatusAfterEdit("conflict"), "conflict");
});

test("状态胶囊只在有待落盘/待处理时可点击", () => {
  assert.equal(saveChipInteractive("saved"), false);
  assert.equal(saveChipInteractive("saving"), false);
  assert.equal(saveChipInteractive("dirty"), true);
  assert.equal(saveChipInteractive("error"), true);
  assert.equal(saveChipInteractive("conflict"), true);
});

test("菜单导航：上下移动并跳过禁用项", () => {
  // [可用, 禁用, 可用]
  const enabled = [true, false, true];
  assert.equal(nextMenuIndex(enabled, 0, "ArrowDown"), 2);
  assert.equal(nextMenuIndex(enabled, 2, "ArrowDown"), 0); // 环形回绕
  assert.equal(nextMenuIndex(enabled, 2, "ArrowUp"), 0);
  assert.equal(nextMenuIndex(enabled, 0, "ArrowUp"), 2);
});

test("菜单导航：刚打开（from=-1）与 Home/End", () => {
  const enabled = [false, true, true, false];
  assert.equal(nextMenuIndex(enabled, -1, "ArrowDown"), 1);
  assert.equal(nextMenuIndex(enabled, -1, "ArrowUp"), 2);
  assert.equal(nextMenuIndex(enabled, 3, "Home"), 1);
  assert.equal(nextMenuIndex(enabled, 0, "End"), 2);
});

test("菜单导航：没有可用项返回 -1；空菜单安全", () => {
  assert.equal(nextMenuIndex([false, false], 0, "ArrowDown"), -1);
  assert.equal(nextMenuIndex([], -1, "ArrowDown"), -1);
});
