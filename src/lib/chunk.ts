import type { CorpusDocumentId } from "./corpus";
import type { ParsedDocument, ParsedUnit, ParsedUnitKind } from "./parsedDocument";

/** Preferred size when an oversized narrative is cut into pieces. */
export const CHUNK_TARGET_CHARS = 1_200;

/** A unit at or under this length stays whole, except a storage category, which always does. */
export const CHUNK_HARD_MAX_CHARS = 2_000;

/** Shared tail between neighbours. Applied only to paragraph splits. */
export const CHUNK_OVERLAP_CHARS = 200;

/** Prose shorter than this is not indexed as its own chunk. */
export const CHUNK_MIN_PROSE_CHARS = 80;

export type ChunkUnitKind =
  | "section"
  | "recommendation"
  | "table"
  | "category"
  | "paragraph-split";

/** Citation fields copied onto every chunk. `retrievedAt` comes from `fetch.json`. */
export type ChunkSource = {
  id: CorpusDocumentId;
  name: string;
  publisher: string;
  year: number;
  sourceUrl: string;
  retrievedAt: string;
};

export type GuidanceChunk = {
  id: string;
  documentId: CorpusDocumentId;
  documentName: string;
  publisher: string;
  year: number;
  sourceUrl: string;
  retrievedAt: string;
  sectionHeading: string;
  text: string;
  unitKind: ChunkUnitKind;
};

type Draft = {
  sectionHeading: string;
  text: string;
  unitKind: ChunkUnitKind;
  /** True when this piece is one part of a table cut between rows. */
  rowSplit: boolean;
};

export type ChunkBuild = {
  chunks: GuidanceChunk[];
  paragraphSplits: number;
  rowSplits: number;
};

/**
 * Turn one parsed document into citation-bearing chunks.
 * The splitter does not read the PDF or HTML again.
 */
export function chunkDocument(
  parsed: ParsedDocument,
  source: ChunkSource,
): GuidanceChunk[] {
  return buildChunks(parsed, source).chunks;
}

/**
 * Same chunks as `chunkDocument`, plus how many of them are paragraph
 * splits or row splits. Row-split pieces stay `unitKind: "table"`.
 */
export function buildChunks(
  parsed: ParsedDocument,
  source: ChunkSource,
): ChunkBuild {
  if (parsed.documentId !== source.id) {
    throw new Error(
      `chunk source ${source.id} does not match parsed document ${parsed.documentId}`,
    );
  }

  const drafts = mergeShortDrafts(
    parsed.units.flatMap((unit) => expandUnit(unit, source.name)),
  );
  const chunks = drafts.map((draft, index) => ({
    id: `${source.id}:${index + 1}`,
    documentId: source.id,
    documentName: source.name,
    publisher: source.publisher,
    year: source.year,
    sourceUrl: source.sourceUrl,
    retrievedAt: source.retrievedAt,
    sectionHeading: draft.sectionHeading,
    text: draft.text,
    unitKind: draft.unitKind,
  }));
  return {
    chunks,
    paragraphSplits: chunks.filter((chunk) => chunk.unitKind === "paragraph-split")
      .length,
    rowSplits: drafts.filter((draft) => draft.rowSplit).length,
  };
}

function expandUnit(unit: ParsedUnit, documentName: string): Draft[] {
  const text = unit.text.trim();
  if (!text) return [];
  const sectionHeading = unit.sectionHeading.trim() || documentName;

  if (unit.kind === "category") {
    return [{ sectionHeading, text, unitKind: "category", rowSplit: false }];
  }
  if (unit.kind === "recommendation") {
    return [{ sectionHeading, text, unitKind: "recommendation", rowSplit: false }];
  }
  if (unit.kind === "table") {
    const pieces = splitTable(unit);
    const rowSplit = pieces.length > 1;
    return pieces.map((piece) => ({
      sectionHeading,
      text: piece,
      unitKind: "table" as const,
      rowSplit,
    }));
  }
  return splitSection(text, sectionHeading, unit.kind);
}

function splitSection(
  text: string,
  sectionHeading: string,
  kind: ParsedUnitKind,
): Draft[] {
  if (kind !== "section" && kind !== "list") {
    return [{ sectionHeading, text, unitKind: "section", rowSplit: false }];
  }
  if (text.length <= CHUNK_HARD_MAX_CHARS) {
    return [{ sectionHeading, text, unitKind: "section", rowSplit: false }];
  }

  const paragraphs = text
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const groups = mergeShortTexts(packParagraphs(paragraphs));
  if (groups.length <= 1) {
    return [
      {
        sectionHeading,
        text: groups[0] ?? text,
        unitKind: "section",
        rowSplit: false,
      },
    ];
  }

  return withParagraphOverlap(groups).map((piece) => ({
    sectionHeading,
    text: piece,
    unitKind: "paragraph-split" as const,
    rowSplit: false,
  }));
}

