import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GuidanceChunk } from "./chunk";
import { FETCH_JSON_NAME, rawDirectory, type FetchRecord } from "./fetchCorpus";
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  batchEmbeddingInputs,
  createEmbeddingClient,
  estimateEmbeddingTokens,
  type EmbeddingBatchLimits,
} from "./model";
import type { EmbeddingClient } from "./types";

/** `guidance.db` file name inside `DATA_DIR`. */
export const GUIDANCE_DB_NAME = "guidance.db";

const SCHEMA = `
create table documents (
  id text primary key,
  name text not null,
  publisher text not null,
  year integer not null,
  source_url text not null,
  retrieved_at text not null,
  content_hash text not null
);

create table chunks (
  id text primary key,
  document_id text not null references documents(id),
  document_name text not null,
  publisher text not null,
  year integer not null,
  source_url text not null,
  retrieved_at text not null,
  section_heading text not null,
  unit_kind text not null,
  text text not null,
  embedding blob not null
);
`;

export type GuidanceIndexResult = {
  reused: number;
  embedded: number;
  batches: number;
  counts: Record<string, number>;
};

export type WriteGuidanceIndexOptions = {
  chunks: readonly GuidanceChunk[];
  contentHashes: ReadonlyMap<string, string>;
  indexPath: string;
  client: EmbeddingClient;
  limits?: EmbeddingBatchLimits;
  log?: (line: string) => void;
};

type StoredVector = {
  contentHash: string;
  sectionHeading: string;
  text: string;
  embedding: Buffer;
};

type DocumentRow = {
  id: string;
  name: string;
  publisher: string;
  year: number;
  sourceUrl: string;
  retrievedAt: string;
  contentHash: string;
};

/**
 * The string sent to the embedding model for a chunk.
 * The stored passage stays `text`; this prefix is not written to that column.
 */
export function embeddingInput(sectionHeading: string, text: string): string {
  return `${sectionHeading}\n\n${text}`;
}

export function vectorToFloat32(values: readonly number[]): Buffer {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingDimensionError(values.length);
  }
  const buffer = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index]!, index * 4);
  }
  return buffer;
}

export function float32ToVector(blob: Buffer): number[] {
  if (blob.length % 4 !== 0) {
    throw new Error(
      `embedding blob length ${blob.length} is not a multiple of 4`,
    );
  }
  const values = new Array<number>(blob.length / 4);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = blob.readFloatLE(index * 4);
  }
  return values;
}

/**
 * Embed chunks whose document hash or heading-plus-text input changed,
 * then replace `guidance.db`. A failed embed deletes its temp file and
 * leaves the previous index in place.
 */
export async function writeGuidanceIndex(
  options: WriteGuidanceIndexOptions,
): Promise<GuidanceIndexResult> {
  const { chunks, client } = options;
  if (chunks.length === 0) {
    throw new Error("no chunks to embed");
  }
  assertUniqueIds(chunks);
  const documents = documentRows(chunks, options.contentHashes);
  const counts = countChunks(chunks);
  const previous = loadReusableVectors(options.indexPath);
  const encoded = new Map<string, Buffer>();
  const pending: GuidanceChunk[] = [];

  for (const chunk of chunks) {
    const contentHash = options.contentHashes.get(chunk.documentId);
    if (!contentHash) {
      throw new Error(`missing content hash for ${chunk.documentId}`);
    }
    const reused = reusableEmbedding(previous.get(chunk.id), chunk, contentHash);
    if (reused) encoded.set(chunk.id, reused);
    else pending.push(chunk);
  }

  const groups =
    pending.length === 0
      ? []
      : batchEmbeddingInputs(
          pending.map((chunk) =>
            embeddingInput(chunk.sectionHeading, chunk.text),
          ),
          options.limits,
        );

  const batchLogs: string[] = [];
  let offset = 0;
  for (const group of groups) {
    const vectors = await client.embed(group);
    if (vectors.length !== group.length) {
      throw new Error(
        `embedding response has ${vectors.length} vectors; expected ${group.length}`,
      );
    }
    for (let index = 0; index < group.length; index += 1) {
      const chunk = pending[offset + index];
      if (!chunk) {
        throw new Error("embedding batch is longer than the pending chunks");
      }
      encoded.set(chunk.id, vectorToFloat32(vectors[index]!));
    }
    offset += group.length;
    const tokens = group.reduce(
      (sum, text) => sum + estimateEmbeddingTokens(text),
      0,
    );
    batchLogs.push(`embed batch inputs=${group.length} tokens≈${tokens}`);
  }

  await mkdir(dirname(options.indexPath), { recursive: true });
  await replaceIndex(options.indexPath, (tempPath) => {
    writeDatabase(tempPath, documents, chunks, encoded);
  });

  for (const line of batchLogs) options.log?.(line);
  if (groups.length === 0) {
    options.log?.(
      `embed skipped: content hash and embedding input unchanged (${chunks.length} chunks)`,
    );
  }
  options.log?.(
    `embed reused=${encoded.size - pending.length} embedded=${pending.length} batches=${groups.length}`,
  );
  for (const [id, count] of counts) {
    options.log?.(`${id} chunks=${count}`);
  }

  return {
    reused: encoded.size - pending.length,
    embedded: pending.length,
    batches: groups.length,
    counts: Object.fromEntries(counts),
  };
}

