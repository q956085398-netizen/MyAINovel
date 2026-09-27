import "./helpers/installDom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import ExpectationBoard from "../src/ExpectationBoard.tsx";
import { SearchDestinationContext } from "../src/globalSearchNavigation.tsx";
import type { ExpectationBoard as Board, ExpectationView } from "../src/types.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type TauriInternals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function expectationView(
  name: string,
  kind: string,
  pending: boolean,
  horizon: string,
  chapter: number,
): ExpectationView {
  return {
    name,
    kind,
    horizon,
    state: "部分兑现",
    pending,
    planted: [{ chapter, quote: `${name} 的埋设引文。`, stale: false }],
    fulfilled: [{
      chapter: chapter + 2,
      quote: `${name} 的兑现引文。`,
      kind: "阶段",
      note: `${name} 的兑现说明。`,
      stale: false,
    }],
    unadvancedChapters: 2,
    overdue: false,
  };
}

function installIpc(items: ExpectationView[]) {
  let board: Board = { maxChapter: 12, tableFingerprint: "table-1", items: structuredClone(items) };
  let version = 1;
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const tauri = window as unknown as Window & { __TAURI_INTERNALS__: TauriInternals };
  const advanceVersion = () => {
    version += 1;
    board = { ...board, tableFingerprint: `table-${version}` };
  };
  tauri.__TAURI_INTERNALS__ = {
    invoke: async (command, args = {}) => {
      calls.push({ command, args });
      if (command === "expectation_board") return structuredClone(board);
      if (command === "set_expectation_pending") {
        if (args.fingerprint !== board.tableFingerprint) return { status: "conflict" };
        const item = board.items.find((candidate) => candidate.name === args.name);
        assert.ok(item, "待打磨操作应定位到现有期待线");
        item.pending = args.pending as boolean;
        advanceVersion();
        return { status: "saved", fingerprint: board.tableFingerprint };
      }
      if (command === "set_expectation_state") {
        const item = board.items.find((candidate) => candidate.name === args.name);
        assert.ok(item, "状态操作应定位到现有期待线");
        item.state = args.state as string;
        advanceVersion();
        return structuredClone(board.items);
      }
      if (command === "set_expectation_meta") {
        const item = board.items.find((candidate) => candidate.name === args.name);
        assert.ok(item, "类别/档位操作应定位到现有期待线");
        item.kind = args.kind as string;
        item.horizon = args.horizon as string;
        advanceVersion();
        return structuredClone(board.items);
      }
      if (command === "delete_expectation") {
        board = { ...board, items: board.items.filter((item) => item.name !== args.name) };
        return structuredClone(board.items);
      }
      throw new Error(`未预期的 Tauri 命令：${command}`);
    },
  };
  return {
    calls,
    board: () => structuredClone(board),
    remove() {
      delete (tauri as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    },
  };
}

function destination(project: string, kind: string, title: string) {
  return {
    query: title,
    hit: {
      kind: "期待线",
      title,
      path: `${project}/三线.yaml`,
      projectDir: project,
      projectTitle: "测试书",
      category: kind,
      matches: [],
    },
  };
}

async function flushReact() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flushReact();
  });
}

async function change(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flushReact();
  });
}

function buttonWithin(root: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(button, `找不到「${label}」按钮`);
  return button as HTMLButtonElement;
}

function note(container: HTMLElement, name: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>(".exp-pending-note"))
    .find((candidate) => candidate.querySelector(".card-title")?.textContent?.trim() === name);
  assert.ok(found, `找不到待打磨期待线「${name}」`);
  return found;
}

async function mount(
  container: HTMLElement,
  project: string,
  kind: string,
  searchTitle: string,
  onOpenChapter: (chapter: number, quote: string) => void = () => {},
): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(
      SearchDestinationContext.Provider,
      { value: destination(project, kind, searchTitle) },
      createElement(ExpectationBoard, {
        project,
        kind,
        chapterPrefix: null,
        onChanged: () => {},
        onOpenChapter,
      }),
    ));
    await flushReact();
  });
  return root;
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
    await flushReact();
  });
}

