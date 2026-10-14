/**
 * A fragment names no food, storage condition, or document. The route
 * stores this sentence and does not call the model or open the index.
 * A pronoun follow-up is left for the rewriter when an earlier user
 * message exists.
 */
export const CLARIFICATION_ANSWER =
  "I need a specific question before I can search the guidance. Name a food, a storage condition, or a document. For example: how long cooked rice keeps in the refrigerator, or what the Eatwell Guide says about fruit and vegetables.";

export const GREETING_ANSWER =
  "Hey! What would you like to know about dietary guidance or food safety?";

export const NONSENSE_ANSWER =
  "Could you clarify your question? I can help with dietary guidance and food safety.";

export const PROFANITY_ANSWER =
  "I'm here to help with dietary guidance and food safety. What would you like to know?";

export const UNRELATED_MATHS_ANSWER =
  "I can help with dietary guidance and food safety rather than general maths.";

const AMBIGUOUS_ANSWERS: Readonly<Record<string, string>> = {
  water:
    "What would you like to know about water—daily intake, hydration, or something else?",
  honey: "Are you asking about honey's role in dietary guidance or how to store it?",
  rice: "Would you like to know about rice as part of a balanced diet or how to store cooked rice safely?",
};

export type InquiryReason =
  | "greeting"
  | "ambiguous"
  | "nonsense"
  | "profanity"
  | "unrelated"
  | "unclear";

export type InquiryDecision =
  | { outcome: "proceed" }
  | { outcome: "respond"; reason: InquiryReason; answer: string };

/** Greeting, profanity, and maths replies are not "need a clearer question". */
const SILENT_CLARIFICATION_LABEL = new Set([
  GREETING_ANSWER,
  PROFANITY_ANSWER,
  UNRELATED_MATHS_ANSWER,
]);

export function showsClarificationLabel(answer: string): boolean {
  return !SILENT_CLARIFICATION_LABEL.has(answer);
}

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

/**
 * Frequent English pairs. A token of five or more letters with none of
 * these is not treated as a topic, so a string such as a keyboard mash
 * does not open retrieval.
 */
const COMMON_BIGRAMS = new Set([
  "ac", "ai", "al", "an", "ar", "as", "at", "au", "ay", "be", "bl", "br",
  "ca", "ce", "ch", "ck", "cl", "co", "cr", "de", "di", "dr", "ea", "ed",
  "ee", "el", "en", "er", "es", "fl", "fo", "fr", "ge", "gh", "gl", "gr",
  "ha", "he", "hi", "ho", "hy", "ic", "id", "ie", "il", "in", "io", "is",
  "it", "la", "ld", "le", "li", "ll", "lt", "ly", "ma", "me", "mi", "mp",
  "my", "nd", "ne", "ng", "nk", "nt", "ny", "oa", "of", "om", "on", "oo",
  "or", "ou", "pe", "ph", "pl", "pr", "qu", "ra", "rd", "re", "ri", "ro",
  "rt", "ry", "se", "sh", "si", "sk", "sl", "sm", "sn", "sp", "st", "sw",
  "te", "th", "ti", "to", "tr", "ty", "ul", "un", "ur", "us", "ve", "wa",
  "we", "wh", "wi", "wo",
]);

function isWordLike(token: string): boolean {
  if (token.length < 5) return /[aeiouy]/.test(token) || token.length <= 2;
  if (!/[aeiouy]/.test(token)) return false;
  for (let index = 0; index < token.length - 1; index += 1) {
    if (COMMON_BIGRAMS.has(token.slice(index, index + 2))) return true;
  }
  return false;
}

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
      !/^\d+$/.test(token) &&
      isWordLike(token),
  );
  if (content.length > 0) return false;

  const hasReference = tokens.some((token) => REFERENCE_WORDS.has(token));
  return !(hasReference && options.hasEarlierUserMessage);
}

/**
 * Trim, collapse whitespace, and lowercase. The stored user message stays
 * as typed. Classification uses this form so case and padding do not matter.
 */
