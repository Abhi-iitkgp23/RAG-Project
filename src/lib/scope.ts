import { z } from "zod";
import { PRECEDING_MESSAGE_LIMIT } from "./store";
import { ModelOutputError } from "./model";
import type { JsonSchema, ModelClient } from "./types";

export const SCOPE_SCHEMA_NAME = "scope_decision";

export const SCOPE_CATEGORIES = [
  "calorie_target",
  "weight_recommendation",
  "medical_advice",
] as const;

export type ScopeCategory = (typeof SCOPE_CATEGORIES)[number];

export type ScopeDecision =
  | { outcome: "allow" }
  | { outcome: "decline"; category: ScopeCategory | "unparsed" };

export type ScopeTurn = {
  role: "user" | "assistant";
  content: string;
};

/** A drafted claim the output scan can drop or use to refuse the turn. */
export type OutputClaim = {
  text: string;
  documentId: string;
};

export type OutputScanResult =
  | { action: "decline" }
  | { action: "keep"; claims: OutputClaim[] };

const CATEGORY_VALUES = [
  "none",
  "calorie_target",
  "weight_recommendation",
  "medical_advice",
] as const;

/**
 * Strict object the classifier must return. `category` is `none` on an allow.
 * Every property is required, which is what strict `json_schema` demands.
 */
export const SCOPE_DECISION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: ["allow", "decline"],
    },
    category: {
      type: "string",
      enum: [...CATEGORY_VALUES],
    },
  },
  required: ["decision", "category"],
};

const scopeDecisionSchema = z.strictObject({
  decision: z.enum(["allow", "decline"]),
  category: z.enum(CATEGORY_VALUES),
});

/**
 * Instructions for the input gate. The user-facing refusal sentences are not
 * in this prompt. There is no second, deterministic scan of the user message.
 */
export const SCOPE_CLASSIFIER_PROMPT = `You classify one turn of a dietary-guidance chat. Read the current user message together with the preceding turns. Do not answer the question.

Return decision "allow" and category "none" when the turn asks about population dietary guidance or cold-food storage, including what a published document says about a population, with no personal target. How much water or other fluid to drink is population dietary guidance, including in hot weather or summer. "I", "should I consume", "stay hydrated", and a misspelling of summer do not make that a personal target.

Return decision "decline" and exactly one category when the turn asks for any of these:
- calorie_target: a personal or daily calorie number, a deficit or surplus, or how much to eat to lose fat or weight. A fluid amount is not a calorie target.
- weight_recommendation: a goal weight, a weight range, a BMI target, or what anyone should weigh.
- medical_advice: what to eat, take, or avoid for a named condition, symptom, medication, pregnancy complication, allergy treatment, or diagnosis. Thirst and staying hydrated are not conditions. "What should I drink for my dehydration" is medical_advice. "How much water should I drink in summer to stay hydrated" is allow.

Judge only the messages in this request. If the current message is out of scope, decline even when earlier messages were ordinary food questions. If an earlier message was out of scope and the current message is an ordinary food or storage question, allow it.`;

/**
 * Run the scope classifier. `preceding` is the stored turns before the current
 * user message; only the latest 12 are sent. The current message is added
 * after them.
 *
 * A body that is not the decision schema declines. A transport or provider
 * error is rethrown so the route can return 500 without retrieving.
 */
export async function classifyScope(
  client: ModelClient,
  currentMessage: string,
  preceding: readonly ScopeTurn[] = [],
): Promise<ScopeDecision> {
  const history = preceding.slice(-PRECEDING_MESSAGE_LIMIT);
  let raw: unknown;
  try {
    raw = await client.complete({
      system: SCOPE_CLASSIFIER_PROMPT,
      messages: [...history, { role: "user", content: currentMessage }],
      schema: SCOPE_DECISION_SCHEMA,
      schemaName: SCOPE_SCHEMA_NAME,
    });
  } catch (error) {
    if (error instanceof ModelOutputError) {
      return { outcome: "decline", category: "unparsed" };
    }
    throw error;
  }
  return interpretScopeDecision(raw);
}

/** Map a parsed object onto allow or decline. An invalid shape declines. */
export function interpretScopeDecision(raw: unknown): ScopeDecision {
  const parsed = scopeDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return { outcome: "decline", category: "unparsed" };
  }
  if (parsed.data.decision === "allow") {
    return { outcome: "allow" };
  }
  if (parsed.data.category === "none") {
    return { outcome: "decline", category: "unparsed" };
  }
  return { outcome: "decline", category: parsed.data.category };
}

