import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RegionDraft, RegionEntry } from "./types";
import { PLACE_SCALES } from "./types";
import { errMsg, splitList } from "./util";
import { dirName } from "./editorRender";
import MarkdownEditor from "./MarkdownEditor";
import VocabInput from "./VocabInput";

interface RegionDialogProps {
  project: string;
  initial: RegionDraft;
  /** 编辑既有地域时的文件位置；null 为新建。 */
  prevPath: string | null;
  /** 改名前的旧名（新建＝null）：包含行的对账依据。 */
  prevName: string | null;
  /** 当前所属地图名（结构表「包含」行派生）；null＝尚未归入任何地图。 */
  ownerMap: string | null;
  /** 现有地图名：归属与「展开为」的选择项。 */
  mapNames: string[];
  onClose: () => void;
  onSaved: (entry: RegionEntry) => void;
  onDeleted: (path: string) => void;
}

/** 地域档案编辑框（工单 #65 / T15）：地图内部的局部区域。档案管地方
 *  本身；归属（包含）单独落在结构表，改名或换图时一并对账。 */
export default function RegionDialog({
  project,
  initial,
  prevPath,
  prevName,
  ownerMap,
  mapNames,
  onClose,
  onSaved,
  onDeleted,
}: RegionDialogProps) {
  const [name, setName] = useState(initial.name);
  const [scale, setScale] = useState(initial.scale ?? "");
  const [owner, setOwner] = useState(ownerMap ?? "");
  const [plotRole, setPlotRole] = useState(initial.plotRole ?? "");
  const [localMainline, setLocalMainline] = useState(initial.localMainline ?? "");
  const [secret, setSecret] = useState(initial.secret ?? "");
  // 手补数据可能把「展开为」指向自己的所属地图：按不冲突的口径呈现。
  const [expandsTo, setExpandsTo] = useState(
    initial.expandsTo && initial.expandsTo !== ownerMap ? initial.expandsTo : "",
  );
  const [peopleText, setPeopleText] = useState(initial.people.join("、"));
  const [orgsText, setOrgsText] = useState(initial.organizations.join("、"));
  const [contrasText, setContrasText] = useState(initial.contradictions.join("、"));
  const [unitsText, setUnitsText] = useState(initial.units.join("、"));
  const [foreshadowsText, setForeshadowsText] = useState(initial.foreshadows.join("、"));
  const [erasText, setErasText] = useState(initial.eras.join("、"));
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);

  function changeOwner(next: string) {
    setOwner(next);
    if (next === expandsTo) setExpandsTo("");
  }

  async function save() {
    if (busy) return;
    const draft: RegionDraft = {
      name: name.trim(),
      scale: scale.trim() || null,
      plotRole: plotRole.trim() || null,
      people: splitList(peopleText),
      organizations: splitList(orgsText),
      contradictions: splitList(contrasText),
      units: splitList(unitsText),
      foreshadows: splitList(foreshadowsText),
      eras: splitList(erasText),
      localMainline: localMainline.trim() || null,
      secret: secret.trim() || null,
      expandsTo: expandsTo.trim() || null,
      body,
    };
    if (!draft.name) {
      window.alert("地域名不能为空。");
      return;
    }
    setBusy(true);
    try {
      const entry = await invoke<RegionEntry>("save_region", { project, draft, prevPath });
      // 档案与归属分开保存：档案先落盘；改名或换图时对账结构表的包含行。
      if (draft.name !== (prevName ?? "") || owner !== (ownerMap ?? "")) {
        try {
          await invoke("set_region_containment", {
            project,
            prevRegion: prevName,
            region: entry.name,
            mapName: owner || null,
          });
        } catch (e) {
          window.alert(
            `档案已保存，但所属地图更新失败：${errMsg(e)}\n结构表读取或校验出了问题，请先处理再重试保存。`,
          );
          return;
        }
      }
      onSaved(entry);
    } catch (e) {
      window.alert(`地域保存失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!prevPath || busy) return;
    if (
      !window.confirm(
        `确定删除地域「${name.trim() || initial.name}」？\n${prevPath}\n` +
          "删除的是档案文件；归属与相邻关系不会自动清理（照常显示缺省节点）。",
      )
    )
      return;
    setBusy(true);
    try {
      await invoke("delete_map_place", { path: prevPath });
      onDeleted(prevPath);
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog wide">
        <h2>{prevPath ? "编辑地域" : "新建地域"}</h2>
        <label>
          地域名（标题即文件名）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：京城"
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            局部尺度（只提示，可自由输入）
            <VocabInput
              value={scale}
              onChange={setScale}
              words={PLACE_SCALES}
              placeholder="地点 / 村落 / 城镇 / 城市……"
            />
          </label>
          <label>
            所属地图（包含关系；一个地域只归一张地图）
            <select value={owner} onChange={(e) => changeOwner(e.target.value)}>
              <option value="">（不属于任何地图）</option>
              {mapNames.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          剧情功能（这个地方在故事里干什么）
          <input
            value={plotRole}
            onChange={(e) => setPlotRole(e.target.value)}
            placeholder="如：权力中心与身份危机的主舞台"
          />
        </label>
        <div className="form-row">
          <label>
            当地主线
            <input
              value={localMainline}
              onChange={(e) => setLocalMainline(e.target.value)}
              placeholder="如：在新朝眼皮底下站稳脚跟"
            />
          </label>
          <label>
            秘密
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="如：地宫里躺着前朝真龙"
            />
          </label>
        </div>
        <label>
          展开为另一张地图（名字引用；两边互不复制正文）
          <select value={expandsTo} onChange={(e) => setExpandsTo(e.target.value)}>
            <option value="">（不展开）</option>
            {mapNames
              .filter((m) => m !== owner)
              .map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
          </select>
        </label>
        <div className="form-row">
          <label>
            人物（多个用、隔开）
            <input
              value={peopleText}
              onChange={(e) => setPeopleText(e.target.value)}
              placeholder="如：主角、皇后"
            />
          </label>
          <label>
            组织（多个用、隔开）
            <input
              value={orgsText}
              onChange={(e) => setOrgsText(e.target.value)}
              placeholder="如：新朝、前朝暗线"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            矛盾（多个用、隔开）
            <input
              value={contrasText}
              onChange={(e) => setContrasText(e.target.value)}
              placeholder="发生在这里的矛盾"
            />
          </label>
          <label>
            单元（多个用、隔开）
            <input
              value={unitsText}
              onChange={(e) => setUnitsText(e.target.value)}
              placeholder="如：初入京城"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            伏笔（多个用、隔开）
            <input
              value={foreshadowsText}
              onChange={(e) => setForeshadowsText(e.target.value)}
              placeholder="埋在这里的伏笔"
            />
          </label>
          <label>
            时代（多个用、隔开；「历史」页签按时代查看）
            <input
              value={erasText}
              onChange={(e) => setErasText(e.target.value)}
              placeholder="如：开国时代"
            />
          </label>
        </div>
        <label>
          正文（氛围、视觉印象、地域隐秘、当地历史……）
          <MarkdownEditor
            value={body}
            onChange={setBody}
            height="200px"
            resolveDir={prevPath ? dirName(prevPath) : undefined}
          />
        </label>
        <p className="hint">
          保存写入 构思/地域/{name.trim() || "地域名"}.md；同名自动续号，在 Obsidian
          里手补的字段不会丢。
        </p>
        <div className="dialog-actions">
          {prevPath && (
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>
              删除
            </button>
          )}
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
