/** JSON Schema document passed to a strict structured-output call. */
export type JsonSchema = Record<string, unknown>;

export type DraftClaim = {
  text: string;
  quote: string;
  chunkId: string;
};

export type GroundedDraft = {
  covered: boolean;
  claims: DraftClaim[];
};

export type Source = {
  documentName: string;
  publisher: string;
  year: number;
  url: string;
  sectionHeading: string;
};

export type Claim = {
  text: string;
  source: Source;
};

export type Coverage = "answered" | "not_in_corpus" | "declined" | "clarify";

export type ChatResponse = {
  conversationId: string;
  message: {
    id: string;
    role: "assistant";
    answer: string;
    claims: Claim[];
    declined: boolean;
    coverage: Coverage;
    createdAt: string;
  };
};

/** User turn as `GET /api/conversations/:id` returns it. */
export type ConversationUserMessage = {
  id: string;
  role: "user";
  content: string;
  createdAt: string;
};

/**
 * A reloaded thread. Assistant entries use the chat message shape so a
 * reload can bind the sources panel to `claims`.
 */
export type ConversationResponse = {
  conversationId: string;
  createdAt: string;
  messages: Array<ConversationUserMessage | ChatResponse["message"]>;
};

export type ChatRequest = {
  conversationId?: string;
  message: string;
};

export type RetrieveRequest = {
  query: string;
  documentId?: string;
  k?: number;
};

export type RetrievedChunk = {
  id: string;
  documentId: string;
  documentName: string;
  publisher: string;
  year: number;
  sourceUrl: string;
  sectionHeading: string;
  text: string;
  score: number;
};

export type ModelClient = {
  complete(input: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    schema: JsonSchema;
    schemaName: string;
  }): Promise<unknown>;
};

export type EmbeddingClient = {
  embed(texts: string[]): Promise<number[][]>;
};
