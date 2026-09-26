export interface ReaderPrompt {
  id: "expectation" | "stereotype" | "unique";
  label: string;
  text: string;
}

export const DEFAULT_READER_PROMPTS: ReaderPrompt[] = [
  {
    id: "expectation",
    label: "读者期待",
    text: "读者看到这个创意，最先会期待哪一幕？",
  },
  {
    id: "stereotype",
    label: "题材刻板印象",
    text: "这个题材通常承诺什么，又有哪些老路值得避开或反用？",
  },
  {
    id: "unique",
    label: "独特吸引力",
    text: "只有这本书的设定与人物组合，才能带来什么感受？",
  },
];

const READER_PROMPT_IDS = new Set(DEFAULT_READER_PROMPTS.map((prompt) => prompt.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeReaderPrompts(value: unknown): ReaderPrompt[] {
  if (value == null) return DEFAULT_READER_PROMPTS.map((prompt) => ({ ...prompt }));
  if (!Array.isArray(value)) return DEFAULT_READER_PROMPTS.map((prompt) => ({ ...prompt }));
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      !READER_PROMPT_IDS.has(item.id as ReaderPrompt["id"]) ||
      seen.has(item.id as string) ||
      typeof item.label !== "string" ||
      typeof item.text !== "string"
    ) {
      return [];
    }
    seen.add(item.id as string);
    return [
      {
        id: item.id as ReaderPrompt["id"],
        label: item.label,
        text: item.text,
      },
    ];
  });
}

export function selectOverviewQuestion(
  overview: {
    premise: string | null;
    readerImaginations: string[];
    characters: Array<{ name: string }>;
    maps: Array<{ name: string }>;
  },
  dismissed: string[],
): { id: string; tab: string; text: string } | null {
  const candidates = [
    !overview.premise && {
      id: "premise",
      tab: "大纲",
      text: "如果只用一句话介绍这本书，最想让读者记住什么？",
    },
    overview.readerImaginations.length === 0 && {
      id: "reader-imagination",
      tab: "读者遐想（类型圈）",
      text: "读者看到这个创意，最先会期待什么？",
    },
    overview.characters.length === 0 && {
      id: "characters",
      tab: "人物",
      text: "谁最能把这本书的核心困境带到读者面前？",
    },
    overview.maps.length === 0 && {
      id: "maps",
      tab: "地图",
      text: "哪个故事空间最能放大这本书的矛盾？",
    },
  ].filter(Boolean) as Array<{ id: string; tab: string; text: string }>;
  return candidates.find((candidate) => !dismissed.includes(candidate.id)) ?? null;
}
