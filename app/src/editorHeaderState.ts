/**
 * 编辑器头部状态机（工单 #66 / T04，spec 工作台与卡片呈现 §五）。
 *
 * 保存状态与菜单键盘导航的纯逻辑：两个编辑器（拆书/书写）共用，
 * 这里不碰 DOM，供 node:test 直接覆盖。
 */

/** 保存五态：自动保存成功、保存中、失败、冲突、未保存都可辨认。 */
export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

/** 打字：冲突未裁决时仍是冲突（自动保存被暂停，改字不解除冲突），其余进入未保存。 */
export function saveStatusAfterEdit(prev: SaveStatus): SaveStatus {
  return prev === "conflict" ? "conflict" : "dirty";
}

/** 五态的固定文案；测试断言五者互不相同（验收：均可辨认）。 */
export function saveStatusLabel(status: SaveStatus): string {
  switch (status) {
    case "saved":
      return "已保存";
    case "dirty":
      return "未保存";
    case "saving":
      return "保存中…";
    case "error":
      return "保存失败";
    case "conflict":
      return "保存冲突";
  }
}

/** 状态胶囊可点击（＝立即保存/重试/重新裁决）的态：干净与保存中不可点。 */
export function saveChipInteractive(status: SaveStatus): boolean {
  return status === "dirty" || status === "error" || status === "conflict";
}

/** 菜单键盘导航支持的按键。 */
export type MenuNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * 下一个聚焦项索引：在 enabled 标记的项间移动，跳过禁用项，环形回绕。
 * from 为 -1 表示菜单刚打开：ArrowDown/Home 取第一个可用项，
 * ArrowUp/End 取最后一个；一个可用项都没有返回 -1。
 */
export function nextMenuIndex(enabled: boolean[], from: number, key: MenuNavKey): number {
  const count = enabled.length;
  if (count === 0 || !enabled.some(Boolean)) return -1;
  if (key === "Home") return enabled.indexOf(true);
  if (key === "End") return enabled.lastIndexOf(true);
  const step = key === "ArrowDown" ? 1 : -1;
  let i = from;
  for (let n = 0; n < count; n++) {
    i = (i + step + count) % count;
    if (enabled[i]) return i;
  }
  return -1;
}
