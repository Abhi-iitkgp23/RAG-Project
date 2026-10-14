import { afterEach, describe, expect, it } from "vitest";
import { ChatBudget, GPT_OSS_120B_LIMITS, LlmLimitError } from "./llmBudget";
import type { EmbeddingClient, JsonSchema } from "./types";
import {
  COMPLETION_TEMPERATURE,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_INPUTS,
  EMBEDDING_MAX_TOKENS,
  EmbeddingDimensionError,
  ModelOutputError,
  STRUCTURED_OUTPUT_ATTEMPTS,
  RATE_LIMIT_RETRIES,
  completeStructured,
  parseGroqDurationMs,
  rateLimitDisposition,
  rateLimitWaitMs,
  batchEmbeddingInputs,
  chatModelFromEnv,
  embeddingDimensionsFromEnv,
  LOCAL_EMBEDDING_MAX_INPUTS,
  localEmbeddingModelId,
  createEmbeddingClient,
  createModelClient,
  embedQuery,
  estimateEmbeddingTokens,
  parseModelObject,
} from "./model";

const envKeys = ["EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "OPENAI_MODEL"] as const;
const previousEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of envKeys) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
});

function rememberEnv(key: (typeof envKeys)[number]): void {
  if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
}

function vector(seed: number): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[0] = seed;
  return values;
}

describe("embedding client", () => {
  it("defaults to text-embedding-3-small and does not pass dimensions", async () => {
    rememberEnv("EMBEDDING_MODEL");
    delete process.env.EMBEDDING_MODEL;
    let body: { model: string; input: string[] } | undefined;
    const client = createEmbeddingClient({
      embeddings: {
        async create(request) {
          body = request;
          return { data: [{ index: 0, embedding: vector(1) }] };
        },
      },
    });

    const vectors = await client.embed(["how long does cooked chicken last"]);

    expect(body).toEqual({
      model: DEFAULT_EMBEDDING_MODEL,
      input: ["how long does cooked chicken last"],
    });
    expect(body).not.toHaveProperty("dimensions");
    expect(vectors).toEqual([vector(1)]);
  });

  it("reads the model id from EMBEDDING_MODEL", async () => {
    rememberEnv("EMBEDDING_MODEL");
    process.env.EMBEDDING_MODEL = " text-embedding-3-small ";
    let model = "";
    const client = createEmbeddingClient({
      embeddings: {
        async create(request) {
          model = request.model;
          return { data: [{ index: 0, embedding: vector(1) }] };
        },
      },
    });

    await client.embed(["question"]);

    expect(model).toBe("text-embedding-3-small");
  });

  it("reads the vector width from EMBEDDING_DIMENSIONS", () => {
    rememberEnv("EMBEDDING_DIMENSIONS");
    delete process.env.EMBEDDING_DIMENSIONS;
    expect(embeddingDimensionsFromEnv()).toBe(EMBEDDING_DIMENSIONS);

    process.env.EMBEDDING_DIMENSIONS = " 768 ";
    expect(embeddingDimensionsFromEnv()).toBe(768);
    process.env.EMBEDDING_DIMENSIONS = "0";
    expect(() => embeddingDimensionsFromEnv()).toThrow("positive integer");
  });

  it("treats a local: model id as on-device and leaves API ids alone", () => {
    expect(localEmbeddingModelId("text-embedding-3-small")).toBeNull();
    expect(localEmbeddingModelId("local:")).toBeNull();
    expect(localEmbeddingModelId("local:onnx-community/all-MiniLM-L6-v2-ONNX")).toBe(
      "onnx-community/all-MiniLM-L6-v2-ONNX",
    );
  });

  it("returns vectors in input order", async () => {
    const client = createEmbeddingClient({
      embeddings: {
        async create() {
          return {
            data: [
              { index: 1, embedding: vector(2) },
              { index: 0, embedding: vector(1) },
            ],
          };
        },
      },
    });

    await expect(client.embed(["first", "second"])).resolves.toEqual([
      vector(1),
      vector(2),
    ]);
  });

  it("rejects a vector whose length is not 1536", async () => {
    const client = createEmbeddingClient({
      embeddings: {
        async create() {
          return { data: [{ index: 0, embedding: [0.1, 0.2] }] };
        },
      },
    });

    await expect(client.embed(["question"])).rejects.toBeInstanceOf(
      EmbeddingDimensionError,
    );
  });

  it("rejects a request over the input or token cap without calling the API", async () => {
    let calls = 0;
    const client = createEmbeddingClient({
      embeddings: {
        async create() {
          calls += 1;
          return { data: [] };
        },
      },
    });

    await expect(
      client.embed(Array.from({ length: EMBEDDING_MAX_INPUTS + 1 }, () => "a")),
    ).rejects.toThrow(String(EMBEDDING_MAX_INPUTS));
    const oversized = "a".repeat(EMBEDDING_MAX_TOKENS * 4);
    await expect(client.embed([oversized, "a"])).rejects.toThrow(
      String(EMBEDDING_MAX_TOKENS),
    );
    expect(calls).toBe(0);
  });

  it("embeds one query string per request", async () => {
    const calls: string[][] = [];
    const client: EmbeddingClient = {
      async embed(texts) {
        calls.push([...texts]);
        return [vector(0.25)];
      },
    };

    const result = await embedQuery(
      client,
      "how long does cooked chicken last in the refrigerator",
    );

    expect(calls).toEqual([
      ["how long does cooked chicken last in the refrigerator"],
    ]);
    expect(result).toEqual(vector(0.25));
  });

  it("adds the nomic search_query prefix and leaves other models unprefixed", async () => {
    rememberEnv("EMBEDDING_MODEL");
    const calls: string[][] = [];
    const client: EmbeddingClient = {
      async embed(texts) {
        calls.push([...texts]);
        return [vector(0.25)];
      },
    };

    process.env.EMBEDDING_MODEL = "nomic-embed-text-v1_5";
    await embedQuery(client, "how long does cooked chicken last");
    process.env.EMBEDDING_MODEL = "local:nomic-ai/nomic-embed-text-v1.5";
    await embedQuery(client, "how long does cooked chicken last");
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await embedQuery(client, "how long does cooked chicken last");

    expect(calls).toEqual([
      ["search_query: how long does cooked chicken last"],
      ["search_query: how long does cooked chicken last"],
      ["how long does cooked chicken last"],
    ]);
  });

  it("splits an on-device batch under the local cap", () => {
    expect(LOCAL_EMBEDDING_MAX_INPUTS).toBeLessThan(EMBEDDING_MAX_INPUTS);
    const batches = batchEmbeddingInputs(
      Array.from({ length: LOCAL_EMBEDDING_MAX_INPUTS + 1 }, () => "oils"),
      { maxInputs: LOCAL_EMBEDDING_MAX_INPUTS },
    );
    expect(batches.map((batch) => batch.length)).toEqual([
      LOCAL_EMBEDDING_MAX_INPUTS,
      1,
    ]);
  });
});

const draftSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { covered: { type: "boolean" } },
  required: ["covered"],
};

describe("chat completion client", () => {
  it("calls strict json_schema at temperature 0 and parses the object", async () => {
    rememberEnv("OPENAI_MODEL");
    delete process.env.OPENAI_MODEL;
    let body: {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
      response_format: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: JsonSchema };
      };
    } | undefined;

    const client = createModelClient({
      completions: {
        async create(request) {
          body = request;
          return {
            choices: [
              { message: { content: '{"covered":true,"extra":1}' } },
            ],
          };
        },
      },
    });

    const parsed = await client.complete({
      system: "Return the draft.",
      messages: [
        { role: "user", content: "How long can cooked chicken stay?" },
      ],
      schema: draftSchema,
      schemaName: "grounded_draft",
    });

    expect(body).toEqual({
      model: DEFAULT_CHAT_MODEL,
      temperature: COMPLETION_TEMPERATURE,
      messages: [
        { role: "system", content: "Return the draft." },
        { role: "user", content: "How long can cooked chicken stay?" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "grounded_draft",
          strict: true,
          schema: draftSchema,
        },
      },
    });
    expect(parsed).toEqual({ covered: true, extra: 1 });
  });

  it("reads the model id from OPENAI_MODEL", async () => {
    rememberEnv("OPENAI_MODEL");
    process.env.OPENAI_MODEL = " openai/gpt-oss-120b ";
    let model = "";
    const client = createModelClient({
      completions: {
        async create(request) {
          model = request.model;
          return { choices: [{ message: { content: "{}" } }] };
        },
      },
    });

    await client.complete({
      system: "system",
      messages: [],
      schema: draftSchema,
      schemaName: "grounded_draft",
    });

    expect(model).toBe("openai/gpt-oss-120b");
    expect(chatModelFromEnv()).toBe("openai/gpt-oss-120b");
  });

  it("throws when the body is prose, empty, or not an object", () => {
    expect(() => parseModelObject("not json {")).toThrow(ModelOutputError);
    expect(() => parseModelObject("  ")).toThrow(ModelOutputError);
    expect(() => parseModelObject('"just prose"')).toThrow(ModelOutputError);
    expect(() => parseModelObject("[1]")).toThrow(ModelOutputError);
    expect(() => parseModelObject("null")).toThrow(ModelOutputError);
  });

  it("does not resolve prose when the completion is not JSON", async () => {
    const prose = "Eat 1,500 calories a day to lose weight.";
    const client = createModelClient({
      completions: {
        async create() {
          return { choices: [{ message: { content: prose } }] };
        },
      },
    });

    await expect(
      client.complete({
        system: "system",
        messages: [{ role: "user", content: "calories?" }],
        schema: draftSchema,
        schemaName: "grounded_draft",
      }),
    ).rejects.toBeInstanceOf(ModelOutputError);
  });

  it("lets a provider error propagate", async () => {
    let calls = 0;
    const client = createModelClient({
      completions: {
        async create() {
          calls += 1;
          throw new Error("timeout");
        },
      },
    });

    await expect(
      client.complete({
        system: "system",
        messages: [],
        schema: draftSchema,
        schemaName: "grounded_draft",
      }),
    ).rejects.toThrow("timeout");
    expect(calls).toBe(1);
  });

  it("retries a Groq structured-output parse failure and keeps the next object", async () => {
    let calls = 0;
    const client = createModelClient({
      model: "openai/gpt-oss-120b",
      completions: {
        async create(request) {
          calls += 1;
          expect(request.reasoning_effort).toBe("low");
          expect(request.max_completion_tokens).toBe(2_048);
          if (calls === 1) {
            const error = new Error("Parsing failed");
            Object.assign(error, { code: "output_parse_failed" });
            throw error;
          }
          return { choices: [{ message: { content: '{"covered":false,"claims":[]}' } }] };
        },
      },
    });

    await expect(
      client.complete({
        system: "system",
        messages: [{ role: "user", content: "how many days honey can be stored" }],
        schema: draftSchema,
        schemaName: "grounded_draft",
      }),
    ).resolves.toEqual({ covered: false, claims: [] });
    expect(calls).toBe(2);
  });

  it("stops after the structured-output attempt budget", async () => {
    let calls = 0;
    const client = createModelClient({
      completions: {
        async create() {
          calls += 1;
          const error = new Error("Parsing failed");
          Object.assign(error, { error: { code: "json_validate_failed" } });
          throw error;
        },
      },
    });

    await expect(
      client.complete({
        system: "system",
        messages: [],
        schema: draftSchema,
        schemaName: "grounded_draft",
      }),
    ).rejects.toThrow("Parsing failed");
    expect(calls).toBe(STRUCTURED_OUTPUT_ATTEMPTS);
  });

  it("waits out one Groq token window and keeps the next object", async () => {
    expect(parseGroqDurationMs("31.657s")).toBe(31_657);
    expect(parseGroqDurationMs("2m3.5s")).toBe(123_500);
    expect(rateLimitWaitMs(new Error("timeout"))).toBeNull();

    const limited = new Error("Rate limit reached");
    Object.assign(limited, {
      status: 429,
      code: "rate_limit_exceeded",
      headers: { "x-ratelimit-reset-tokens": "31.657s" },
    });
    expect(rateLimitWaitMs(limited)).toBe(32_157);

    let calls = 0;
    const waits: number[] = [];
    const response = await completeStructured(
      {
        async create() {
          calls += 1;
          if (calls === 1) throw limited;
          return { choices: [{ message: { content: "{}" } }] };
        },
      },
      {
        model: "openai/gpt-oss-120b",
        temperature: 0,
        messages: [],
        response_format: {
          type: "json_schema",
          json_schema: { name: "grounded_draft", strict: true, schema: draftSchema },
        },
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    expect(response.choices[0]?.message.content).toBe("{}");
    expect(calls).toBe(1 + RATE_LIMIT_RETRIES);
    expect(waits).toEqual([32_157]);
  });

  it("stops after one minute-window retry and does not retry a daily cap", async () => {
    const minute = new Error("Rate limit reached on tokens per minute");
    Object.assign(minute, { status: 429, code: "rate_limit_exceeded" });
    expect(rateLimitDisposition(minute)).toBe("minute");

    const daily = new Error(
      "Rate limit reached on tokens per day (TPD): Limit 200000, Requested 100",
    );
    Object.assign(daily, { status: 429, code: "rate_limit_exceeded" });
    expect(rateLimitDisposition(daily)).toBe("day");

    const oversized = new Error("Limit 8000, Requested 9000");
    Object.assign(oversized, { status: 429, code: "rate_limit_exceeded" });
    expect(rateLimitDisposition(oversized)).toBe("too_large");

    await expect(
      completeStructured(
        {
          async create() {
            throw minute;
          },
        },
        {
          model: "openai/gpt-oss-120b",
          temperature: 0,
          messages: [],
          response_format: {
            type: "json_schema",
            json_schema: { name: "grounded_draft", strict: true, schema: draftSchema },
          },
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ reason: "minute" });

    await expect(
      completeStructured(
        {
          async create() {
            throw daily;
          },
        },
        {
          model: "openai/gpt-oss-120b",
          temperature: 0,
          messages: [],
          response_format: {
            type: "json_schema",
            json_schema: { name: "grounded_draft", strict: true, schema: draftSchema },
          },
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ reason: "day" });
  });

  it("caps gpt-oss output, trims older turns, and skips the provider when the day is spent", async () => {
    let now = Date.parse("2026-10-15T12:00:00.000Z");
    const budget = ChatBudget.memory({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const reservation = await budget.acquire(100);
    await budget.reject(reservation.id, { daily: true, blockMs: 0 });

    let calls = 0;
    const client = createModelClient({
      model: "openai/gpt-oss-120b",
      budget,
      completions: {
        async create() {
          calls += 1;
          return { choices: [{ message: { content: "{}" } }] };
        },
      },
    });

    await expect(
      client.complete({
        system: "system",
        messages: [{ role: "user", content: "how long does cooked chicken last" }],
        schema: draftSchema,
        schemaName: "grounded_draft",
      }),
    ).rejects.toBeInstanceOf(LlmLimitError);
    expect(calls).toBe(0);

    const open = ChatBudget.memory({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await open.acquire(7_500);
    let seen = 0;
    const waiting = createModelClient({
      model: "openai/gpt-oss-120b",
      budget: open,
      completions: {
        async create(request) {
          seen += 1;
          expect(request.max_completion_tokens).toBe(512);
          expect(request.messages.some((message) => message.content === "oldest")).toBe(false);
          expect(request.messages.at(-1)?.content).toBe("latest");
          return {
            choices: [{ message: { content: "{}" } }],
            usage: { total_tokens: 40 },
          };
        },
      },
    });

    await waiting.complete({
      system: "system",
      messages: [
        { role: "user", content: "oldest" },
        { role: "user", content: "x".repeat(40_000) },
        { role: "user", content: "latest" },
      ],
      schema: draftSchema,
      schemaName: "scope_decision",
    });
    expect(seen).toBe(1);
    expect(open.snapshot().minuteTokens).toBe(40);
    expect(open.snapshot().dayTokens).toBe(7_540);
  });

  it("does not call the provider when one prompt exceeds the minute token cap", async () => {
    let calls = 0;
    const client = createModelClient({
      model: "openai/gpt-oss-120b",
      completions: {
        async create() {
          calls += 1;
          return { choices: [{ message: { content: "{}" } }] };
        },
      },
    });

    await expect(
      client.complete({
        system: "s".repeat(GPT_OSS_120B_LIMITS.tokensPerMinute * 4),
        messages: [{ role: "user", content: "question" }],
        schema: draftSchema,
        schemaName: "grounded_draft",
      }),
    ).rejects.toMatchObject({ reason: "too_large" });
    expect(calls).toBe(0);
  });
});

describe("embedding batches", () => {
  it("estimates tokens at four characters per token", () => {
    expect(estimateEmbeddingTokens("")).toBe(0);
    expect(estimateEmbeddingTokens("abcd")).toBe(1);
    expect(estimateEmbeddingTokens("abcde")).toBe(2);
  });

  it("splits on the input cap and the token cap", () => {
    expect(
      batchEmbeddingInputs(["a", "b", "c"], { maxInputs: 2, maxTokens: 100 }),
    ).toEqual([["a", "b"], ["c"]]);

    const four = "abcd";
    const eight = "abcdefgh";
    expect(estimateEmbeddingTokens(four)).toBe(1);
    expect(estimateEmbeddingTokens(eight)).toBe(2);
    expect(
      batchEmbeddingInputs([four, eight, four], { maxTokens: 3 }),
    ).toEqual([
      [four, eight],
      [four],
    ]);
  });

  it("keeps one oversized input in its own batch", () => {
    const huge = "a".repeat(40);
    expect(batchEmbeddingInputs([huge], { maxTokens: 3 })).toEqual([[huge]]);
  });
});
