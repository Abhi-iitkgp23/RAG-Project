import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildChunks, type GuidanceChunk } from "./chunk";
import type { CorpusDocument } from "./corpus";
import { FETCH_JSON_NAME, rawDirectory, type FetchRecord } from "./fetchCorpus";
import { parseCorpusDocument } from "./parse";
import type { ParsedDocument } from "./parsedDocument";

/**
 * A PDF text layer below this is near-empty. Ingest records it and stops
 * before embedding. The Eatwell booklet's accepted extract is far above this.
 */
export const NEAR_EMPTY_PDF_CHARACTERS = 1_000;

const COUNTS_START = "<!-- counts";
const COUNTS_END = "-->";

export class ThinExtractError extends Error {
  readonly documentIds: string[];

  constructor(documentIds: string[]) {
    super(
      `${documentIds.join(", ")}: text layer looks thin. Recorded before embedding; the index was not replaced.`,
    );
    this.name = "ThinExtractError";
    this.documentIds = documentIds;
  }
}

export type DocumentChunkStats = {
  documentId: string;
  name: string;
  form: CorpusDocument["form"];
  characters: number;
  headingCount: number;
  tableCount: number;
  chunkCount: number;
  paragraphSplits: number;
  rowSplits: number;
};

export type PrepareChunkResult = {
  chunks: GuidanceChunk[];
  stats: DocumentChunkStats[];
  recordUpdated: boolean;
};

export type ParseDocument = (
  bytes: Uint8Array,
  document: CorpusDocument,
) => Promise<ParsedDocument>;

/**
 * Parse and chunk the raw files already on disk, write `chunks/chunk.json`,
 * and rewrite `docs/ingest-record.md` when those counts change.
 * A thin PDF text layer updates the record and throws before `chunk.json`
 * or `guidance.db` is replaced.
 */
export async function prepareChunkCorpus(options: {
  dataDir: string;
  documents: readonly CorpusDocument[];
  recordPath: string;
  now?: () => Date;
  log?: (line: string) => void;
  parseDocument?: ParseDocument;
}): Promise<PrepareChunkResult> {
  if (options.documents.length === 0) {
    throw new Error("no documents to chunk");
  }
  const parseDocument = options.parseDocument ?? parseCorpusDocument;
  const log = options.log ?? (() => {});
  const built = [];

  for (const document of options.documents) {
    const bodyPath = join(rawDirectory(options.dataDir, document.id), "body");
    const fetchPath = join(
      rawDirectory(options.dataDir, document.id),
      FETCH_JSON_NAME,
    );
    const [bytes, record] = await Promise.all([
      readRawBody(bodyPath, document.id),
      readFetchRecord(fetchPath, document.id),
    ]);
    const parsed = await parseDocument(bytes, document);
    if (parsed.documentId !== document.id) {
      throw new Error(
        `${document.id}: parser returned document ${parsed.documentId}`,
      );
    }
    const chunks = buildChunks(parsed, {
      id: document.id,
      name: document.name,
      publisher: document.publisher,
      year: document.year,
      sourceUrl: document.sourceUrl,
      retrievedAt: record.retrievedAt,
    });
    built.push({ document, parsed, chunks });
  }

  const stats = built.map(({ document, parsed, chunks }) => ({
    documentId: document.id,
    name: document.name,
    form: document.form,
    characters: parsed.characters,
    headingCount: parsed.headingCount,
    tableCount: parsed.tableCount,
    chunkCount: chunks.chunks.length,
    paragraphSplits: chunks.paragraphSplits,
    rowSplits: chunks.rowSplits,
  }));
  for (const stat of stats) log(statisticLine(stat));

  const thin = stats.filter(
    (stat) =>
      stat.form === "pdf" && stat.characters < NEAR_EMPTY_PDF_CHARACTERS,
  );
  const date = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  if (thin.length > 0) {
    await writeRecord(options.recordPath, renderIngestRecord(stats, date));
    log(`ingest record updated ${options.recordPath}`);
    throw new ThinExtractError(thin.map((stat) => stat.documentId));
  }

  const chunks = built.flatMap((item) => item.chunks.chunks);
  if (chunks.length === 0) {
    throw new Error("parse produced no chunks");
  }
  await writeTextAtomic(
    join(options.dataDir, "chunks", "chunk.json"),
    `${JSON.stringify(
      {
        documents: built.map((item) => ({
          documentId: item.document.id,
          name: item.document.name,
          chunkCount: item.chunks.chunks.length,
          chunks: item.chunks.chunks,
        })),
      },
      null,
      2,
    )}\n`,
  );

  const previous = await readOptional(options.recordPath);
  const recordUpdated = recordCountsChanged(previous, stats);
  if (recordUpdated) {
    await writeRecord(options.recordPath, renderIngestRecord(stats, date));
    log(`ingest record updated ${options.recordPath}`);
  } else {
    log("ingest record unchanged");
  }

  return { chunks, stats, recordUpdated };
}

