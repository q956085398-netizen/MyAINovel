import { emptyNoteDraft } from "./types.ts";

export const POWER_SYSTEM_CATEGORY = "力量体系";

/** 仅是新草稿的自由正文，不给旧词条补模板，也不产生必填字段。 */
export function createPowerSystemDraft(withPrompts: boolean) {
  return {
    ...emptyNoteDraft("世界观"),
    category: POWER_SYSTEM_CATEGORY,
    body: withPrompts ? [
      "## 等级边界\n\n不同阶段能做到什么，又有什么做不到？没有等级也可以删掉这一节。",
      "## 力量来源\n\n力量从哪里来，与这本书的题材和读者期待有什么联系？",
      "## 成长条件\n\n人物如何获得下一步成长，需要经历什么选择或行动？",
      "## 代价限制\n\n使用和成长要付出什么，什么限制能带来矛盾？",
      "## 主角例外\n\n主角有什么例外？它如何保留困境，而不抹掉代价？",
      "## 剧情展示\n\n用哪一场具体事件，让读者看见力量与限制，而不是只听解释？",
      "## 下一阶段期待\n\n眼下看得见、还够不到的能力或目标，怎样让读者期待下一阶段？",
    ].join("\n\n") + "\n" : "",
  };
}
