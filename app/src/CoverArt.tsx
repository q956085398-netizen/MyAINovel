import { stripBookMarks } from "./util";

/** 封面位（工单 #22 骨架，#23 长出真图）：无封面以书名首字＋主题底色占位，
 *  底色跟主题变量走，深色模式自动适配。 */
export default function CoverArt({ name }: { name: string }) {
  const bare = stripBookMarks(name).trim();
  const first = Array.from(bare)[0] ?? "书";
  return <div className="cover-art cover-placeholder">{first}</div>;
}
