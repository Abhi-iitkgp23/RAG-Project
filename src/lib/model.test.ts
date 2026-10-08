import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingClient } from "./types";
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_INPUTS,
  EMBEDDING_MAX_TOKENS,
  EmbeddingDimensionError,
  batchEmbeddingInputs,
  createEmbeddingClient,
  embedQuery,
  estimateEmbeddingTokens,
} from "./model";

const envKeys = ["EMBEDDING_MODEL"] as const;
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
