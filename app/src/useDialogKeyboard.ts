import { useEffect, useRef, type KeyboardEvent } from "react";

/** 模态窗口只在自身范围内循环 Tab；校对侧面板允许 Tab 回正文。 */
export function useDialogKeyboard(open: boolean, close: () => void, busy = false, modal = true) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>("input:not(:disabled),textarea:not(:disabled),button:not(:disabled),select:not(:disabled)") ?? dialog).focus();
    }
  }, [open]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) close();
    } else if (event.key === "Tab" && modal) {
      const controls = [...(ref.current?.querySelectorAll<HTMLElement>(
        'input:not(:disabled),textarea:not(:disabled),button:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]',
      ) ?? [])].filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
        event.preventDefault(); first.focus();
      }
    }
  }
  return { ref, onKeyDown, tabIndex: -1 };
}
