import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/chat/route";
import {
  CLARIFICATION_ANSWER,
  GREETING_ANSWER,
  NONSENSE_ANSWER,
  PROFANITY_ANSWER,
  UNRELATED_MATHS_ANSWER,
} from "./clarify";
import { notInCorpusAnswer } from "./coverage";
import { PROFESSIONAL_REFUSAL } from "./decline";
import { DAILY_LIMIT_MESSAGE, QUESTION_TOO_LONG_MESSAGE, RATE_LIMIT_MESSAGE } from "./copy";
import { LlmLimitError } from "./llmBudget";
import { ModelOutputError } from "./model";
import { GROUNDED_DRAFT_SCHEMA_NAME, PROMPT_VERSION } from "./prompt";
import { GuidanceIndexError } from "./retrieve";
import { REWRITE_HISTORY_LIMIT, REWRITE_SCHEMA_NAME } from "./rewrite";
import { SCOPE_SCHEMA_NAME } from "./scope";
import {
  nutritionDbPath,
  openConversationStore,
  setConversationStore,
  type ConversationStore,
} from "./store";
import type { ModelClient, RetrievedChunk } from "./types";
import {
  FORMAT_MISMATCH_MESSAGE,
  MESSAGE_REQUIRED,
  RETRY_MESSAGE,
  dietRetrievalQuery,
  setChatDependencies,
  UNKNOWN_CONVERSATION,
} from "./chat";

const CHICKEN_TEXT =
  "Leftovers | Cooked meat or poultry | 3 to 4 days | 2 to 6 months";
const CHICKEN_QUOTE = "Cooked meat or poultry | 3 to 4 days";
const CHICKEN_CLAIM =
  "Cooked meat or poultry keeps for 3 to 4 days in the refrigerator.";

const directories: string[] = [];
const stores: ConversationStore[] = [];

afterEach(async () => {
  setChatDependencies(null);
  setConversationStore(null);
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type CompleteInput = {
  schemaName: string;
  system: string;
  messages: { role: string; content: string }[];
};

function useStore(): ConversationStore {
  const directory = directories.at(-1) ?? "";
  const store = openConversationStore(nutritionDbPath(directory));
  stores.push(store);
  setConversationStore(store);
  return store;
}

async function tempStore(): Promise<ConversationStore> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-chat-"));
  directories.push(directory);
  return useStore();
}

function countConversations(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("select count(*) as n from conversations").get() as {
      n: number;
    };
    return row.n;
  } finally {
    db.close();
  }
}

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: "cold-storage-2023:12",
    documentId: "cold-storage-2023",
    documentName: "Cold Food Storage Chart",
    publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
    year: 2023,
    sourceUrl:
      "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
    sectionHeading: "Leftovers",
    text: CHICKEN_TEXT,
    score: 0.82,
    ...overrides,
  };
}

function validDraft(chunkId = "cold-storage-2023:12") {
  return {
    covered: true,
    claims: [
      {
        text: CHICKEN_CLAIM,
        quote: CHICKEN_QUOTE,
        chunkId,
      },
    ],
  };
}

