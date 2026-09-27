import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

import type { ForeshadowView } from "../src/types.ts";

interface BoardContentProps {
  project: string;
  chapterPrefix: string | null;
  views: ForeshadowView[];
  busy: boolean;
  searchHitName: string | null;
  onOpenChapter: (ordinal: number, quote: string) => void;
  onChangeState: (name: string, state: string) => void;
  onChangePending: (name: string, pending: boolean) => void;
  onRemove: (name: string) => void;
}

let vite: ViteDevServer;
let BoardContent: ComponentType<BoardContentProps>;

before(async () => {
  vite = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  const module = await vite.ssrLoadModule("/src/ForeshadowBoardContent.tsx");
  BoardContent = module.default as ComponentType<BoardContentProps>;
});

after(async () => {
  await vite?.close();
});

function view(name: string, pending: boolean, state = "部分收"): ForeshadowView {
  return {
    name,
    state,
    pending,
    planted: [{ chapter: 3, quote: "门缝里露出一截黄铜钥匙。", stale: false }],
    recovered: [{
      chapter: 8,
      quote: "钥匙打开了旧宅的门。",
      kind: "阶段",
      note: "只揭开了失踪案的一半。",
      stale: false,
    }],
    uncollectedChapters: 5,
    overdue: false,
  };
}

function render(views: ForeshadowView[]) {
  return renderToStaticMarkup(createElement(BoardContent, {
    project: "C:/作品/《旧宅》",
    chapterPrefix: null,
    views,
    busy: false,
    searchHitName: null,
    onOpenChapter: () => {},
    onChangeState: () => {},
    onChangePending: () => {},
    onRemove: () => {},
  }));
}

test("顶部待打磨便笺显示完整伏笔并保留原操作", () => {
  const markup = render([view("黄铜钥匙", true), view("玉佩", false, "已埋")]);

  assert.match(markup, /aria-label="待打磨的伏笔"/);
  assert.match(markup, /黄铜钥匙/);
  assert.match(markup, /部分收/);
  assert.match(markup, /门缝里露出一截黄铜钥匙/);
  assert.match(markup, /钥匙打开了旧宅的门/);
  assert.match(markup, /只揭开了失踪案的一半/);
  assert.match(markup, /整理完成/);
  assert.match(markup, /删除/);
  assert.equal((markup.match(/class="card-item/g) ?? []).length, 2, "每条伏笔只呈现一次");
});

test("待打磨区为空时隐藏；整理完成后回到原业务分组", () => {
  const markup = render([view("黄铜钥匙", false)]);

  assert.doesNotMatch(markup, /aria-label="待打磨的伏笔"/);
  assert.match(markup, /class="foreshadow-group"/);
  assert.match(markup, /部分收/);
  assert.match(markup, /待打磨/);
  assert.doesNotMatch(markup, /整理完成/);
  assert.equal((markup.match(/class="card-item/g) ?? []).length, 1);
});
