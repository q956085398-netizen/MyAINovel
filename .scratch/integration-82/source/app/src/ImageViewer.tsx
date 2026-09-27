import { useEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface ImageViewerProps {
  /** 本地绝对路径（编辑器渲染层解析好的）。 */
  path: string;
  alt?: string;
  onClose: () => void;
}

/** 原图大图查看器（工单 #31，spec 编辑器渲染层.md §二）：可缩放（滚轮/
 *  按钮）、拖拽平移、Esc/点遮罩关闭；「原始大小」去 CSS 上限按 1:1 像素
 *  显示（超出视口拖拽平移）；不做标注/裁剪。 */
export default function ImageViewer({ path, alt, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 滚轮缩放（非被动监听才能 preventDefault，避免顺带滚动下层页面）。
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => Math.min(8, Math.max(0.1, e.deltaY < 0 ? s * 1.15 : s / 1.15)));
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, []);

  function reset() {
    setScale(1);
    setPos({ x: 0, y: 0 });
    setNatural(false);
  }

  return (
    <div className="image-viewer" ref={overlayRef} onClick={onClose}>
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button className="btn small" onClick={() => setScale((s) => Math.min(8, s * 1.25))}>
          放大
        </button>
        <span className="image-viewer-scale">{Math.round(scale * 100)}%</span>
        <button className="btn small" onClick={() => setScale((s) => Math.max(0.1, s / 1.25))}>
          缩小
        </button>
        <button className="btn small" onClick={() => setNatural((v) => !v)}>
          {natural ? "适应屏幕" : "原始大小"}
        </button>
        <button className="btn small" onClick={reset}>
          重置
        </button>
        <button className="btn small" onClick={onClose}>
          关闭（Esc）
        </button>
      </div>
      <img
        src={convertFileSrc(path)}
        alt={alt ?? ""}
        draggable={false}
        className={natural ? "natural" : ""}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, y: e.clientY, baseX: pos.x, baseY: pos.y };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          setPos({ x: d.baseX + (e.clientX - d.x), y: d.baseY + (e.clientY - d.y) });
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={reset}
      />
    </div>
  );
}

/** 三个编辑器共用的查看器接线：open 给渲染层回调，node 挂页面树。 */
export function useImageViewer(): {
  open: (path: string, alt: string) => void;
  node: ReactNode;
} {
  const [image, setImage] = useState<{ path: string; alt: string } | null>(null);
  return {
    open: (path, alt) => setImage({ path, alt }),
    node: image ? (
      <ImageViewer path={image.path} alt={image.alt} onClose={() => setImage(null)} />
    ) : null,
  };
}
