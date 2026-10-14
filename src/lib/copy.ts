/** Shown for a draft that failed the schema. It is not stored as an assistant message. */
export const FORMAT_MISMATCH_MESSAGE =
  "This answer didn't match the expected format, so it wasn't shown.";

/** Shown when the index or the provider fails. The composer keeps the typed text. */
export const RETRY_MESSAGE =
  "The answer could not be completed. Please try again.";

/** Shown when the minute window is full and the turn cannot wait it out. */
export const RATE_LIMIT_MESSAGE =
  "The answer service is at its per-minute limit. Please try again in a minute.";

/** Shown when today's Groq request or token allowance for gpt-oss-120b is spent. */
export const DAILY_LIMIT_MESSAGE =
  "The answer service has reached its daily limit. Please try again tomorrow.";

/** Shown when one question cannot fit in the 8,000-token minute cap. */
export const QUESTION_TOO_LONG_MESSAGE =
  "This question is too long to answer within the model's limit. Try a shorter question.";

export const MESSAGE_REQUIRED = "Message is required.";

export const UNKNOWN_CONVERSATION = "Unknown conversation";

export const NO_CLAIMS = "No claims in this answer";

export const DECLINED_LABEL = "Outside what this assistant can answer";

export const NOT_IN_CORPUS_LABEL = "Not in the guidance";

/** Shown in place of the stored coverage sentence. The sentence still names the search scope. */
export const UNSUPPORTED_HEADING =
  "I couldn't find enough guidance to answer this question.";

export const UNSUPPORTED_NEXT =
  "Try rephrasing your question or asking about another dietary or food-safety topic.";

export const CLARIFICATION_LABEL = "Need a clearer question";
