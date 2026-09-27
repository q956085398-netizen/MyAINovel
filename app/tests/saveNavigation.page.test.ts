/**
 * 保存与导航页面回归（工单 #77，docs/spec/整体验收修复与终验.md）：
 *  真实页面组件（书写 WritingPage / 拆书 EditorPage）+ 可控 IPC 替身，
 *  覆盖切章、返回项目、搜索跳转三类入口在「保存等待期间继续输入」、
 *  已有自动保存进行中、连续点击不同目标、迟到读取、保存失败与外部
 *  指纹冲突下的作者可见行为：最新文字全部落盘后才离开，或留在原编辑器
 *  且文字与当前对象保持原样。
 *  断言面向作者可见结果（编辑器文字、状态胶囊、标题、横幅、onBack、
 *  落盘内容），不断言组件内部变量或函数调用次数。
 */
import "./helpers/installDom.ts";
import "./helpers/pageHarness.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { flushAllSavers } from "../src/saveFlush";
import { prepareSearchNavigation } from "../src/globalSearchNavigation";
import { updateSettings } from "../src/settings";
import {
  deferred,
  flushDom,
  mountBookEditor,
  mountWriting,
  waitFor,
  type ChapterFix,
  type MockIpc,
} from "./helpers/pageHarness.ts";

const CH: ChapterFix[] = [
  fix(1, "开端", "第一章原有正文"),
  fix(2, "推进", "第二章正文"),
  fix(3, "转折", "第三章正文"),
];

function fix(n: number, title: string, content: string): ChapterFix {
  return {
    path: `项目/《测试书》/正文/第${n}章 ${title}.md`,
    fileName: `第${n}章 ${title}.md`,
    ordinal: n,
    title,
    content,
    fingerprint: `fp${n}`,
  };
}

/** 保存控制：gate 队列逐个挂住保存往返；fail/conflict 按旗标响应。 */
interface SaveControl {
  gates: { promise: Promise<unknown> }[];
  fail: boolean;
  conflict: boolean;
}

function wireSaves(ipc: MockIpc, command: string, control: SaveControl) {
  ipc.on(command, async (args) => {
    const path = args.path as string;
    ipc.saved.set(path, args.content as string);
    if (control.gates.length > 0) {
      const gate = control.gates.shift()!;
      await gate.promise;
    }
    if (control.conflict) return { status: "conflict" };
    if (control.fail) throw new Error("磁盘暂时不可写");
    return { status: "saved", fingerprint: `saved:${path}` };
  });
}

/** 让指定路径的章节读取挂起，返回闸门。 */
function wireReadGate(ipc: MockIpc, chapters: ChapterFix[], path: string) {
  const gate = deferred<{ content: string; fingerprint: string }>();
  ipc.on("read_book_md", (args) => {
    if (args.path === path) return gate.promise;
    const hit = chapters.find((c) => c.path === args.path);
    if (!hit) throw new Error(`读不到章节：${String(args.path)}`);
    return { content: hit.content, fingerprint: hit.fingerprint };
  });
  return gate;
}

test("书写·正常切章：无延迟时输入全部落盘后才进入下一章（对照）", async () => {
  const fx = await mountWriting(CH);
  try {
    fx.type("新增甲");
    fx.clickChapter("第2章");
    await waitFor(() => fx.editorText() === "第二章正文", "切章完成");
    assert.equal(fx.editorText(), "第二章正文");
    assert.ok(fx.headerTitle().includes("第2章"));
    assert.equal(fx.chipText(), "已保存");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文新增甲");
    assert.equal(fx.confirms.length, 0, "常规切章不弹确认框");
    assert.equal(fx.alerts.length, 0);
  } finally {
    fx.unmount();
  }
});

