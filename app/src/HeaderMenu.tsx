import { useEffect, useRef, useState } from "react";
import { ChevronDown, Icon, ICON_SIZE_DENSE } from "./icons";
import { nextMenuIndex, type MenuNavKey } from "./editorHeaderState";

/** 头部下拉菜单的一项；hint 是右侧的补充说明（快捷键、前提条件）。 */
export interface HeaderMenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

interface HeaderMenuProps {
  label: string;
  title?: string;
  items: HeaderMenuItem[];
  /** 菜单用键盘或选择项关闭后，把焦点交回正文（验收：回到正文）。 */
  onReturnFocus?: () => void;
}

/** 编辑器头部的下拉菜单（工单 #66 / T04）：插入、AI、页面动作的容器。
 *  键盘全程可达——↑↓ 移动（跳过禁用项）、Enter 选择、Esc/点外关闭，
 *  关闭与选择后焦点交回正文。 */
export default function HeaderMenu({ label, title, items, onReturnFocus }: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const enabled = items.map((it) => !it.disabled);

  function close(returnFocus: boolean) {
    setOpen(false);
    setFocusIndex(-1);
    if (returnFocus) onReturnFocus?.();
  }

  // 点外关闭：不抢焦点（正文里 mousedown 后菜单消失，光标不动）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 菜单打开后聚焦目标项（刚打开＝首个可用项）。
  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusIndex]);

  /** 触发按钮上的键盘行为：↑↓ 直接打开菜单（Enter/空格走原生点击激活）。 */
  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setFocusIndex(nextMenuIndex(enabled, -1, e.key === "ArrowUp" ? "ArrowUp" : "ArrowDown"));
    }
  }

  function onPopupKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      // Tab 离开菜单：收起弹层，让焦点按自然顺序走。
      close(false);
      return;
    }
    const navKeys: MenuNavKey[] = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (navKeys.includes(e.key as MenuNavKey)) {
      e.preventDefault();
      setFocusIndex(nextMenuIndex(enabled, focusIndex, e.key as MenuNavKey));
    }
  }

  return (
    <div className="header-menu" ref={rootRef}>
      <button
        type="button"
        className="btn with-icon"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(false);
          } else {
            setOpen(true);
            setFocusIndex(nextMenuIndex(enabled, -1, "ArrowDown"));
          }
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
        <Icon as={ChevronDown} size={ICON_SIZE_DENSE} />
      </button>
      {open && (
        <div className="header-menu-popup" role="menu" onKeyDown={onPopupKeyDown}>
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className="header-menu-item"
              disabled={it.disabled}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              tabIndex={-1}
              onClick={() => {
                if (it.disabled) return;
                close(true);
                it.run();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="header-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
