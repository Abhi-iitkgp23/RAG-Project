import OpenAI from "openai";
import type { EmbeddingClient, JsonSchema, ModelClient } from "./types";

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
    super(`embedding length ${length}, expected ${embeddingDimensionsFromEnv()}`);
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

const LOCAL_EMBEDDING_PREFIX = "local:";

/** `local:<huggingface id>` embeds on this machine. Any other id uses the API. */
export function localEmbeddingModelId(model: string): string | null {
  if (!model.startsWith(LOCAL_EMBEDDING_PREFIX)) return null;
  const id = model.slice(LOCAL_EMBEDDING_PREFIX.length).trim();
  return id === "" ? null : id;
}

/**
 * Width of one stored vector. Unset `EMBEDDING_DIMENSIONS` keeps the
 * `text-embedding-3-small` default. A host that serves another model,
 * such as Groq `nomic-embed-text-v1_5`, sets this to that model's width.
 */
export function embeddingDimensionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env.EMBEDDING_DIMENSIONS?.trim();
  if (!configured) return EMBEDDING_DIMENSIONS;
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error("EMBEDDING_DIMENSIONS must be a positive integer");
  }
  return Number(configured);
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
  const localId = options?.embeddings ? null : localEmbeddingModelId(model);
  if (localId) {
    return {
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const batches = batchEmbeddingInputs(texts);
        if (batches.length !== 1) {
          throw new Error(
            `embedding request has ${texts.length} inputs; the maximum is ${EMBEDDING_MAX_INPUTS} inputs and ${EMBEDDING_MAX_TOKENS} tokens`,
          );
        }
        const { embedWithLocalModel } = await import("./localEmbed");
        return embedWithLocalModel(localId, texts);
      },
    };
  }
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
  if (!vector || vector.length !== embeddingDimensionsFromEnv()) {
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

/**
 * Default when `OPENAI_MODEL` is unset or blank. This id supports strict
 * `json_schema`. A deployment overrides it with `OPENAI_MODEL`.
 */
export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

/** Structured completions always sample at temperature 0. */
export const COMPLETION_TEMPERATURE = 0;

/**
 * The completion body was missing, empty, or not a JSON object.
 * Callers that must fail closed (the scope gate) catch this.
 * A transport or provider error is a different exception and is not wrapped.
 */
export class ModelOutputError extends Error {
  constructor(message = "model output is not a JSON object") {
    super(message);
    this.name = "ModelOutputError";
  }
}

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Attempts for one structured call. Groq sometimes returns `output_parse_failed` with an empty body. */
export const STRUCTURED_OUTPUT_ATTEMPTS = 3;

type ChatCompletionRequest = {
  model: string;
  temperature: number;
  messages: ChatMessage[];
  response_format: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: true;
      schema: JsonSchema;
    };
  };
  reasoning_effort?: "low";
};

type ChatCompletionResponse = {
  choices: Array<{
    message: { content: string | null };
  }>;
};

type ChatCompletionsApi = {
  create(body: ChatCompletionRequest): Promise<ChatCompletionResponse>;
};

export function chatModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.OPENAI_MODEL?.trim();
  return configured ? configured : DEFAULT_CHAT_MODEL;
}

/**
 * OpenAI chat client for the scope classifier, the query rewriter, and the
 * grounded draft. Temperature is 0. The response format is strict
 * `json_schema` under the caller's schema name. A body that is not a JSON
 * object throws `ModelOutputError` instead of returning the prose.
 */
export function createModelClient(options?: {
  model?: string;
  completions?: ChatCompletionsApi;
}): ModelClient {
  const model = options?.model ?? chatModelFromEnv();
  let completions = options?.completions;

  return {
    async complete(input) {
      const schemaName = input.schemaName.trim();
      if (schemaName === "") {
        throw new Error("schema name is required");
      }

      completions ??= openAiCompletions();
      const response = await completeStructured(completions, {
        model,
        temperature: COMPLETION_TEMPERATURE,
        messages: [
          { role: "system", content: input.system },
          ...input.messages,
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            strict: true,
            schema: input.schema,
          },
        },
        ...reasoningEffortFor(model),
      });

      return parseModelObject(response.choices[0]?.message.content);
    },
  };
}

/**
 * `openai/gpt-oss-*` spends the completion on a reasoning channel. Groq then
 * rejects the turn with `output_parse_failed` and an empty `failed_generation`.
 * Low effort keeps the visible JSON inside the schema.
 */
export function reasoningEffortFor(model: string): { reasoning_effort: "low" } | Record<string, never> {
  return model.includes("gpt-oss") ? { reasoning_effort: "low" } : {};
}

/**
 * Groq's grammar check fails closed with HTTP 400 and no content. A later
 * attempt often returns the object. A timeout or a 5xx is not retried.
 */
export async function completeStructured(
  completions: ChatCompletionsApi,
  body: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STRUCTURED_OUTPUT_ATTEMPTS; attempt += 1) {
    try {
      return await completions.create(body);
    } catch (error) {
      lastError = error;
      if (!isStructuredOutputParseError(error) || attempt === STRUCTURED_OUTPUT_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError;
}

/** Provider rejected the generation because it was not the schema. */
export function isStructuredOutputParseError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "output_parse_failed" || code === "json_validate_failed";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("error" in error && error.error && typeof error.error === "object" && "code" in error.error) {
    const nested = error.error.code;
    return typeof nested === "string" ? nested : undefined;
  }
  return undefined;
}

function openAiCompletions(): ChatCompletionsApi {
  const openai = new OpenAI();
  return {
    async create(body) {
      const response = await openai.chat.completions.create({
        model: body.model,
        temperature: body.temperature,
        messages: body.messages,
        response_format: body.response_format,
        ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
      });
      return {
        choices: response.choices.map((choice) => ({
          message: {
            content:
              typeof choice.message.content === "string"
                ? choice.message.content
                : null,
          },
        })),
      };
    },
  };
}

/** JSON.parse a completion body. Prose, arrays, and empty bodies throw. */
export function parseModelObject(content: string | null | undefined): unknown {
  const trimmed = content?.trim() ?? "";
  if (trimmed === "") {
    throw new ModelOutputError("model output is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ModelOutputError("model output is not valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelOutputError("model output is not a JSON object");
  }
  return parsed;
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
    if (embedding.length !== embeddingDimensionsFromEnv()) {
      throw new EmbeddingDimensionError(embedding.length);
    }
    vectors.push(embedding);
  }
  return vectors;
}
