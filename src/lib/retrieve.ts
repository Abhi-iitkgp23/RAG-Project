import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { float32ToVector } from "./embed";
import { embedQuery, embeddingDimensionsFromEnv } from "./model";
import type { EmbeddingClient, RetrieveRequest, RetrievedChunk } from "./types";

/** Chunks below this cosine are not evidence. */
export const MIN_SCORE = 0.3;

/** How many chunks a search returns when the request omits `k`. */
export const DEFAULT_K = 6;

/** A missing or unreadable `guidance.db`. The chat route maps this to 500. */
export class GuidanceIndexError extends Error {
  readonly indexPath: string;

  constructor(indexPath: string, message: string) {
    super(`${indexPath}: ${message}`);
    this.name = "GuidanceIndexError";
    this.indexPath = indexPath;
  }
}

/** One indexed passage kept in memory for the life of the process. */
export type IndexedChunk = {
  id: string;
  documentId: string;
  documentName: string;
  publisher: string;
  year: number;
  sourceUrl: string;
  sectionHeading: string;
  text: string;
  embedding: number[];
};

export type Retriever = {
  retrieve(request: RetrieveRequest): Promise<RetrievedChunk[]>;
};

type ScoredChunk = {
  chunk: IndexedChunk;
  score: number;
};

type ChunkRow = {
  id: string;
  document_id: string;
  document_name: string;
  publisher: string;
  year: number;
  source_url: string;
  section_heading: string;
  text: string;
  embedding: Buffer | Uint8Array | null;
};

/**
 * Exact cosine similarity. A zero vector scores 0 so a bad embedding
 * cannot clear `MIN_SCORE` as NaN.
 */
export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error(
      `cosine requires equal non-empty vectors (${left.length} and ${right.length})`,
    );
  }

  let dot = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftSq += a * a;
    rightSq += b * b;
  }
  if (leftSq === 0 || rightSq === 0) return 0;
  const score = dot / (Math.sqrt(leftSq) * Math.sqrt(rightSq));
  return Number.isFinite(score) ? score : 0;
}

/**
 * Score every chunk, then apply `documentId`.
 * The filter does not change the query embedding or `k`: it drops other
 * documents after scoring, and the same `k` is taken from what remains.
 * Hits below `MIN_SCORE` are discarded before the result is returned.
 */
export function rankChunks(
  chunks: readonly IndexedChunk[],
  queryEmbedding: readonly number[],
  request: Pick<RetrieveRequest, "documentId" | "k"> = {},
): RetrievedChunk[] {
  const k = resolveK(request.k);
  const scored: ScoredChunk[] = chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));
  const scoped = request.documentId
    ? scored.filter((hit) => hit.chunk.documentId === request.documentId)
    : scored;

  return scoped
    .filter((hit) => Number.isFinite(hit.score) && hit.score >= MIN_SCORE)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.chunk.id.localeCompare(right.chunk.id),
    )
    .slice(0, k)
    .map((hit) => toRetrieved(hit.chunk, hit.score));
}

/**
 * Open `guidance.db` the way the app reads it. The connection is read-only.
 * Conversation rows go to `nutrition.db`, never this file.
 */
export function openGuidanceDatabase(indexPath: string): Database.Database {
  return new Database(indexPath, { readonly: true, fileMustExist: true });
}

/**
 * Read every chunk from `guidance.db`. Throws `GuidanceIndexError` when the
 * file is missing or is not a readable index.
 */
export function loadGuidanceIndex(indexPath: string): IndexedChunk[] {
  if (!existsSync(indexPath)) {
    throw new GuidanceIndexError(indexPath, "guidance index is missing");
  }

  let db: Database.Database;
  try {
    db = openGuidanceDatabase(indexPath);
  } catch (error) {
    throw new GuidanceIndexError(
      indexPath,
      `guidance index is unreadable (${errorMessage(error)})`,
    );
  }

  try {
    const rows = db
      .prepare(
        `select id, document_id, document_name, publisher, year, source_url,
                section_heading, text, embedding
         from chunks
         order by id`,
      )
      .all() as ChunkRow[];

    return rows.map((row) => {
      if (!row.embedding) {
        throw new GuidanceIndexError(
          indexPath,
          `chunk ${row.id} embedding is missing`,
        );
      }
      let embedding: number[];
      try {
        const blob = Buffer.isBuffer(row.embedding)
          ? row.embedding
          : Buffer.from(row.embedding);
        embedding = float32ToVector(blob);
      } catch (error) {
        throw new GuidanceIndexError(
          indexPath,
          `chunk ${row.id} embedding is unreadable (${errorMessage(error)})`,
        );
      }
      if (embedding.length !== embeddingDimensionsFromEnv()) {
        throw new GuidanceIndexError(
          indexPath,
          `chunk ${row.id} embedding has ${embedding.length} dimensions`,
        );
      }
      return {
        id: row.id,
        documentId: row.document_id,
        documentName: row.document_name,
        publisher: row.publisher,
        year: row.year,
        sourceUrl: row.source_url,
        sectionHeading: row.section_heading,
        text: row.text,
        embedding,
      };
    });
  } catch (error) {
    if (error instanceof GuidanceIndexError) throw error;
    throw new GuidanceIndexError(
      indexPath,
      `guidance index is unreadable (${errorMessage(error)})`,
    );
  } finally {
    db.close();
  }
}

/**
 * Load the index once. Later searches score that snapshot and embed only
 * the query string, with no section-heading prefix.
 */
export function createRetriever(options: {
  indexPath: string;
  client: EmbeddingClient;
}): Retriever {
  const chunks = loadGuidanceIndex(options.indexPath);
  return {
    async retrieve(request) {
      const queryEmbedding = await embedQuery(options.client, request.query);
      return rankChunks(chunks, queryEmbedding, request);
    },
  };
}

function resolveK(k: number | undefined): number {
  const resolved = k ?? DEFAULT_K;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error("k must be a positive integer");
  }
  return resolved;
}

function toRetrieved(chunk: IndexedChunk, score: number): RetrievedChunk {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    publisher: chunk.publisher,
    year: chunk.year,
    sourceUrl: chunk.sourceUrl,
    sectionHeading: chunk.sectionHeading,
    text: chunk.text,
    score,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
