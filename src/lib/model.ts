import OpenAI from "openai";
import type { EmbeddingClient } from "./types";

/** Default from `EMBEDDING_MODEL` when the variable is unset or blank. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Default width of `text-embedding-3-small`. Requests omit `dimensions`
 * so the API keeps this width instead of a shortened vector.
 */
export const EMBEDDING_DIMENSIONS = 1_536;

/** One embeddings request accepts at most this many inputs. */
export const EMBEDDING_MAX_INPUTS = 2_048;

/** One embeddings request accepts at most this many tokens, summed. */
export const EMBEDDING_MAX_TOKENS = 300_000;

export class EmbeddingDimensionError extends Error {
  readonly length: number;

  constructor(length: number) {
    super(`embedding length ${length}, expected ${EMBEDDING_DIMENSIONS}`);
    this.name = "EmbeddingDimensionError";
    this.length = length;
  }
}

export type EmbeddingBatchLimits = {
  maxInputs?: number;
  maxTokens?: number;
};

type EmbeddingRequest = {
  model: string;
  input: string[];
};

type EmbeddingResponse = {
  data: Array<{ embedding: number[]; index: number }>;
};

type EmbeddingsApi = {
  create(body: EmbeddingRequest): Promise<EmbeddingResponse>;
};

/** About four characters per token, the estimate used to stay under the request cap. */
export function estimateEmbeddingTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function embeddingModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.EMBEDDING_MODEL?.trim();
  return configured ? configured : DEFAULT_EMBEDDING_MODEL;
}

/**
 * Split texts so each batch stays within the embeddings request caps.
 * A single input that is already over the token cap is left in its own batch.
 */
export function batchEmbeddingInputs(
  texts: readonly string[],
  limits: EmbeddingBatchLimits = {},
): string[][] {
  const maxInputs = limits.maxInputs ?? EMBEDDING_MAX_INPUTS;
  const maxTokens = limits.maxTokens ?? EMBEDDING_MAX_TOKENS;
  if (maxInputs < 1 || maxTokens < 1) {
    throw new Error("embedding batch limits must be at least 1");
  }

  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const text of texts) {
    const cost = estimateEmbeddingTokens(text);
    const overflows =
      current.length > 0 &&
      (current.length >= maxInputs || tokens + cost > maxTokens);
    if (overflows) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * OpenAI embeddings client. Corpus ingest calls `embed` with a batch.
 * The request path uses `embedQuery`, which sends one string.
 */
export function createEmbeddingClient(options?: {
  model?: string;
  embeddings?: EmbeddingsApi;
}): EmbeddingClient {
  const model = options?.model ?? embeddingModelFromEnv();
  let embeddings = options?.embeddings;

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const batches = batchEmbeddingInputs(texts);
      if (batches.length !== 1) {
        throw new Error(
          `embedding request has ${texts.length} inputs; the maximum is ${EMBEDDING_MAX_INPUTS} inputs and ${EMBEDDING_MAX_TOKENS} tokens`,
        );
      }

      embeddings ??= openAiEmbeddings();
      const response = await embeddings.create({
        model,
        input: [...texts],
      });
      return vectorsInInputOrder(response.data, texts.length);
    },
  };
}

/** Embed one rewritten question, with no section-heading prefix. */
export async function embedQuery(
  client: EmbeddingClient,
  query: string,
): Promise<number[]> {
  const vectors = await client.embed([query]);
  if (vectors.length !== 1) {
    throw new Error(`query embedding returned ${vectors.length} vectors`);
  }
  const vector = vectors[0];
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingDimensionError(vector?.length ?? 0);
  }
  return vector;
}

function openAiEmbeddings(): EmbeddingsApi {
  const openai = new OpenAI();
  return {
    create(body) {
      return openai.embeddings.create({
        model: body.model,
        input: body.input,
      });
    },
  };
}

function vectorsInInputOrder(
  data: EmbeddingResponse["data"],
  count: number,
): number[][] {
  const byIndex = new Map(data.map((item) => [item.index, item.embedding]));
  const vectors: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const embedding = byIndex.get(index);
    if (!embedding) {
      throw new Error(`embedding response is missing index ${index}`);
    }
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingDimensionError(embedding.length);
    }
    vectors.push(embedding);
  }
  return vectors;
}
