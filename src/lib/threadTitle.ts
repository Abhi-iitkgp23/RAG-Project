import { classifyInquiry, normalizeQuery } from "./clarify";

/**
 * Exact welcome prompts, plus the same wording without a trailing question mark.
 * These are display titles only. They do not change the message that is sent.
 */
const CURATED_TITLES: Readonly<Record<string, string>> = {
  "what should i eat daily": "Daily dietary guidance",
  "daily water intake": "Water intake",
  "food storage and leftovers": "Food storage and leftovers",
  "explore an official guide": "The Eatwell Guide",
};

const TITLE_LIMIT = 72;

/**
 * Three or more consonants that are not a normal English cluster.
 * "abshe" contains "bsh"; "fridge" and "strength" do not match this.
 */
const ILLEGAL_CLUSTER =
  /[bcdfghjklmnpqrstvwxyz]{3,}/;
const ALLOWED_CLUSTER =
  /str|spr|scr|spl|shr|thr|sch|ght|tch|dge|cks|nks|ngs|nds|nts|rds|lds|nch|rch|lch|nth|lth|rth|mph/;

function contentWords(message: string): string[] {
  return normalizeQuery(message)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && /[aeiouy]/.test(token) && !hasIllegalCluster(token));
}

function hasIllegalCluster(token: string): boolean {
  const clusters = token.match(ILLEGAL_CLUSTER);
  if (!clusters) return false;
  return clusters.some((cluster) => !ALLOWED_CLUSTER.test(cluster));
}

function curatedTitle(message: string): string | null {
  const key = normalizeQuery(message).replace(/[^a-z0-9]+$/g, "");
  return CURATED_TITLES[key] ?? null;
}

function readableTitle(message: string): string | null {
  const clean = message
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hi|hey|hello|good morning|good afternoon|good evening)[,!\s]+/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  if (!clean || contentWords(clean).length === 0) return null;
  const sentence = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (sentence.length <= TITLE_LIMIT) return sentence;
  const cut = sentence.slice(0, TITLE_LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 32 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** A greeting, a typo of one, or a mash such as "abshe" is not a title. */
function titleFromMessage(message: string): string | null {
  if (classifyInquiry(message).outcome !== "proceed") return null;
  if (contentWords(message).length === 0) return null;
  return curatedTitle(message) ?? readableTitle(message);
}

/**
 * Title for the sidebar. Uses the first message that is actually a question.
 * An earlier greeting stays in the thread and does not become the title.
 */
export function conversationTitle(messages: readonly string[]): string | null {
  for (const message of messages) {
    const title = titleFromMessage(message);
    if (title) return title;
  }
  return null;
}
