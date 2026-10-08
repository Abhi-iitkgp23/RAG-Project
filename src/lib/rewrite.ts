import { z } from "zod";
import { ModelOutputError } from "./model";
import type { JsonSchema, ModelClient } from "./types";
import type { ScopeTurn } from "./scope";

export const REWRITE_SCHEMA_NAME = "standalone_query";

/**
 * Recent turns the rewriter may see. This is not the scope gate's window of
 * 12 stored messages. A pronoun usually refers to the last few turns.
 */
export const REWRITE_HISTORY_LIMIT = 6;

export const REWRITE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string" },
  },
  required: ["query"],
};

/**
 * Search-string instructions. The rewrite is not an answer and is not shown.
 * The refusal sentences are not in this prompt.
 */
export const REWRITE_PROMPT = `You rewrite the latest user message into one standalone search query.

Use the earlier turns only to resolve pronouns and ellipsis. Keep food names and document names. Do not answer the question. Do not add advice.

Return a JSON object whose only field is query, the search string.`;

const rewriteSchema = z.strictObject({
  query: z.string(),
});

/**
 * Resolve the latest message into a search string. A body that is not the
 * schema, or an empty query, falls through to the raw user message. A
 * transport or provider error is rethrown so retrieval is not given a
 * partial rewrite.
 */
export async function rewriteQuery(
  client: ModelClient,
  currentMessage: string,
  preceding: readonly ScopeTurn[] = [],
): Promise<string> {
  const history = preceding.slice(-REWRITE_HISTORY_LIMIT);
  let raw: unknown;
  try {
    raw = await client.complete({
      system: REWRITE_PROMPT,
      messages: [...history, { role: "user", content: currentMessage }],
      schema: REWRITE_SCHEMA,
      schemaName: REWRITE_SCHEMA_NAME,
    });
  } catch (error) {
    if (error instanceof ModelOutputError) return currentMessage;
    throw error;
  }

  const parsed = rewriteSchema.safeParse(raw);
  if (!parsed.success) return currentMessage;
  const query = parsed.data.query.trim();
  return query === "" ? currentMessage : query;
}
