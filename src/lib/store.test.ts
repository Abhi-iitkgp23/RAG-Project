import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DELETE, GET } from "../app/api/conversations/[id]/route";
import { GUIDANCE_DB_NAME } from "./embed";
import { openGuidanceDatabase } from "./retrieve";
import {
  PRECEDING_MESSAGE_LIMIT,
  nutritionDbPath,
  openConversationStore,
  resolveConversation,
  setConversationStore,
  type AssistantMessageInput,
  type ConversationStore,
  type StoredMessage,
} from "./store";
import type { Claim, Coverage } from "./types";

const CLAIM: Claim = {
  text: "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
  source: {
    documentName: "Cold Food Storage Chart",
    publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
    year: 2023,
    url: "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
    sectionHeading: "Poultry",
  },
};

const TRICKY = `It's a "quote".\nDROP TABLE messages; -- still text`;

const directories: string[] = [];
const stores: ConversationStore[] = [];

afterEach(async () => {
  setConversationStore(null);
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-store-"));
  directories.push(directory);
  return directory;
}

function openTemp(directory: string): ConversationStore {
  const store = openConversationStore(nutritionDbPath(directory));
  stores.push(store);
  return store;
}

function countConversations(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`select count(*) as n from conversations`).get() as {
      n: number;
    };
    return row.n;
  } finally {
    db.close();
  }
}

type RawMessage = {
  role: string;
  content: string;
  claims_json: string | null;
  declined: number;
  coverage: string | null;
  prompt_version: string | null;
};

function rawMessages(path: string, conversationId: string): RawMessage[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `select role, content, claims_json, declined, coverage, prompt_version
         from messages
         where conversation_id = ?
         order by rowid`,
      )
      .all(conversationId) as RawMessage[];
  } finally {
    db.close();
  }
}

function assistantInput(
  coverage: Coverage,
  answer: string,
  claims: Claim[] = [],
): AssistantMessageInput {
  return {
    answer,
    claims,
    declined: coverage === "declined",
    coverage,
    promptVersion: "prompt-v1",
  };
}

function texts(messages: StoredMessage[]): string[] {
  return messages.map((message) => message.content);
}