/**
 * Read `DATA_DIR/chunks/chunk.json` and the raw content hashes, then write
 * `DATA_DIR/guidance.db`.
 */
export async function embedGuidanceIndex(options: {
  dataDir: string;
  client?: EmbeddingClient;
  limits?: EmbeddingBatchLimits;
  log?: (line: string) => void;
}): Promise<GuidanceIndexResult> {
  const chunks = await loadChunkFile(
    join(options.dataDir, "chunks", "chunk.json"),
  );
  const contentHashes = await readContentHashes(
    options.dataDir,
    [...new Set(chunks.map((chunk) => chunk.documentId))],
  );
  return writeGuidanceIndex({
    chunks,
    contentHashes,
    indexPath: join(options.dataDir, GUIDANCE_DB_NAME),
    client: options.client ?? createEmbeddingClient(),
    limits: options.limits,
    log: options.log,
  });
}

export async function loadChunkFile(filePath: string): Promise<GuidanceChunk[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`chunk file not readable: ${filePath} (${message})`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("documents" in parsed) ||
    !Array.isArray(parsed.documents)
  ) {
    throw new Error(`chunk file ${filePath} is missing a documents array`);
  }

  const chunks: GuidanceChunk[] = [];
  for (const document of parsed.documents) {
    if (
      !document ||
      typeof document !== "object" ||
      !("chunks" in document) ||
      !Array.isArray(document.chunks)
    ) {
      throw new Error(`chunk file ${filePath} has a document without chunks`);
    }
    for (const chunk of document.chunks) {
      chunks.push(assertChunk(chunk));
    }
  }
  if (chunks.length === 0) {
    throw new Error(`chunk file ${filePath} has no chunks`);
  }
  return chunks;
}

