import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

function zIndexOf(selector: string): number {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `缺少 ${selector} 样式规则`);

  const zIndex = rule[1].match(/z-index:\s*(\d+)/);
  assert.ok(zIndex, `${selector} 必须明确声明 z-index`);
  return Number(zIndex[1]);
}

test("当前项目面板位于点外关闭幕之上", () => {
  assert.ok(
    zIndexOf(".rail-flyout") > zIndexOf(".rail-flyout-backdrop"),
    "透明幕不能拦截面板内的继续工作与待办点击",
  );
});
