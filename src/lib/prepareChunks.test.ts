import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS, type CorpusDocument } from "./corpus";
import { GUIDANCE_DB_NAME, loadChunkFile } from "./embed";
import type { ParsedDocument } from "./parsedDocument";
import {
  NEAR_EMPTY_PDF_CHARACTERS,
  ThinExtractError,
  prepareChunkCorpus,
} from "./prepareChunks";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-prepare-"));
  directories.push(directory);
  return directory;
}

function document(id: CorpusDocument["id"]): CorpusDocument {
  const found = CORPUS.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function parsed(
  id: CorpusDocument["id"],
  characters: number,
  headings = 2,
  tables = 1,
): ParsedDocument {
  const text = "Cooked chicken keeps for 3 to 4 days in the refrigerator.";
  return {
    documentId: id,
    characters,
    headingCount: headings,
    tableCount: tables,
    units: [
      {
        kind: "section",
        sectionHeading: "Leftovers",
        text,
      },
    ],
  };
}

async function writeRaw(
  dataDir: string,
  id: string,
  retrievedAt = "2026-10-07T00:00:00.000Z",
): Promise<void> {
  const directory = join(dataDir, "raw", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "body"), "raw-body");
  await writeFile(
    join(directory, "fetch.json"),
    `${JSON.stringify({
      url: "https://example.test",
      status: 200,
      retrievedAt,
      contentType: "text/html",
      contentHash: `hash-${id}`,
    })}\n`,
  );
}

