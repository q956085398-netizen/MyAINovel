/** 关窗兜底保存的登记处（工单 #28，spec 拆书保存与模板 §二）：
 *  应用级 Tauri 关窗事件拦下默认→逐个落盘→再真正关闭。拆书/书写
 *  两编辑器挂载时各登记一个静默保存函数（不该弹框、不裁决冲突——
 *  冲突时盘上为准，ADR 0004）；失败也放行关窗，兜底是保险不是闸。 */
const flushers = new Set<() => Promise<void>>();

/** 挂载时登记，返回注销函数（直接放 useEffect return 里）。 */
export function registerFlushSaver(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

export async function flushAllSavers(): Promise<void> {
  await Promise.allSettled([...flushers].map((flush) => flush()));
}
