import type { ComponentType, SVGProps } from "react";

/**
 * 图标体系（工单 #35，方向乙「现代通透」，docs/spec/视觉系统.md §三）。
 *
 * 全应用图标只从这里取：一处定尺寸与描边，调用点不再各写各的。
 * 图标源＝Lucide（ISC 许可，24px 网格线性图标）；18px 配 1.75 描边——
 * 描边随尺寸收细，小尺寸下更干净，与中文字重也更协调（Obsidian 官方
 * 图标表同样是「越大越细」：14/16px 用 2、18px 用 1.75、32px 用 1.25）。
 */
export type Glyph = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }
>;

/** 默认尺寸：侧栏导航、页面动作。密集控件与正文内联用 16。 */
export const ICON_SIZE = 18;
/** 默认描边（方向乙）。 */
export const ICON_STROKE = 1.75;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  as: Glyph;
  /** 缺省 18；密集控件用 16。 */
  size?: number;
  strokeWidth?: number;
}

/** 统一出口：`<Icon as={Settings} />`。装饰性图标不进无障碍树（旁边总有可见文案）。 */
export function Icon({ as: Glyph, size = ICON_SIZE, strokeWidth = ICON_STROKE, ...rest }: IconProps) {
  return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden focusable="false" {...rest} />;
}

export {
  ArrowLeft,
  BookOpen,
  Check,
  Layers,
  MessageCircle,
  PenLine,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
