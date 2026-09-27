/** 章节关联只记录项目目录名和章节文件名，与 Rust 的解析规则一致。 */
export function chapterInspirationLink(link: string): { project: string; fileName: string } | null {
  if (!link.startsWith("章:")) return null;
  const segments = link.slice(2).split("/");
  if (segments.length !== 2) return null;
  try {
    return { project: decodeURIComponent(segments[0]), fileName: decodeURIComponent(segments[1]) };
  } catch {
    return null;
  }
}
