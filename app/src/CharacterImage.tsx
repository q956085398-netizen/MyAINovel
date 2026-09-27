import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { dirName, resolveRelative } from "./editorRender";
import "./CharacterImage.css";

/** 只展示本地附件，失败只影响图片，文字档案始终可用。 */
export default function CharacterImage({ image, path, name }: { image?: string | null; path: string; name: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!image?.trim()) return null;
  const local = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(image) || /^[a-zA-Z]:[\\/]/.test(image);
  const absolute = /^[a-zA-Z]:[\\/]|^[/\\]/.test(image) ? image : resolveRelative(dirName(path), image);
  const source = local ? convertFileSrc(absolute) : null;
  if (!source || failedSource === source) return <p className="hint">形象图无法显示：{image}。文字档案仍可编辑。</p>;
  return <img className="character-image" src={source} alt={`${name}的形象图`} onError={() => setFailedSource(source)} />;
}
