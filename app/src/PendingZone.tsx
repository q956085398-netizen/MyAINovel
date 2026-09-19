import type { ReactNode } from "react";
import { formatCount } from "./util";

interface PendingZoneProps {
  /** 区域名，如「待打磨灵感」「待打磨的单元」。 */
  label: string;
  /** 便笺数量；为 0 时整个区域不渲染（spec §2.3）。 */
  count: number;
  hint: string;
  children: ReactNode;
}

/** 待打磨便笺区（工单 #64 / T03）：所属页面顶部的集中呈现，只显示
 *  真实数量与完整内容；便笺只是状态视图，不建第二份内容。 */
export default function PendingZone({ label, count, hint, children }: PendingZoneProps) {
  if (count === 0) return null;
  return (
    <section className="pending-zone" aria-label={label}>
      <div className="section-heading">
        <div>
          <h2>
            {label}（{formatCount(count)}）
          </h2>
          <p>{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
