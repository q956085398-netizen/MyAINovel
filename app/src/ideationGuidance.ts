export interface IdeationPrompt {
  id: string;
  title: string;
  text: string;
}

export interface IdeationQuestion {
  id: string;
  text: string;
}

export const DEFAULT_IMAGINATION_PROMPTS: IdeationPrompt[] = [
  {
    id: "reader-expectation",
    title: "读者期待",
    text: "读者点进这类故事时，最想看到哪几种满足感、场面或关系变化？",
  },
  {
    id: "genre-stereotype",
    title: "题材刻板印象",
    text: "这个题材最常见、也最容易让人猜到的套路是什么？你准备沿用、反转还是绕开？",
  },
  {
    id: "unique-attraction",
    title: "独特吸引力",
    text: "如果读者只能记住这本书一个与同类不同的吸引力，它会是什么？",
  },
];

export function firstOpenQuestion(
  candidates: IdeationQuestion[],
  dismissed: string[],
): IdeationQuestion | null {
  return candidates.find((item) => !dismissed.includes(item.id)) ?? null;
}

export function editPrompt(
  prompts: IdeationPrompt[],
  id: string,
  text: string,
): IdeationPrompt[] {
  return prompts.map((prompt) => (prompt.id === id ? { ...prompt, text } : prompt));
}

export function removePrompt(prompts: IdeationPrompt[], id: string): IdeationPrompt[] {
  return prompts.filter((prompt) => prompt.id !== id);
}
