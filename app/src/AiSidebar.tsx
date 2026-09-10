import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SYSTEM_PROMPT,
  buildCommandMessages,
  buildRequestMessages,
  formatCalloutText,
  formatProseText,
  isReportKind,
  parseTropeSuggestion,
} from "./ai";
import type {
  AiCommandKind,
  AiConfig,
  AiSeed,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  DocSnapshot,
  MessageMeta,
  TropeSuggestion,
  Vocabulary,
} from "./types";
import { errMsg, oneLinePreview } from "./util";
import ProviderSettingsDialog from "./ProviderSettingsDialog";

interface AiSidebarProps {
  open: boolean;
  onClose: () => void;
  /** 库根：标注命令组提示词前加载词表，让 AI 优先复用既有类型词。 */
  libraryPath: string | null;
  /** 板块命令种子：带材料（拆书三条带选区与行号），面板消费后回调清空。 */
  seed: AiSeed | null;
  onSeedConsumed: () => void;
  getDoc: () => DocSnapshot | null;
  /** 采纳 callout：anchorLine 为命令时选区末行（1 起），编辑器按其行尾插入。 */
  adoptCallout: (kind: "点评" | "小结", text: string, anchorLine: number) => boolean;
  adoptTrope: (startLine: number, endLine: number, s: TropeSuggestion) => void;
  /** 采纳润色稿：替换写作页当前选区（没有选区/编辑器未就绪返回 false）。 */
  replaceSelection: (text: string) => boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** VSCode 式 AI 侧边栏（设计共识 §七）。面板常驻挂载、仅隐藏切换，
 *  中途收起不打断流式输出。 */
export default function AiSidebar({
  open,
  onClose,
  libraryPath,
  seed,
  onSeedConsumed,
  getDoc,
  adoptCallout,
  adoptTrope,
  replaceSelection,
}: AiSidebarProps) {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  /** null＝尚未开聊的草稿（首次发送才建会话文件）。 */
  const [current, setCurrent] = useState<ChatSession | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [docAttached, setDocAttached] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const streamingRef = useRef(false);
  const tokenRef = useRef(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  /** 与 current 同步的镜像：Channel 回调里读会话现值、做保存副作用，不走 setState updater。 */
  const currentRef = useRef<ChatSession | null>(null);
  /** 已采纳过回写的消息（会话内序号），采纳一次即失效。 */
  const [adoptedSet, setAdoptedSet] = useState<Set<number>>(new Set());
  /** 防种子被重复消费（React 严格模式效应会跑两遍）。 */
  const seedRef = useRef<AiSeed | null>(null);

  function updateSession(
    fn: (prev: ChatSession | null) => ChatSession | null,
  ): ChatSession | null {
    const next = fn(currentRef.current);
    currentRef.current = next;
    setCurrent(next);
    return next;
  }

  function resetAdopted() {
    setAdoptedSet(new Set());
  }

  const provider = config?.providers.find((p) => p.id === config.activeProviderId) ?? null;
  const doc = getDoc();

  async function refreshSessions() {
    try {
      setSessions(await invoke<ChatSessionSummary[]>("list_chat_sessions"));
    } catch {
      // 会话列表刷不出来不影响当前对话
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await invoke<AiConfig>("load_ai_config");
        setConfig(cfg);
      } catch (e) {
        setError(errMsg(e));
        setConfig({ providers: [], activeProviderId: null });
      }
      await refreshSessions();
    })();
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current?.messages, streaming]);

  /** 收尾：去掉没等到任何内容的空助手消息，落盘并刷新列表。 */
  function finalizeStream() {
    if (!streamingRef.current) return;
    streamingRef.current = false;
    setStreaming(false);
    const updated = updateSession((prev) => {
      if (!prev) return prev;
      let messages = prev.messages;
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.content === "") {
        messages = messages.slice(0, -1);
      }
      return { ...prev, messages, updatedAt: nowSec() };
    });
    if (updated) {
      void invoke("save_chat_session", { session: updated })
        .then(() => refreshSessions())
        .catch(() => {});
    }
  }

  async function send(userText: string, meta?: MessageMeta | null, system?: string) {
    const text = userText.trim();
    if (!text || streamingRef.current) return;
    if (!provider) {
      setError("先在「设置」里配置并选择供应商。");
      setSettingsOpen(true);
      return;
    }

    const now = nowSec();
    const base =
      currentRef.current ??
      {
        id: crypto.randomUUID(),
        title: oneLinePreview(text, 20),
        createdAt: now,
        updatedAt: now,
        messages: [] as ChatMessage[],
      };
    const withUser: ChatSession = {
      ...base,
      messages: [...base.messages, { role: "user", content: text, meta: meta ?? undefined }],
      updatedAt: now,
    };
    updateSession(() => withUser);
    setError(null);
    resetAdopted();
    streamingRef.current = true;
    setStreaming(true);
    // 用户消息先落盘：中途崩溃/停止也不丢提问。
    try {
      await invoke("save_chat_session", { session: withUser });
      void refreshSessions();
    } catch {
      // 落盘失败不阻塞对话
    }

    const docForRequest = docAttached ? getDoc() : null;
    const reqMessages = buildRequestMessages(
      withUser.messages,
      system ?? DEFAULT_SYSTEM_PROMPT,
      docForRequest,
    );
    const token = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    tokenRef.current = token;
    const channel = new Channel<ChatStreamEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "delta") {
        updateSession((prev) => {
          if (!prev) return prev;
          const messages = [...prev.messages];
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant") {
            messages[messages.length - 1] = { ...last, content: last.content + ev.text };
          } else {
            messages.push({ role: "assistant", content: ev.text, meta: meta ?? undefined });
          }
          return { ...prev, messages };
        });
      } else {
        finalizeStream();
      }
    };
    try {
      await invoke("chat_stream", {
        req: {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: reqMessages,
        },
        token,
        onEvent: channel,
      });
      finalizeStream();
    } catch (e) {
      setError(errMsg(e));
      finalizeStream();
    }
  }

  // 板块命令种子：面板拿到即组提示词发送（ADR 0003：AI 只处理人写的内容）。
  // 供应商未配置时保留种子并打开设置，配好后重跑本效应即自动发出，材料不丢。
  useEffect(() => {
    if (!seed || !config || seedRef.current === seed) return;
    if (!provider) {
      setError("先配置供应商，「" + seed.kind + "」命令会在配好后自动发出。");
      setSettingsOpen(true);
      return;
    }
    seedRef.current = seed;
    onSeedConsumed();
    void (async () => {
      // 标注命令带词表（每次现取，词表在 Obsidian 里手改也即时生效）。
      let vocab: Vocabulary | null = null;
      if (seed.kind === "标注" && libraryPath) {
        try {
          vocab = await invoke<Vocabulary>("load_vocab", { root: libraryPath });
        } catch (e) {
          // 词表损坏要亮出来（spec：显式报错），但不挡命令本身。
          setError(`词表加载失败：${errMsg(e)}（标注命令继续，类型提示用通用示例）`);
        }
      }
      const { system, user } = buildCommandMessages(seed, vocab);
      const meta: MessageMeta = {
        kind: seed.kind,
        startLine: seed.startLine,
        endLine: seed.endLine,
      };
      void send(user, meta, system);
    })();
    // seed 由用户动作驱动、send 闭包读取即时不依赖其稳定性。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, config]);

  function stop() {
    if (!streamingRef.current) return;
    void invoke("chat_cancel", { token: tokenRef.current }).catch(() => {
      // 取消失败只能等流自然结束
    });
  }

  async function selectSession(id: string) {
    if (streamingRef.current) return;
    try {
      const session = await invoke<ChatSession>("load_chat_session", { id });
      updateSession(() => session);
      resetAdopted();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function deleteCurrentSession() {
    const session = currentRef.current;
    if (!session || streamingRef.current) return;
    if (!window.confirm(`确定删除会话「${session.title}」？删除后不可恢复。`)) return;
    try {
      await invoke("delete_chat_session", { id: session.id });
      updateSession(() => null);
      resetAdopted();
      await refreshSessions();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  function handleAdopt(kind: AiCommandKind, idx: number, content: string, meta: MessageMeta) {
    if (isReportKind(kind)) {
      // 体检类命令只出报告（spec §二、§五：建议不是闸，报告不落盘）。
      return;
    }
    if (kind === "标注") {
      const suggestion = parseTropeSuggestion(content);
      // 行号是命令时的选区快照：缺了（老会话/新命令）就不采纳，不猜位置。
      if (!suggestion || meta.startLine === undefined || meta.endLine === undefined) return;
      adoptTrope(meta.startLine, meta.endLine, suggestion);
      setAdoptedSet((s) => new Set(s).add(idx));
      return;
    }
    if (kind === "润色") {
      // 润色是整体改写：替换选中；编辑器不可用（切了板块/没选区）只提示，不乱插。
      const ok = replaceSelection(formatProseText(content));
      if (ok) {
        setAdoptedSet((s) => new Set(s).add(idx));
      } else {
        setError("替换失败：回到书写板块、停在当前章，且正文里还留着那段选区。");
      }
      return;
    }
    if (meta.endLine === undefined) return;
    const ok = adoptCallout(
      kind === "梳理" ? "点评" : "小结",
      formatCalloutText(content),
      meta.endLine,
    );
    if (ok) setAdoptedSet((s) => new Set(s).add(idx));
  }

  const lastIdx = current ? current.messages.length - 1 : -1;

  return (
    <aside className={`ai-panel ${open ? "" : "closed"}`}>
      <header className="ai-header">
        <span className="ai-title">AI 助手</span>
        <button
          className="btn small"
          disabled={streaming}
          title={current ? "开一个新会话" : "已在空会话"}
          onClick={() => {
            updateSession(() => null);
            resetAdopted();
          }}
        >
          新会话
        </button>
        <button
          className="btn small"
          disabled={!current || streaming}
          title="删除当前会话"
          onClick={() => void deleteCurrentSession()}
        >
          删除
        </button>
        <button className="btn small" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button className="btn small" onClick={onClose} title="收起面板">
          ×
        </button>
      </header>

      {provider ? (
        <div className="ai-session-bar">
          <select
            className="ai-session-select"
            value={current?.id ?? ""}
            disabled={streaming}
            onChange={(e) => {
              if (e.target.value) void selectSession(e.target.value);
            }}
          >
            {!current && <option value="">（新会话）</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}（{s.messageCount} 条）
              </option>
            ))}
          </select>
          <span className="ai-provider-chip" title={`${provider.baseUrl} · ${provider.model}`}>
            {provider.name || provider.model}
          </span>
        </div>
      ) : (
        <div className="ai-session-bar">
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            去配置供应商
          </button>
        </div>
      )}

      <div className="ai-messages" ref={messagesRef}>
        {!current || current.messages.length === 0 ? (
          <div className="ai-empty">
            <p>和 AI 聊拆书、找灵感、构思剧情。各板块的「AI 命令」：</p>
            <p className="hint">拆书：梳理选中内容 · 建议类型/解法标注 · 提炼小结</p>
            <p className="hint">构思：排布体检 · 矛盾梳理（只出报告，不改文件）</p>
            <p className="hint">书写：本章体检 · 润色选中（润色点采纳才替换正文）</p>
            <p className="hint">AI 只给初稿与建议，采纳后才会写入文档。</p>
          </div>
        ) : (
          current.messages.map((m, i) => (
            <div key={i} className={`ai-msg ${m.role}`}>
              <div className="ai-bubble">
                {m.content}
                {streaming && i === lastIdx && m.role === "assistant" && (
                  <span className="ai-cursor">▍</span>
                )}
              </div>
              {m.role === "assistant" && !streaming && m.meta && (
                <AdoptActions
                  kind={m.meta.kind}
                  content={m.content}
                  adopted={adoptedSet.has(i)}
                  onAdopt={() => handleAdopt(m.meta!.kind, i, m.content, m.meta!)}
                />
              )}
            </div>
          ))
        )}
        {error && <div className="error-box">{error}</div>}
      </div>

      <div className="ai-composer">
        <div className="ai-composer-controls">
          <label className="ai-attach" title="把当前打开的文档（拆书稿或当前章）全文作为上下文发给 AI">
            <input
              type="checkbox"
              checked={docAttached}
              disabled={!doc}
              onChange={(e) => setDocAttached(e.target.checked)}
            />
            携带当前文档
          </label>
          {docAttached && doc && (
            <span className="ai-ctx-chip">
              《{doc.bookName}》{doc.label ? ` · ${doc.label}` : ""} 约 {doc.content.length} 字
            </span>
          )}
        </div>
        <textarea
          className="ai-input"
          rows={3}
          value={input}
          placeholder={provider ? "输入后回车发送，Shift+Enter 换行" : "先在「设置」里配置供应商"}
          disabled={!provider}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const text = input;
              setInput("");
              void send(text);
            }
          }}
        />
        <div className="ai-composer-actions">
          {streaming ? (
            <button className="btn" onClick={stop}>
              停止
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={!provider || !input.trim()}
              onClick={() => {
                const text = input;
                setInput("");
                void send(text);
              }}
            >
              发送
            </button>
          )}
        </div>
      </div>

      {settingsOpen && config && (
        <ProviderSettingsDialog
          initial={config}
          onClose={() => setSettingsOpen(false)}
          onSaved={(cfg) => {
            setConfig(cfg);
            setSettingsOpen(false);
          }}
        />
      )}
    </aside>
  );
}

