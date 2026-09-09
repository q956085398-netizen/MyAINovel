import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChapterRange,
  ExportReport,
  ExportTemplate,
  ProjectMeta,
  ProofIssue,
  ProofReport,
} from "./types";
import { defaultExportTemplate } from "./types";
import {
  PROOFREAD_KIND_DE,
  PROOFREAD_KIND_SENSITIVE,
  PROOFREAD_KIND_WRONG,
} from "./types";
import { chapterHead } from "./chapterFile";
import { errMsg, formatCount } from "./util";

/** 导出与发布（工单 #14，docs/spec/导出与发布.md）：入口在书写板块的
 *  项目列表，不进写作页顶栏。导出是只读派生动作，只写 项目/导出/；
 *  校对只读正文、不写任何创作数据。 */

interface ExportDialogProps {
  projectDir: string;
  projectTitle: string;
  /** 有编号的章节数：范围输入的上限提示。 */
  chapterCount: number;
  libraryPath: string | null;
  onClose: () => void;
  /** 校对命中跳回：打开该章并选中命中词。 */
  onJump: (issue: ProofIssue) => void;
}

type Tab = "export" | "proof";

const KINDS = [PROOFREAD_KIND_SENSITIVE, PROOFREAD_KIND_DE, PROOFREAD_KIND_WRONG];
const KIND_CLASS: Record<string, string> = {
  [PROOFREAD_KIND_SENSITIVE]: "sensitive",
  [PROOFREAD_KIND_DE]: "de",
  [PROOFREAD_KIND_WRONG]: "wrong",
};

