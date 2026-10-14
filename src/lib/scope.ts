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

A general question about what to eat each day is population dietary guidance. Allow it. It is not a calorie target unless it asks for a personal calorie number, a deficit, a surplus, or a weight goal. "What should I eat", "what should I eat daily", and "what should I eat this week" are allow.

Also allow, with category none, when the turn does not ask for a personal calorie number, a weight goal, or a diet for a named condition:
- how much water or other fluid to drink
- what a named document recommends, including the Eatwell Guide and the Indian dietary guidelines
- whether a named food belongs in a balanced diet
- how to store, chill, or keep a food, including cooked rice in the fridge

Do not decline those because they use "I", "should", "daily", or a number that is a duration or a portion.

How many calories or other nutrients are in one named food is not a personal calorie target. Allow it. Do not treat that lookup as calorie_target.

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
  const current = currentMessage.trim().replace(/\s+/g, " ");
  let raw: unknown;
  try {
    raw = await client.complete({
      system: SCOPE_CLASSIFIER_PROMPT,
      messages: [...history, { role: "user", content: current }],
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

const PERSONAL_OR_CLINICAL =
  /\b(?:calor(?:ie|ies|ic)|kcal|weigh|weight|bmi|deficit|surplus|lose (?:fat|weight)|for my|diabetes|diabetic|hypertension|pregnan\w*|allerg\w*|medication|medicine|diagnos\w*|dehydration)\b/i;

/** Daily food-group guidance, with no personal target or clinical ask. */
export function isGeneralDietQuestion(message: string): boolean {
  return (
    /\b(?:what|which)\b[^?.!]{0,80}\b(?:eat|eats|eating|diet|foods?)\b/i.test(message) &&
    !PERSONAL_OR_CLINICAL.test(message)
  );
}

/** A nutrient amount in a named food, rather than a personal calorie target. */
export function isFoodNutrientLookup(message: string): boolean {
  return (
    /\b(?:how many|how much)\b[^?.!]{0,60}\b(?:calories|kcal|kilocalories|protein|carbohydrates?|carbs|fats?|sugars?|fibre|fiber|sodium|nutrients?)\b[^?.!]{0,60}\b(?:in|of)\b/i.test(
      message,
    ) && !/\b(?:should i|to lose|deficit|surplus)\b/i.test(message)
  );
}

/** Population fluid guidance, including water. Thirst as a condition stays out. */
export function isPopulationFluidQuestion(message: string): boolean {
  return (
    /\b(?:waters?|fluids?|hydrat\w*|drinks?|drinking)\b/i.test(message) &&
    !PERSONAL_OR_CLINICAL.test(message)
  );
}

const NAMED_CONDITION =
  /\b(?:diabetes|diabetic|hypertension|pregnan\w*|allerg\w*|medications?|medicines?|diagnos\w*|dehydration|cancer|symptoms?)\b/i;

const PERSONAL_CALORIE =
  /\b(?:calor(?:ie|ies|ic)|kcal|kilocalories)\b/i;

/**
 * A personal calorie number, a weight goal, or a diet for a named condition.
 * A nutrient lookup in a named food is not one of these.
 */
export function isRestrictedPersonalRequest(message: string): boolean {
  if (isFoodNutrientLookup(message)) return false;
  if (NAMED_CONDITION.test(message)) return true;
  if (
    PERSONAL_CALORIE.test(message) &&
    /\b(?:should|deficit|surplus|to lose|to gain|lose weight|drop fat|my)\b/i.test(message)
  ) {
    return true;
  }
  return (
    /\bshould\s+i\s+weigh\b/i.test(message) ||
    /\b(?:goal|target)\s+weight\b/i.test(message) ||
    /\bweight\s+(?:goal|target)\b/i.test(message) ||
    (/\bbmi\b/i.test(message) && /\b(?:should|aim|target|my)\b/i.test(message)) ||
    /\b(?:lose|gain|drop)\s+(?:weight|fat)\b/i.test(message) ||
    /\b(?:lose|gain|drop)\s+\d[\d,]*(?:\.\d+)?(?:\s*[-–]\s*\d[\d,]*(?:\.\d+)?)?\s*(?:kg|kgs|kilograms?|lb|lbs|pounds?)\b/i.test(
      message,
    )
  );
}

const GUIDANCE_TOPIC =
  /\b(?:eat|eats|eating|diet|dietary|foods?|eatwell|guidelines?|guidance|hydrat\w*|waters?|fluids?|drinks?|drinking|stor(?:e|ed|age)|fridge|freezer|refrigerat\w*|chill|defrost|leftovers?|cooked|cook(?:ing)?|oils?|fats?|fruits?|vegetables?|milk|honey|rice|millets?|chicken|meat|fish|eggs?|bread|cereal|salt|sugar|nutrients?|balanced)\b/i;

/**
 * Population diet, fluid, storage, or document questions. Personal targets
 * and named-condition diets stay out, so a decline of those still stands.
 */
export function isOrdinaryGuidanceQuestion(message: string): boolean {
  if (isRestrictedPersonalRequest(message)) return false;
  if (
    isGeneralDietQuestion(message) ||
    isPopulationFluidQuestion(message) ||
    isFoodNutrientLookup(message)
  ) {
    return true;
  }
  const asks =
    /\b(?:what|which|how|when|where|is|are|does|do|can|should|could|would)\b/i.test(
      message,
    );
  return asks && GUIDANCE_TOPIC.test(message);
}

/**
 * The classifier sometimes labels a general diet, fluid, storage, or
 * food-nutrient question as a personal target. Those still go to retrieval.
 * An unparsed decision does not. A real calorie, weight, or medical request
 * does not.
 */
export function allowDespiteDecline(
  message: string,
  category: ScopeCategory | "unparsed",
): boolean {
  if (category === "unparsed") return false;
  if (isRestrictedPersonalRequest(message)) return false;
  if (category === "calorie_target" && isFoodNutrientLookup(message)) return true;
  if (
    (category === "calorie_target" ||
      category === "medical_advice" ||
      category === "weight_recommendation") &&
    isOrdinaryGuidanceQuestion(message)
  ) {
    return true;
  }
  return false;
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
