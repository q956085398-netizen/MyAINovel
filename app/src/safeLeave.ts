/**
 * 可安全离开约定（工单 #77，docs/spec/整体验收修复与终验.md）：
 * 一次保存请求成功只证明该请求携带的内容快照落盘，不证明编辑器已无
 * 未保存内容。凡会替换或卸载编辑器的导航（切章、返回项目、拆书返回、
 * 全局搜索跳转，以及后续的切库），必须先经 settleForLeave 结算到
 * 「无未保存内容」才放行。
 *
 * 外部行为（供切库等后续流程复用同一合同）：
 * - 完成：返回 true 当且仅当返回时刻编辑器没有未落盘内容（或本就
 *   无内容可存）；此前输入的每个字都已随某一轮保存写盘。放行后调用
 *   方才执行导航/切换。
 * - 被阻止：返回 true 前任一保存轮失败、冲突未裁决、或保存往返期间
 *   持续有新编辑而在轮次上限内未收敛时，返回 false；编辑器保持挂载、
 *   原文字与当前对象不变，调用方不得导航。不新增常规确认弹窗，也不
 *   强制覆盖冲突。
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

/** 结算所需的最小编辑器能力（两个长活编辑器及切库前的缓冲都满足）。 */
export interface SettleableBuffer {
  /** 是否还有未落盘的编辑。 */
  isDirty(): boolean;
  /** 冲突是否未裁决（未裁决时不发起保存轮）。 */
  inConflict(): boolean;
  /** 正在进行的保存（若有）：结算等它完成而不是另起一轮挤门闩。 */
  inFlightSave(): Promise<unknown> | null;
  /** 发起一轮保存（真实快照落盘），返回该轮是否成功。 */
  saveRound(): Promise<boolean>;
}

/** 结算到稳定版本：循环「等在途保存／发起保存轮」直到无未保存内容。
 *  clean（不脏）直接 true；每轮成功后仍脏＝往返期间又打了字，再来
 *  一轮；轮失败、冲突或超上限 → false（留在原编辑器）。 */
export async function settleForLeave(buffer: SettleableBuffer): Promise<boolean> {
  for (let round = 0; round < SETTLE_MAX_ROUNDS; round += 1) {
    if (!buffer.isDirty()) return true;
    if (buffer.inConflict()) return false;
    const inFlight = buffer.inFlightSave();
    if (inFlight) {
      await inFlight.catch(() => {});
      continue;
    }
    if (!(await buffer.saveRound())) return false;
  }
  return buffer.isDirty() ? false : true;
}