function AdoptActions({
  kind,
  content,
  adopted,
  onAdopt,
}: {
  kind: AiCommandKind;
  content: string;
  adopted: boolean;
  onAdopt: () => void;
}) {
  // 体检类命令只出报告，没有采纳动作（spec §二、§五）。
  if (isReportKind(kind)) return null;
  if (kind === "标注") {
    const parsed = parseTropeSuggestion(content);
    return (
      <div className="ai-adopt">
        <button
          className="btn small"
          disabled={!parsed || adopted}
          title={parsed ? "按建议预填桥段标注，确认后才写入 .yaml" : "未能从回复解析出类型/解法"}
          onClick={onAdopt}
        >
          {adopted ? "已预填标注 ✓" : "按建议预填桥段标注"}
        </button>
        {parsed && (
          <span className="hint">
            类型：{parsed.types.join("、")}
            {parsed.solution ? ` ｜ 解法：${parsed.solution}` : ""}
          </span>
        )}
      </div>
    );
  }
  const label =
    kind === "梳理" ? "采纳为「点评」块插入" : kind === "润色" ? "替换选中正文" : "采纳为「小结」块插入";
  return (
    <div className="ai-adopt">
      <button
        className="btn small"
        disabled={adopted}
        title={kind === "润色" ? "用润色稿替换正文里那段选区（可 Ctrl+Z 撤销）" : undefined}
        onClick={onAdopt}
      >
        {adopted ? (kind === "润色" ? "已替换 ✓" : "已插入 ✓") : label}
      </button>
    </div>
  );
}
