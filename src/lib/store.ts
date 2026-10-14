import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { boundClaimSchema } from "./schema";
import type {
  Claim,
  ConversationResponse,
  Coverage,
} from "./types";

/** `nutrition.db` file name inside `DATA_DIR`. Separate from `guidance.db`. */
export const NUTRITION_DB_NAME = "nutrition.db";

/**
 * How many stored messages the scope gate sees before the current user
 * message. The chat route passes this window plus that current message.
 */
export const PRECEDING_MESSAGE_LIMIT = 12;

const SCHEMA = `
create table if not exists conversations (
  id text primary key,
  created_at text not null
);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  claims_json text,
  declined integer not null default 0,
  coverage text,
  prompt_version text,
  created_at text not null
);
`;

export type Conversation = {
  id: string;
  createdAt: string;
};

export type StoredUserMessage = {
  id: string;
  conversationId: string;
  role: "user";
  content: string;
  claimsJson: null;
  declined: false;
  coverage: null;
  promptVersion: null;
  createdAt: string;
};

export type StoredAssistantMessage = {
  id: string;
  conversationId: string;
  role: "assistant";
  content: string;
  claims: Claim[];
  declined: boolean;
  coverage: Coverage;
  promptVersion: string;
  createdAt: string;
};

export type StoredMessage = StoredUserMessage | StoredAssistantMessage;

export type AssistantMessageInput = {
  answer: string;
  claims: Claim[];
  declined: boolean;
  coverage: Coverage;
  promptVersion: string;
};

export type ConversationStore = {
  readonly path: string;
  createConversation(): Conversation;
  getConversation(id: string): Conversation | null;
  appendUserMessage(conversationId: string, content: string): StoredUserMessage;
  appendAssistantMessage(
    conversationId: string,
    message: AssistantMessageInput,
  ): StoredAssistantMessage;
  listMessages(conversationId: string): StoredMessage[];
  messagesPreceding(messageId: string, limit?: number): StoredMessage[];
  /** Removes one conversation and its messages. False when the id is unknown. */
  deleteConversation(id: string): boolean;
  close(): void;
};

type ConversationRow = {
  id: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  claims_json: string | null;
  declined: number;
  coverage: string | null;
  prompt_version: string | null;
  created_at: string;
};

const COVERAGES: readonly Coverage[] = [
  "answered",
  "not_in_corpus",
  "declined",
  "clarify",
];

let active: ConversationStore | undefined;

/** Directory for both sqlite files. Empty `DATA_DIR` uses `./data`. */
export function dataDirectory(): string {
  const configured = process.env.DATA_DIR;
  if (configured === undefined || configured.trim() === "") return "./data";
  return configured;
}

export function nutritionDbPath(dataDir = dataDirectory()): string {
  return join(dataDir, NUTRITION_DB_NAME);
}

/**
 * Open `DATA_DIR/nutrition.db`, creating the file and tables when absent.
 * Re-opening the same path reads the rows already stored there.
 */
