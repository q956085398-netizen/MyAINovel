import type { RegionDraft, RegionEntry } from "./types";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

interface RegionSaveRequest {
  project: string;
  draft: RegionDraft;
  prevPath: string | null;
  prevName: string | null;
  owner: string;
  ownerMap: string | null;
}

/**
 * 地域档案与结构表仍各自落盘，但档案一旦成功便立刻把新路径交还调用方。
 * 这样第二步失败后重试会编辑刚保存的文件，不会续号新建或继续引用旧路径。
 */
export async function saveRegionFlow(
  invokeCommand: Invoke,
  request: RegionSaveRequest,
  onArchiveSaved: (entry: RegionEntry) => void,
): Promise<RegionEntry> {
  const entry = await invokeCommand<RegionEntry>("save_region", {
    project: request.project,
    draft: request.draft,
    prevPath: request.prevPath,
  });
  onArchiveSaved(entry);

  if (request.draft.name !== (request.prevName ?? "") || request.owner !== (request.ownerMap ?? "")) {
    await invokeCommand("set_region_containment", {
      project: request.project,
      prevRegion: request.prevName,
      region: entry.name,
      mapName: request.owner || null,
    });
  }
  return entry;
}
