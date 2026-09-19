import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./util";

/** 切换内容对象的待打磨状态（工单 #64 / T03）：对对象文件动
 *  「待打磨」键，成功后刷新本页；连点只执行第一次。
 *  灵感库与构思笔记列表共用同一份切换逻辑。 */
export function usePendingToggle(refresh: () => void | Promise<void>) {
  const [switching, setSwitching] = useState<string | null>(null);
  const toggle = useCallback(
    async (path: string, next: boolean) => {
      if (switching) return;
      setSwitching(path);
      try {
        await invoke("set_content_pending", { path, pending: next });
        await refresh();
      } catch (e) {
        window.alert(`切换待打磨失败：${errMsg(e)}`);
      } finally {
        setSwitching(null);
      }
    },
    [switching, refresh],
  );
  return { switching, toggle };
}