test("书写·保存等待期间继续输入再切章：新增文字全部落盘后才替换编辑器", async () => {
  const fx = await mountWriting(CH);
  try {
    fx.type("新增甲");
    const saveGate = deferred();
    const control: SaveControl = { gates: [saveGate], fail: false, conflict: false };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.clickChapter("第2章");
    // 第一轮保存已发出（快照＝点章时刻的文字），编辑器尚未被替换。
    await waitFor(() => fx.ipc.saved.has(CH[0].path), "第一轮保存已发出");
    await flushDom(15);
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文新增甲");
    assert.equal(fx.editorText(), "第一章原有正文新增甲", "保存完成前不替换编辑器");
    assert.equal(fx.onBackCalls.length, 0);

    fx.type("新增乙"); // 保存往返期间继续输入
    saveGate.release();
    await waitFor(() => fx.editorText() === "第二章正文", "结算后切章完成");

    // 结算把往返期间的新输入再保存一轮，然后才载入第二章。
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文新增甲新增乙");
    assert.ok(fx.headerTitle().includes("第2章"));
    assert.equal(fx.chipText(), "已保存");
    // 顺序证据：第一章最后一轮保存先于第二章读取。
    const lastSave = fx.ipc.calls.reduce(
      (at, c, i) => (c.cmd === "save_chapter_md" && c.args.path === CH[0].path ? i : at),
      -1,
    );
    const readAt = fx.ipc.calls.findIndex(
      (c) => c.cmd === "read_book_md" && c.args.path === CH[1].path,
    );
    assert.ok(readAt >= 0 && lastSave >= 0 && lastSave < readAt);
    assert.equal(fx.confirms.length, 0);
    assert.equal(fx.alerts.length, 0);
  } finally {
    fx.unmount();
  }
});

test("书写·已有自动保存进行中切章：等在途保存完成后才离开，不丢字", async () => {
  const fx = await mountWriting(CH);
  try {
    updateSettings({ autosaveSec: 1 }); // 挂载夹具会重置为 3 秒，这里再收紧
    const saveGate = deferred();
    const control: SaveControl = { gates: [saveGate], fail: false, conflict: false };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.type("自动保存前输入");
    await waitFor(() => fx.ipc.saved.has(CH[0].path), "自动保存已发起");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文自动保存前输入");

    fx.clickChapter("第2章");
    await flushDom(20);
    assert.equal(
      fx.editorText(),
      "第一章原有正文自动保存前输入",
      "在途保存完成前不切章",
    );
    saveGate.release();
    await waitFor(() => fx.editorText() === "第二章正文", "结算后切章完成");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文自动保存前输入");
    assert.equal(fx.chipText(), "已保存");
  } finally {
    updateSettings({ autosaveSec: 3 });
    fx.unmount();
  }
});

test("书写·连续点击不同目标：旧章节读取迟到被丢弃，不加载陈旧目的地", async () => {
  const fx = await mountWriting(CH);
  try {
    const readGate = wireReadGate(fx.ipc, CH, CH[1].path);
    fx.clickChapter("第2章");
    await waitFor(
      () => fx.ipc.calls.some((c) => c.cmd === "read_book_md" && c.args.path === CH[1].path),
      "第二章读取已发出",
    );
    fx.clickChapter("第3章"); // 第二章读取挂起时点第三章
    await waitFor(() => fx.editorText() === "第三章正文", "第三章载入");
    assert.ok(fx.headerTitle().includes("第3章"));

    readGate.release({ content: CH[1].content, fingerprint: CH[1].fingerprint });
    await flushDom(40);
    assert.equal(fx.editorText(), "第三章正文", "迟到的旧读取不得覆盖已到达的新目的地");
    assert.ok(fx.headerTitle().includes("第3章"));
    assert.equal(fx.chipText(), "已保存");
  } finally {
    fx.unmount();
  }
});

test("书写·章节读取期间继续输入：释放后先落盘再进新章", async () => {
  const fx = await mountWriting(CH);
  try {
    const readGate = wireReadGate(fx.ipc, CH, CH[1].path);
    fx.clickChapter("第2章");
    await waitFor(
      () => fx.ipc.calls.some((c) => c.cmd === "read_book_md" && c.args.path === CH[1].path),
      "第二章读取已发出",
    );
    fx.type("读取期间新增");
    assert.equal(fx.editorText(), "第一章原有正文读取期间新增");
    readGate.release({ content: CH[1].content, fingerprint: CH[1].fingerprint });
    await waitFor(() => fx.editorText() === "第二章正文", "落盘后进入第二章");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文读取期间新增");
    assert.equal(fx.chipText(), "已保存");
  } finally {
    fx.unmount();
  }
});

