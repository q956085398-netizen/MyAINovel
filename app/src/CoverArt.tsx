import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { errMsg, stripBookMarks } from "./util";

/** 封面位（工单 #22 骨架、#23 真图）：有封面显示图片（asset 协议本地加载），
 *  无封面以书名首字＋主题底色占位；悬浮「设封面」选图即设。
 *  在 OB 里手动放一张 附件/封面.jpg 同样被扫描识别——零登记。 */
export default function CoverArt({
  name,
  cover,
  onSetCover,
}: {
  name: string;
  cover?: string | null;
  /** 提供则显示悬浮「设封面」按钮；不提供＝只展示不可改。 */
  onSetCover?: () => void;
}) {
  const bare = stripBookMarks(name).trim();
  const first = Array.from(bare)[0] ?? "书";
  return (
    <div className="cover-art-wrap">
      {cover ? (
        <div className="cover-art">
          <img src={convertFileSrc(cover)} alt={`${name} 封面`} loading="lazy" />
        </div>
      ) : (
        <div className="cover-art cover-placeholder">{first}</div>
      )}
      {onSetCover && (
        <button
          type="button"
          className="btn small set-cover-btn"
          title="选一张图设为封面（拷进附件/，替换旧封面）"
          onClick={(e) => {
            e.stopPropagation();
            onSetCover();
          }}
        >
          设封面
        </button>
      )}
    </div>
  );
}

/** 「设封面」动作本体（书库/构思/书写三处共用）：选图 → Rust 拷为
 *  coverDir/封面.<ext>（旧封面删除替换）→ onDone 重扫刷新。
 *  coverDir 来自扫描结果，落点约定在 Rust 侧（三处布局各自不同）。 */
export async function pickAndSetCover(coverDir: string, onDone: () => void) {
  const picked = await open({
    multiple: false,
    filters: [{ name: "图片", extensions: ["png", "jpg", "webp"] }],
  });
  if (typeof picked !== "string") return;
  try {
    await invoke("set_cover", { coverDir, imagePath: picked });
    onDone();
  } catch (e) {
    window.alert(`设封面失败：${errMsg(e)}`);
  }
}
