interface SectionPlaceholderProps {
  title: string;
  items: string;
}

/** 构思/书写板块的骨架占位页（设计共识 §一：v1 重点拆书，其余只留骨架）。 */
export default function SectionPlaceholder({ title, items }: SectionPlaceholderProps) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
        </div>
      </header>
      <div className="empty-state">
        <p>{items}</p>
        <p className="hint">v1 只留骨架，待实现级设计定稿后开发。</p>
      </div>
    </div>
  );
}
