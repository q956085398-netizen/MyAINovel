import { BookOpen, Icon, ICON_SIZE_DENSE, MessageCircle, PenLine, Sparkles } from "./icons";
import type { AssistantPreset, ChatPreset } from "./types";

/** 内置预设的固定图标；个人预设显示自己填的 emoji，没填就退通用图标。
 *  设置页（T06）与 AI 侧栏（T07）共用一份口径。 */
const BUILTIN_ICONS: Record<string, typeof MessageCircle> = {
  "builtin:general": MessageCircle,
  "builtin:analyst": BookOpen,
  "builtin:ideator": Sparkles,
  "builtin:editor": PenLine,
};

export default function PresetGlyph({ preset }: { preset: AssistantPreset | ChatPreset }) {
  const Builtin = BUILTIN_ICONS[preset.id];
  if (Builtin) return <Icon as={Builtin} size={ICON_SIZE_DENSE} />;
  if (preset.icon) return <span className="preset-emoji">{preset.icon}</span>;
  return <Icon as={MessageCircle} size={ICON_SIZE_DENSE} />;
}