export async function readContentHashes(
  dataDir: string,
  documentIds: readonly string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const id of documentIds) {
    if (hashes.has(id)) continue;
    const filePath = join(rawDirectory(dataDir, id), FETCH_JSON_NAME);
    let record: Partial<FetchRecord>;
    try {
      record = JSON.parse(await readFile(filePath, "utf8")) as Partial<FetchRecord>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${id}: content hash not readable (${message})`);
    }
    if (typeof record.contentHash !== "string" || record.contentHash === "") {
      throw new Error(`${id}: content hash missing`);
    }
    hashes.set(id, record.contentHash);
  }
  return hashes;
}

function assertUniqueIds(chunks: readonly GuidanceChunk[]): void {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) throw new Error(`duplicate chunk id ${chunk.id}`);
    seen.add(chunk.id);
  }
}

function documentRows(
  chunks: readonly GuidanceChunk[],
  contentHashes: ReadonlyMap<string, string>,
): DocumentRow[] {
  const rows: DocumentRow[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.documentId)) continue;
    seen.add(chunk.documentId);
    const contentHash = contentHashes.get(chunk.documentId);
    if (!contentHash) {
      throw new Error(`missing content hash for ${chunk.documentId}`);
    }
    rows.push({
      id: chunk.documentId,
      name: chunk.documentName,
      publisher: chunk.publisher,
      year: chunk.year,
      sourceUrl: chunk.sourceUrl,
      retrievedAt: chunk.retrievedAt,
      contentHash,
    });
  }
  return rows;
}

function countChunks(chunks: readonly GuidanceChunk[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    counts.set(chunk.documentId, (counts.get(chunk.documentId) ?? 0) + 1);
  }
  return counts;
}

function reusableEmbedding(
  stored: StoredVector | undefined,
  chunk: GuidanceChunk,
  contentHash: string,
): Buffer | null {
  if (!stored) return null;
  if (stored.contentHash !== contentHash) return null;
  if (
    embeddingInput(stored.sectionHeading, stored.text) !==
    embeddingInput(chunk.sectionHeading, chunk.text)
  ) {
    return null;
  }
  if (stored.embedding.length !== EMBEDDING_DIMENSIONS * 4) return null;
  return Buffer.from(stored.embedding);
}

function loadReusableVectors(indexPath: string): Map<string, StoredVector> {
  if (!existsSync(indexPath)) return new Map();

  let db: Database.Database;
  try {
    db = new Database(indexPath, { readonly: true, fileMustExist: true });
  } catch {
    return new Map();
  }

  try {
    const rows = db
      .prepare(
        `select c.id, c.section_heading, c.text, c.embedding, d.content_hash
         from chunks c
         join documents d on d.id = c.document_id`,
      )
      .all() as Array<{
      id: string;
      section_heading: string;
      text: string;
      embedding: Buffer | Uint8Array;
      content_hash: string;
    }>;

    const stored = new Map<string, StoredVector>();
    for (const row of rows) {
      stored.set(row.id, {
        contentHash: row.content_hash,
        sectionHeading: row.section_heading,
        text: row.text,
        embedding: asBuffer(row.embedding),
      });
    }
    return stored;
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

function writeDatabase(
  tempPath: string,
  documents: readonly DocumentRow[],
  chunks: readonly GuidanceChunk[],
  embeddings: ReadonlyMap<string, Buffer>,
): void {
  const db = new Database(tempPath);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    const insertDocument = db.prepare(
      `insert into documents (
         id, name, publisher, year, source_url, retrieved_at, content_hash
       ) values (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChunk = db.prepare(
      `insert into chunks (
         id, document_id, document_name, publisher, year, source_url, retrieved_at,
         section_heading, unit_kind, text, embedding
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = db.transaction(() => {
      for (const document of documents) {
        insertDocument.run(
          document.id,
          document.name,
          document.publisher,
          document.year,
          document.sourceUrl,
          document.retrievedAt,
          document.contentHash,
        );
      }
      for (const chunk of chunks) {
        const embedding = embeddings.get(chunk.id);
        if (!embedding) throw new Error(`missing embedding for ${chunk.id}`);
        insertChunk.run(
          chunk.id,
          chunk.documentId,
          chunk.documentName,
          chunk.publisher,
          chunk.year,
          chunk.sourceUrl,
          chunk.retrievedAt,
          chunk.sectionHeading,
          chunk.unitKind,
          chunk.text,
          embedding,
        );
      }
    });
    write();
  } finally {
    db.close();
  }
}

async function replaceIndex(
  indexPath: string,
  write: (tempPath: string) => void,
): Promise<void> {
  const tempPath = `${indexPath}.${process.pid}.tmp`;
  await removeTemp(tempPath);
  try {
    write(tempPath);
    await rename(tempPath, indexPath);
  } catch (error) {
    await removeTemp(tempPath);
    throw error;
  }
}

async function removeTemp(tempPath: string): Promise<void> {
  await Promise.all(
    [tempPath, `${tempPath}-journal`, `${tempPath}-wal`, `${tempPath}-shm`].map(
      (file) => rm(file, { force: true }),
    ),
  );
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function assertChunk(value: unknown): GuidanceChunk {
  if (!value || typeof value !== "object") {
    throw new Error("chunk is not an object");
  }
  const chunk = value as Partial<GuidanceChunk>;
  const required = [
    "id",
    "documentId",
    "documentName",
    "publisher",
    "sourceUrl",
    "retrievedAt",
    "sectionHeading",
    "text",
    "unitKind",
  ] as const;
  for (const key of required) {
    if (typeof chunk[key] !== "string" || chunk[key] === "") {
      throw new Error(`chunk ${chunk.id ?? "?"} is missing ${key}`);
    }
  }
  if (typeof chunk.year !== "number") {
    throw new Error(`chunk ${chunk.id} is missing year`);
  }
  return chunk as GuidanceChunk;
}