export function statisticLine(stat: DocumentChunkStats): string {
  return [
    stat.documentId,
    `characters=${stat.characters}`,
    `headings=${stat.headingCount}`,
    `tables=${stat.tableCount}`,
    `chunks=${stat.chunkCount}`,
    `paragraph-splits=${stat.paragraphSplits}`,
    `row-splits=${stat.rowSplits}`,
  ].join(" ");
}

export function recordCountsChanged(
  previous: string | null,
  stats: readonly DocumentChunkStats[],
): boolean {
  if (previous === null) return true;
  return countBlock(previous) !== stats.map((stat) => statisticLine(stat)).join("\n");
}

export function renderIngestRecord(
  stats: readonly DocumentChunkStats[],
  date: string,
): string {
  const header = [
    "| Document | Extracted characters | Headings | Tables | Chunks | Paragraph splits | Row splits |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const rows = stats.map(
    (stat) =>
      `| ${stat.documentId} | ${stat.characters} | ${stat.headingCount} | ${stat.tableCount} | ${stat.chunkCount} | ${stat.paragraphSplits} | ${stat.rowSplits} |`,
  );
  const notes = recordNotes(stats);
  return [
    "# Ingest record",
    "",
    `Date: ${date}`,
    "",
    ...header,
    ...rows,
    "",
    ...(notes.length > 0 ? [...notes, ""] : []),
    COUNTS_START,
    ...stats.map((stat) => statisticLine(stat)),
    COUNTS_END,
    "",
  ].join("\n");
}

function recordNotes(stats: readonly DocumentChunkStats[]): string[] {
  const notes: string[] = [];
  for (const stat of stats) {
    if (stat.form === "pdf" && stat.characters < NEAR_EMPTY_PDF_CHARACTERS) {
      notes.push(
        `${stat.documentId}: text layer looks thin (${stat.characters} characters). Ingest stopped before embedding.`,
      );
    }
  }
  const eatwell = stats.find((stat) => stat.documentId === "eatwell-2018");
  if (eatwell && eatwell.characters >= NEAR_EMPTY_PDF_CHARACTERS) {
    notes.push(
      "eatwell-2018: the plate drawing contributes only its text layer. Prose pages and the food-group chart are present; the curved labels on the drawing are not reconstructed.",
    );
  }
  return notes;
}

function countBlock(record: string): string | null {
  const start = record.indexOf(COUNTS_START);
  const end = record.indexOf(COUNTS_END, start + COUNTS_START.length);
  if (start === -1 || end === -1) return null;
  return record
    .slice(start + COUNTS_START.length, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

async function readRawBody(filePath: string, documentId: string): Promise<Uint8Array> {
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    if (bytes.byteLength === 0) {
      throw new Error(`${documentId}: raw body is empty`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.includes("raw body is empty")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${documentId}: raw body not readable (${message})`);
  }
}

async function readFetchRecord(
  filePath: string,
  documentId: string,
): Promise<FetchRecord> {
  let record: Partial<FetchRecord>;
  try {
    record = JSON.parse(await readFile(filePath, "utf8")) as Partial<FetchRecord>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${documentId}: fetch record not readable (${message})`);
  }
  if (typeof record.retrievedAt !== "string" || record.retrievedAt === "") {
    throw new Error(`${documentId}: retrievedAt missing`);
  }
  if (typeof record.contentHash !== "string" || record.contentHash === "") {
    throw new Error(`${documentId}: content hash missing`);
  }
  return record as FetchRecord;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
    if (code === "ENOENT") return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ingest record not readable (${message})`);
  }
}

async function writeRecord(filePath: string, contents: string): Promise<void> {
  await writeTextAtomic(filePath, contents);
}

async function writeTextAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, filePath);
}
