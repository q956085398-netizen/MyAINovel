import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChapterAnchor, TropeSpan, Vocabulary } from "./types";
import { errMsg, tropeSpanLabel } from "./util";
import VocabInput from "./VocabInput";

/** 类型分隔符：中英文逗号/顿号/分号都可。 */
function parseTypes(text: string): string[] {
  return text
    .split(/[,，、;；]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

interface TropeDialogProps {
  mdPath: string;
  /** 库根：加载词表提示（库根「词表.yaml」＋库内已用词）。 */
  libraryPath: string | null;
  chapters: ChapterAnchor[];
  initial: TropeSpan[];
  /** 已有 .yaml 解析失败时的警告（保存会整文件覆盖）。 */
  warning?: string;
  onClose: () => void;
  onSaved: (tropes: TropeSpan[]) => void;
}

/** 桥段标注（设计共识 §四）：选起止章 → 填类型（必填）/解法 →
 *  存入该书 .yaml 的「桥段」列表。起止为章标题序数，非正文章号。
 *  类型/解法输入挂词表提示（只提示不校验，工单 #10）。 */
export default function TropeDialog({
  mdPath,
  libraryPath,
  chapters,
  initial,
  warning,
  onClose,
  onSaved,
}: TropeDialogProps) {
  const [list, setList] = useState<TropeSpan[]>(initial);
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(Math.min(4, Math.max(chapters.length, 1)));
  const [typesText, setTypesText] = useState("");
  const [solution, setSolution] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [vocab, setVocab] = useState<Vocabulary | null>(null);
  const [vocabError, setVocabError] = useState<string | null>(null);

  // 首次打开桥段标注面板即触发词表种子落盘（应用此后对词表只读不写）。
  useEffect(() => {
    if (!libraryPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const v = await invoke<Vocabulary>("load_vocab", { root: libraryPath });
        if (!cancelled) setVocab(v);
      } catch (e) {
        if (!cancelled) setVocabError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryPath]);

  // 词表加载失败（或无库根）时兜底：本书已标注的词照样给提示，输入不受影响。
  const typeWords = useMemo(
    () =>
      vocab && !vocabError
        ? vocab.types
        : [...new Set(list.flatMap((t) => t.types))],
    [vocab, vocabError, list],
  );
  const solutionWords = useMemo(
    () =>
      vocab && !vocabError
        ? vocab.solutions
        : [...new Set(list.map((t) => t.solution).filter((s): s is string => Boolean(s)))],
    [vocab, vocabError, list],
  );

  function addTrope() {
    const types = parseTypes(typesText);
    if (types.length === 0) {
      setFormError("类型必填：至少填一个（如「掉马甲、打脸」）");
      return;
    }
    if (start > end) {
      setFormError("起章不能晚于止章");
      return;
    }
    setList((l) => [
      ...l,
      {
        startChapter: start,
        endChapter: end,
        types,
        solution: solution.trim() || null,
      },
    ]);
    setTypesText("");
    setSolution("");
    setFormError(null);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await invoke("save_tropes", { mdPath, tropes: list });
      onSaved(list);
    } catch (e) {
      window.alert(`桥段保存失败：${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog wide">
        <h2>桥段标注</h2>
        {warning && <div className="error-box">{warning}</div>}
        <p className="hint">
          起止按正文里第几个章标题计（约 4 章一个桥段）；类型必填，解法可选。
          标注存入同名 .yaml，书库首页可按类型/解法跨书筛选。
          类型/解法有词表提示（只提示不校验），词表在库根「词表.yaml」，可在
          Obsidian 里增删。
        </p>
        {vocabError && (
          <p className="hint">词表加载失败：{vocabError}（仍可自由输入）。</p>
        )}

        {chapters.length === 0 ? (
          <div className="error-box">
            正文中没有检测到章标题。先用「开下一章」或按章前缀写标题，再来标注桥段。
          </div>
        ) : (
          <div className="trope-form">
            <label>
              起章
              <select
                value={start}
                onChange={(e) => setStart(Number(e.target.value))}
              >
                {chapters.map((c) => (
                  <option key={c.ordinal} value={c.ordinal}>
                    #{c.ordinal} {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              止章
              <select value={end} onChange={(e) => setEnd(Number(e.target.value))}>
                {chapters.map((c) => (
                  <option key={c.ordinal} value={c.ordinal}>
                    #{c.ordinal} {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              类型（必填，多个用、隔开）
              <VocabInput
                value={typesText}
                onChange={setTypesText}
                words={typeWords}
                placeholder="如：掉马甲、打脸"
              />
            </label>
            <label className="grow">
              解法（可选）
              <VocabInput
                value={solution}
                onChange={setSolution}
                words={solutionWords}
                placeholder="这一段的具体写法/花样"
              />
            </label>
            <button className="btn" onClick={addTrope}>
              加入列表
            </button>
          </div>
        )}
        {formError && <div className="error-box">{formError}</div>}

        {list.length > 0 ? (
          <table className="trope-table">
            <thead>
              <tr>
                <th>章范围</th>
                <th>类型</th>
                <th>解法</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t, i) => (
                <tr key={`${t.startChapter}-${t.endChapter}-${i}`}>
                  <td title="按正文里第几个章标题计，非正文章号">{tropeSpanLabel(t)}</td>
                  <td>
                    {t.types.map((ty) => (
                      <span key={ty} className="tag">
                        {ty}
                      </span>
                    ))}
                  </td>
                  <td>{t.solution ?? "—"}</td>
                  <td>
                    <button
                      className="btn small"
                      onClick={() => setList((l) => l.filter((_, j) => j !== i))}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">还没有桥段标注。</p>
        )}

        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
