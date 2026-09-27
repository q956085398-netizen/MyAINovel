export const CONTENT_SURFACE_STORAGE_KEY = "gongbi.content-surfaces";

interface ContentSurfacePreferences {
  version: 1;
  surfaces: Record<string, string[]>;
}

interface SearchableContentCard {
  title: string;
  body: string;
  tags: string[];
  source: string | null;
  links: string[];
  core: string | null;
}

export interface TextMatchSegment {
  text: string;
  matched: boolean;
}

function parsePreferences(raw: string | null): ContentSurfacePreferences {
  if (!raw) return { version: 1, surfaces: {} };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return { version: 1, surfaces: {} };
    const surfacesValue = (value as { surfaces?: unknown }).surfaces;
    if (!surfacesValue || typeof surfacesValue !== "object") {
      return { version: 1, surfaces: {} };
    }

    const surfaces: Record<string, string[]> = {};
    for (const [name, paths] of Object.entries(surfacesValue)) {
      if (!Array.isArray(paths)) continue;
      surfaces[name] = paths.filter((path): path is string => typeof path === "string");
    }
    return { version: 1, surfaces };
  } catch {
    return { version: 1, surfaces: {} };
  }
}

export function readCollapsedCardPaths(raw: string | null, surface: string): Set<string> {
  return new Set(parsePreferences(raw).surfaces[surface] ?? []);
}

export function serializeCollapsedCardPaths(
  raw: string | null,
  surface: string,
  paths: ReadonlySet<string>,
): string {
  const preferences = parsePreferences(raw);
  preferences.surfaces[surface] = [...paths].sort();
  return JSON.stringify(preferences);
}

export function shouldExpandContentCard(
  path: string,
  collapsedPaths: ReadonlySet<string>,
  searchMatched: boolean,
): boolean {
  return searchMatched || !collapsedPaths.has(path);
}

export function cardMatchesQuery(card: SearchableContentCard, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase("zh-Hans-CN");
  if (!normalized) return true;
  return [
    card.title,
    card.body,
    card.source ?? "",
    card.core ?? "",
    card.tags.join(" "),
    card.links.join(" "),
  ]
    .join("\n")
    .toLocaleLowerCase("zh-Hans-CN")
    .includes(normalized);
}

export function contentCardDomId(path: string): string {
  return `content-card-${encodeURIComponent(path)}`;
}

export function splitTextMatches(text: string, query: string): TextMatchSegment[] {
  const needle = query.trim().toLocaleLowerCase("zh-Hans-CN");
  if (!needle) return [{ text, matched: false }];

  const haystack = text.toLocaleLowerCase("zh-Hans-CN");
  const segments: TextMatchSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const matchAt = haystack.indexOf(needle, cursor);
    if (matchAt < 0) {
      segments.push({ text: text.slice(cursor), matched: false });
      break;
    }
    if (matchAt > cursor) {
      segments.push({ text: text.slice(cursor, matchAt), matched: false });
    }
    const matchEnd = matchAt + needle.length;
    segments.push({ text: text.slice(matchAt, matchEnd), matched: true });
    cursor = matchEnd;
  }
  return segments.length > 0 ? segments : [{ text, matched: false }];
}