export function normalizeQuery(message: string): string {
  return message.trim().replace(/['’]/g, "").replace(/\s+/g, " ").toLowerCase();
}

function withoutEdgePunctuation(value: string): string {
  return value.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").trim();
}

function tokenize(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

const EXACT_GREETINGS = new Set([
  "hi",
  "hey",
  "hello",
  "heya",
  "hiya",
  "howdy",
  "yo",
  "hii",
  "hiii",
  "heyy",
  "helloo",
  "hey there",
  "hi there",
  "hello there",
  "good morning",
  "good afternoon",
  "good evening",
  "good day",
]);

/** Real words one edit from hi, hey, or hello. They are not greetings. */
const NOT_A_GREETING = new Set([
  "hay",
  "ham",
  "hat",
  "her",
  "his",
  "hot",
  "how",
  "has",
  "had",
  "him",
  "hit",
  "hop",
  "hue",
  "hug",
  "hut",
  "hen",
  "hex",
  "hid",
  "hip",
  "hum",
  "help",
  "home",
  "honey",
  "water",
  "rice",
  "heat",
  "herb",
  "herbs",
  "health",
  "healthy",
  "happy",
  "house",
  "hour",
  "hours",
  "human",
  "hunger",
  "hungry",
  "hydrate",
  "hydration",
  "habit",
  "habits",
  "heart",
  "heavy",
]);

const LEADING_GREETINGS = [
  "good morning",
  "good afternoon",
  "good evening",
  "good day",
  "hey there",
  "hi there",
  "hello there",
  "hello",
  "howdy",
  "heya",
  "hiya",
  "helloo",
  "hey",
  "hi",
  "yo",
];

const QUESTION_FRAMES = new Set([
  "what",
  "which",
  "how",
  "when",
  "where",
  "why",
  "is",
  "are",
  "does",
  "do",
  "can",
  "should",
  "could",
  "would",
  "did",
]);

const PROFANITY = new Set([
  "bsdk",
  "bsdkm",
  "madarchod",
  "behenchod",
  "bhenchod",
  "chutiya",
  "chutiye",
  "chutia",
  "gaandu",
  "gandu",
  "harami",
  "randi",
  "fuck",
  "fucking",
  "fucked",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "cunt",
  "motherfucker",
  "bullshit",
]);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/**
 * A sum, product, or similar expression, and nothing else.
 * A storage question that happens to contain "3+4" does not match.
 */
const ARITHMETIC_INQUIRY =
  /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[+\-*/x×÷]\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+))+(?:\s*=\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)?)?$/i;

const MATHS_LEAD = /^(?:what is|whats|calculate|solve|compute)\s+/;

export function isArithmeticInquiry(message: string): boolean {
  const text = withoutEdgePunctuation(normalizeQuery(message));
  if (ARITHMETIC_INQUIRY.test(text)) return true;
  const rest = text.replace(MATHS_LEAD, "");
  return rest !== text && ARITHMETIC_INQUIRY.test(withoutEdgePunctuation(rest));
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => 0),
  );
  for (let row = 0; row < rows; row += 1) matrix[row]![0] = row;
  for (let col = 0; col < cols; col += 1) matrix[0]![col] = col;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row]![col] = Math.min(
        matrix[row - 1]![col]! + 1,
        matrix[row]![col - 1]! + 1,
        matrix[row - 1]![col - 1]! + cost,
      );
    }
  }
  return matrix[left.length]![right.length]!;
}

function isGreetingTypo(token: string): boolean {
  if (token.length < 3 || token.length > 6) return false;
  if (!token.startsWith("h")) return false;
  if (NOT_A_GREETING.has(token)) return false;
  return (
    editDistance(token, "hey") === 1 ||
    editDistance(token, "hello") === 1 ||
    editDistance(token, "hi") === 1
  );
}

function isGreetingOnly(text: string): boolean {
  if (EXACT_GREETINGS.has(text)) return true;
  const tokens = tokenize(text);
  return tokens.length === 1 && isGreetingTypo(tokens[0] ?? "");
}

function stripLeadingGreeting(text: string): string | null {
  for (const greeting of LEADING_GREETINGS) {
    if (text.startsWith(`${greeting} `)) return text.slice(greeting.length).trim();
  }
  return null;
}

function isKeyboardMash(token: string): boolean {
  if (token.length < 4) return false;
  for (const row of KEYBOARD_ROWS) {
    for (let start = 0; start <= token.length - 4; start += 1) {
      const slice = token.slice(start, start + 4);
      if (row.includes(slice)) return true;
      const reversed = [...slice].reverse().join("");
      if (row.includes(reversed)) return true;
    }
  }
  return false;
}

