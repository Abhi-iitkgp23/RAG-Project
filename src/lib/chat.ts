import { join } from "node:path";
import { z } from "zod";
import { classifyInquiry, isArithmeticInquiry } from "./clarify";
import { CORPUS, documentFilter } from "./corpus";
import { notInCorpusAnswer, type SearchScope } from "./coverage";
import { PROFESSIONAL_REFUSAL } from "./decline";
import { GUIDANCE_DB_NAME } from "./embed";
import { ground } from "./ground";
import {
  completionTokenReserve,
  estimateRequestTokens,
  GPT_OSS_120B_LIMITS,
  LlmLimitError,
  usesGptOss120bLimits,
} from "./llmBudget";
import {
  createEmbeddingClient,
  chatModelFromEnv,
  createModelClient,
  ModelOutputError,
} from "./model";
import {
  GROUNDED_DRAFT_SCHEMA,
  GROUNDED_DRAFT_SCHEMA_NAME,
  loadSystemPrompt,
  PROMPT_VERSION,
} from "./prompt";
import { createRetriever, DEFAULT_K, MIN_SCORE, type Retriever } from "./retrieve";
import { rewriteQuery, REWRITE_HISTORY_LIMIT } from "./rewrite";
import { groundedDraftSchema } from "./schema";
import { allowDespiteDecline, classifyScope } from "./scope";
import {
  dataDirectory,
  PRECEDING_MESSAGE_LIMIT,
  resolveConversation,
  type ConversationStore,
  type StoredAssistantMessage,
  type StoredMessage,
} from "./store";
import type {
  ChatResponse,
  ModelClient,
  RetrievedChunk,
  RetrieveRequest,
} from "./types";
import {
  DAILY_LIMIT_MESSAGE,
  FORMAT_MISMATCH_MESSAGE,
  MESSAGE_REQUIRED,
  QUESTION_TOO_LONG_MESSAGE,
  RATE_LIMIT_MESSAGE,
  RETRY_MESSAGE,
  UNKNOWN_CONVERSATION,
} from "./copy";

export {
  FORMAT_MISMATCH_MESSAGE,
  MESSAGE_REQUIRED,
  RETRY_MESSAGE,
  UNKNOWN_CONVERSATION,
};

export { isArithmeticInquiry };

const requestSchema = z.strictObject({
  conversationId: z.string().optional(),
  message: z.string(),
});

export type ChatErrorBody = {
  error: string;
  conversationId?: string;
};

export type ChatHandlerResult = {
  status: number;
  body: ChatResponse | ChatErrorBody;
};

export type ChatDependencies = {
  store: ConversationStore;
  model: ModelClient;
  retrieve: (request: RetrieveRequest) => Promise<RetrievedChunk[]>;
  systemPrompt?: string;
  promptVersion?: string;
};

type ChatOverrides = {
  model?: ModelClient;
  retrieve?: (request: RetrieveRequest) => Promise<RetrievedChunk[]>;
};

let overrides: ChatOverrides | null = null;
let cachedRetriever: Retriever | undefined;

/** Tests point the route at doubles so `./data` and the live model stay unused. */
export function setChatDependencies(next: ChatOverrides | null): void {
  overrides = next;
  if (!next) cachedRetriever = undefined;
}

export function resolveChatDependencies(): Pick<
  ChatDependencies,
  "model" | "retrieve"
> {
  return {
    model: overrides?.model ?? createModelClient(),
    retrieve: overrides?.retrieve ?? retrieveFromIndex,
  };
}

/**
 * One user turn. The route calls this and does not contain prompt text,
 * SQL, or citation formatting. A failure after the user row is written
 * leaves that row and does not invent an assistant answer.
 */
