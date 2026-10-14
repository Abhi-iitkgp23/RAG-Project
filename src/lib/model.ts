import { join } from "node:path";
import OpenAI from "openai";
import {
  ChatBudget,
  completionTokenReserve,
  estimateRequestTokens,
  GPT_OSS_120B_LIMITS,
  LlmLimitError,
  trimMessagesToLimit,
  usesGptOss120bLimits,
} from "./llmBudget";
import { dataDirectory } from "./store";
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

/**
 * On-device batches stay small. One ONNX call padded to the longest
 * chunk in the batch has to fit in the server that answers questions.
 */
export const LOCAL_EMBEDDING_MAX_INPUTS = 8;

/** Token cap for one on-device batch, using the same four-characters estimate. */
export const LOCAL_EMBEDDING_MAX_TOKENS = 8_192;

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
 * Nomic embed models score retrieval only when the input names the task.
 * The host does not add this prefix, including a `local:` model.
 */
export const NOMIC_DOCUMENT_PREFIX = "search_document: ";
export const NOMIC_QUERY_PREFIX = "search_query: ";

/**
 * True for Nomic embed ids. A `local:` id is checked after the prefix,
 * so `local:nomic-ai/nomic-embed-text-v1.5` still gets the task string.
 */
export function usesNomicTaskPrefix(model = embeddingModelFromEnv()): boolean {
  const id = localEmbeddingModelId(model) ?? model;
  return id.includes("nomic-embed-text");
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
        const batches = batchEmbeddingInputs(texts, {
          maxInputs: LOCAL_EMBEDDING_MAX_INPUTS,
          maxTokens: LOCAL_EMBEDDING_MAX_TOKENS,
        });
        const { embedWithLocalModel } = await import("./localEmbed");
        const vectors: number[][] = [];
        for (const batch of batches) {
          vectors.push(...(await embedWithLocalModel(localId, batch)));
        }
        return vectors;
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

/**
 * Embed one rewritten question, with no section-heading prefix.
 * A Nomic model also receives the `search_query:` task prefix.
 */
export async function embedQuery(
  client: EmbeddingClient,
  query: string,
): Promise<number[]> {
  const input = usesNomicTaskPrefix() ? `${NOMIC_QUERY_PREFIX}${query}` : query;
  const vectors = await client.embed([input]);
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

/**
 * One extra try after HTTP 429. Groq's short retry fires in about 2 seconds,
 * while the token window on this tier resets in about 30.
 */
export const RATE_LIMIT_RETRIES = 1;

/** Do not hold a chat turn open longer than this for a single 429. */
export const MAX_RATE_LIMIT_WAIT_MS = 40_000;

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
  max_completion_tokens?: number;
};

type ChatCompletionResponse = {
  choices: Array<{
    message: { content: string | null };
  }>;
  usage?: { total_tokens?: number };
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
  budget?: ChatBudget | null;
}): ModelClient {
  const model = options?.model ?? chatModelFromEnv();
  const limited = usesGptOss120bLimits(model);
  const budget =
    options?.budget !== undefined
      ? options.budget
      : options?.completions
        ? null
        : sharedBudget(model);
  let completions = options?.completions;
  if (completions && budget) completions = budgetedCompletions(completions, budget);

  return {
    async complete(input) {
      const schemaName = input.schemaName.trim();
      if (schemaName === "") {
        throw new Error("schema name is required");
      }

      const messages = limited
        ? trimMessagesToLimit(
            [{ role: "system" as const, content: input.system }, ...input.messages],
            input.schema,
            schemaName,
          )
        : [{ role: "system" as const, content: input.system }, ...input.messages];
      const reserve = limited ? completionTokenReserve(schemaName) : undefined;
      if (
        reserve !== undefined &&
        estimateRequestTokens(messages, input.schema, reserve) >
          GPT_OSS_120B_LIMITS.tokensPerMinute
      ) {
        throw new LlmLimitError("too_large");
      }

      completions ??= openAiCompletions(budget);
      const response = await completeStructured(completions, {
        model,
        temperature: COMPLETION_TEMPERATURE,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            strict: true,
            schema: input.schema,
          },
        },
        ...reasoningEffortFor(model),
        ...(reserve !== undefined ? { max_completion_tokens: reserve } : {}),
      });

      return parseModelObject(response.choices[0]?.message.content);
    },
  };
}

let persistentBudget: ChatBudget | undefined;

