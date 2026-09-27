import type { Membership } from "./characterProfile";
import type { LegendItem } from "./types";

export interface SocialNode { kind: "人物" | "组织"; name: string }
export interface Placement { node: SocialNode; x: number; y: number; pinned: boolean }
export interface SocialEdge {
  from: SocialNode; to: SocialNode; kind: string; directed: boolean; note: string | null; secret: boolean;
}
export interface SocialCanvasData {
  nodes: SocialNode[]; placements: Placement[]; edges: SocialEdge[];
  legend: LegendItem[];
  fingerprint: string; upgraded: boolean; recoveryNeeded: boolean;
}
export interface OrganizationDraft {
  name: string; purpose: string | null; location: string | null; conflict: string | null; secret: string | null; body: string;
}
export interface Organization { path: string; draft: OrganizationDraft; fingerprint: string }
export interface SocialWorkspace {
  organizations: Organization[]; persons: string[]; memberships: Membership[];
  fingerprint: string; upgraded: boolean; recoveryNeeded: boolean;
}
export const ORG_FIELDS = [
  ["purpose", "目的"], ["location", "所在地"], ["conflict", "矛盾"], ["secret", "秘密"],
] as const;
export function nodeId(node: SocialNode): string { return `${node.kind}:${node.name}`; }
export function nodeLabel(node: SocialNode): string { return `${node.name}（${node.kind}）`; }
