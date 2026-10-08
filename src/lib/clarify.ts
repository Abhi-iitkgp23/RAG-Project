/**
 * A fragment names no food, storage condition, or document. The route
 * stores this sentence and does not call the model or open the index.
 * A pronoun follow-up is left for the rewriter when an earlier user
 * message exists.
 */
export const CLARIFICATION_ANSWER =
  "I need a specific question before I can search the guidance. Name a food, a storage condition, or a document. For example: how long cooked rice keeps in the refrigerator, or what the Eatwell Guide says about fruit and vegetables.";

/**
 * Question frames and fillers. A token in this set is not a topic.
 * "long" is absent on purpose, so "how long?" still reaches the rewriter.
 */
const FUNCTION_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "anything",
  "are",
  "as",
  "ask",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "define",
  "did",
  "do",
  "does",
  "doing",
  "explain",
  "for",
  "from",
  "he",
  "hello",
  "help",
  "her",
  "hey",
  "hi",
  "him",
  "hmm",
  "how",
  "huh",
  "i",
  "if",
  "im",
  "in",
  "into",
  "is",
  "just",
  "know",
  "let",
  "lets",
  "may",
  "me",
  "mean",
  "meaning",
  "means",
  "might",
  "must",
  "my",
  "need",
  "of",
  "ok",
  "okay",
  "on",
  "or",
  "our",
  "over",
  "please",
  "say",
  "shall",
  "she",
  "should",
  "something",
  "tell",
  "than",
  "thank",
  "thanks",
  "the",
  "then",
  "to",
  "uh",
  "um",
  "under",
  "us",
  "want",
  "was",
  "we",
  "were",
  "what",
  "whats",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Points at an earlier turn. With a previous user message, the rewriter
 * resolves these. Alone, they are not a question.
 */
const REFERENCE_WORDS = new Set([
  "here",
  "it",
  "its",
  "one",
  "same",
  "that",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
]);

export function isUnclearInquiry(
  message: string,
  options: { hasEarlierUserMessage: boolean } = { hasEarlierUserMessage: false },
): boolean {
  const tokens = message
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return true;

  const content = tokens.filter(
    (token) =>
      !FUNCTION_WORDS.has(token) &&
      !REFERENCE_WORDS.has(token) &&
      !/^\d+$/.test(token),
  );
  if (content.length > 0) return false;

  const hasReference = tokens.some((token) => REFERENCE_WORDS.has(token));
  return !(hasReference && options.hasEarlierUserMessage);
}