export async function handleChatTurn(
  rawBody: unknown,
  deps: ChatDependencies,
): Promise<ChatHandlerResult> {
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: MESSAGE_REQUIRED } };
  }

  const message = parsed.data.message;
  if (message.trim() === "") {
    return { status: 400, body: { error: MESSAGE_REQUIRED } };
  }

  const conversation = resolveConversation(deps.store, parsed.data.conversationId);
  if (!conversation) {
    return { status: 404, body: { error: UNKNOWN_CONVERSATION } };
  }

  const user = deps.store.appendUserMessage(conversation.id, message);
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const systemPrompt = deps.systemPrompt ?? loadSystemPrompt();

  try {
    const preceding = deps.store.messagesPreceding(
      user.id,
      PRECEDING_MESSAGE_LIMIT,
    );
    const inquiry = classifyInquiry(message, {
      hasEarlierUserMessage: preceding.some((item) => item.role === "user"),
    });
    if (inquiry.outcome === "respond") {
      const stored = deps.store.appendAssistantMessage(conversation.id, {
        answer: inquiry.answer,
        claims: [],
        declined: false,
        coverage: "clarify",
        promptVersion,
      });
      return ok(conversation.id, stored);
    }

    const decision = await classifyScope(
      deps.model,
      message,
      preceding.map(toTurn),
    );
    if (
      decision.outcome === "decline" &&
      !allowDespiteDecline(message, decision.category)
    ) {
      const stored = deps.store.appendAssistantMessage(conversation.id, {
        answer: PROFESSIONAL_REFUSAL,
        claims: [],
        declined: true,
        coverage: "declined",
        promptVersion,
      });
      return ok(conversation.id, stored);
    }

    const recent = preceding.slice(-REWRITE_HISTORY_LIMIT);
    let query: string;
    try {
      query = await rewriteQuery(deps.model, message, recent.map(toTurn));
    } catch (error) {
      return failTurn(conversation.id, error);
    }

    const documentId = documentFilter(message);
    const scope: SearchScope = documentId ?? "all";
    const search = dietRetrievalQuery(message, query);
    let retrieved: RetrievedChunk[];
    try {
      retrieved = await deps.retrieve(
        documentId ? { query: search, documentId } : { query: search },
      );
    } catch (error) {
      return failTurn(conversation.id, error);
    }

    const chunks = retrieved
      .filter((chunk) => Number.isFinite(chunk.score) && chunk.score >= MIN_SCORE)
      .slice(0, DEFAULT_K);

    if (chunks.length === 0) {
      const stored = deps.store.appendAssistantMessage(conversation.id, {
        answer: notInCorpusAnswer(scope),
        claims: [],
        declined: false,
        coverage: "not_in_corpus",
        promptVersion,
      });
      return ok(conversation.id, stored);
    }

    const history = deps.store
      .listMessages(conversation.id)
      .filter((item) => item.id !== user.id);
    const fitted = fitGroundedContext(systemPrompt, message, scope, history, chunks);

    let rawDraft: unknown;
    try {
      rawDraft = await deps.model.complete({
        system: systemPrompt,
        messages: [
          ...fitted.turns,
          { role: "user", content: formatEvidence(message, scope, fitted.chunks) },
        ],
        schema: GROUNDED_DRAFT_SCHEMA,
        schemaName: GROUNDED_DRAFT_SCHEMA_NAME,
      });
    } catch (error) {
      if (error instanceof ModelOutputError) {
        return formatMismatch(conversation.id);
      }
      return failTurn(conversation.id, error);
    }

    const draft = groundedDraftSchema.safeParse(rawDraft);
    if (!draft.success) return formatMismatch(conversation.id);

    const grounded = ground(draft.data, chunks, scope);
    const stored = deps.store.appendAssistantMessage(conversation.id, {
      answer: grounded.answer,
      claims: grounded.claims,
      declined: grounded.declined,
      coverage: grounded.coverage,
      promptVersion,
    });
    return ok(conversation.id, stored);
  } catch (error) {
    return failTurn(conversation.id, error);
  }
}

/**
 * A general "what should this population eat" question. The embedding of
 * that wording lands on child and elderly tables. Adding the documents'
 * own terms pulls the balanced-diet passages into the top results.
 * Storage questions are left unchanged.
 */
const POPULATION_DIET =
  /\b(?:what|which)\b[^?.!]{0,48}\b(?:eat|eats|eating|diet|foods?)\b/i;

const STORAGE_QUESTION =
  /\b(?:fridge|freezer|refrigerat\w*|store|stored|storage|chill|defrost|days)\b/i;

/**
 * Fluid questions otherwise land on boiling, infant, or waste passages.
 * These are the documents' own words for the daily amount.
 */
const HYDRATION_QUESTION = /\b(?:waters?|fluids?|hydrat\w*|thirst|drinks?|drinking)\b/i;

/**
 * Dietary Guidelines for Indians has many oil sections, so a plain oil
 * question fills the top results with that document. These are the two
 * documents' own terms for the same topic.
 */
const OIL_GUIDANCE = /\b(?:oils?|fats?|spreads?)\b/i;