const PERSONAL_PLAN_PHRASES = [
  "you should eat",
  "your plate should",
  "I recommend you eat",
  "for you",
  "your target",
  "your plan",
  "based on your weight",
  "based on your height",
] as const;

const BLEND_PHRASES = [
  "the guidelines say",
  "both authorities agree",
  "the correct guidance",
  "more reliable",
] as const;

/**
 * One pattern per publisher. Several aliases of the same publisher count once.
 * Two or more groups in one claim is a blend.
 */
const PUBLISHER_GROUPS: readonly RegExp[][] = [
  [/\bICMR\b/i, /National Institute of Nutrition/i],
  [/Public Health England/i],
  [/FoodSafety\.gov/i, /\bUSDA\b/, /\bFDA\b/, /\bCDC\b/],
  [/Food Standards Agency/i],
];

const CALORIE_TARGET = [
  /\bcalor(?:ie|ic)\s+(?:target|goal|budget|deficit|surplus)\b/i,
  /\b(?:target|goal|budget)\s+of\s+\d[\d,]*(?:\.\d+)?\s*(?:k?cal|calories?)\b/i,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:k?cal|calories?)\s+(?:deficit|surplus)\b/i,
  /\b(?:deficit|surplus)\s+of\s+\d[\d,]*(?:\.\d+)?\s*(?:k?cal|calories?)\b/i,
  /\b(?:eat|consume|aim(?:ing)? for|stick to)\s+\d[\d,]*(?:\.\d+)?\s*(?:k?cal|calories?)\b/i,
  /\bto lose (?:weight|fat)\b/i,
];

const WEIGHT_TARGET = [
  /\b(?:goal|target)\s+weight\b/i,
  /\bweight\s+(?:goal|target|range)\b/i,
  /\bshould weigh\b/i,
  /\b(?:target\s+bmi|bmi\s+target|aim for a bmi)\b/i,
  /\b(?:lose|drop)\s+\d[\d,]*(?:\.\d+)?(?:\s*[-–]\s*\d[\d,]*(?:\.\d+)?)?\s*(?:kg|kgs|kilograms?|lb|lbs|pounds?)\b/i,
  /\bget down to\s+\d/i,
];

const MEDICAL_ADVICE = [
  /\b(?:medications?|medicines?|prescription|dosage)\b/i,
  /\bdose of\b/i,
  /\bdiagnos(?:is|e|ed|es)\b/i,
  /\b(?:to treat|to cure)\b/i,
  /\bpregnancy complication\b/i,
  /\ballergy treatment\b/i,
  /\bfor (?:my|your) (?:diabetes|diabetic|hypertension|allerg(?:y|ies)|condition|symptoms?|diagnosis|pregnancy)\b/i,
];

function containsPhrase(text: string, phrase: string): boolean {
  const body = phrase
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?:^|\\W)${body}(?:$|\\W)`, "i").test(text);
}

function namesTwoPublishers(text: string): boolean {
  let groups = 0;
  for (const group of PUBLISHER_GROUPS) {
    if (group.some((pattern) => pattern.test(text))) groups += 1;
  }
  return groups >= 2;
}

/** A calorie target, a weight target, or medical advice refuses the turn. */
export function isProfessionalRefusalText(text: string): boolean {
  return (
    CALORIE_TARGET.some((pattern) => pattern.test(text)) ||
    WEIGHT_TARGET.some((pattern) => pattern.test(text)) ||
    MEDICAL_ADVICE.some((pattern) => pattern.test(text))
  );
}

/**
 * Personal-plan wording and blend patterns drop that claim only.
 * The same phrases are dropped on storage documents. Reader-addressed
 * storage instructions that do not use these phrases stay.
 */
export function isClaimDropped(text: string): boolean {
  if (PERSONAL_PLAN_PHRASES.some((phrase) => containsPhrase(text, phrase))) {
    return true;
  }
  if (BLEND_PHRASES.some((phrase) => containsPhrase(text, phrase))) {
    return true;
  }
  return namesTwoPublishers(text);
}

/**
 * Scan drafted claim text. One calorie, weight, or medical claim refuses
 * the whole turn. A personal-plan phrase or a blend drops only that claim.
 * Claims that remain are returned in their original order.
 */
export function scanOutputClaims(
  claims: readonly OutputClaim[],
): OutputScanResult {
  if (claims.some((claim) => isProfessionalRefusalText(claim.text))) {
    return { action: "decline" };
  }
  return {
    action: "keep",
    claims: claims.filter((claim) => !isClaimDropped(claim.text)),
  };
}
