import type { CorpusDocument } from "./corpus";
import { parseHtmlDocument } from "./parseHtml";
import { parsePdfDocument } from "./parsePdf";
import type { ParsedDocument } from "./parsedDocument";

export type {
  ParsedDocument,
  ParsedUnit,
  ParsedUnitKind,
} from "./parsedDocument";
export { HEADING_SEPARATOR } from "./parsedDocument";

/**
 * Parse one corpus document from the raw bytes already on disk.
 * PDF booklets and HTML guidance pages take different paths; neither
 * fetches the source again.
 */
export async function parseCorpusDocument(
  bytes: Uint8Array,
  document: CorpusDocument,
): Promise<ParsedDocument> {
  if (bytes.byteLength === 0) {
    throw new Error(`${document.id}: raw body is empty`);
  }
  if (document.form === "html") {
    return parseHtmlDocument(bytes, document, {
      chartCategories: document.id === "cold-storage-2023",
    });
  }
  return parsePdfDocument(bytes, document);
}
