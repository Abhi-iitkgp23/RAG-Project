import { NO_CLAIMS } from "../lib/copy";
import { CORPUS } from "../lib/corpus";
import { uniqueSources } from "../lib/presentClaims";
import type { Source } from "../lib/types";
import { IconSource } from "./icons";

function citationCount(count: number): string {
  if (count === 1) return "1 Verified Citation";
  return `${count} Verified Citations`;
}

/** Renders `claims[].source` only. A URL inside the answer is not a citation. */
export function SourcesPanel({ sources }: { sources: Source[] }) {
  const listed = uniqueSources(sources);
  const cited = listed.length > 0;

  return (
    <aside className="sources" aria-label="Sources">
      <div className="sources-heading">
        <div className="sources-title">
          <IconSource />
          <h2>Sources</h2>
        </div>
        <span className={cited ? "count-badge is-cited" : "count-badge"}>
          {citationCount(listed.length)}
        </span>
      </div>

      {listed.length === 0 ? (
        <p className="sources-empty">{NO_CLAIMS}</p>
      ) : (
        <ol>
          {listed.map((source, index) => (
            <li
              key={`${source.url}-${source.sectionHeading}-${index}`}
              className="source-card"
            >
              <h3>{source.documentName}</h3>
              <p>
                {source.publisher}, {source.year}
                <span aria-hidden="true"> · </span>
                {source.sectionHeading}
              </p>
              <a href={source.url}>{source.url}</a>
            </li>
          ))}
        </ol>
      )}

      <div className="corpus-list">
        <span className="corpus-kicker">Permitted corpus</span>
        <ul>
          {CORPUS.map((document) => (
            <li key={document.id}>
              <span className="corpus-dot" aria-hidden="true" />
              <span>
                {document.name} ({document.year})
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
