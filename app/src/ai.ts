import type {
  AiCommandKind,
  AiSeed,
  ChatMessage,
  DocSnapshot,
  TropeSuggestion,
  Vocabulary,
} from "./types";

/** 普通对话的默认系统提示（ADR 0003：只做梳理、建议、提炼、激发灵感这类助手活）。 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是「工笔」（个人网文创作工具）里的写作助手，帮用户拆书、找灵感、构思剧情。" +
  "回答用中文，简明直接，多用要点。";

/** 词表进标注提示词的类型上限：防词表长大后提示词膨胀。 */
const VOCAB_PROMPT_LIMIT = 60;

const COMMAND_PROMPTS: Record<
  AiCommandKind,
  (seed: AiSeed, vocab?: Vocabulary | null) => { system: string; user: string }
> = {
  梳理: (seed) => ({
    system:
      "你是「工笔」的拆书助手，只处理用户自己写下的拆书记录。请梳理用户选中的内容，" +
      "输出简明 markdown 要点：一、脉络概括；二、结构判断（对照章节拍：代入、信息差、" +
      "拉扯、兑现、善后、启下，指出哪些拍已有、哪些缺）；三、可改进点。",
    user: `请梳理以下选中的拆书记录（来自《${seed.bookName}》）：\n\n${seed.text}`,
  }),
  标注: (seed, vocab) => ({
    system:
      "你是「工笔」的拆书助手。阅读用户选中的拆书记录，判断其中包含的桥段「类型」" +
      "（爽点类型）与「解法」（该类型下的具体写法与花样）。" +
      (vocab && vocab.types.length > 0
        ? `优先从词表已有的类型中选取：${vocab.types.slice(0, VOCAB_PROMPT_LIMIT).join("、")}；` +
          "确有新类型再自造。"
        : "类型如：掉马甲、打脸、扮猪吃虎、逆袭、鉴宝。") +
      "输出必须严格只有两行，格式如下，不要任何其他内容：\n" +
      "类型：类型A、类型B\n解法：一句话描述具体写法",
    user: `请判断以下选中内容（来自《${seed.bookName}》）的桥段类型与解法：\n\n${seed.text}`,
  }),
  小结: (seed) => ({
    system:
      "你是「工笔」的拆书助手。为用户提供的章节拆书记录提炼一段小结：100 字以内，" +
      "概括梗概、亮点与可借鉴之处。直接输出小结正文，不要标题、不要前后缀说明。",
    user: `请为以下章节拆书记录${seed.note ? `（${seed.note}）` : ""}提炼小结：\n\n${seed.text}`,
  }),
  排布体检: (seed) => ({
    system:
      "你是「工笔」的构思助手。用户给你的是他自己写的排布（大纲）现状与机检提示。" +
      "请只做体检判断，不替他改写排布。输出三节：\n" +
      "一、结构判断：升级:战斗比例与张弛交替是否成立（机检只是地板，你要看趋势）；\n" +
      "二、风险点：连续同类、节奏塌陷、地图扎堆、单元核心与排布属性对不上、类型圈覆盖缺口，" +
      "逐个点名到具体位次；\n" +
      "三、调整建议：最多三条，每条说清「动哪一项、往哪动」，不写泛泛而谈的建议。\n" +
      "材料不足就直说，不要编造没给出的单元。",
    user: `请体检以下排布材料：\n\n${seed.text}`,
  }),
  矛盾梳理: (seed) => ({
    system:
      "你是「工笔」的构思助手。用户给你的是他的矛盾池（剧情种子）现状。" +
      "请只做分拣判断，不要替他写剧情正文。按四组列出：\n" +
      "一、可以展开成单元的（点名＋一句展开方向，说明它和类型圈的哪种爽点对得上）；\n" +
      "二、彼此像或与已有单元重复的（并列点名，说明为什么像）；\n" +
      "三、偏离类型圈的（点名，说明偏在哪）；\n" +
      "四、信息不足难判断的（点名，说缺什么）。\n" +
      "每条不超过两行；不确定就说不确定；没给的信息不要猜。",
    user: `请分拣以下矛盾池材料：\n\n${seed.text}`,
  }),
  人物关系梳理: (seed) => ({
    system:
      "你是「工笔」的构思助手。用户给你的是他选中的人物小传、这些人物身上的关系" +
      "（含不在选中名单里的那一端），以及这本书的类型圈与已有矛盾标题。" +
      "请只做关系网的体检判断，不要替他写剧情正文。输出三节：\n" +
      "一、剧情发生器：哪几条关系能直接长出剧情（点名关系两端，说明它和类型圈的哪种爽点对得上）；\n" +
      "二、废线与孤岛：哪些关系连了却长不出东西、谁还一条线都没有，点名；\n" +
      "三、缺失的连接：按已有的人物与阵营，指出哪里该有关系却没有（说清「谁和谁、什么关系」），最多三条。\n" +
      "每条不超过两行；只依据给你的材料，不确定就说不确定；不要编造没给的人物与关系。",
    user: `请体检以下人物关系材料：\n\n${seed.text}`,
  }),
  本章体检: (seed) => ({
    system:
      "你是「工笔」的书写助手。用户给你的是他自己写的这一章正文，以及这一章的伏笔、" +
      "期待线现状与所属单元。请只做体检，不改写正文。输出三节：\n" +
      "一、章节拍对照：代入、信息差、拉扯、兑现、善后、启下——哪些在、哪些缺、哪个过头，" +
      "要引正文里的证据，不空谈；\n" +
      "二、欠账提醒：本章该埋没埋、该收没收的伏笔与期待线（点名），全书未收的线里哪些拖得太久；" +
      "正文里埋了却没收的伏笔也可以点出，但不许编造设定；\n" +
      "三、可改进点：最多三条，每条指到具体位置。\n" +
      "只依据给你的材料，不补设定、不猜后续剧情。",
    user: `请体检以下单章材料：\n\n${seed.text}`,
  }),
  润色: (seed) => ({
    system:
      "你是「工笔」的书写助手。请润色用户选中的这段正文：只改字句（用词、节奏、" +
      "语气与原文一致），不改人称与视角，不增删情节与信息，不改变分段意图。" +
      "直接输出润色后的正文，不要解释、不要标题、不要代码栏；拿不准的地方保持原样。",
    user: `请润色以下选中正文${seed.note ? `（${seed.note}）` : ""}：\n\n${seed.text}`,
  }),
};

