import type { CorpusDocumentId } from "./corpus";

/** Breadcrumb separator, as in "Fats and oils › Visible fats". */
export const HEADING_SEPARATOR = " \u203a ";

/**
 * Structure the parser found. Chunking (the next phase) decides which of
 * these stay whole and which get split.
 */
export type ParsedUnitKind =
  | "section"
  | "recommendation"
  | "table"
  | "category"
  | "list";

export type ParsedUnit = {
  sectionHeading: string;
  kind: ParsedUnitKind;
  text: string;
  /**
   * Table or storage-chart rows, header first, cells already joined by
   * ` | `. Set so a later row split can repeat the header.
   */
  rows?: string[];
};

export type ParsedDocument = {
  documentId: CorpusDocumentId;
  units: ParsedUnit[];
  headingCount: number;
  tableCount: number;
  characters: number;
};