/** One ledger per process, stored under `DATA_DIR`, so restarts keep the daily spend. */
function sharedBudget(model: string): ChatBudget | null {
  if (!usesGptOss120bLimits(model)) return null;
  persistentBudget ??= ChatBudget.open(join(dataDirectory(), "llm-budget.json"));
  return persistentBudget;
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
 * A minute-window 429 waits once, then tries the same body again. A second
 * minute 429, a daily cap, or a request larger than the minute token cap
 * throws `LlmLimitError`.
 */
export async function completeStructured(
  completions: ChatCompletionsApi,
  body: ChatCompletionRequest,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<ChatCompletionResponse> {
  let parseAttempts = 0;
  let rateLimitWaits = 0;
  while (true) {
    try {
      return await completions.create(body);
    } catch (error) {
      const waitMs = rateLimitWaitMs(error);
      if (waitMs !== null) {
        const disposition = rateLimitDisposition(error);
        if (disposition === "day" || disposition === "too_large") {
          throw new LlmLimitError(disposition);
        }
        if (rateLimitWaits < RATE_LIMIT_RETRIES) {
          rateLimitWaits += 1;
          await sleep(waitMs);
          continue;
        }
        throw new LlmLimitError("minute");
      }
      parseAttempts += 1;
      if (!isStructuredOutputParseError(error) || parseAttempts >= STRUCTURED_OUTPUT_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/**
 * A 429 that waiting will not clear: the UTC day is already full, or this
 * one request is larger than the minute token cap.
 */
export function rateLimitDisposition(error: unknown): "day" | "too_large" | "minute" | null {
  if (rateLimitWaitMs(error) === null) return null;
  const message = errorMessage(error);
  if (/\bper day\b|\bTPD\b|\bRPD\b/i.test(message)) return "day";
  const requested = /Requested\s+(\d+)/i.exec(message);
  const limit = /Limit\s+(\d+)/i.exec(message);
  if (requested && limit && Number(requested[1]) > Number(limit[1])) return "too_large";
  return "minute";
}

/** Milliseconds to wait for a Groq token window, or null when this is not a 429. */
export function rateLimitWaitMs(error: unknown): number | null {
  const limited = errorCode(error) === "rate_limit_exceeded" || httpStatus(error) === 429;
  if (!limited) return null;
  const reset = headerValue(error, "x-ratelimit-reset-tokens");
  const fromReset = reset ? parseGroqDurationMs(reset) : null;
  if (fromReset !== null) return Math.min(fromReset + 500, MAX_RATE_LIMIT_WAIT_MS);
  const retryAfter = headerValue(error, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000) + 500, MAX_RATE_LIMIT_WAIT_MS);
    }
  }
  return 20_000;
}

/** Groq sends this header as `31.657s` or `2m3.5s`. */
export function parseGroqDurationMs(value: string): number | null {
  const match = /^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function headerValue(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== "object" || !("headers" in error)) return undefined;
  const headers = error.headers;
  if (!headers || typeof headers !== "object") return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

/** Provider rejected the generation because it was not the schema. */
export function isStructuredOutputParseError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "output_parse_failed" || code === "json_validate_failed";
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const parts: string[] = [];
  if ("message" in error && typeof error.message === "string") parts.push(error.message);
  if ("error" in error && error.error && typeof error.error === "object") {
    const nested = error.error;
    if ("message" in nested && typeof nested.message === "string") parts.push(nested.message);
  }
  return parts.join(" ");
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

function openAiCompletions(budget: ChatBudget | null): ChatCompletionsApi {
  const openai = new OpenAI({ maxRetries: 0 });
  const api: ChatCompletionsApi = {
    async create(body) {
      const response = await openai.chat.completions.create({
        model: body.model,
        temperature: body.temperature,
        messages: body.messages,
        response_format: body.response_format,
        ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
        ...(body.max_completion_tokens
          ? { max_completion_tokens: body.max_completion_tokens }
          : {}),
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
        usage: response.usage
          ? { total_tokens: response.usage.total_tokens }
          : undefined,
      };
    },
  };
  return budget ? budgetedCompletions(api, budget) : api;
}

/**
 * Reserve gpt-oss-120b capacity before the HTTP call.
 * A minute limit pauses. A daily limit or an oversized request fails closed.
 */
function budgetedCompletions(inner: ChatCompletionsApi, budget: ChatBudget): ChatCompletionsApi {
  return {
    async create(body) {
      const reserve =
        body.max_completion_tokens ??
        completionTokenReserve(body.response_format.json_schema.name);
      const tokens = estimateRequestTokens(
        body.messages,
        body.response_format.json_schema.schema,
        reserve,
      );
      const reservation = await budget.acquire(tokens);
      try {
        const response = await inner.create(body);
        await budget.reconcile(reservation.id, response.usage?.total_tokens);
        return response;
      } catch (error) {
        const kind = rateLimitDisposition(error);
        if (kind === "day" || kind === "too_large") {
          await budget.reject(reservation.id, { daily: kind === "day", blockMs: 0 });
          throw new LlmLimitError(kind);
        }
        if (kind === "minute") {
          await budget.reject(reservation.id, {
            daily: false,
            blockMs: rateLimitWaitMs(error) ?? 20_000,
          });
        }
        throw error;
      }
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