export function dietRetrievalQuery(message: string, rewritten: string): string {
  if (STORAGE_QUESTION.test(message)) return rewritten;
  if (OIL_GUIDANCE.test(message)) {
    return `${rewritten} unsaturated oils and spreads visible fats`;
  }
  if (HYDRATION_QUESTION.test(message) && !POPULATION_DIET.test(message)) {
    return `${rewritten} adequate water glasses of fluid beverages hydration`;
  }
  if (!POPULATION_DIET.test(message)) return rewritten;
  return `${rewritten} balanced diet food groups Eatwell Guide variety of foods`;
}

function retrieveFromIndex(request: RetrieveRequest): Promise<RetrievedChunk[]> {
  if (!cachedRetriever) {
    cachedRetriever = createRetriever({
      indexPath: join(dataDirectory(), GUIDANCE_DB_NAME),
      client: createEmbeddingClient(),
    });
  }
  return cachedRetriever.retrieve(request);
}

function toTurn(message: StoredMessage): {
  role: "user" | "assistant";
  content: string;
} {
  return { role: message.role, content: message.content };
}

/**
 * A grounded draft has to fit in the 8,000-token minute cap by itself.
 * Older turns are dropped first. Extra passages go next, lowest score last.
 */
function fitGroundedContext(
  systemPrompt: string,
  message: string,
  scope: SearchScope,
  history: readonly StoredMessage[],
  chunks: readonly RetrievedChunk[],
): {
  turns: { role: "user" | "assistant"; content: string }[];
  chunks: RetrievedChunk[];
} {
  const turns = history.map(toTurn);
  if (!usesGptOss120bLimits(chatModelFromEnv())) {
    return { turns, chunks: [...chunks] };
  }

  let keptTurns = turns;
  let keptChunks = [...chunks];
  const reserve = completionTokenReserve(GROUNDED_DRAFT_SCHEMA_NAME);
  const fits = () =>
    estimateRequestTokens(
      [
        { content: systemPrompt },
        ...keptTurns,
        { content: formatEvidence(message, scope, keptChunks) },
      ],
      GROUNDED_DRAFT_SCHEMA,
      reserve,
    ) <= GPT_OSS_120B_LIMITS.tokensPerMinute;

  while (!fits() && keptTurns.length > 0) keptTurns = keptTurns.slice(1);
  while (!fits() && keptChunks.length > 1) keptChunks = keptChunks.slice(0, -1);
  return { turns: keptTurns, chunks: keptChunks };
}

/**
 * The answer model sees the question, the search scope, and at most six
 * passages. The passage list has no URL. The server attaches that later.
 */
export function formatEvidence(
  message: string,
  scope: SearchScope,
  chunks: readonly RetrievedChunk[],
): string {
  const scopeLine =
    scope === "all" ? "all" : (CORPUS.find((document) => document.id === scope)?.name ?? scope);
  const passages = chunks.map((chunk, index) =>
    [
      `Passage ${index + 1}`,
      `id: ${chunk.id}`,
      `document: ${chunk.documentName}`,
      `publisher: ${chunk.publisher}`,
      `year: ${chunk.year}`,
      `section: ${chunk.sectionHeading}`,
      "text:",
      chunk.text,
    ].join("\n"),
  );
  return [
    `Search scope: ${scopeLine}`,
    "",
    "Question:",
    message,
    "",
    "Passages:",
    passages.join("\n\n"),
  ].join("\n");
}

function ok(
  conversationId: string,
  message: StoredAssistantMessage,
): ChatHandlerResult {
  const body: ChatResponse = {
    conversationId,
    message: {
      id: message.id,
      role: "assistant",
      answer: message.content,
      claims: message.claims,
      declined: message.declined,
      coverage: message.coverage,
      createdAt: message.createdAt,
    },
  };
  return { status: 200, body };
}

function formatMismatch(conversationId: string): ChatHandlerResult {
  return {
    status: 422,
    body: { error: FORMAT_MISMATCH_MESSAGE, conversationId },
  };
}

function failTurn(conversationId: string, error: unknown): ChatHandlerResult {
  if (error instanceof LlmLimitError) {
    console.error(error);
    const errorText =
      error.reason === "day"
        ? DAILY_LIMIT_MESSAGE
        : error.reason === "too_large"
          ? QUESTION_TOO_LONG_MESSAGE
          : RATE_LIMIT_MESSAGE;
    return {
      status: 429,
      body: { error: errorText, conversationId },
    };
  }
  console.error(error);
  return retry(conversationId);
}

function retry(conversationId: string): ChatHandlerResult {
  return {
    status: 500,
    body: { error: RETRY_MESSAGE, conversationId },
  };
}