function scriptedModel(
  respond: (input: CompleteInput) => unknown,
): ModelClient & { calls: CompleteInput[] } {
  const calls: CompleteInput[] = [];
  return {
    calls,
    async complete(input) {
      const recorded = {
        schemaName: input.schemaName,
        system: input.system,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
      calls.push(recorded);
      return respond(recorded);
    },
  };
}

function wire(options: {
  model: ModelClient;
  chunks?: RetrievedChunk[];
  onRetrieve?: (query: string, documentId?: string) => void;
  retrieveError?: Error;
}) {
  const retrieved: { query: string; documentId?: string }[] = [];
  setChatDependencies({
    model: options.model,
    retrieve: async (request) => {
      retrieved.push({
        query: request.query,
        documentId: request.documentId,
      });
      options.onRetrieve?.(request.query, request.documentId);
      if (options.retrieveError) throw options.retrieveError;
      return options.chunks ?? [chunk()];
    },
  });
  return retrieved;
}

function allowingModel(
  draft: unknown,
  rewrite: "raw" | "bad-json" | "throw" | string = "raw",
): ModelClient & { calls: CompleteInput[] } {
  return scriptedModel((input) => {
    if (input.schemaName === SCOPE_SCHEMA_NAME) {
      return { decision: "allow", category: "none" };
    }
    if (input.schemaName === REWRITE_SCHEMA_NAME) {
      if (rewrite === "throw") throw new Error("rewriter unavailable");
      if (rewrite === "bad-json") {
        throw new ModelOutputError("model output is not valid JSON");
      }
      if (rewrite === "raw") {
        return { query: input.messages.at(-1)?.content ?? "" };
      }
      return { query: rewrite };
    }
    if (input.schemaName === GROUNDED_DRAFT_SCHEMA_NAME) return draft;
    throw new Error(`unexpected schema ${input.schemaName}`);
  });
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function answerOf(json: Record<string, unknown>): Record<string, unknown> {
  return json.message as Record<string, unknown>;
}

describe("POST /api/chat", () => {
  it("returns 400 for a missing, blank, or non-string message and writes no rows", async () => {
    const store = await tempStore();
    const client = allowingModel(validDraft());
    wire({ model: client, chunks: [] });

    for (const body of [
      {},
      { message: "" },
      { message: "   " },
      { message: 12 },
      { message: "ok", extra: true },
      [],
    ]) {
      const { status, json } = await post(body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: MESSAGE_REQUIRED });
    }

    expect(countConversations(store.path)).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it("returns 400 for a body that is not JSON and does not open a turn", async () => {
    const store = await tempStore();
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGE_REQUIRED });
    expect(countConversations(store.path)).toBe(0);
  });

  it("returns 404 for an unknown id, including an empty string, and does not create a conversation", async () => {
    const store = await tempStore();
    wire({ model: allowingModel(validDraft()), chunks: [] });

    for (const conversationId of ["", "missing-id"]) {
      const { status, json } = await post({
        conversationId,
        message: "How long can cooked chicken stay in the fridge?",
      });
      expect(status).toBe(404);
      expect(json).toEqual({ error: UNKNOWN_CONVERSATION });
    }
    expect(countConversations(store.path)).toBe(0);
  });

  it("creates a conversation when the id is omitted and appends a later turn to it", async () => {
    await tempStore();
    const client = allowingModel(validDraft());
    const retrieved = wire({ model: client });

    const first = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(first.status).toBe(200);
    const conversationId = first.json.conversationId;
    expect(typeof conversationId).toBe("string");

    const second = await post({
      conversationId,
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(second.status).toBe(200);
    expect(second.json.conversationId).toBe(conversationId);
    expect(retrieved).toHaveLength(2);
  });

  it("completes a bare sum without the model or the index", async () => {
    const store = await tempStore();
    const client = allowingModel(validDraft());
    const retrieved = wire({
      model: client,
      retrieveError: new GuidanceIndexError("/tmp/guidance.db", "guidance index is missing"),
    });

    for (const message of ["6+3", "6 + 3", "6+3?"]) {
      const { status, json } = await post({ message });
      expect(status).toBe(200);
      expect(answerOf(json)).toMatchObject({
        role: "assistant",
        answer: UNRELATED_MATHS_ANSWER,
        claims: [],
        declined: false,
        coverage: "clarify",
      });
      const stored = store.listMessages(String(json.conversationId));
      expect(stored.map((row) => row.role)).toEqual(["user", "assistant"]);
    }

    expect(client.calls).toHaveLength(0);
    expect(retrieved).toHaveLength(0);

    const food = await post({ message: "Can I keep leftovers 3+4 days?" });
    expect(food.status).toBe(500);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(retrieved.length).toBeGreaterThan(0);
  });

  it("asks for a clearer question without the model or the index", async () => {
    const store = await tempStore();
    const client = allowingModel(validDraft());
    const retrieved = wire({
      model: client,
      retrieveError: new GuidanceIndexError("/tmp/guidance.db", "guidance index is missing"),
    });

    for (const message of ["what is ?", "what is", "huh", "??", "tell me"]) {
      const { status, json } = await post({ message });
      expect(status, message).toBe(200);
      expect(answerOf(json), message).toMatchObject({
        role: "assistant",
        answer: CLARIFICATION_ANSWER,
        claims: [],
        declined: false,
        coverage: "clarify",
      });
      const stored = store.listMessages(String(json.conversationId));
      expect(stored.map((row) => row.role)).toEqual(["user", "assistant"]);
    }

    expect(client.calls).toHaveLength(0);
    expect(retrieved).toHaveLength(0);
  });

  it("searches a population diet question with the documents' own terms", async () => {
    await tempStore();
    const client = allowingModel(validDraft());
    const retrieved = wire({ model: client, chunks: [] });

    const { status } = await post({ message: "what should an adult eat" });

    expect(status).toBe(200);
    expect(retrieved[0]?.query).toBe(
      dietRetrievalQuery("what should an adult eat", "what should an adult eat"),
    );
    expect(retrieved[0]?.query).toContain("balanced diet");
    expect(dietRetrievalQuery("How long can cooked chicken stay in the fridge?", "chicken fridge")).toBe(
      "chicken fridge",
    );
    expect(
      dietRetrievalQuery(
        "What is the published guidance on cooking oil and fats?",
        "published guidance on cooking oil and fats",
      ),
    ).toContain("unsaturated oils and spreads");
  });

  it("still searches a follow-up that names a topic or points at an earlier turn", async () => {
    await tempStore();
    const client = allowingModel(validDraft());
    const retrieved = wire({ model: client });

    const first = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(first.status).toBe(200);
    const conversationId = String(first.json.conversationId);

    for (const message of ["what about the freezer?", "how long?", "what about it?"]) {
      const follow = await post({ conversationId, message });
      expect(follow.status, message).toBe(200);
      expect(answerOf(follow.json).coverage, message).toBe("answered");
    }

    const fragment = await post({ conversationId, message: "what is ?" });
    expect(fragment.status).toBe(200);
    expect(answerOf(fragment.json)).toMatchObject({
      answer: CLARIFICATION_ANSWER,
      coverage: "clarify",
      claims: [],
      declined: false,
    });

    expect(retrieved.map((call) => call.query)).toEqual([
      "How long can cooked chicken stay in the fridge?",
      "what about the freezer?",
      "how long?",
      "what about it?",
    ]);
  });

  it("declines a calorie question before retrieval or the answer model", async () => {
    const store = await tempStore();
    let embeddings = 0;
    const client = scriptedModel(() => ({
      decision: "decline",
      category: "calorie_target",
    }));
    wire({
      model: client,
      onRetrieve: () => {
        embeddings += 1;
      },
    });

    const { status, json } = await post({
      message: "How many calories should I eat to lose 5 kg?",
    });

    expect(status).toBe(200);
    expect(answerOf(json)).toMatchObject({
      role: "assistant",
      answer: PROFESSIONAL_REFUSAL,
      claims: [],
      declined: true,
      coverage: "declined",
    });
    expect(embeddings).toBe(0);
    expect(client.calls.map((call) => call.schemaName)).toEqual([SCOPE_SCHEMA_NAME]);
    const stored = store.listMessages(String(json.conversationId));
    expect(stored[1]).toMatchObject({
      coverage: "declined",
      promptVersion: PROMPT_VERSION,
    });
  });

  it("uses the raw message when the rewrite is not JSON", async () => {
    await tempStore();
    const client = allowingModel(validDraft(), "bad-json");
    const retrieved = wire({ model: client });
    const message = "how long can I keep that?";

    const { status, json } = await post({ message });

    expect(status).toBe(200);
    expect(retrieved).toEqual([{ query: message, documentId: undefined }]);
    expect(answerOf(json).answer).not.toBe(message);
    expect(String(answerOf(json).answer)).not.toContain("standalone");
  });

  it("returns 500 when the rewriter throws and does not retrieve", async () => {
    const store = await tempStore();
    const client = allowingModel(validDraft(), "throw");
    const retrieved = wire({ model: client });

    const { status, json } = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });

    expect(status).toBe(500);
    expect(json.error).toBe(RETRY_MESSAGE);
    expect(retrieved).toHaveLength(0);
    const messages = store.listMessages(String(json.conversationId));
    expect(messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("returns 429 when the model is past the daily or per-minute limit", async () => {
    const store = await tempStore();
    wire({
      model: scriptedModel(() => {
        throw new LlmLimitError("day");
      }),
    });

    const daily = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(daily.status).toBe(429);
    expect(daily.json.error).toBe(DAILY_LIMIT_MESSAGE);
    expect(store.listMessages(String(daily.json.conversationId)).map((message) => message.role)).toEqual([
      "user",
    ]);

    wire({
      model: scriptedModel(() => {
        throw new LlmLimitError("minute");
      }),
    });
    const minute = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(minute.status).toBe(429);
    expect(minute.json.error).toBe(RATE_LIMIT_MESSAGE);

    wire({
      model: scriptedModel(() => {
        throw new LlmLimitError("too_large");
      }),
    });
    const oversized = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(oversized.status).toBe(429);
    expect(oversized.json.error).toBe(QUESTION_TOO_LONG_MESSAGE);
  });

  it("drops older turns and extra passages so a gpt-oss draft fits the minute token cap", async () => {
    const previous = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = "openai/gpt-oss-120b";
    try {
      const store = await tempStore();
      const conversation = store.createConversation();
      store.appendUserMessage(conversation.id, `OLDEST${"x".repeat(20_000)}`);
      const client = allowingModel(validDraft());
      wire({
        model: client,
        chunks: [
          chunk({ id: "cold-storage-2023:0", text: `KEEP${"c".repeat(9_000)}`, score: 0.9 }),
          chunk({ id: "cold-storage-2023:1", text: `DROP-A${"c".repeat(9_000)}`, score: 0.5 }),
          chunk({ id: "cold-storage-2023:2", text: `DROP-B${"c".repeat(9_000)}`, score: 0.4 }),
        ],
      });

      const { status } = await post({
        conversationId: conversation.id,
        message: "How long can cooked chicken stay in the fridge?",
      });

      expect(status).toBe(200);
      const draft = client.calls.find((call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME);
      const payload = draft?.messages.map((message) => message.content).join("\n") ?? "";
      expect(payload).not.toContain("OLDEST");
      expect(payload).toContain("id: cold-storage-2023:0");
      expect(payload).not.toContain("id: cold-storage-2023:1");
      expect(payload).not.toContain("id: cold-storage-2023:2");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = previous;
    }
  });

  it("retrieves again for a follow-up and does not treat the previous answer as a chunk", async () => {
    const store = await tempStore();
    const client = allowingModel(
      validDraft(),
      "how long can cooked chicken stay in the refrigerator",
    );
    const retrieved = wire({ model: client });

    const first = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    const conversationId = String(first.json.conversationId);
    const firstAnswer = String(answerOf(first.json).answer);

    const second = await post({
      conversationId,
      message: "how long can I keep that?",
    });

    expect(second.status).toBe(200);
    expect(retrieved[1]).toEqual({
      query: "how long can cooked chicken stay in the refrigerator",
      documentId: undefined,
    });
    const draftCall = client.calls.filter(
      (call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME,
    )[1];
    const assistantTurns = draftCall?.messages.filter((message) => message.role === "assistant");
    expect(assistantTurns?.map((message) => message.content)).toEqual([firstAnswer]);
    expect(assistantTurns?.[0]?.content).not.toContain("cold-storage-2023:12");
    expect(JSON.stringify(assistantTurns)).not.toContain("claims");
    const rows = store.listMessages(conversationId);
    expect(rows.filter((row) => row.role === "assistant")).toHaveLength(2);
  });

  it("filters a follow-up to Eatwell when the raw message names that document", async () => {
    await tempStore();
    const client = allowingModel({ covered: false, claims: [] }, "raw");
    const retrieved = wire({ model: client, chunks: [] });

    const first = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    const second = await post({
      conversationId: first.json.conversationId,
      message: "according to the Eatwell Guide, how long can I keep that?",
    });

    expect(retrieved[1]?.documentId).toBe("eatwell-2018");
    expect(second.status).toBe(200);
    expect(answerOf(second.json)).toMatchObject({
      coverage: "not_in_corpus",
      declined: false,
      claims: [],
      answer: notInCorpusAnswer("eatwell-2018"),
    });
  });

  it("stores the coverage refusal without calling the answer model when nothing clears the floor", async () => {
    const store = await tempStore();
    const client = allowingModel(validDraft());
    wire({ model: client, chunks: [chunk({ score: 0.29 })] });

    const { status, json } = await post({
      message: "How should I brew kombucha at home?",
    });

    expect(status).toBe(200);
    expect(answerOf(json)).toMatchObject({
      coverage: "not_in_corpus",
      declined: false,
      claims: [],
      answer: notInCorpusAnswer("all"),
    });
    expect(client.calls.map((call) => call.schemaName)).not.toContain(
      GROUNDED_DRAFT_SCHEMA_NAME,
    );
    expect(store.listMessages(String(json.conversationId))[1]).toMatchObject({
      promptVersion: PROMPT_VERSION,
      coverage: "not_in_corpus",
    });
  });

  it("stores the coverage refusal when the draft says covered false", async () => {
    const store = await tempStore();
    const client = allowingModel({ covered: false, claims: [] });
    wire({ model: client });

    const { status, json } = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });

    expect(status).toBe(200);
    expect(answerOf(json).coverage).toBe("not_in_corpus");
    const drafts = client.calls.filter(
      (call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME,
    );
    expect(drafts).toHaveLength(1);
    expect(store.listMessages(String(json.conversationId))[1]).toMatchObject({
      promptVersion: PROMPT_VERSION,
    });
  });

  it("stores the coverage refusal when every quote fails verification", async () => {
    await tempStore();
    const client = allowingModel({
      covered: true,
      claims: [
        {
          text: CHICKEN_CLAIM,
          quote: "this paraphrase is not in the chunk at all",
          chunkId: "cold-storage-2023:12",
        },
      ],
    });
    wire({ model: client });

    const { status, json } = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });

    expect(status).toBe(200);
    expect(answerOf(json)).toMatchObject({
      coverage: "not_in_corpus",
      claims: [],
      declined: false,
    });
    expect(
      client.calls.filter((call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME),
    ).toHaveLength(1);
  });

  it("returns 422 and keeps only the user row when the draft does not match the schema", async () => {
    const store = await tempStore();
    const failures: unknown[] = [
      { covered: true, claims: [], note: "extra" },
      {
        covered: false,
        claims: [
          {
            text: CHICKEN_CLAIM,
            quote: CHICKEN_QUOTE,
            chunkId: "cold-storage-2023:12",
          },
        ],
      },
    ];

    for (const draft of failures) {
      const client = allowingModel(draft);
      wire({ model: client });
      const { status, json } = await post({
        message: "How long can cooked chicken stay in the fridge?",
      });
      expect(status).toBe(422);
      expect(json.error).toBe(FORMAT_MISMATCH_MESSAGE);
      const messages = store.listMessages(String(json.conversationId));
      expect(messages.map((message) => message.role)).toEqual(["user"]);
    }

    const client = scriptedModel((input) => {
      if (input.schemaName === SCOPE_SCHEMA_NAME) {
        return { decision: "allow", category: "none" };
      }
      if (input.schemaName === REWRITE_SCHEMA_NAME) {
        return { query: "cooked chicken refrigerator" };
      }
      throw new ModelOutputError("model output is not valid JSON");
    });
    wire({ model: client });
    const { status, json } = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(status).toBe(422);
    expect(json.error).toBe(FORMAT_MISMATCH_MESSAGE);
    expect(store.listMessages(String(json.conversationId)).map((message) => message.role)).toEqual([
      "user",
    ]);
  });

  it("returns 500 when the index is missing or a later model call throws, and leaves the user row", async () => {
    const store = await tempStore();
    const missing = new GuidanceIndexError("/tmp/guidance.db", "guidance index is missing");
    wire({
      model: allowingModel(validDraft()),
      retrieveError: missing,
    });

    const indexFailure = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(indexFailure.status).toBe(500);
    expect(indexFailure.json.error).toBe(RETRY_MESSAGE);
    expect(
      store.listMessages(String(indexFailure.json.conversationId)).map((message) => message.role),
    ).toEqual(["user"]);

    const client = scriptedModel((input) => {
      if (input.schemaName === SCOPE_SCHEMA_NAME) {
        return { decision: "allow", category: "none" };
      }
      if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: "cooked chicken" };
      throw new Error("answer model down");
    });
    wire({ model: client });
    const modelFailure = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });
    expect(modelFailure.status).toBe(500);
    expect(
      store.listMessages(String(modelFailure.json.conversationId)).map((message) => message.role),
    ).toEqual(["user"]);
  });

  it("sends the answer model at most six passages, none of them under the score floor", async () => {
    await tempStore();
    const client = allowingModel({ covered: false, claims: [] });
    const chunks = Array.from({ length: 8 }, (_, index) =>
      chunk({
        id: `cold-storage-2023:${index}`,
        score: index === 3 ? 0.1 : 0.9,
        text: `${CHICKEN_TEXT} ${index}`,
      }),
    );
    wire({ model: client, chunks });

    await post({ message: "How long can cooked chicken stay in the fridge?" });

    const draft = client.calls.find((call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME);
    const payload = draft?.messages.at(-1)?.content ?? "";
    const ids = [...payload.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
    expect(ids).toEqual([
      "cold-storage-2023:0",
      "cold-storage-2023:1",
      "cold-storage-2023:2",
      "cold-storage-2023:4",
      "cold-storage-2023:5",
      "cold-storage-2023:6",
    ]);
    expect(payload).not.toContain("https://");
  });

  it("limits the scope gate to 12 preceding messages and the rewriter to a shorter recent window", async () => {
    const store = await tempStore();
    const conversation = store.createConversation();
    for (let index = 0; index < 20; index += 1) {
      store.appendUserMessage(conversation.id, `prior-${index}`);
    }
    const client = allowingModel(validDraft());
    wire({ model: client });

    await post({
      conversationId: conversation.id,
      message: "How long can cooked chicken stay in the fridge?",
    });

    const scope = client.calls.find((call) => call.schemaName === SCOPE_SCHEMA_NAME);
    const rewrite = client.calls.find((call) => call.schemaName === REWRITE_SCHEMA_NAME);
    const draft = client.calls.find((call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME);
    const scopeContents = scope?.messages.map((message) => message.content) ?? [];
    const rewriteContents = rewrite?.messages.map((message) => message.content) ?? [];

    expect(scopeContents[0]).toBe("prior-8");
    expect(scopeContents).not.toContain("prior-7");
    expect(scopeContents.at(-1)).toBe("How long can cooked chicken stay in the fridge?");
    expect(scopeContents).toHaveLength(13);
    expect(rewriteContents[0]).toBe(`prior-${20 - REWRITE_HISTORY_LIMIT}`);
    expect(rewriteContents).not.toContain("prior-8");
    expect(rewriteContents).toHaveLength(REWRITE_HISTORY_LIMIT + 1);
    expect(draft?.messages.map((message) => message.content)).toContain("prior-0");
    const assistantDraftTurns = draft?.messages.filter((message) => message.role === "assistant");
    expect(assistantDraftTurns).toEqual([]);
  });

  it("stores the typed text, including SQL and HTML, and still returns JSON", async () => {
    const store = await tempStore();
    wire({ model: allowingModel(validDraft()) });
    const message = `'; DROP TABLE messages; -- <script>alert(1)</script>`;

    const { status, json } = await post({ message });

    expect(status).toBe(200);
    expect(json.message).toBeTypeOf("object");
    const rows = store.listMessages(String(json.conversationId));
    expect(rows[0]).toMatchObject({ role: "user", content: message });
    expect(store.getConversation(String(json.conversationId))).not.toBeNull();
  });

  it("stores two rows for each of two sequential posts of the same turn", async () => {
    const store = await tempStore();
    wire({ model: allowingModel(validDraft()) });
    const message = "How long can cooked chicken stay in the fridge?";

    const first = await post({ message });
    const second = await post({
      conversationId: first.json.conversationId,
      message,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const roles = store
      .listMessages(String(first.json.conversationId))
      .map((row) => row.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("stores the prompt version on an answered turn", async () => {
    const store = await tempStore();
    wire({ model: allowingModel(validDraft()) });

    const { status, json } = await post({
      message: "How long can cooked chicken stay in the fridge?",
    });

    expect(status).toBe(200);
    expect(answerOf(json)).toMatchObject({
      coverage: "answered",
      declined: false,
    });
    const claims = answerOf(json).claims as Array<{ source: { url: string } }>;
    expect(claims[0]?.source.url).toContain("foodsafety.gov");
    expect(store.listMessages(String(json.conversationId))[1]).toMatchObject({
      promptVersion: PROMPT_VERSION,
      coverage: "answered",
    });
  });

  it("answers greetings, keywords, gibberish, profanity, and maths without retrieval", async () => {
    const store = await tempStore();
    const client = allowingModel(validDraft());
    const retrieved = wire({
      model: client,
      retrieveError: new GuidanceIndexError("/tmp/guidance.db", "guidance index is missing"),
    });

    const cases: Array<[string, string]> = [
      ["Hi", GREETING_ANSWER],
      ["Hey ", GREETING_ANSWER],
      [" hello ", GREETING_ANSWER],
      ["HEY", GREETING_ANSWER],
      ["hney", GREETING_ANSWER],
      [
        "water",
        "What would you like to know about water—daily intake, hydration, or something else?",
      ],
      ["Honey", "Are you asking about honey's role in dietary guidance or how to store it?"],
      [
        "rice",
        "Would you like to know about rice as part of a balanced diet or how to store cooked rice safely?",
      ],
      ["GAVSV", NONSENSE_ANSWER],
      ["asdfgh", NONSENSE_ANSWER],
      ["bsdk", PROFANITY_ANSWER],
      ["6+6", UNRELATED_MATHS_ANSWER],
    ];

    for (const [message, answer] of cases) {
      const { status, json } = await post({ message });
      expect(status, message).toBe(200);
      expect(answerOf(json), message).toMatchObject({
        answer,
        claims: [],
        declined: false,
        coverage: "clarify",
      });
      expect(answerOf(json).answer, message).not.toBe(PROFESSIONAL_REFUSAL);
      const rows = store.listMessages(String(json.conversationId));
      expect(rows[0]?.content, message).toBe(message);
    }

    expect(client.calls).toHaveLength(0);
    expect(retrieved).toHaveLength(0);
  });

  it("retrieves valid dietary questions even when the scope model declines them", async () => {
    await tempStore();
    const client = scriptedModel((input) => {
      if (input.schemaName === SCOPE_SCHEMA_NAME) {
        return { decision: "decline", category: "medical_advice" };
      }
      if (input.schemaName === REWRITE_SCHEMA_NAME) {
        return { query: input.messages.at(-1)?.content ?? "" };
      }
      return validDraft();
    });
    const retrieved = wire({ model: client });

    const questions = [
      "What should I eat?",
      "What should I eat daily?",
      "So what should I eat this week?",
      "How much water should I drink daily?",
      "What does the Eatwell Guide recommend?",
      "What are the Indian dietary guidelines?",
      "Is honey part of a balanced diet?",
      "How long can cooked rice stay in the fridge?",
      "How should I store cooked food safely?",
      "Hey what should I eat on daily basis?",
      "  HOW MUCH WATER SHOULD I DRINK DAILY?  ",
    ];

    for (const message of questions) {
      const { status, json } = await post({ message });
      expect(status, message).toBe(200);
      expect(answerOf(json), message).toMatchObject({
        coverage: "answered",
        declined: false,
      });
      expect(answerOf(json).answer, message).not.toBe(PROFESSIONAL_REFUSAL);
      expect((answerOf(json).claims as unknown[]).length, message).toBeGreaterThan(0);
    }

    expect(retrieved).toHaveLength(questions.length);
    expect(client.calls.some((call) => call.schemaName === GROUNDED_DRAFT_SCHEMA_NAME)).toBe(
      true,
    );
  });

  it("keeps the professional refusal for a personal calorie target or a named condition", async () => {
    await tempStore();
    const client = scriptedModel((input) => {
      const current = input.messages.at(-1)?.content ?? "";
      if (current.toLowerCase().includes("weigh") || current.toLowerCase().includes("bmi")) {
        return { decision: "decline", category: "weight_recommendation" };
      }
      if (current.toLowerCase().includes("diabetes")) {
        return { decision: "decline", category: "medical_advice" };
      }
      return { decision: "decline", category: "calorie_target" };
    });
    const retrieved = wire({ model: client });

    for (const message of [
      "How many calories should I eat to lose 10 kg?",
      "I have diabetes. What diet should I follow?",
      "What should I eat for my diabetes?",
      "What should I weigh?",
    ]) {
      const { status, json } = await post({ message });
      expect(status, message).toBe(200);
      expect(answerOf(json), message).toMatchObject({
        answer: PROFESSIONAL_REFUSAL,
        claims: [],
        declined: true,
        coverage: "declined",
      });
    }

    expect(retrieved).toHaveLength(0);
    expect(client.calls.every((call) => call.schemaName === SCOPE_SCHEMA_NAME)).toBe(true);
  });

  it("does not ship a claim whose quote is absent from the retrieved passage", async () => {
    await tempStore();
    const invented = "Honey is required at every meal as part of a balanced diet.";
    const client = allowingModel({
      covered: true,
      claims: [
        {
          text: invented,
          quote: "this sentence is not in the retrieved passage",
          chunkId: "cold-storage-2023:12",
        },
      ],
    });
    const retrieved = wire({ model: client });

    const { status, json } = await post({
      message: "Is honey part of a balanced diet?",
    });

    expect(status).toBe(200);
    expect(retrieved).toHaveLength(1);
    expect(answerOf(json)).toMatchObject({
      coverage: "not_in_corpus",
      claims: [],
      declined: false,
      answer: notInCorpusAnswer("all"),
    });
    expect(JSON.stringify(answerOf(json))).not.toContain(invented);
  });
});
