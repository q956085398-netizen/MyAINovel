import "./helpers/installDom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import PlanningView from "../src/PlanningView.tsx";
import type { MainlinePlan, Milestone, StoryLine } from "../src/types.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type TauriInternals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function fixtureMilestone(
  title: string,
  source: { lineIndex: number; milestoneIndex: number },
  overrides: Partial<Milestone> = {},
): Milestone {
  return {
    title,
    change: null,
    readerFeeling: null,
    units: [],
    note: null,
    pending: false,
    source,
    extra: { "自定义里程碑字段": "保留" },
    ...overrides,
  };
}

function copyPlan(plan: MainlinePlan): MainlinePlan {
  return structuredClone(plan);
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

function buttonWithin(root: ParentNode, label: string): HTMLButtonElement {
  const hit = Array.from(root.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(hit, `找不到「${label}」按钮`);
  return hit as HTMLButtonElement;
}

function trackByName(container: HTMLElement, name: string): HTMLElement {
  const hit = Array.from(container.querySelectorAll<HTMLElement>(".mainline-track"))
    .find((track) => track.querySelector<HTMLInputElement>(".track-name input")?.value === name);
  assert.ok(hit, `找不到情节线「${name}」`);
  return hit;
}

function installIpc(initial: MainlinePlan) {
  let savedPlan = copyPlan(initial);
  let fingerprint = 1;
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const tauri = window as unknown as Window & { __TAURI_INTERNALS__: TauriInternals };
  tauri.__TAURI_INTERNALS__ = {
    invoke: async (command, args = {}) => {
      calls.push({ command, args });
      if (command === "read_outline") return { body: "", fingerprint: "outline-1" };
      if (command === "read_mainlines") return copyPlan(savedPlan);
      if (command === "set_milestone_pending") {
        const source = args.source as { lineIndex: number; milestoneIndex: number };
        const pending = args.pending as boolean;
        const milestone = savedPlan.lines[source.lineIndex]?.milestones[source.milestoneIndex];
        assert.ok(milestone, "状态操作应定位到指定原始里程碑");
        milestone.pending = pending;
        fingerprint += 1;
        savedPlan.fingerprint = `mainline-${fingerprint}`;
        return { status: "saved", fingerprint: savedPlan.fingerprint };
      }
      if (command === "save_mainlines") {
        savedPlan = copyPlan(args.plan as MainlinePlan);
        fingerprint += 1;
        savedPlan.fingerprint = `mainline-${fingerprint}`;
        return { status: "saved", fingerprint: savedPlan.fingerprint };
      }
      throw new Error(`未预期的 Tauri 命令：${command}`);
    },
  };
  return {
    calls,
    savedPlan: () => copyPlan(savedPlan),
    remove() {
      delete (tauri as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    },
  };
}

async function mount(container: HTMLElement): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PlanningView, { project: "项目/《测试书》", unitNames: ["初入京城"] }));
    await flushReact();
  });
  return root;
}

