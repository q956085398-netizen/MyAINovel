import "./helpers/installDom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import NoteList from "../src/NoteList.tsx";
import { emptyBridgeDraft, emptyNoteDraft, type Bridge, type NoteEntry } from "../src/types.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("单元内桥段按人工次序展示并对原文件移动和取消安排", async () => {
  const unit: NoteEntry = { ...emptyNoteDraft("单元"), name: "初入京城", path: "项目/构思/单元/初入京城.md", pending: false };
  let bridges: Bridge[] = [
    { ...emptyBridgeDraft("第二段"), unit: unit.name, order: 2, path: "项目/构思/桥段/二.md", pending: false, body: "第二段完整正文" },
    { ...emptyBridgeDraft("第一段"), unit: unit.name, order: 1, path: "项目/构思/桥段/一.md", pending: false, priorDesire: "先保住身份" },
  ];
  const calls: { command: string; path?: unknown }[] = [];
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
  tauri.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
    calls.push({ command, path: args.path });
    if (command === "scan_notes") return [unit];
    if (command === "scan_bridges") return structuredClone(bridges);
    if (command === "move_bridge") {
      bridges = bridges.map((bridge) => ({ ...bridge, order: bridge.order === 1 ? 2 : 1 }));
      return bridges;
    }
    if (command === "unarrange_bridge") {
      bridges = bridges.map((bridge) => bridge.path === args.path ? { ...bridge, unit: null, order: null } : bridge);
      return bridges.find((bridge) => bridge.path === args.path);
    }
    throw new Error(`未预期命令：${command}`);
  } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
  const cards = () => Array.from(container.querySelectorAll(".unit-bridges .bridge-card"));
  async function click(card: Element, label: string) {
    const button = Array.from(card.querySelectorAll("button")).find((node) => node.textContent === label);
    assert.ok(button);
    await act(async () => { button.click(); await flush(); });
  }
  try {
    await act(async () => {
      root.render(createElement(NoteList, { project: "项目", kind: "单元", vocab: null, orderedNames: [unit.name], onChanged: () => {}, onPromoted: () => {} }));
      await flush();
    });
    assert.equal(cards().length, 2);
    assert.match(cards()[0].textContent ?? "", /第一段/);
    assert.match(container.textContent ?? "", /先保住身份/);
    assert.match(container.textContent ?? "", /第二段完整正文/);
    await click(cards()[0], "下移");
    assert.match(cards()[0].textContent ?? "", /第二段/);
    assert.ok(calls.some((call) => call.command === "move_bridge" && call.path === "项目/构思/桥段/一.md"));
    await click(cards()[0], "取消安排");
    assert.equal(cards().length, 1);
    assert.ok(calls.some((call) => call.command === "unarrange_bridge" && call.path === "项目/构思/桥段/二.md"));
    assert.ok(!calls.some((call) => call.command === "save_note" || call.command === "save_bridge"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete tauri.__TAURI_INTERNALS__;
  }
});
