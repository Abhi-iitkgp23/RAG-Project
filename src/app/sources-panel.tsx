import { CORPUS, type CorpusDocumentId } from "../lib/corpus";
import { documentsNamedInCoverageAnswer } from "../lib/coverage";
import { NO_CLAIMS, UNSUPPORTED_HEADING, UNSUPPORTED_NEXT } from "../lib/copy";
import { readableSections, uniqueSources } from "../lib/presentClaims";
import type { Source } from "../lib/types";
import { IconChevron, IconSource } from "./icons";

function filled(value: string | undefined): string {
  return value?.trim() ?? "";
}

function publishedLine(source: Source): string {
  const publisher = filled(source.publisher);
  const year = Number.isFinite(source.year) ? String(source.year) : "";
  return [publisher, year].filter((part) => part.length > 0).join(" · ");
}

/** One cited document. Empty fields are omitted; nothing is filled in. */
export function SourceItem({
  source,
  variant = "inline",
}: {
  source: Source;
  variant?: "inline" | "panel";
}) {
  const title = filled(source.documentName);
  const published = publishedLine(source);
  const sections = readableSections(source.sectionHeading, title);
  const url = filled(source.url);
  const inlineSection = sections.at(-1) ?? "";
  if (!title && !published && sections.length === 0 && !url) return null;

  return (
    <div className={variant === "panel" ? "source-item is-panel" : "source-item"}>
      <span className="source-icon" aria-hidden="true">
        <IconSource size={16} />
      </span>
      <div className="source-copy">
        {title ? <p className="source-title">{title}</p> : null}
        {variant === "panel" ? (
          <>
            {published ? <p className="source-publisher">{published}</p> : null}
            {sections.map((section, index) => (
              <p key={`${section}-${index}`} className="source-section">
                {section}
              </p>
            ))}
            {url ? <SourceLink url={url} title={title} /> : null}
          </>
        ) : published || inlineSection || url ? (
          <p className="source-meta">
            {published ? <span>{published}</span> : null}
            {inlineSection ? <span>{inlineSection}</span> : null}
            {url ? <SourceLink url={url} title={title} /> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SourceLink({ url, title }: { url: string; title: string }) {
  return (
    <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">
      View source
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only">
        {title ? ` for ${title}` : ""} (opens in a new tab)
      </span>
    </a>
  );
}

/**
 * Titles and organizations for the coverage disclosure. URLs come from the
 * corpus. These are the documents that were searched, not claim citations.
 */
const CHECKED_SOURCE_COPY: Record<
  CorpusDocumentId,
  { title: string; organization: string }
> = {
  "dgi-2024": {
    title: "Dietary Guidelines for Indians (2024)",
    organization: "ICMR\u2013National Institute of Nutrition",
  },
  "eatwell-2018": {
    title: "The Eatwell Guide booklet (2018)",
    organization: "Public Health England",
  },
  "cold-storage-2023": {
    title: "Cold Food Storage Chart",
    organization: "FoodSafety.gov",
  },
  "fsa-chill-2017": {
    title: "How to chill, freeze and defrost food safely (2017)",
    organization: "UK Food Standards Agency",
  },
};

export type CheckedSource = {
  id: CorpusDocumentId;
  title: string;
  organization: string;
  url: string;
};

/** Documents the coverage sentence says were searched, in corpus order. */
export function checkedSourcesForAnswer(answer: string): CheckedSource[] {
  return documentsNamedInCoverageAnswer(answer).flatMap((id) => {
    const document = CORPUS.find((item) => item.id === id);
    const copy = CHECKED_SOURCE_COPY[id];
    if (!document || !copy) return [];
    return [
      {
        id,
        title: copy.title,
        organization: copy.organization,
        url: document.sourceUrl,
      },
    ];
  });
}

function sourcesCheckedLabel(count: number): string {
  const noun = count === 1 ? "document" : "documents";
  return `Sources checked \u00b7 ${count} ${noun}`;
}

/** Short coverage refusal. The stored sentence is not shown again. */
export function UnsupportedAnswer() {
  return (
    <div className="answer">
      <p>
        <strong>{UNSUPPORTED_HEADING}</strong>
      </p>
      <p>{UNSUPPORTED_NEXT}</p>
    </div>
  );
}

/**
 * Collapsed list of documents a coverage refusal actually searched.
 * An answer that does not name a search renders nothing.
 */
export function SourcesChecked({ answer }: { answer: string }) {
  const documents = checkedSourcesForAnswer(answer);
  if (documents.length === 0) return null;

  return (
    <details className="sources-checked">
      <summary>
        <span className="sources-checked-icon" aria-hidden="true">
          <IconSource size={14} />
        </span>
        <span className="sources-checked-label">{sourcesCheckedLabel(documents.length)}</span>
        <span className="sources-checked-chevron" aria-hidden="true">
          <IconChevron size={16} />
        </span>
      </summary>
      <ul className="sources-checked-list">
        {documents.map((document) => (
          <li key={document.id}>
            <a href={document.url} target="_blank" rel="noopener noreferrer">
              {document.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <p className="sources-checked-org">{document.organization}</p>
            <p className="sources-checked-url">{document.url}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Permanent library of the four approved documents.
 * It does not depend on the current question or on retrieved claims.
 */
const LIBRARY_COPY: Record<CorpusDocumentId, { title: string; organization: string }> = {
  "dgi-2024": {
    title: "Dietary Guidelines for Indians (2024)",
    organization: "ICMR\u2013National Institute of Nutrition",
  },
  "eatwell-2018": {
    title: "The Eatwell Guide booklet (2018)",
    organization: "Public Health England",
  },
  "cold-storage-2023": {
    title: "Cold Food Storage Chart",
    organization: "FoodSafety.gov (USDA, FDA, and CDC)",
  },
  "fsa-chill-2017": {
    title: "How to chill, freeze and defrost food safely (2017)",
    organization: "UK Food Standards Agency",
  },
};

export type LibraryDocument = {
  id: CorpusDocumentId;
  title: string;
  organization: string;
  year: number;
  url: string;
};

export function officialSourceLibrary(): LibraryDocument[] {
  return CORPUS.map((document) => {
    const copy = LIBRARY_COPY[document.id];
    return {
      id: document.id,
      title: copy.title,
      organization: copy.organization,
      year: document.year,
      url: document.sourceUrl,
    };
  });
}

export function OfficialSources() {
  return (
    <ul className="library-list">
      {officialSourceLibrary().map((document) => (
        <li key={document.id} className="library-item">
          <span className="source-icon" aria-hidden="true">
            <IconSource size={16} />
          </span>
          <div className="source-copy">
            <p className="source-title">{document.title}</p>
            <p className="source-publisher">
              {document.organization}
              {Number.isFinite(document.year) ? <span> · {document.year}</span> : null}
            </p>
            <a className="source-link" href={document.url} target="_blank" rel="noopener noreferrer">
              Open official source
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Renders `claims[].source` only. A URL inside the answer is not a citation. */
export function SourcesPanel({ sources }: { sources: Source[] }) {
  const listed = uniqueSources(sources);
  if (listed.length === 0) {
    return <p className="sources-empty">{NO_CLAIMS}</p>;
  }

  return (
    <ul className="source-list source-list-panel">
      {listed.map((source, index) => (
        <li key={`${source.url}-${source.sectionHeading}-${index}`}>
          <SourceItem source={source} variant="panel" />
        </li>
      ))}
    </ul>
  );
}