describe("conversation store", () => {
  it("creates a conversation when the id is omitted and refuses an empty id", async () => {
    const store = openTemp(await tempDir());
    expect(countConversations(store.path)).toBe(0);

    const created = resolveConversation(store, undefined);
    expect(created).not.toBeNull();
    expect(countConversations(store.path)).toBe(1);
    expect(resolveConversation(store, created?.id)).toEqual(created);
    expect(countConversations(store.path)).toBe(1);

    expect(resolveConversation(store, "")).toBeNull();
    expect(resolveConversation(store, "missing-id")).toBeNull();
    expect(countConversations(store.path)).toBe(1);
  });

  it("stores a user row as typed text with null assistant fields", async () => {
    const store = openTemp(await tempDir());
    const conversation = store.createConversation();
    const message = store.appendUserMessage(conversation.id, TRICKY);

    expect(message.content).toBe(TRICKY);
    expect(message.claimsJson).toBeNull();
    expect(message.coverage).toBeNull();
    expect(message.promptVersion).toBeNull();
    expect(message.declined).toBe(false);

    const [raw] = rawMessages(store.path, conversation.id);
    expect(raw).toEqual({
      role: "user",
      content: TRICKY,
      claims_json: null,
      declined: 0,
      coverage: null,
      prompt_version: null,
    });
  });

  it("round-trips assistant claims, coverage, and prompt version", async () => {
    const store = openTemp(await tempDir());
    const cases: Array<{ coverage: Coverage; answer: string; claims: Claim[] }> = [
      {
        coverage: "answered",
        answer: "Cold Food Storage Chart (FoodSafety.gov, 2023): Cooked chicken keeps for 3 to 4 days in the refrigerator.",
        claims: [CLAIM],
      },
      {
        coverage: "not_in_corpus",
        answer: "The guidance I searched does not cover that.",
        claims: [],
      },
      {
        coverage: "declined",
        answer: "I can't give calorie targets, weight recommendations, or medical advice.",
        claims: [],
      },
      {
        coverage: "clarify",
        answer: "I need a specific question before I can search the guidance.",
        claims: [],
      },
    ];

    for (const item of cases) {
      const thread = store.createConversation();
      store.appendAssistantMessage(
        thread.id,
        assistantInput(item.coverage, item.answer, item.claims),
      );
      const [stored] = store.listMessages(thread.id);
      expect(stored?.role).toBe("assistant");
      if (stored?.role !== "assistant") continue;
      expect(stored.content).toBe(item.answer);
      expect(stored.claims).toEqual(item.claims);
      expect(stored.coverage).toBe(item.coverage);
      expect(stored.declined).toBe(item.coverage === "declined");
      expect(stored.promptVersion).toBe("prompt-v1");

      const [raw] = rawMessages(store.path, thread.id);
      expect(raw?.coverage).toBe(item.coverage);
      expect(raw?.prompt_version).toBe("prompt-v1");
      expect(raw?.declined).toBe(item.coverage === "declined" ? 1 : 0);
      expect(JSON.parse(raw?.claims_json ?? "null")).toEqual(item.claims);
    }
  });

  it("rejects a role other than user or assistant", async () => {
    const store = openTemp(await tempDir());
    const conversation = store.createConversation();
    const db = new Database(store.path);
    try {
      expect(() =>
        db
          .prepare(
            `insert into messages (
               id, conversation_id, role, content, created_at
             ) values (?, ?, 'system', 'nope', ?)`,
          )
          .run("bad-role", conversation.id, new Date().toISOString()),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("lists each conversation's messages in insert order", async () => {
    const store = openTemp(await tempDir());
    const first = store.createConversation();
    const second = store.createConversation();

    store.appendUserMessage(first.id, "first user");
    store.appendUserMessage(second.id, "second user");
    store.appendAssistantMessage(
      first.id,
      assistantInput("answered", "first answer", [CLAIM]),
    );
    store.appendAssistantMessage(
      second.id,
      assistantInput("not_in_corpus", "second answer"),
    );

    expect(texts(store.listMessages(first.id))).toEqual([
      "first user",
      "first answer",
    ]);
    expect(texts(store.listMessages(second.id))).toEqual([
      "second user",
      "second answer",
    ]);
  });

  it("returns the older messages when fewer than 12 precede the newest", async () => {
    const store = openTemp(await tempDir());
    const conversation = store.createConversation();
    const ids: string[] = [];
    for (let index = 0; index < PRECEDING_MESSAGE_LIMIT; index += 1) {
      ids.push(store.appendUserMessage(conversation.id, `m${index}`).id);
    }

    const preceding = store.messagesPreceding(ids.at(-1) ?? "");
    expect(texts(preceding)).toEqual(
      Array.from({ length: PRECEDING_MESSAGE_LIMIT - 1 }, (_, index) => `m${index}`),
    );
    expect(preceding.some((message) => message.id === ids.at(-1))).toBe(false);
  });

  it("keeps the 12 messages immediately before the current one", async () => {
    const store = openTemp(await tempDir());
    const conversation = store.createConversation();
    const total = PRECEDING_MESSAGE_LIMIT + 2;
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      ids.push(store.appendUserMessage(conversation.id, `m${index}`).id);
    }

    const newest = ids.at(-1) ?? "";
    const preceding = store.messagesPreceding(newest);
    expect(texts(preceding)).toEqual(
      Array.from(
        { length: PRECEDING_MESSAGE_LIMIT },
        (_, index) => `m${index + 1}`,
      ),
    );
    expect(texts(preceding)).not.toContain("m0");
    expect(preceding.some((message) => message.id === newest)).toBe(false);
  });

  it("includes every predecessor when the current message is the 13th", async () => {
    const store = openTemp(await tempDir());
    const conversation = store.createConversation();
    const total = PRECEDING_MESSAGE_LIMIT + 1;
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      ids.push(store.appendUserMessage(conversation.id, `m${index}`).id);
    }

    const preceding = store.messagesPreceding(ids.at(-1) ?? "");
    expect(texts(preceding)).toEqual(
      Array.from({ length: PRECEDING_MESSAGE_LIMIT }, (_, index) => `m${index}`),
    );
    expect(texts(preceding)[0]).toBe("m0");
  });

  it("does not pull preceding messages from another conversation", async () => {
    const store = openTemp(await tempDir());
    const first = store.createConversation();
    const second = store.createConversation();
    store.appendUserMessage(first.id, "a0");
    store.appendUserMessage(second.id, "b0");
    const current = store.appendUserMessage(first.id, "a1");

    expect(texts(store.messagesPreceding(current.id))).toEqual(["a0"]);
  });

  it("rejects a message that names a missing conversation", async () => {
    const store = openTemp(await tempDir());
    expect(() => store.appendUserMessage("missing", "hello")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("keeps nutrition.db separate and opens the guidance index read-only", async () => {
    const directory = await tempDir();
    const guidancePath = join(directory, GUIDANCE_DB_NAME);
    const writable = new Database(guidancePath);
    writable.exec(`create table chunks (id text)`);
    writable.close();

    const store = openTemp(directory);
    expect(store.path).toBe(nutritionDbPath(directory));
    expect(store.path).not.toBe(guidancePath);

    const guidance = openGuidanceDatabase(guidancePath);
    try {
      expect(() =>
        guidance.prepare(`insert into chunks (id) values ('x')`).run(),
      ).toThrow(/readonly/);
    } finally {
      guidance.close();
    }
  });
});

describe("DELETE /api/conversations/:id", () => {
  it("returns 404 for an id that was never created", async () => {
    const store = openTemp(await tempDir());
    setConversationStore(store);

    const response = await DELETE(new Request("http://localhost/api/conversations/missing", { method: "DELETE" }), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown conversation" });
  });

  it("deletes one conversation and its messages and leaves the others", async () => {
    const directory = await tempDir();
    const path = nutritionDbPath(directory);
    const store = openConversationStore(path);
    stores.push(store);
    setConversationStore(store);

    const keep = store.createConversation();
    store.appendUserMessage(keep.id, "How long can cooked chicken stay in the fridge?");
    const remove = store.createConversation();
    store.appendUserMessage(remove.id, "What should I eat daily?");
    store.appendAssistantMessage(remove.id, assistantInput("clarify", "Which meal?", []));

    const response = await DELETE(
      new Request(`http://localhost/api/conversations/${remove.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: remove.id }) },
    );

    expect(response.status).toBe(204);
    expect(store.getConversation(remove.id)).toBeNull();
    expect(store.listMessages(remove.id)).toEqual([]);
    expect(store.getConversation(keep.id)?.id).toBe(keep.id);
    expect(store.listMessages(keep.id)).toHaveLength(1);
    expect(countConversations(path)).toBe(1);

    const missing = await GET(
      new Request(`http://localhost/api/conversations/${remove.id}`),
      { params: Promise.resolve({ id: remove.id }) },
    );
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/conversations/:id", () => {
  it("returns 404 for an id that was never created and writes nothing", async () => {
    const store = openTemp(await tempDir());
    setConversationStore(store);

    const response = await GET(new Request("http://localhost/api/conversations/missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown conversation" });
    expect(countConversations(store.path)).toBe(0);
  });

  it("returns the thread from nutrition.db after the store is reopened", async () => {
    const directory = await tempDir();
    const path = nutritionDbPath(directory);
    const first = openConversationStore(path);
    const conversation = first.createConversation();
    first.appendUserMessage(conversation.id, TRICKY);
    first.appendAssistantMessage(
      conversation.id,
      assistantInput(
        "answered",
        "Cold Food Storage Chart (FoodSafety.gov, 2023): Cooked chicken keeps for 3 to 4 days in the refrigerator.",
        [CLAIM],
      ),
    );
    const createdAt = conversation.createdAt;
    first.close();

    const second = openConversationStore(path);
    stores.push(second);
    setConversationStore(second);

    const response = await GET(
      new Request(`http://localhost/api/conversations/${conversation.id}`),
      { params: Promise.resolve({ id: conversation.id }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversationId).toBe(conversation.id);
    expect(body.createdAt).toBe(createdAt);
    expect(body.messages).toEqual([
      {
        id: expect.any(String),
        role: "user",
        content: TRICKY,
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        role: "assistant",
        answer:
          "Cold Food Storage Chart (FoodSafety.gov, 2023): Cooked chicken keeps for 3 to 4 days in the refrigerator.",
        claims: [CLAIM],
        declined: false,
        coverage: "answered",
        createdAt: expect.any(String),
      },
    ]);
  });
});
