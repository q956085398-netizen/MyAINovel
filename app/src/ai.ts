import type {
  AiCommandKind,
  AiSeed,
  ChatMessage,
  DocSnapshot,
  TropeSuggestion,
} from "./types";

/** 普通对话的默认系统提示（ADR 0003：只做梳理、建议、提炼、激发灵感这类助手活）。 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是「工笔」（个人网文创作工具）里的写作助手，帮用户拆书、找灵感、构思剧情。" +
  "回答用中文，简明直接，多用要点。";

const COMMAND_PROMPTS: Record<AiCommandKind, (seed: AiSeed) => { system: string; user: string }> = {
  梳理: (seed) => ({
    system:
      "你是「工笔」的拆书助手，只处理用户自己写下的拆书记录。请梳理用户选中的内容，" +
      "输出简明 markdown 要点：一、脉络概括；二、结构判断（对照章节拍：代入、信息差、" +
      "拉扯、兑现、善后、启下，指出哪些拍已有、哪些缺）；三、可改进点。",
    user: `请梳理以下选中的拆书记录（来自《${seed.bookName}》）：\n\n${seed.text}`,
  }),
  标注: (seed) => ({
    system:
      "你是「工笔」的拆书助手。阅读用户选中的拆书记录，判断其中包含的桥段「类型」" +
      "（爽点类型，如：掉马甲、打脸、扮猪吃虎、逆袭、鉴宝）与「解法」（该类型下的具体" +
      "写法与花样）。输出必须严格只有两行，格式如下，不要任何其他内容：\n" +
      "类型：类型A、类型B\n解法：一句话描述具体写法",
    user: `请判断以下选中内容（来自《${seed.bookName}》）的桥段类型与解法：\n\n${seed.text}`,
  }),
  小结: (seed) => ({
    system:
      "你是「工笔」的拆书助手。为用户提供的章节拆书记录提炼一段小结：100 字以内，" +
      "概括梗概、亮点与可借鉴之处。直接输出小结正文，不要标题、不要前后缀说明。",
    user: `请为以下章节拆书记录${seed.note ? `（${seed.note}）` : ""}提炼小结：\n\n${seed.text}`,
  }),
};

/** 三命令的用户消息（进会话历史）与系统提示（每次请求时组装）。 */
export function buildCommandMessages(seed: AiSeed): { system: string; user: string } {
  return COMMAND_PROMPTS[seed.kind](seed);
}

/** 解析「建议类型/解法标注」的回复；容忍 markdown 加粗与空白。解析不出类型则返回 null。 */
export function parseTropeSuggestion(reply: string): TropeSuggestion | null {
  const cleaned = reply.replace(/\*\*/g, "");
  let types: string[] | null = null;
  let solution: string | null = null;
  for (const line of cleaned.split(/\r?\n/)) {
    const typeMatch = line.match(/^\s*类型\s*[:：]\s*(.+)$/);
    if (typeMatch) {
      const parsed = typeMatch[1]
        .split(/[,，、;；]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (parsed.length > 0) types = parsed;
      continue;
    }
    const solutionMatch = line.match(/^\s*解法\s*[:：]\s*(.+)$/);
    if (solutionMatch) {
      solution = solutionMatch[1].trim() || null;
    }
  }
  return types ? { types, solution } : null;
}

/** 把 AI 回复整成 callout 正文：去首尾空白与包裹代码栏，压掉连续空行。 */
export function formatCalloutText(reply: string): string {
  let text = reply.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  return text.replace(/\n{3,}/g, "\n\n");
}

/** 「携带当前文档」时注入的系统消息（只进请求，不进会话历史）。 */
export function docContextMessage(doc: DocSnapshot): string {
  return (
    `当前打开的拆书稿：《${doc.bookName}》\n${doc.path}\n` +
    `--- 正文开始 ---\n${doc.content}\n--- 正文结束 ---`
  );
}

/** 组装请求消息：默认系统提示（或命令系统提示）＋可选文档上下文＋会话历史。 */
export function buildRequestMessages(
  sessionMessages: ChatMessage[],
  system: string,
  doc: DocSnapshot | null,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  if (doc) messages.push({ role: "system", content: docContextMessage(doc) });
  messages.push(
    ...sessionMessages.map((m) => ({ role: m.role, content: m.content })),
  );
  return messages;
}
