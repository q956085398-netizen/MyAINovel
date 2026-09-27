import { createContext, useContext, useEffect, useRef } from "react";
import type { ProjectTab } from "./ProjectPage";

export interface GlobalSearchHit {
  kind: string;
  title: string;
  path: string;
  projectDir: string | null;
  projectTitle: string | null;
  category: string | null;
  matches: { field: string; line: number; snippet: string; quote: string }[];
}
export interface GlobalSearchReport {
  hits: GlobalSearchHit[];
  warnings: string[];
  truncated: boolean;
}
export interface SearchDestination { hit: GlobalSearchHit; query: string }
export const SearchDestinationContext = createContext<SearchDestination | null>(null);
export const useSearchDestination = () => useContext(SearchDestinationContext);

export function searchProjectTab(hit: GlobalSearchHit): ProjectTab {
  switch (hit.kind) {
    case "组织": return "人物";
    case "地图": case "地域": return "地图";
    case "桥段": return "桥段库";
    case "期待线": return hit.category === "目标" ? "目标" : "期待感";
    case "人物": case "单元": case "矛盾": case "世界观": case "开头": case "伏笔": return hit.kind;
    default: return "首页";
  }
}

/** 等权威列表载入后只揭示一次；刷新/保存不再次打开已经关掉的详情。 */
export function useRevealSearchResult<T extends { path: string }>(
  items: T[], reveal: (item: T) => void,
) {
  const destination = useSearchDestination();
  const consumed = useRef<SearchDestination | null>(null);
  useEffect(() => {
    if (!destination || consumed.current === destination) return;
    const item = items.find((item) => item.path === destination.hit.path);
    if (!item) return;
    consumed.current = destination;
    reveal(item);
  }, [items, destination, reveal]);
}

const navigationGuards = new Set<() => Promise<boolean>>();
export function registerSearchNavigationGuard(guard: () => Promise<boolean>) {
  navigationGuards.add(guard);
  return () => { navigationGuards.delete(guard); };
}
/** 跳转可能重挂编辑器：冲突/失败时留在原处，不能用关窗的 best-effort 保存。 */
export async function prepareSearchNavigation() {
  for (const guard of navigationGuards) {
    if (!(await guard())) throw new Error("当前正文尚未保存，请先处理保存失败或冲突，再打开搜索结果。");
  }
}
