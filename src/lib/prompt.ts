import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema } from "./types";

/**
 * Stored on every assistant row. Bump this when `prompts/system.md` changes,
 * then re-run the frozen question set.
 */
export const PROMPT_VERSION = "3";

export const GROUNDED_DRAFT_SCHEMA_NAME = "grounded_draft";

/**
 * Strict object the answer model must return. Citation fields are not here.
 * The server builds those from the chunk after the quote check.
 */
export const GROUNDED_DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    covered: { type: "boolean" },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          quote: { type: "string" },
          chunkId: { type: "string" },
        },
        required: ["text", "quote", "chunkId"],
      },
    },
  },
  required: ["covered", "claims"],
};

let cachedPrompt: string | undefined;

/** Prompt body from `prompts/system.md`. Refusal sentences are not in this file. */
export function loadSystemPrompt(cwd = process.cwd()): string {
  if (cachedPrompt === undefined) {
    cachedPrompt = readFileSync(join(cwd, "prompts", "system.md"), "utf8").trim();
  }
  return cachedPrompt;
}