test("书写·保存失败：留在原章原文字可重试，重试后可正常切章", async () => {
  const fx = await mountWriting(CH);
  try {
    const control: SaveControl = { gates: [], fail: true, conflict: false };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.type("新增甲");
    fx.clickChapter("第2章");
    await waitFor(() => fx.alerts.length > 0, "保存失败提示出现");
    assert.equal(fx.editorText(), "第一章原有正文新增甲", "失败后编辑器原文字保持");
    assert.ok(fx.headerTitle().includes("第1章"));
    assert.equal(fx.chipText(), "保存失败");
    assert.ok(fx.alerts.some((a) => a.includes("保存失败")));
    assert.equal(
      fx.ipc.calls.some((c) => c.cmd === "read_book_md" && c.args.path === CH[1].path),
      false,
      "保存失败不得载入新章",
    );

    control.fail = false;
    fx.clickChapter("第2章");
    await waitFor(() => fx.editorText() === "第二章正文", "重试后切章完成");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文新增甲");
  } finally {
    fx.unmount();
  }
});

test("书写·持续输入不收敛：结算到轮次上限放弃，明确留在原章且文字全保留", async () => {
  const fx = await mountWriting(CH);
  try {
    // 每轮保存都挂起，释放后立刻又打字——模拟作者持续输入不停笔。
    let pending: ReturnType<typeof deferred> | null = null;
    fx.ipc.on("save_chapter_md", async (args) => {
      const path = args.path as string;
      fx.ipc.saved.set(path, args.content as string);
      const gate = deferred();
      pending = gate;
      await gate.promise;
      return { status: "saved", fingerprint: `saved:${path}` };
    });
    fx.type("起始输入");
    fx.clickChapter("第2章");
    const saves = () => fx.ipc.calls.filter((c) => c.cmd === "save_chapter_md").length;
    for (let round = 0; round < 8; round += 1) {
      await waitFor(() => saves() > round, `第 ${round + 1} 轮保存已发出`);
      fx.type(`续写${round}`);
      pending?.release();
      pending = null;
    }
    await waitFor(() => fx.alerts.some((a) => a.includes("没保存完")), "明确提示导航未完成");
    assert.ok(fx.headerTitle().includes("第1章"), "留在原章");
    assert.ok(fx.editorText().startsWith("第一章原有正文"), "原文字保持");
    assert.ok(fx.editorText().includes("续写7"), "持续输入的文字都还在编辑器里");

    // 停笔后重试：结算收敛，正常切章。
    fx.clickChapter("第2章");
    await waitFor(() => pending !== null, "重试的保存已发出");
    pending?.release();
    await waitFor(() => fx.editorText() === "第二章正文", "停笔后可正常切章");
    assert.ok(fx.ipc.saved.get(CH[0].path)!.includes("续写7"), "全部文字落盘");
  } finally {
    fx.unmount();
  }
});

test("书写·外部指纹冲突：横幅裁决前导航被阻止，重新加载后可继续", async () => {
  const fx = await mountWriting(CH);
  try {
    const control: SaveControl = { gates: [], fail: false, conflict: true };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.type("新增甲");
    fx.clickChapter("第2章");
    await waitFor(() => !!fx.container.querySelector(".conflict-bar"), "冲突横幅出现");
    assert.equal(fx.editorText(), "第一章原有正文新增甲", "冲突未裁决留在原章原文字");
    assert.ok(fx.headerTitle().includes("第1章"));
    assert.equal(fx.chipText(), "保存冲突");

    control.conflict = false;
    // 模拟外部修改后的盘面，走「重新加载」。
    fx.ipc.on("read_book_md", (args) => {
      if (args.path === CH[0].path) {
        return { content: "外部修改后的第一章", fingerprint: "ext1" };
      }
      const hit = CH.find((c) => c.path === args.path);
      return { content: hit!.content, fingerprint: hit!.fingerprint };
    });
    fx.clickButton("重新加载");
    await waitFor(() => fx.editorText() === "外部修改后的第一章", "重新加载完成");
    assert.ok(!fx.container.querySelector(".conflict-bar"), "裁决后横幅消失");

    fx.clickChapter("第2章");
    await waitFor(() => fx.editorText() === "第二章正文", "裁决后可正常切章");
  } finally {
    fx.unmount();
  }
});