function hasCommonBigram(token: string): boolean {
  for (let index = 0; index < token.length - 1; index += 1) {
    if (COMMON_BIGRAMS.has(token.slice(index, index + 2))) return true;
  }
  return false;
}

function looksLikeGibberish(token: string): boolean {
  if (FUNCTION_WORDS.has(token) || REFERENCE_WORDS.has(token) || PROFANITY.has(token)) {
    return false;
  }
  if (isKeyboardMash(token)) return true;
  const letters = token.replace(/[^a-z]/g, "");
  const digits = token.replace(/\D/g, "");
  if (letters.length > 0 && digits.length > 0) {
    if (/^\d+(?:\.\d+)?(?:g|kg|mg|ml|l|oz|lb|kcal)?$/.test(token)) return false;
    return true;
  }
  if (letters.length <= 2) return false;
  if (!/[aeiouy]/.test(letters)) return true;
  if (letters.length >= 5 && !hasCommonBigram(letters)) return true;
  if (/[^aeiouy]{4,}/.test(letters)) return true;
  return false;
}

function contentTokens(text: string): string[] {
  return tokenize(text).filter(
    (token) =>
      !FUNCTION_WORDS.has(token) &&
      !REFERENCE_WORDS.has(token) &&
      !PROFANITY.has(token) &&
      !/^\d+$/.test(token) &&
      !looksLikeGibberish(token),
  );
}

function isSubstantiveQuestion(text: string): boolean {
  const tokens = tokenize(text);
  if (!tokens.some((token) => QUESTION_FRAMES.has(token))) return false;
  return contentTokens(text).length > 0;
}

function isProfanityRedirect(text: string): boolean {
  const tokens = tokenize(text);
  if (!tokens.some((token) => PROFANITY.has(token))) return false;
  const rest = tokens.filter((token) => !PROFANITY.has(token)).join(" ");
  if (rest.trim() === "") return true;
  return !isSubstantiveQuestion(rest);
}

function ambiguousKeyword(text: string): string | null {
  const tokens = tokenize(text);
  if (tokens.length !== 1) return null;
  const token = tokens[0] ?? "";
  if (!/^[a-z]{3,}$/.test(token)) return null;
  if (FUNCTION_WORDS.has(token) || REFERENCE_WORDS.has(token) || PROFANITY.has(token)) {
    return null;
  }
  if (EXACT_GREETINGS.has(token) || looksLikeGibberish(token)) return null;
  return token;
}

function ambiguousAnswer(topic: string): string {
  return AMBIGUOUS_ANSWERS[topic] ?? `What would you like to know about ${topic}?`;
}

function isNonsense(text: string): boolean {
  const meaningful = tokenize(text).filter(
    (token) => !FUNCTION_WORDS.has(token) && !REFERENCE_WORDS.has(token) && !/^\d+$/.test(token),
  );
  return meaningful.length > 0 && meaningful.every((token) => looksLikeGibberish(token));
}

function respond(reason: InquiryReason, answer: string): InquiryDecision {
  return { outcome: "respond", reason, answer };
}

/**
 * Route one message before the scope model and the index.
 * Greetings, single keywords, gibberish, profanity, and bare arithmetic
 * stop here. A dietary question, including one that starts with a greeting
 * or contains a number, proceeds.
 */
export function classifyInquiry(
  message: string,
  options: { hasEarlierUserMessage: boolean } = { hasEarlierUserMessage: false },
): InquiryDecision {
  const text = withoutEdgePunctuation(normalizeQuery(message));
  if (text === "") return respond("unclear", CLARIFICATION_ANSWER);
  if (isProfanityRedirect(text)) return respond("profanity", PROFANITY_ANSWER);
  if (isGreetingOnly(text)) return respond("greeting", GREETING_ANSWER);
  if (isArithmeticInquiry(message)) return respond("unrelated", UNRELATED_MATHS_ANSWER);

  const tail = stripLeadingGreeting(text) ?? text;
  if (isSubstantiveQuestion(tail)) return { outcome: "proceed" };

  const keyword = ambiguousKeyword(tail);
  if (keyword) return respond("ambiguous", ambiguousAnswer(keyword));
  if (isNonsense(text) || isNonsense(tail)) return respond("nonsense", NONSENSE_ANSWER);
  if (isUnclearInquiry(text, options)) return respond("unclear", CLARIFICATION_ANSWER);
  return { outcome: "proceed" };
}
