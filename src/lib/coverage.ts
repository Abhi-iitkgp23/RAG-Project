import { CORPUS, type CorpusDocumentId } from "./corpus";

/**
 * Full corpus, or the one document the alias filter selected.
 * Omitted and `"all"` both name every document, in corpus order.
 */
export type SearchScope = "all" | CorpusDocumentId;

const NOT_IN_CORPUS_OPENING =
  "The guidance I searched does not cover that. I looked in: ";

/**
 * Publishers in the coverage sentence. Eatwell, FoodSafety.gov, and the
 * Food Standards Agency are the short forms, not the longer manifest strings.
 */
const COVERAGE_PUBLISHER: Record<CorpusDocumentId, string> = {
  "dgi-2024": "ICMR\u2013National Institute of Nutrition",
  "eatwell-2018": "Public Health England",
  "cold-storage-2023": "FoodSafety.gov",
  "fsa-chill-2017": "Food Standards Agency",
};

function coverageLabel(id: CorpusDocumentId): string {
  const document = CORPUS.find((item) => item.id === id);
  if (!document) {
    throw new Error(`unknown search scope ${id}`);
  }
  return `${document.name} (${COVERAGE_PUBLISHER[id]}, ${document.year})`;
}

/**
 * The not-in-the-guidance sentence for the scope that was actually searched.
 * A single document is named alone. The full corpus lists all four.
 */
export function notInCorpusAnswer(
  scope: SearchScope | undefined = "all",
): string {
  const ids =
    scope === undefined || scope === "all"
      ? CORPUS.map((document) => document.id)
      : [scope];
  return `${NOT_IN_CORPUS_OPENING}${ids.map(coverageLabel).join("; ")}.`;
}

/**
 * Documents named by a coverage refusal. A scope decline, a clarification,
 * or any other answer returns none, so the UI does not claim they were searched.
 */
export function documentsNamedInCoverageAnswer(
  answer: string,
): CorpusDocumentId[] {
  if (!answer.startsWith(NOT_IN_CORPUS_OPENING)) return [];
  return CORPUS.filter((document) =>
    answer.includes(coverageLabel(document.id)),
  ).map((document) => document.id);
}