test("书写·冲突横幅「确认覆盖」保留编辑器文字并落盘", async () => {
  const fx = await mountWriting(CH);
  try {
    const control: SaveControl = { gates: [], fail: false, conflict: true };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.type("新增甲");
    fx.clickChapter("第2章");
    await waitFor(() => !!fx.container.querySelector(".conflict-bar"), "冲突横幅出现");
    control.conflict = false;
    fx.clickButton("确认覆盖");
    await waitFor(() => !fx.container.querySelector(".conflict-bar"), "覆盖后横幅消失");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文新增甲");
    assert.equal(fx.editorText(), "第一章原有正文新增甲", "覆盖后文字仍在编辑器");
  } finally {
    fx.unmount();
  }
});

test("书写·搜索跳转守卫：冲突时阻止（不弹框），延迟保存期间输入收敛后放行", async () => {
  const fx = await mountWriting(CH);
  try {
    const control: SaveControl = { gates: [], fail: false, conflict: true };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.type("新增甲");
    await assert.rejects(() => prepareSearchNavigation(), /尚未保存/);
    assert.equal(fx.editorText(), "第一章原有正文新增甲", "被阻止时编辑器文字保持");
    assert.equal(fx.confirms.length, 0, "守卫阻止不新增确认弹窗");

    // 先裁决冲突（重新加载），再验证延迟保存收敛后守卫放行。
    control.conflict = false;
    await waitFor(() => !!fx.container.querySelector(".conflict-bar"), "冲突横幅渲染");
    fx.clickButton("重新加载");
    await waitFor(() => !fx.container.querySelector(".conflict-bar"), "冲突已裁决");

    const saveGate = deferred();
    control.gates.push(saveGate);
    fx.type("新增乙");
    const navigation = prepareSearchNavigation();
    await waitFor(() => fx.ipc.saved.has(CH[0].path), "守卫触发的保存已发出");
    fx.type("搜索等待期间输入");
    saveGate.release();
    await navigation;
    await flushDom(20);
    assert.equal(
      fx.ipc.saved.get(CH[0].path),
      "第一章原有正文新增乙搜索等待期间输入",
    );
  } finally {
    fx.unmount();
  }
});

test("书写·返回项目：保存等待期间继续输入，全部落盘后才回调 onBack", async () => {
  const fx = await mountWriting(CH);
  try {
    fx.type("返回前输入");
    const saveGate = deferred();
    const control: SaveControl = { gates: [saveGate], fail: false, conflict: false };
    wireSaves(fx.ipc, "save_chapter_md", control);
    fx.clickButton("项目列表");
    await waitFor(() => fx.ipc.saved.has(CH[0].path), "返回触发的保存已发出");
    assert.equal(fx.onBackCalls.length, 0, "保存完成前不返回");
    fx.type("返回等待期间输入");
    saveGate.release();
    await waitFor(() => fx.onBackCalls.length === 1, "落盘后返回");
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文返回前输入返回等待期间输入");
  } finally {
    fx.unmount();
  }
});

test("书写·关窗兜底回归：flushAllSavers 静默落盘最新文字", async () => {
  const fx = await mountWriting(CH);
  try {
    fx.type("关窗前的输入");
    await flushAllSavers();
    await flushDom(20);
    assert.equal(fx.ipc.saved.get(CH[0].path), "第一章原有正文关窗前的输入");
    assert.equal(fx.alerts.length, 0, "兜底保存不弹框");
  } finally {
    fx.unmount();
  }
});

// ---------- 拆书编辑器（EditorPage） ----------

const BOOK = {
  primaryMd: "拆书/《示例书》/《示例书》.md",
  original: "拆书稿原稿正文",
  content: "拆书稿原稿正文",
  fingerprint: "bfp1",
};