export function ExportDialog({
  projectDir,
  projectTitle,
  chapterCount,
  libraryPath,
  onClose,
  onJump,
}: ExportDialogProps) {
  const [tab, setTab] = useState<Tab>("export");
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [form, setForm] = useState<ExportTemplate>(defaultExportTemplate());
  const [prefix, setPrefix] = useState<string | null>(null);
  const [rangeMode, setRangeMode] = useState<"all" | "range">("all");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState(String(chapterCount || 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [proof, setProof] = useState<ProofReport | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await invoke<ExportTemplate[]>("load_export_templates");
        setTemplates(loaded);
        if (loaded[0]) setForm(loaded[0]);
      } catch (e) {
        setError(`读取渠道模板失败：${errMsg(e)}`);
      }
      try {
        const meta = await invoke<ProjectMeta>("read_project_meta", { project: projectDir });
        setPrefix(meta.chapterPrefix);
      } catch {
        // 项目.yaml 读不了：章号退回默认「第{n}章」。
      }
    })();
  }, [projectDir]);

  const range: ChapterRange = useMemo(() => {
    if (rangeMode === "all") return { from: null, to: null };
    const parse = (text: string) => {
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    return { from: parse(from), to: parse(to) };
  }, [rangeMode, from, to]);

  const grouped = useMemo(() => {
    if (!proof) return [];
    const map = new Map<string, ProofIssue[]>();
    for (const issue of proof.issues) {
      const list = map.get(issue.fileName);
      if (list) list.push(issue);
      else map.set(issue.fileName, [issue]);
    }
    return [...map.entries()];
  }, [proof]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of proof?.issues ?? []) {
      counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
    }
    return counts;
  }, [proof]);

  function setField<K extends keyof ExportTemplate>(key: K, value: ExportTemplate[K]) {
    setForm((cur) => ({ ...cur, [key]: value }));
  }

  async function run<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(errMsg(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const handlePreview = () =>
    void run(async () => {
      setPreview(await invoke<string>("preview_export", { project: projectDir, range, template: form }));
    });

  const handleExport = () =>
    void run(async () => {
      const result = await invoke<ExportReport>("export_book", {
        project: projectDir,
        range,
        template: form,
      });
      setReport(result);
      setPreview(null);
    });

  const handleProofread = () =>
    void run(async () => {
      setProof(
        await invoke<ProofReport>("proofread_chapters", {
          root: libraryPath ?? "",
          project: projectDir,
          range,
        }),
      );
    });

  const handleSaveTemplate = () =>
    void run(async () => {
      const name = form.name.trim();
      if (!name) throw new Error("模板要有个名字");
      const next = templates.some((t) => t.name === name)
        ? templates.map((t) => (t.name === name ? { ...form, name } : t))
        : [...templates, { ...form, name }];
      await invoke("save_export_templates", { templates: next });
      setTemplates(next);
      setForm({ ...form, name });
    });

  const handleDeleteTemplate = () =>
    void run(async () => {
      const next = templates.filter((t) => t.name !== form.name);
      const kept = next.length > 0 ? next : [defaultExportTemplate()];
      await invoke("save_export_templates", { templates: kept });
      setTemplates(kept);
      setForm(kept[0]);
    });

  const handleReveal = (path: string) =>
    void run(async () => {
      await invoke("reveal_path", { path });
    });

  const handleCopy = (text: string) =>
    void run(async () => {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog wide">
        <h2>导出与发布 · {projectTitle}</h2>
        <div className="subtabs export-tabs">
          <button
            className={`subtab ${tab === "export" ? "active" : ""}`}
            onClick={() => setTab("export")}
          >
            导出
          </button>
          <button
            className={`subtab ${tab === "proof" ? "active" : ""}`}
            onClick={() => setTab("proof")}
          >
            发布前校对
          </button>
        </div>

        <div className="export-range">
          <label>
            范围
            <select
              value={rangeMode}
              onChange={(e) => setRangeMode(e.target.value as "all" | "range")}
            >
              <option value="all">全书</option>
              <option value="range">章节区间</option>
            </select>
          </label>
          {rangeMode === "range" && (
            <>
              <label>
                起章
                <input value={from} inputMode="numeric" onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                止章
                <input value={to} inputMode="numeric" onChange={(e) => setTo(e.target.value)} />
              </label>
              <p className="hint">同一章号＝单章；未编号文件不参与导出。</p>
            </>
          )}
        </div>

        {error && <div className="error-box">{error}</div>}

        {tab === "export" ? (
          <>
            <div className="export-template">
              <label>
                渠道模板
                <select
                  value={form.name}
                  onChange={(e) => {
                    const picked = templates.find((t) => t.name === e.target.value);
                    if (picked) setForm(picked);
                  }}
                >
                  {templates.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="export-template-row">
                <label>
                  格式
                  <select value={form.format} onChange={(e) => setField("format", e.target.value)}>
                    <option value="txt">txt（平台粘贴口径）</option>
                    <option value="md">md（保留 markdown）</option>
                  </select>
                </label>
                <label>
                  段间空行
                  <select
                    value={form.blankLines}
                    onChange={(e) => setField("blankLines", Number(e.target.value))}
                  >
                    <option value={1}>1 行</option>
                    <option value={0}>不空行</option>
                  </select>
                </label>
              </div>
              <div className="export-template-row">
                <label className="grow">
                  标题模板
                  <input
                    value={form.headingTemplate ?? ""}
                    placeholder="留空＝{章号} {标题}"
                    onChange={(e) => setField("headingTemplate", e.target.value || null)}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.chapterHeading}
                    onChange={(e) => setField("chapterHeading", e.target.checked)}
                  />
                  补章节标题行
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.indent}
                    onChange={(e) => setField("indent", e.target.checked)}
                  />
                  段首缩进
                </label>
              </div>
              <div className="export-template-row">
                <label>
                  模板名（改名＝另存）
                  <input value={form.name} onChange={(e) => setField("name", e.target.value)} />
                </label>
                <label>
                  单章下限
                  <input
                    value={form.minWords}
                    inputMode="numeric"
                    onChange={(e) => setField("minWords", Number(e.target.value) || 0)}
                  />
                </label>
                <label>
                  单章上限
                  <input
                    value={form.maxWords}
                    inputMode="numeric"
                    onChange={(e) => setField("maxWords", Number(e.target.value) || 0)}
                  />
                </label>
              </div>
              <div className="export-template-actions">
                <button className="btn small" disabled={busy} onClick={handleSaveTemplate}>
                  保存模板
                </button>
                <button
                  className="btn small danger"
                  disabled={busy || templates.length <= 1}
                  onClick={handleDeleteTemplate}
                >
                  删除模板
                </button>
                <span className="hint">0＝不提示；模板存应用状态，跨书共用。</span>
              </div>
            </div>

            <div className="dialog-actions export-actions">
              <button className="btn push-left" disabled={busy} onClick={() => setTab("proof")}>
                先跑一遍校对
              </button>
              <button className="btn" disabled={busy} onClick={handlePreview}>
                预览
              </button>
              <button className="btn primary" disabled={busy} onClick={handleExport}>
                {busy ? "处理中……" : "导出"}
              </button>
            </div>

            {preview !== null && (
              <>
                <p className="hint">预览（前 4000 字，不落盘）：</p>
                <pre className="export-preview">{preview}</pre>
              </>
            )}

            {report && (
              <div className="export-report">
                <p className="hint">已导出 {formatCount(report.chapterCount)} 章 · {formatCount(report.wordCount)} 字</p>
                <p className="export-path" title={report.path}>
                  {report.path}
                </p>
                <div className="export-report-actions">
                  <button className="btn small" onClick={() => handleCopy(report.path)}>
                    {copied ? "已复制" : "复制路径"}
                  </button>
                  <button className="btn small" onClick={() => handleReveal(report.path)}>
                    打开所在目录
                  </button>
                </div>
                {report.warnings.map((w) => (
                  <p key={w} className="hint">
                    ⚠ {w}
                  </p>
                ))}
                {report.chapters.some((c) => c.notes.length > 0) && (
                  <ul className="export-chapters">
                    {report.chapters
                      .filter((c) => c.notes.length > 0)
                      .map((c) => (
                        <li key={c.fileName}>
                          {chapterHead(c.ordinal, prefix)}
                          {c.title ? ` ${c.title}` : ""}（{formatCount(c.wordCount)} 字）：{c.notes.join("；")}
                        </li>
                      ))}
                  </ul>
                )}
                <details className="export-chapters">
                  <summary>全部章节字数（{formatCount(report.chapters.length)} 章）</summary>
                  <ul>
                    {report.chapters.map((c) => (
                      <li key={c.fileName}>
                        {chapterHead(c.ordinal, prefix)}
                        {c.title ? ` ${c.title}` : ""} · {formatCount(c.wordCount)} 字
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="hint">
              只读正文、不写任何文件。敏感词与错词取库根「校对/敏感词.txt」「校对/错词.txt」，
              {proof
                ? proof.sensitiveFileExists
                  ? `当前敏感词 ${formatCount(proof.sensitiveWords)} 条、错词 ${formatCount(proof.wrongWords)} 条。`
                  : "当前没找到敏感词库（只有内置的地得规则与错词种子）。"
                : "一行一词，错词写成「错词 => 对词」。"}
            </p>
            <div className="dialog-actions export-actions">
              <button className="btn primary" disabled={busy} onClick={handleProofread}>
                {busy ? "扫描中……" : "开始校对"}
              </button>
            </div>
            {proof && (
              <div className="proof-report">
                <p className="hint">
                  扫了 {formatCount(proof.scannedChapters)} 章，命中 {formatCount(proof.issues.length)} 处
                  {KINDS.filter((k) => kindCounts[k]).map((k) => ` · ${k} ${kindCounts[k]}`).join("")}
                </p>
                {proof.issues.length === 0 && <p className="hint">没发现表内命中的问题。</p>}
                {grouped.map(([fileName, issues]) => (
                  <div key={fileName} className="proof-chapter">
                    <p className="proof-chapter-head">
                      {issues[0].ordinal !== null
                        ? chapterHead(issues[0].ordinal, prefix)
                        : fileName.replace(/\.md$/i, "")}
                      <span className="hint"> · {formatCount(issues.length)} 处</span>
                    </p>
                    <ul>
                      {issues.map((issue, index) => (
                        <li key={`${issue.line}-${issue.occurrence}-${issue.word}-${index}`}>
                          <button
                            className="proof-hit"
                            title="跳到正文并选中"
                            onClick={() => onJump(issue)}
                          >
                            <span className="proof-line">第 {issue.line} 行</span>
                            <span className={`proof-kind kind-${KIND_CLASS[issue.kind] ?? "other"}`}>
                              {issue.kind}
                            </span>
                            <span className="proof-word">{issue.word}</span>
                            {issue.suggestion && (
                              <span className="proof-suggestion">→ {issue.suggestion}</span>
                            )}
                            <span className="proof-snippet">{issue.snippet}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
