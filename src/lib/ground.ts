import { CORPUS } from "./corpus";
import { notInCorpusAnswer, type SearchScope } from "./coverage";
import { PROFESSIONAL_REFUSAL } from "./decline";
import { assembleCited, withoutRepeatedClaims } from "./presentClaims";
import { scanOutputClaims, type OutputClaim } from "./scope";
import type {
  Claim,
  Coverage,
  GroundedDraft,
  RetrievedChunk,
  Source,
} from "./types";

/** A quote shorter than this, after whitespace collapse, cannot support a claim. */
export const MIN_QUOTE_CHARS = 20;

export type GroundResult = {
  answer: string;
  claims: Claim[];
  declined: boolean;
  coverage: Coverage;
};

type BoundClaim = OutputClaim & {
  source: Source;
};

/**
 * Bind a grounded draft to the chunks just retrieved, then write `answer`
 * from the claims that survived. The draft's free-form prose is ignored.
 * `quote` is used only to verify a span; it is never copied into `answer`.
 */
export function ground(
  draft: GroundedDraft,
  retrievedChunks: readonly RetrievedChunk[],
  scope: SearchScope | undefined,
): GroundResult {
  if (!draft.covered) return coverageRefusal(scope);

  const chunksById = new Map<string, RetrievedChunk>();
  for (const chunk of retrievedChunks) {
    if (!chunksById.has(chunk.id)) chunksById.set(chunk.id, chunk);
  }

  const bound: BoundClaim[] = [];
  for (const draftClaim of draft.claims) {
    const chunk = chunksById.get(draftClaim.chunkId);
    if (!chunk) continue;
    if (!quoteSupports(draftClaim.quote, chunk.text)) continue;
    const text = draftClaim.text.trim();
    if (text.length === 0) continue;
    bound.push({
      text,
      documentId: chunk.documentId,
      source: sourceFromChunk(chunk),
    });
  }

  const scan = scanOutputClaims(bound);
  if (scan.action === "decline") return professionalRefusal();

  const kept = withoutRepeatedClaims(
    orderClaims(bound.filter((claim) => scan.claims.includes(claim))),
    (claim) => claim.documentId,
  );
  if (kept.length === 0) return coverageRefusal(scope);

  return {
    answer: assembleCited(kept, (claim) => claim.documentId),
    claims: kept.map((claim) => ({ text: claim.text, source: claim.source })),
    declined: false,
    coverage: "answered",
  };
}

/** Collapse runs of whitespace, including newlines, to a single space. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteSupports(quote: string, chunkText: string): boolean {
  const collapsed = collapseWhitespace(quote);
  if (collapsed.length < MIN_QUOTE_CHARS) return false;
  return collapseWhitespace(chunkText).includes(collapsed);
}

function sourceFromChunk(chunk: RetrievedChunk): Source {
  return {
    documentName: chunk.documentName,
    publisher: chunk.publisher,
    year: chunk.year,
    url: chunk.sourceUrl,
    sectionHeading: chunk.sectionHeading,
  };
}

function professionalRefusal(): GroundResult {
  return {
    answer: PROFESSIONAL_REFUSAL,
    claims: [],
    declined: true,
    coverage: "declined",
  };
}

function coverageRefusal(scope: SearchScope | undefined): GroundResult {
  return {
    answer: notInCorpusAnswer(scope),
    claims: [],
    declined: false,
    coverage: "not_in_corpus",
  };
}

/**
 * Corpus order across documents. Within one document, draft order is kept.
 * A document id outside the manifest stays after the known documents.
 */
function orderClaims(claims: readonly BoundClaim[]): BoundClaim[] {
  const groups = new Map<string, BoundClaim[]>();
  for (const claim of claims) {
    const group = groups.get(claim.documentId);
    if (group) group.push(claim);
    else groups.set(claim.documentId, [claim]);
  }

  const ordered: BoundClaim[] = [];
  for (const document of CORPUS) {
    const group = groups.get(document.id);
    if (group) {
      ordered.push(...group);
      groups.delete(document.id);
    }
  }
  for (const group of groups.values()) ordered.push(...group);
  return ordered;
}