/** 体检类命令：只出报告，没有采纳动作（docs/spec/AI命令集.md §二、§五）。 */
export function isReportKind(kind: AiCommandKind): boolean {
  return (
    kind === "排布体检" ||
    kind === "矛盾梳理" ||
    kind === "人物关系梳理" ||
    kind === "本章体检"
  );
}

/** 命令的用户消息（进会话历史）与系统提示（每次请求时组装）。
 *  vocab 仅标注命令使用：让 AI 优先复用既有类型词，避免增殖（工单 #10）。 */
export function buildCommandMessages(
  seed: AiSeed,
  vocab?: Vocabulary | null,
): { system: string; user: string } {
  return COMMAND_PROMPTS[seed.kind](seed, vocab);
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

/** 把 AI 回复整成可直接替换正文的润色稿：只去包裹代码栏与首尾空白。
 *  不压空行、不动分段——正文字该是什么样是人的事（spec §2.4）。 */
export function formatProseText(reply: string): string {
  const text = reply.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : text;
}

/** 「携带当前文档」时注入的系统消息（只进请求，不进会话历史）。
 *  抬头中立：拆书稿与书写章节都走这一条；`label`＝更细的定位（如章名）。 */
export function docContextMessage(doc: DocSnapshot): string {
  const head = doc.label ? `《${doc.bookName}》· ${doc.label}` : `《${doc.bookName}》`;
  return (
    `当前打开的文档：${head}\n${doc.path}\n` +
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
