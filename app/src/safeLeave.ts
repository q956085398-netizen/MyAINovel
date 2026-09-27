/**
 * 可安全离开约定（工单 #77，docs/spec/整体验收修复与终验.md）：
 * 一次保存请求成功只证明该请求携带的内容快照落盘，不证明编辑器已无
 * 未保存内容。凡会替换或卸载编辑器的导航（切章、返回项目、拆书返回、
 * 全局搜索跳转，以及后续的切库），必须先经 settleForLeave 结算到
 * 「无未保存内容」才放行。
 *
 * 外部行为（供切库等后续流程复用同一合同）：
 * - 完成（"done"）：返回当且仅当返回时刻编辑器没有未落盘内容（或本就
 *   无内容可存）；此前输入的每个字都已随某一轮保存写盘。调用方此时才
 *   执行导航/切换。
 * - 被阻止（其余三种）——编辑器保持挂载、原文字与当前对象不变，调用方
 *   不得导航；不新增常规确认弹窗，也不强制覆盖冲突：
 *   - "conflict"：外部指纹冲突未裁决（横幅/胶囊已亮，等既有裁决交互）；
 *   - "failed"：一轮保存失败（失败提示已由保存入口给出，可重试）；
 *   - "busy"：保存往返期间持续有新编辑，到轮次上限仍未收敛——导航未
 *     完成，调用方应向作者明确「留在原编辑器」，绝不无限重试。
 * - 陈旧请求：结算不取消在途 IPC，但调用方须以请求代次（generation）
 *   约束读取与保存响应——导航目标已被更新的请求取代时，迟到的响应
 *   不得回填界面（见 WritingPage.openChapter 的代次守卫）。
 *
 * 这里只有与编辑器无关的循环骨架；isDirty/inConflict/inFlightSave/
 * saveRound 由两个编辑器（拆书/书写）各自以现有 ref 接入。
 */

/** 保存轮次上限：正常「保存往返期间又打字」两三轮即收敛；持续输入
 *  （按住不放）到上限后放弃结算并阻止导航——绝不无限重试。 */
export const SETTLE_MAX_ROUNDS = 8;

/** 结算结果：done＝可安全离开；其余＝被阻止（原因各异，见模块头）。 */
export type SettleOutcome = "done" | "conflict" | "failed" | "busy";

/** 结算所需的最小编辑器能力（两个长活编辑器及切库前的缓冲都满足）。 */
export interface SettleableBuffer {
  /** 是否还有未落盘的编辑。 */
  isDirty(): boolean;
  /** 冲突是否未裁决（未裁决时不发起保存轮）。 */
  inConflict(): boolean;
  /** 正在进行的保存（若有）：结算等它完成而不是另起一轮挤门闩。 */
  inFlightSave(): Promise<unknown> | null;
  /** 推进一轮保存（真实快照落盘），返回该轮是否成功；失败时结算立即
   *  停止并报 "failed"，由重试入口或下一轮导航重新尝试。 */
  saveRound(): Promise<boolean>;
}

/** 结算到稳定版本：循环「等在途保存／发起保存轮」直到无未保存内容。 */
export async function settleForLeave(buffer: SettleableBuffer): Promise<SettleOutcome> {
  for (let round = 0; round < SETTLE_MAX_ROUNDS; round += 1) {
    if (!buffer.isDirty()) return "done";
    if (buffer.inConflict()) return "conflict";
    const inFlight = buffer.inFlightSave();
    if (inFlight) {
      // 等别人的在途保存只是等待，不算一轮：它失败也没关系，下一轮
      // 会由 saveRound 真正重试（有界）。
      await inFlight.catch(() => {});
      continue;
    }
    if (!(await buffer.saveRound())) return "failed";
  }
  return buffer.isDirty() ? "busy" : "done";
}
