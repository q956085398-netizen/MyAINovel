import { useSearchDestination } from "./globalSearchNavigation";
import { contentCardDomId } from "./contentSurfaceState";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ForeshadowView } from "./types";
import { FORESHADOW_OVERDUE_CHAPTERS } from "./types";
import { errMsg } from "./util";
import { ForeshadowNameDialog } from "./ForeshadowDialog";
import ForeshadowBoardContent from "./ForeshadowBoardContent";

interface ForeshadowBoardProps {
  project: string;
  /** 项目章前缀，用于渲染「第N章」。 */
  chapterPrefix: string | null;
  /** 伏笔变了：让项目页刷新计数。 */
  onChanged: () => void;
  /** 点章名：跳到书写板块打开该章并选中引文。 */
  onOpenChapter: (ordinal: number, quote: string) => void;
}

/** 伏笔看板（工单 #6，docs/spec/伏笔系统.md）：长期管理半区——
 *  按状态分组、超期统计（埋了 N 章未收的清单）、引文失配提示。 */
export default function ForeshadowBoard({
  project,
  chapterPrefix,
  onChanged,
  onOpenChapter,
}: ForeshadowBoardProps) {
  const [views, setViews] = useState<ForeshadowView[]>([]);
  const destination = useSearchDestination();
  useEffect(() => {
    if (destination?.hit.kind !== "伏笔" || destination.hit.projectDir !== project) return;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(contentCardDomId(`${project}/伏笔/${destination.hit.title}`));
      card?.scrollIntoView({ block: "center" }); card?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [destination, project, views]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setViews(await invoke<ForeshadowView[]>("foreshadow_board", { project }));
    } catch (e) {
      setViews([]);
      setError(`读取伏笔失败：${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function changeState(name: string, state: string) {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("set_foreshadow_state", { project, name, state });
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`改状态失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function changePending(name: string, pending: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("set_foreshadow_pending", { project, name, pending });
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`切换待打磨失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (busy) return;
    if (!window.confirm(`删除伏笔「${name}」？\n（伏笔.yaml 里的这一条会整条删掉）`)) return;
    setBusy(true);
    try {
      await invoke("delete_foreshadow", { project, name });
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function create(name: string) {
    setBusy(true);
    try {
      await invoke("add_foreshadow", { project, name });
      setCreating(false);
      await scan();
      onChanged();
    } catch (e) {
      window.alert(`新建伏笔失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const overdueCount = views.filter((v) => v.overdue).length;
  const searchHitName = destination?.hit.kind === "伏笔" ? destination.hit.title : null;

  return (
    <div className="note-pane">
      <div className="pane-head">
        <div>
          <h2>伏笔看板</h2>
          <p className="hint">
            长期线索按状态管理：写作时选中正文右键设为伏笔/回收伏笔；这里看谁埋了太久没收。
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          新建伏笔
        </button>
      </div>

      {overdueCount > 0 && (
        <div className="hint-box">
          有 {overdueCount} 条伏笔埋了 {FORESHADOW_OVERDUE_CHAPTERS} 章以上还没收，先看它们。
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {loading && <p className="hint">正在读取……</p>}

      {!loading && !error && views.length === 0 && (
        <div className="empty-state">
          <p>还没有伏笔。</p>
          <p className="hint">
            到「书写」里选中一段正文右键「设为伏笔」，这里就会出现它；
            <br />
            也可以先「新建伏笔」记下名字（待埋），写作时再标注。
          </p>
        </div>
      )}

      <ForeshadowBoardContent
        project={project}
        chapterPrefix={chapterPrefix}
        views={views}
        busy={busy}
        searchHitName={searchHitName}
        onOpenChapter={onOpenChapter}
        onChangeState={changeState}
        onChangePending={changePending}
        onRemove={remove}
      />
      {creating && (
        <ForeshadowNameDialog
          title="新建伏笔（待埋）"
          label="伏笔名"
          hint="只是先记下这条线索；写作时在正文里选中文字标注，它就会升为「已埋」。"
          initial=""
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={(name) => void create(name)}
        />
      )}
    </div>
  );
}
