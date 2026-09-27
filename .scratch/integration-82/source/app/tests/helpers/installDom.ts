/**
 * happy-dom 全局安装（工单 #77 页面回归设施）。
 * 必须先于任何应用模块求值——页面回归测试文件的第一条 import。
 * React 19 与 CodeMirror 6 均可在此环境直接挂载真实组件。
 */
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as unknown as Record<string, unknown>;

function define(key: string, value: unknown, force = false) {
  if (!force && g[key] !== undefined) return;
  Object.defineProperty(g, key, { value, writable: true, configurable: true, enumerable: true });
}

// 窗口与存储强制接管（Node 自带的 navigator/localStorage 不适合页面测试）。
define("window", win, true);
define("document", win.document, true);
define("navigator", win.navigator, true);
define("localStorage", win.localStorage, true);
define("sessionStorage", win.sessionStorage, true);

// 需要 this 绑定窗口的函数。
for (const key of [
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
]) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (typeof value === "function") define(key, (value as (...a: unknown[]) => unknown).bind(win), true);
}

// DOM 构造器与其他接口：缺就补（Node 自带的部分事件类不动，够用）。
for (const key of [
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "FocusEvent",
  "Node",
  "Element",
  "HTMLElement",
  "DocumentFragment",
  "Range",
  "MutationObserver",
  "ResizeObserver",
  "DOMParser",
  "Image",
  "CSS",
]) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined && g[key] === undefined) define(key, value);
}

if (g.ResizeObserver === undefined) {
  define(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

export const sharedWin = win;