export function openConversationStore(dbPath: string): ConversationStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const insertConversation = db.prepare(
    `insert into conversations (id, created_at) values (?, ?)`,
  );
  const selectConversation = db.prepare(
    `select id, created_at from conversations where id = ?`,
  );
  const insertUser = db.prepare(
    `insert into messages (
       id, conversation_id, role, content, claims_json, declined, coverage,
       prompt_version, created_at
     ) values (?, ?, 'user', ?, null, 0, null, null, ?)`,
  );
  const insertAssistant = db.prepare(
    `insert into messages (
       id, conversation_id, role, content, claims_json, declined, coverage,
       prompt_version, created_at
     ) values (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
  );
  const selectMessages = db.prepare(
    `select id, conversation_id, role, content, claims_json, declined, coverage,
            prompt_version, created_at
     from messages
     where conversation_id = ?
     order by rowid`,
  );
  const selectMessage = db.prepare(`select id from messages where id = ?`);
  const selectPreceding = db.prepare(
    `select id, conversation_id, role, content, claims_json, declined, coverage,
            prompt_version, created_at
     from messages
     where conversation_id = (select conversation_id from messages where id = ?)
       and rowid < (select rowid from messages where id = ?)
     order by rowid desc
     limit ?`,
  );
  const deleteMessages = db.prepare(
    `delete from messages where conversation_id = ?`,
  );
  const deleteConversationRow = db.prepare(
    `delete from conversations where id = ?`,
  );
  const removeConversation = db.transaction((id: string) => {
    deleteMessages.run(id);
    deleteConversationRow.run(id);
  });

  let closed = false;

  return {
    path: dbPath,
    createConversation() {
      const conversation: Conversation = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      insertConversation.run(conversation.id, conversation.createdAt);
      return conversation;
    },
    getConversation(id) {
      const row = selectConversation.get(id) as ConversationRow | undefined;
      if (!row) return null;
      return { id: row.id, createdAt: row.created_at };
    },
    appendUserMessage(conversationId, content) {
      const message: StoredUserMessage = {
        id: randomUUID(),
        conversationId,
        role: "user",
        content,
        claimsJson: null,
        declined: false,
        coverage: null,
        promptVersion: null,
        createdAt: new Date().toISOString(),
      };
      insertUser.run(message.id, conversationId, content, message.createdAt);
      return message;
    },
    appendAssistantMessage(conversationId, input) {
      const message = assistantRow(conversationId, input);
      insertAssistant.run(
        message.id,
        conversationId,
        message.content,
        JSON.stringify(message.claims),
        message.declined ? 1 : 0,
        message.coverage,
        message.promptVersion,
        message.createdAt,
      );
      return message;
    },
    listMessages(conversationId) {
      const rows = selectMessages.all(conversationId) as MessageRow[];
      return rows.map(mapMessageRow);
    },
    deleteConversation(id) {
      if (!selectConversation.get(id)) return false;
      removeConversation(id);
      return true;
    },
    messagesPreceding(messageId, limit = PRECEDING_MESSAGE_LIMIT) {
      const resolved = resolveLimit(limit);
      const existing = selectMessage.get(messageId) as { id: string } | undefined;
      if (!existing) throw new Error(`unknown message ${messageId}`);
      const rows = selectPreceding.all(messageId, messageId, resolved) as MessageRow[];
      return rows.reverse().map(mapMessageRow);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * The store the app routes use. Tests point this at a temporary file so
 * `./data/nutrition.db` stays untouched.
 */
export function getConversationStore(): ConversationStore {
  if (!active) active = openConversationStore(nutritionDbPath());
  return active;
}

export function setConversationStore(store: ConversationStore | null): void {
  active = store ?? undefined;
}

/**
 * An omitted id creates a conversation. `""` and any unknown id return null
 * and do not insert a row. The chat route maps null to 404.
 */
export function resolveConversation(
  store: ConversationStore,
  conversationId: string | undefined,
): Conversation | null {
  if (conversationId === undefined) return store.createConversation();
  return store.getConversation(conversationId);
}

/** Thread payload for `GET /api/conversations/:id`. */
export function conversationResponse(
  store: ConversationStore,
  conversation: Conversation,
): ConversationResponse {
  return {
    conversationId: conversation.id,
    createdAt: conversation.createdAt,
    messages: store.listMessages(conversation.id).map(toThreadMessage),
  };
}

function assistantRow(
  conversationId: string,
  input: AssistantMessageInput,
): StoredAssistantMessage {
  if (!COVERAGES.includes(input.coverage)) {
    throw new Error("coverage must be answered, not_in_corpus, declined, or clarify");
  }
  if (input.promptVersion.trim() === "") {
    throw new Error("assistant messages require a prompt version");
  }
  const declined = input.coverage === "declined";
  if (input.declined !== declined) {
    throw new Error("declined is true only when coverage is declined");
  }
  return {
    id: randomUUID(),
    conversationId,
    role: "assistant",
    content: input.answer,
    claims: z.array(boundClaimSchema).parse(input.claims),
    declined,
    coverage: input.coverage,
    promptVersion: input.promptVersion,
    createdAt: new Date().toISOString(),
  };
}

function toThreadMessage(
  message: StoredMessage,
): ConversationResponse["messages"][number] {
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      content: message.content,
      createdAt: message.createdAt,
    };
  }
  return {
    id: message.id,
    role: "assistant",
    answer: message.content,
    claims: message.claims,
    declined: message.declined,
    coverage: message.coverage,
    createdAt: message.createdAt,
  };
}

function mapMessageRow(row: MessageRow): StoredMessage {
  if (row.role === "user") {
    if (
      row.claims_json !== null ||
      row.coverage !== null ||
      row.prompt_version !== null ||
      row.declined !== 0
    ) {
      throw new Error(`user message ${row.id} has assistant fields set`);
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: "user",
      content: row.content,
      claimsJson: null,
      declined: false,
      coverage: null,
      promptVersion: null,
      createdAt: row.created_at,
    };
  }

  if (row.role !== "assistant") {
    throw new Error(`message ${row.id} has role ${row.role}`);
  }
  if (row.claims_json === null) {
    throw new Error(`assistant message ${row.id} is missing claims_json`);
  }
  if (row.prompt_version === null || row.prompt_version.trim() === "") {
    throw new Error(`assistant message ${row.id} is missing a prompt version`);
  }
  if (!isCoverage(row.coverage)) {
    throw new Error(`assistant message ${row.id} has coverage ${String(row.coverage)}`);
  }
  const declined = row.declined !== 0;
  if (declined !== (row.coverage === "declined")) {
    throw new Error(
      `assistant message ${row.id} declined flag does not match coverage`,
    );
  }

  let claims: Claim[];
  try {
    claims = z.array(boundClaimSchema).parse(JSON.parse(row.claims_json));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`assistant message ${row.id} claims_json is unreadable (${detail})`);
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: "assistant",
    content: row.content,
    claims,
    declined,
    coverage: row.coverage,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

function isCoverage(value: string | null): value is Coverage {
  return (
    value === "answered" ||
    value === "not_in_corpus" ||
    value === "declined" ||
    value === "clarify"
  );
}

function resolveLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  return limit;
}
