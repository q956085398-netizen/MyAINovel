import { splitTextMatches } from "./contentSurfaceState";

export default function SearchHighlight({ text, query }: { text: string; query: string }) {
  return splitTextMatches(text, query).map((segment, index) =>
    segment.matched ? (
      <mark key={index} className="search-hit-text" data-search-hit="true">
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
}