test("主线里程碑待打磨页面：完整便笺、重复标题准确切换、保存重开与原序恢复", async () => {
  const initialLines: StoryLine[] = [
    {
      name: "为父正名",
      isMain: true,
      extra: { "自定义情节线字段": "主线保留" },
      milestones: [
        fixtureMilestone("相同标题", { lineIndex: 0, milestoneIndex: 0 }, {
          change: "发现账册",
          readerFeeling: "期待",
          units: ["初入京城"],
          note: "第一条原位",
        }),
        fixtureMilestone("相同标题", { lineIndex: 0, milestoneIndex: 1 }, {
          change: "拿到证词",
          readerFeeling: "痛快又不安",
          units: ["初入京城"],
          note: "第二条备注",
        }),
        fixtureMilestone("后续标题", { lineIndex: 0, milestoneIndex: 2 }, {
          note: "第三条原位",
        }),
      ],
    },
    {
      name: "感情线",
      isMain: false,
      extra: { "自定义情节线字段": "支线保留" },
      milestones: [
        fixtureMilestone("相同标题", { lineIndex: 1, milestoneIndex: 0 }, {
          note: "另一条情节线",
        }),
      ],
    },
  ];
  const ipc = installIpc({ lines: initialLines, fingerprint: "mainline-1" });
  const container = document.createElement("div");
  document.body.append(container);
  const alerts: string[] = [];
  window.alert = (message?: string) => alerts.push(String(message));

  let root = await mount(container);
  try {
    const mainTrack = trackByName(container, "为父正名");
    const originalCards = Array.from(mainTrack.querySelectorAll<HTMLElement>(".milestone-stack > .milestone-card"));
    assert.equal(originalCards.length, 3);
    assert.deepEqual(originalCards.map((card) => card.querySelector<HTMLInputElement>(".milestone-title input")?.value), [
      "相同标题",
      "相同标题",
      "后续标题",
    ]);

    await click(buttonWithin(originalCards[1], "待打磨"));
    const toggleCall = ipc.calls.find((call) => call.command === "set_milestone_pending");
    assert.deepEqual(toggleCall?.args.source, { lineIndex: 0, milestoneIndex: 1 });

    const pendingZone = container.querySelector<HTMLElement>('.pending-zone[aria-label="待打磨的主线里程碑"]');
    assert.ok(pendingZone, "待打磨便笺应出现在大纲页顶部");
    const mainlineTracks = container.querySelector(".mainline-tracks");
    assert.ok(
      mainlineTracks && (pendingZone.compareDocumentPosition(mainlineTracks) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      "便笺区应先于普通主线列表",
    );
    const pendingCard = pendingZone.querySelector<HTMLElement>(".milestone-card");
    assert.ok(pendingCard);
    assert.match(pendingZone.textContent ?? "", /主线 · 为父正名/);
    assert.match(pendingZone.textContent ?? "", /原表第1条情节线，第2个里程碑/);
    assert.match(pendingZone.textContent ?? "", /拿到证词/);
    assert.match(pendingZone.textContent ?? "", /读者感受：痛快又不安/);
    assert.match(pendingZone.textContent ?? "", /初入京城/);
    assert.match(pendingZone.textContent ?? "", /第二条备注/);
    assert.equal(
      mainTrack.querySelectorAll<HTMLElement>(".milestone-stack > .milestone-card").length,
      2,
      "便笺只出现在顶部，不在原轨道复制一份",
    );

    const noteInput = pendingCard.querySelector<HTMLTextAreaElement>("textarea");
    assert.ok(noteInput);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(noteInput, "保存后的备注");
      noteInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      await flushReact();
    });
    await click(buttonWithin(container, "保存主线"));
    assert.equal(ipc.savedPlan().lines[0].milestones[1].note, "保存后的备注");
    assert.equal(ipc.savedPlan().lines[0].milestones[1].pending, true);
    assert.deepEqual(ipc.savedPlan().lines[0].milestones[1].extra, { "自定义里程碑字段": "保留" });
    assert.deepEqual(ipc.savedPlan().lines[0].extra, { "自定义情节线字段": "主线保留" });

    await act(async () => {
      root.unmount();
      await flushReact();
    });
    root = await mount(container);
    assert.ok(container.querySelector('.pending-zone[aria-label="待打磨的主线里程碑"]'));
    assert.match(container.querySelector(".pending-zone")?.textContent ?? "", /保存后的备注/);

    await click(buttonWithin(container.querySelector(".pending-zone")!, "整理完成"));
    assert.equal(container.querySelector('.pending-zone[aria-label="待打磨的主线里程碑"]'), null);
    assert.deepEqual(
      Array.from(trackByName(container, "为父正名").querySelectorAll<HTMLInputElement>(".milestone-stack > .milestone-card .milestone-title input"))
        .map((input) => input.value),
      ["相同标题", "相同标题", "后续标题"],
      "退出后回到原主线人工次序，标题相同的另一条保持不变",
    );
    assert.equal(ipc.savedPlan().lines[0].milestones[1].pending, false);
    assert.equal(ipc.savedPlan().lines[1].milestones[0].pending, false);
    assert.deepEqual(ipc.savedPlan().lines[1].extra, { "自定义情节线字段": "支线保留" });
    assert.deepEqual(ipc.savedPlan().lines[0].milestones[1].extra, { "自定义里程碑字段": "保留" });
    assert.deepEqual(alerts, []);
  } finally {
    await act(async () => root.unmount());
    ipc.remove();
    container.remove();
  }
});
