import type { ReactNode } from "react";
import { contentCardDomId } from "./contentSurfaceState";

interface ContentSurfaceProps {
  identity: string;
  title: ReactNode;
  badges?: ReactNode;
  trailing?: ReactNode;
  expanded: boolean;
  pending?: boolean;
  searchMatched?: boolean;
  onEdit: () => void;
  onToggleExpanded: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

/** 可供灵感、人物、组织等领域对象复用的完整内容表面。
 *  只负责阅读层级与收起行为，不保存任何创作内容副本。 */
export default function ContentSurface({
  identity,
  title,
  badges,
  trailing,
  expanded,
  pending = false,
  searchMatched = false,
  onEdit,
  onToggleExpanded,
  children,
  actions,
}: ContentSurfaceProps) {
  return (
    <article
      id={contentCardDomId(identity)}
      className={`card-item content-card ${pending ? "is-pending" : ""} ${searchMatched ? "is-search-hit" : ""}`}
    >
      <div className="card-title-row">
        <button className="card-title" title="编辑这张卡片" onClick={onEdit}>
          {title}
        </button>
        {badges}
        <span className="card-title-spacer" />
        {trailing}
        <button
          className="card-collapse"
          type="button"
          aria-expanded={expanded}
          aria-controls={`${contentCardDomId(identity)}-content`}
          disabled={searchMatched}
          title={searchMatched ? "搜索命中的卡片保持展开" : expanded ? "收起卡片内容" : "展开卡片内容"}
          onClick={onToggleExpanded}
        >
          {searchMatched ? "搜索命中" : expanded ? "收起" : "展开"}
        </button>
      </div>
      {expanded && (
        <div id={`${contentCardDomId(identity)}-content`} className="content-card-content">
          {children}
          {actions && <div className="content-card-actions">{actions}</div>}
        </div>
      )}
    </article>
  );
}
