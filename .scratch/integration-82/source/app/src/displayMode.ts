import { useSyncExternalStore } from "react";

/** 展示模式偏好（工单 #22，spec 书库新建与展示 §四）：封面网格（默认）｜
 *  书名列表。拆书库一个键、项目列表一个键（构思/书写共用后者）——
 *  三个板块常驻挂载、仅隐藏切换，外部存储同步让「调一处全生效」。 */
export type DisplayMode = "grid" | "list";

export type DisplayScope = "books" | "projects";

const KEYS: Record<DisplayScope, string> = {
  books: "gongbi.books.display",
  projects: "gongbi.projects.display",
};

const listeners = new Set<() => void>();

function read(scope: DisplayScope): DisplayMode {
  return localStorage.getItem(KEYS[scope]) === "list" ? "list" : "grid";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDisplayMode(scope: DisplayScope): [DisplayMode, (mode: DisplayMode) => void] {
  const mode = useSyncExternalStore(subscribe, () => read(scope));
  const set = (next: DisplayMode) => {
    if (next !== read(scope)) {
      localStorage.setItem(KEYS[scope], next);
      listeners.forEach((l) => l());
    }
  };
  return [mode, set];
}