describe("prepareChunkCorpus", () => {
  it("writes chunk.json and the ingest record, then leaves the record when counts match", async () => {
    const directory = await tempDir();
    const recordPath = join(directory, "ingest-record.md");
    const fsa = document("fsa-chill-2017");
    const eatwell = document("eatwell-2018");
    await writeRaw(directory, fsa.id);
    await writeRaw(directory, eatwell.id);
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    await writeFile(indexPath, "previous-index");
    const logs: string[] = [];

    const first = await prepareChunkCorpus({
      dataDir: directory,
      documents: [fsa, eatwell],
      recordPath,
      now: () => new Date("2026-10-01T12:00:00.000Z"),
      log: (line) => logs.push(line),
      parseDocument: async (_bytes, item) =>
        parsed(item.id, item.form === "pdf" ? 29_000 : 6_000),
    });

    expect(first.recordUpdated).toBe(true);
    expect(first.stats.map((stat) => stat.chunkCount)).toEqual([1, 1]);
    expect(logs).toContain(
      "fsa-chill-2017 characters=6000 headings=2 tables=1 chunks=1 paragraph-splits=0 row-splits=0",
    );
    expect(logs.some((line) => line.startsWith("ingest record updated"))).toBe(
      true,
    );
    const record = await readFile(recordPath, "utf8");
    expect(record).toContain("Date: 2026-10-01");
    expect(record).toContain("| fsa-chill-2017 | 6000 | 2 | 1 | 1 | 0 | 0 |");
    expect(record).toContain("| eatwell-2018 | 29000 | 2 | 1 | 1 | 0 | 0 |");
    expect(record).toContain("curved labels on the drawing are not reconstructed");
    expect(record).not.toContain("looks thin");
    const loaded = await loadChunkFile(join(directory, "chunks", "chunk.json"));
    expect(loaded.map((chunk) => chunk.id)).toEqual([
      "fsa-chill-2017:1",
      "eatwell-2018:1",
    ]);
    expect(loaded[0]?.retrievedAt).toBe("2026-10-07T00:00:00.000Z");
    expect(await readFile(indexPath, "utf8")).toBe("previous-index");

    const second = await prepareChunkCorpus({
      dataDir: directory,
      documents: [fsa, eatwell],
      recordPath,
      now: () => new Date("2026-10-08T12:00:00.000Z"),
      parseDocument: async (_bytes, item) =>
        parsed(item.id, item.form === "pdf" ? 29_000 : 6_000),
    });

    expect(second.recordUpdated).toBe(false);
    expect(await readFile(recordPath, "utf8")).toBe(record);
  });

  it("rewrites the ingest record when a re-parse changes the counts", async () => {
    const directory = await tempDir();
    const recordPath = join(directory, "docs", "ingest-record.md");
    const fsa = document("fsa-chill-2017");
    await writeRaw(directory, fsa.id);
    await prepareChunkCorpus({
      dataDir: directory,
      documents: [fsa],
      recordPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      parseDocument: async () => parsed(fsa.id, 6_000, 5, 0),
    });

    const updated = await prepareChunkCorpus({
      dataDir: directory,
      documents: [fsa],
      recordPath,
      now: () => new Date("2026-10-08T00:00:00.000Z"),
      parseDocument: async () => parsed(fsa.id, 7_100, 6, 1),
    });

    expect(updated.recordUpdated).toBe(true);
    const record = await readFile(recordPath, "utf8");
    expect(record).toContain("Date: 2026-10-08");
    expect(record).toContain(
      "fsa-chill-2017 characters=7100 headings=6 tables=1 chunks=1 paragraph-splits=0 row-splits=0",
    );
    expect(record).not.toContain("characters=6000");
  });

  it("records a thin PDF and does not replace chunk.json or the index", async () => {
    const directory = await tempDir();
    const recordPath = join(directory, "ingest-record.md");
    const eatwell = document("eatwell-2018");
    const fsa = document("fsa-chill-2017");
    await writeRaw(directory, eatwell.id);
    await writeRaw(directory, fsa.id);
    const chunkPath = join(directory, "chunks", "chunk.json");
    await mkdir(join(directory, "chunks"), { recursive: true });
    await writeFile(chunkPath, "previous-chunks\n");
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    await writeFile(indexPath, "previous-index");
    expect(NEAR_EMPTY_PDF_CHARACTERS).toBe(1_000);

    await expect(
      prepareChunkCorpus({
        dataDir: directory,
        documents: [eatwell, fsa],
        recordPath,
        now: () => new Date("2026-10-08T00:00:00.000Z"),
        parseDocument: async (_bytes, item) =>
          parsed(item.id, item.id === "eatwell-2018" ? 40 : 6_000),
      }),
    ).rejects.toBeInstanceOf(ThinExtractError);

    const record = await readFile(recordPath, "utf8");
    expect(record).toContain("Date: 2026-10-08");
    expect(record).toContain(
      "eatwell-2018: text layer looks thin (40 characters). Ingest stopped before embedding.",
    );
    expect(record).toContain("| eatwell-2018 | 40 |");
    expect(record).not.toContain("curved labels");
    expect(await readFile(chunkPath, "utf8")).toBe("previous-chunks\n");
    expect(await readFile(indexPath, "utf8")).toBe("previous-index");
  });

  it("does not write the record or chunk.json when parsing fails", async () => {
    const directory = await tempDir();
    const recordPath = join(directory, "ingest-record.md");
    const fsa = document("fsa-chill-2017");
    await writeRaw(directory, fsa.id);
    await writeFile(recordPath, "previous record\n");
    const chunkPath = join(directory, "chunks", "chunk.json");
    await mkdir(join(directory, "chunks"), { recursive: true });
    await writeFile(chunkPath, "previous chunks\n");

    await expect(
      prepareChunkCorpus({
        dataDir: directory,
        documents: [fsa],
        recordPath,
        parseDocument: async () => {
          throw new Error("parse exploded");
        },
      }),
    ).rejects.toThrow("parse exploded");

    expect(await readFile(recordPath, "utf8")).toBe("previous record\n");
    expect(await readFile(chunkPath, "utf8")).toBe("previous chunks\n");
    await expect(access(join(directory, GUIDANCE_DB_NAME))).rejects.toThrow();
  });
});