test("拆书·返回书库：正常输入落盘后返回（对照）", async () => {
  const fx = await mountBookEditor(BOOK);
  try {
    fx.type("批注甲");
    fx.clickButton("返回");
    await waitFor(() => fx.onBackCalls.length === 1, "落盘后返回");
    assert.equal(fx.ipc.saved.get(BOOK.primaryMd), "拆书稿原稿正文批注甲");
    assert.equal(fx.confirms.length, 0);
    assert.equal(fx.alerts.length, 0);
  } finally {
    fx.unmount();
  }
});

test("拆书·返回等待期间继续输入：全部落盘后才返回", async () => {
  const fx = await mountBookEditor(BOOK);
  try {
    fx.type("批注甲");
    const saveGate = deferred();
    const control: SaveControl = { gates: [saveGate], fail: false, conflict: false };
    wireSaves(fx.ipc, "save_book_md", control);
    fx.clickButton("返回");
    await waitFor(() => fx.ipc.saved.has(BOOK.primaryMd), "返回触发的保存已发出");
    assert.equal(fx.onBackCalls.length, 0);
    fx.type("批注乙");
    saveGate.release();
    await waitFor(() => fx.onBackCalls.length === 1, "落盘后返回");
    assert.equal(fx.ipc.saved.get(BOOK.primaryMd), "拆书稿原稿正文批注甲批注乙");
  } finally {
    fx.unmount();
  }
});

test("拆书·搜索跳转守卫：冲突时静默阻止，编辑器文字保持", async () => {
  const fx = await mountBookEditor(BOOK);
  try {
    const control: SaveControl = { gates: [], fail: false, conflict: true };
    wireSaves(fx.ipc, "save_book_md", control);
    fx.type("批注甲");
    await assert.rejects(() => prepareSearchNavigation(), /尚未保存/);
    await flushDom(25); // 等冲突状态渲染到状态胶囊
    assert.equal(fx.editorText(), "拆书稿原稿正文批注甲");
    assert.equal(fx.chipText(), "保存冲突");
    assert.equal(fx.confirms.length, 0, "守卫路径不弹冲突裁决框");
  } finally {
    fx.unmount();
  }
});

test("拆书·返回遇冲突：既有两段确认裁决（重新加载）后放行", async () => {
  const fx = await mountBookEditor(BOOK);
  try {
    const control: SaveControl = { gates: [], fail: false, conflict: true };
    wireSaves(fx.ipc, "save_book_md", control);
    fx.type("批注甲");
    fx.clickButton("返回");
    await waitFor(() => fx.onBackCalls.length === 1, "裁决后放行");
    assert.ok(
      fx.confirms.some((c) => c.includes("保存被拦下")),
      "返回路径弹既有冲突裁决框",
    );
    assert.equal(fx.editorText(), BOOK.original, "重新加载后编辑器与盘上一致");
  } finally {
    fx.unmount();
  }
});

test("拆书·保存失败：留在编辑器可重试，重试后返回成功", async () => {
  const fx = await mountBookEditor(BOOK);
  try {
    const control: SaveControl = { gates: [], fail: true, conflict: false };
    wireSaves(fx.ipc, "save_book_md", control);
    fx.type("批注甲");
    fx.clickButton("返回");
    await waitFor(() => fx.alerts.length > 0, "保存失败提示出现");
    assert.equal(fx.onBackCalls.length, 0, "失败不返回");
    assert.ok(fx.alerts.some((a) => a.includes("保存失败")));
    assert.equal(fx.editorText(), "拆书稿原稿正文批注甲");

    control.fail = false;
    fx.clickButton("返回");
    await waitFor(() => fx.onBackCalls.length === 1, "重试后返回成功");
    assert.equal(fx.ipc.saved.get(BOOK.primaryMd), "拆书稿原稿正文批注甲");
  } finally {
    fx.unmount();
  }
});

test("拆书·关窗兜底回归：flushAllSavers 静默落盘最新文字", async () => {
  const fx = await mountBookEditor(BOOK);
  try {
    fx.type("关窗前的批注");
    await flushAllSavers();
    await flushDom(20);
    assert.equal(fx.ipc.saved.get(BOOK.primaryMd), "拆书稿原稿正文关窗前的批注");
    assert.equal(fx.alerts.length, 0);
  } finally {
    fx.unmount();
  }
});
