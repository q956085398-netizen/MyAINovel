/** 人物的结构摘要；与 Rust CharacterProfile 对应，正文仍完全自由。 */
export interface CharacterProfile {
  image: string | null;
  identity: string | null;
  age: string | null;
  gender: string | null;
  traits: string[];
  goal: string | null;
  ability: string | null;
  weakness: string | null;
  secret: string | null;
}

export const CHARACTER_FIELDS = [
  ["image", "形象图"], ["identity", "一句话身份"], ["age", "年龄或年龄感"],
  ["gender", "性别"], ["goal", "当前目标"], ["ability", "能力"],
  ["weakness", "弱点或代价"], ["secret", "个人秘密"],
] as const;

export function emptyCharacterProfile(): CharacterProfile {
  return { image: null, identity: null, age: null, gender: null, traits: [], goal: null, ability: null, weakness: null, secret: null };
}

export interface Membership {
  person: string;
  organization: string;
  kind: string;
  role: string | null;
  status: string;
  secret: boolean;
  note: string | null;
}

export function membershipSummary(member: Membership): string {
  return [member.organization, member.kind, member.role, member.status, member.secret ? "秘密" : "公开", member.note].filter(Boolean).join(" · ");
}

export function characterDetailRows(profile?: CharacterProfile): [string, string][] {
  if (!profile) return [];
  const rows: [string, string][] = CHARACTER_FIELDS.flatMap(([field, label]) =>
    profile[field]?.trim() ? [[label, profile[field]!]] : [],
  );
  if (profile.traits.length) rows.push(["性格关键词", profile.traits.join("、")]);
  return rows;
}