/**
 * Pack whole paragraphs toward the target. A paragraph that is still over
 * the hard max stays intact. ` | ` is not a boundary.
 */
function packParagraphs(paragraphs: string[]): string[] {
  const groups: string[][] = [];
  let current: string[] = [];

  for (const paragraph of paragraphs) {
    if (current.length > 0) {
      const nextLength = joinParts(current.concat(paragraph)).length;
      if (nextLength > CHUNK_TARGET_CHARS || paragraph.length > CHUNK_HARD_MAX_CHARS) {
        groups.push(current);
        current = [];
      }
    }
    current.push(paragraph);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((parts) => joinParts(parts));
}

function withParagraphOverlap(pieces: string[]): string[] {
  return pieces.map((piece, index) => {
    if (index === 0) return piece;
    const previous = pieces[index - 1] ?? "";
    const tail = previous.slice(-CHUNK_OVERLAP_CHARS);
    return joinParts([tail, piece]);
  });
}

/**
 * A table over the hard max is cut between rows. Each piece repeats the
 * header. A row is never divided, and overlap is not applied.
 */
function splitTable(unit: ParsedUnit): string[] {
  const rows = tableRows(unit);
  const whole = rows.join("\n");
  if (whole.length <= CHUNK_HARD_MAX_CHARS) return [unit.text.trim()];

  const header = rows[0] ?? "";
  const data = rows.slice(1);
  if (!header || data.length === 0) return [whole];

  const groups: string[][] = [];
  let current: string[] = [];
  for (const row of data) {
    if (current.length > 0) {
      const nextLength = [header, ...current, row].join("\n").length;
      if (nextLength > CHUNK_TARGET_CHARS) {
        groups.push(current);
        current = [];
      }
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);

  const folded = foldShortRowGroup(header, groups);
  return folded.map((dataRows) => [header, ...dataRows].join("\n"));
}

function tableRows(unit: ParsedUnit): string[] {
  const fromUnit = unit.rows?.map((row) => row.trim()).filter((row) => row.length > 0);
  if (fromUnit && fromUnit.length > 0) return fromUnit;
  return unit.text
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
}

/** Keep a short final row group on the previous piece so it is not indexed alone. */
function foldShortRowGroup(header: string, groups: string[][]): string[][] {
  if (groups.length < 2) return groups;
  const last = groups[groups.length - 1];
  if (!last) return groups;
  const rendered = [header, ...last].join("\n");
  if (rendered.length >= CHUNK_MIN_PROSE_CHARS) return groups;
  const previous = groups[groups.length - 2];
  if (!previous) return groups;
  return [...groups.slice(0, -2), previous.concat(last)];
}

/**
 * Prefix a chunk under 80 characters to the following chunk of this document.
 * The surviving chunk keeps its own heading and kind. A trailing stub is
 * appended to the previous chunk.
 */
function mergeShortDrafts(drafts: Draft[]): Draft[] {
  const merged: Draft[] = [];
  let pending: Draft[] = [];

  for (const draft of drafts) {
    if (draft.text.length < CHUNK_MIN_PROSE_CHARS) {
      pending.push(draft);
      continue;
    }
    merged.push(pending.length > 0 ? prefixDraft(pending, draft) : draft);
    pending = [];
  }

  if (pending.length === 0) return merged;
  const tail = pending.map((draft) => draft.text).join("\n\n");
  const last = merged.at(-1);
  if (!last) {
    const first = pending[0];
    return [
      {
        sectionHeading: first?.sectionHeading ?? "",
        text: tail,
        unitKind: first?.unitKind ?? "section",
        rowSplit: first?.rowSplit ?? false,
      },
    ];
  }
  last.text = joinParts([last.text, tail]);
  return merged;
}

function prefixDraft(pending: Draft[], draft: Draft): Draft {
  return {
    sectionHeading: draft.sectionHeading,
    unitKind: draft.unitKind,
    rowSplit: draft.rowSplit,
    text: joinParts([pending.map((item) => item.text).join("\n\n"), draft.text]),
  };
}

function mergeShortTexts(texts: string[]): string[] {
  return mergeShortDrafts(
    texts.map((text) => ({
      sectionHeading: "",
      text,
      unitKind: "section",
      rowSplit: false,
    })),
  ).map((draft) => draft.text);
}

function joinParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n\n");
}
