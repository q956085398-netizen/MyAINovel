import assert from "node:assert/strict";
import test from "node:test";

import {
  cardMatchesQuery,
  contentCardDomId,
  readCollapsedCardPaths,
  serializeCollapsedCardPaths,
  shouldExpandContentCard,
  splitTextMatches,
} from "../src/contentSurfaceState.ts";

test("旧偏好或损坏偏好按全部展开处理", () => {
  assert.deepEqual([...readCollapsedCardPaths(null, "inspiration")], []);
  assert.deepEqual([...readCollapsedCardPaths("not json", "inspiration")], []);
  assert.deepEqual([...readCollapsedCardPaths('{"version":1}', "inspiration")], []);
});

test("收起状态按内容表面分区保存并保留其他分区", () => {
  const before = JSON.stringify({
    version: 1,
    surfaces: { people: ["人物/阿青.md"] },
  });
  const raw = serializeCollapsedCardPaths(
    before,
    "inspiration",
    new Set(["灵感库/故事卡/雨夜.md"]),
  );

  assert.deepEqual([...readCollapsedCardPaths(raw, "inspiration")], ["灵感库/故事卡/雨夜.md"]);
  assert.deepEqual([...readCollapsedCardPaths(raw, "people")], ["人物/阿青.md"]);
});

test("搜索命中强制展开但不改写原收起偏好", () => {
  const collapsed = new Set(["灵感库/故事卡/雨夜.md"]);
  assert.equal(shouldExpandContentCard("灵感库/故事卡/雨夜.md", collapsed, false), false);
  assert.equal(shouldExpandContentCard("灵感库/故事卡/雨夜.md", collapsed, true), true);
  assert.equal(collapsed.has("灵感库/故事卡/雨夜.md"), true);
});

test("搜索覆盖标题、正文、标签、来源、关联与一句话核心", () => {
  const card = {
    title: "雨夜来客",
    body: "他敲开了封闭十年的城门。",
    tags: ["悬疑"],
    source: "梦境",
    links: ["《北境》/城门失守"],
    core: "守门人必须放进自己的仇敌",
  };

  for (const query of ["雨夜", "城门", "悬疑", "梦境", "北境", "仇敌"]) {
    assert.equal(cardMatchesQuery(card, query), true, query);
  }
  assert.equal(cardMatchesQuery(card, "海港"), false);
});

test("卡片定位 id 对 Windows 路径稳定且彼此不同", () => {
  const first = contentCardDomId("C:\\库\\灵感库\\故事卡\\雨夜.md");
  const second = contentCardDomId("C:\\库\\灵感库\\故事卡\\雪夜.md");
  assert.equal(first, contentCardDomId("C:\\库\\灵感库\\故事卡\\雨夜.md"));
  assert.notEqual(first, second);
  assert.match(first, /^content-card-/);
});

test("搜索文本切片保留原文并标出所有不区分大小写的命中", () => {
  assert.deepEqual(splitTextMatches("Rain rain，雨夜", "RAIN"), [
    { text: "Rain", matched: true },
    { text: " ", matched: false },
    { text: "rain", matched: true },
    { text: "，雨夜", matched: false },
  ]);
  assert.deepEqual(splitTextMatches("完整正文", ""), [{ text: "完整正文", matched: false }]);
});