test("期待感与目标待打磨页面：搜索定位、完整便笺、编辑与整理后恢复", async () => {
  const project = "C:/作品/《测试书》";
  const expected = expectationView("为父正名", "期待", false, "长", 2);
  const regularExpectation = expectationView("拿到账册", "期待", false, "中", 1);
  const goal = expectationView("找到证人", "目标", false, "短", 3);
  const regularGoal = expectationView("送达证词", "目标", false, "中", 4);
  const ipc = installIpc([expected, regularExpectation, goal, regularGoal]);
  const originalOrder = ipc.board().items.map((item) => item.name);
  const assertOriginalOrder = () =>
    assert.deepEqual(ipc.board().items.map((item) => item.name), originalOrder);
  const container = document.createElement("div");
  document.body.append(container);
  const opened: { chapter: number; quote: string }[] = [];
  window.alert = (message?: string) => assert.fail(String(message));
  window.HTMLElement.prototype.scrollIntoView = () => {};

  let root = await mount(container, project, "期待", expected.name, (chapter, quote) => {
    opened.push({ chapter, quote });
  });
  try {
    assert.equal(container.querySelector('.pending-zone[aria-label="待打磨的期待线（期待感）"]'), null);
    const expectedDetail = container.querySelector(".exp-detail");
    assert.ok(expectedDetail, "搜索应先定位到普通期待线详情");
    await click(buttonWithin(expectedDetail, "待打磨"));

    let expectedNote = note(container, expected.name);
    assert.deepEqual(
      ipc.board().items.find((item) => item.name === expected.name),
      { ...expected, pending: true },
      "进入待打磨只切换独立状态，不动类别、档位、状态和锚点",
    );
    assert.ok(expectedNote.classList.contains("is-search-hit"), "搜索应定位到期待感页顶部便笺");
    assert.match(expectedNote.textContent ?? "", /类别：期待/);
    assert.match(expectedNote.textContent ?? "", /档位：长/);
    assert.match(expectedNote.textContent ?? "", /状态：部分兑现/);
    assert.match(expectedNote.textContent ?? "", /为父正名 的埋设引文/);
    assert.match(expectedNote.textContent ?? "", /为父正名 的兑现引文/);
    assert.match(expectedNote.textContent ?? "", /为父正名 的兑现说明/);
    assert.ok(
      container.querySelector('.pending-zone[aria-label="待打磨的期待线（期待感）"]'),
      "期待感页顶部展示待打磨区",
    );
    assert.equal(
      Array.from(container.querySelectorAll(".exp-pending-note .card-title"))
        .some((title) => title.textContent?.trim() === goal.name),
      false,
      "期待感页不显示目标便笺",
    );

    const anchor = Array.from(expectedNote.querySelectorAll<HTMLButtonElement>(".link-btn"))
      .find((candidate) => candidate.textContent?.includes("埋于"));
    assert.ok(anchor, "便笺保留埋设章节跳转");
    await click(anchor);
    assert.deepEqual(opened, [{ chapter: 2, quote: `${expected.name} 的埋设引文。` }]);

    await change(
      expectedNote.querySelector<HTMLSelectElement>('select[title="期待线状态（与待打磨独立）"]')!,
      "已兑现",
    );
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.state, "已兑现");
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.pending, true);
    assert.ok(ipc.calls.some((call) => call.command === "set_expectation_state"));

    await change(
      expectedNote.querySelector<HTMLSelectElement>('select[title="档位（时间线网格的行）"]')!,
      "短",
    );
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.horizon, "短");
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.kind, "期待");
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.pending, true);

    await unmount(root);
    root = await mount(container, project, "期待", expected.name);
    expectedNote = note(container, expected.name);
    assert.ok(expectedNote.classList.contains("is-search-hit"));
    assert.match(expectedNote.textContent ?? "", /档位：短/);
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.pending, true);

    await click(buttonWithin(expectedNote, "整理完成"));
    assert.equal(container.querySelector('.pending-zone[aria-label="待打磨的期待线（期待感）"]'), null);
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.pending, false);
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.kind, "期待");
    assert.equal(ipc.board().items.find((item) => item.name === expected.name)?.horizon, "短");
    assertOriginalOrder();
    assert.equal(
      container.querySelector(".exp-detail h3")?.textContent,
      expected.name,
      "整理完成后仍可从原期待感网格选中同一条线",
    );

    await unmount(root);
    root = await mount(container, project, "目标", goal.name);
    assert.equal(container.querySelector('.pending-zone[aria-label="待打磨的期待线（目标）"]'), null);
    const goalDetail = container.querySelector(".exp-detail");
    assert.ok(goalDetail, "搜索应先定位到普通目标线详情");
    await click(buttonWithin(goalDetail, "待打磨"));

    let goalNote = note(container, goal.name);
    assert.deepEqual(
      ipc.board().items.find((item) => item.name === goal.name),
      { ...goal, pending: true },
      "目标进入待打磨只切换独立状态，不动原字段",
    );
    assert.ok(goalNote.classList.contains("is-search-hit"), "搜索应定位到目标页顶部便笺");
    assert.match(goalNote.textContent ?? "", /找到证人/);
    assert.match(goalNote.textContent ?? "", /类别：目标/);
    assert.match(goalNote.textContent ?? "", /档位：短/);
    assert.match(goalNote.textContent ?? "", /状态：部分兑现/);
    assert.match(goalNote.textContent ?? "", /找到证人 的埋设引文/);
    assert.match(goalNote.textContent ?? "", /找到证人 的兑现引文/);
    assert.match(goalNote.textContent ?? "", /找到证人 的兑现说明/);
    assert.ok(container.querySelector('.pending-zone[aria-label="待打磨的期待线（目标）"]'));
    assert.doesNotMatch(container.querySelector(".pending-zone")?.textContent ?? "", /为父正名/);

    await change(
      goalNote.querySelector<HTMLSelectElement>('select[title="期待线状态（与待打磨独立）"]')!,
      "已兑现",
    );
    assert.equal(ipc.board().items.find((item) => item.name === goal.name)?.state, "已兑现");
    assert.equal(ipc.board().items.find((item) => item.name === goal.name)?.pending, true);

    await unmount(root);
    root = await mount(container, project, "目标", goal.name);
    goalNote = note(container, goal.name);
    assert.ok(goalNote.classList.contains("is-search-hit"));
    assert.match(goalNote.textContent ?? "", /状态：已兑现/);
    assert.equal(ipc.board().items.find((item) => item.name === goal.name)?.pending, true);

    await click(buttonWithin(goalNote, "整理完成"));
    assert.equal(container.querySelector('.pending-zone[aria-label="待打磨的期待线（目标）"]'), null);
    assert.equal(ipc.board().items.find((item) => item.name === goal.name)?.pending, false);
    assert.equal(ipc.board().items.find((item) => item.name === goal.name)?.kind, "目标");
    assert.equal(ipc.board().items.find((item) => item.name === goal.name)?.horizon, "短");
    assert.equal(ipc.board().items.find((item) => item.name === regularExpectation.name)?.pending, false);
    assert.equal(ipc.board().items.find((item) => item.name === regularGoal.name)?.pending, false);
    assertOriginalOrder();
    assert.equal(ipc.calls.some((call) => call.command === "delete_expectation"), false);
  } finally {
    await unmount(root);
    ipc.remove();
    container.remove();
  }
});
