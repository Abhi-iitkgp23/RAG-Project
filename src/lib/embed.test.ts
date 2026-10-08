import Database from "better-sqlite3";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuidanceChunk } from "./chunk";
import { CORPUS } from "./corpus";
import {
  GUIDANCE_DB_NAME,
  embedGuidanceIndex,
  embeddingInput,
  float32ToVector,
  writeGuidanceIndex,
} from "./embed";
import { EMBEDDING_DIMENSIONS, EmbeddingDimensionError } from "./model";
import type { EmbeddingClient } from "./types";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-embed-"));
  directories.push(directory);
  return directory;
}

function vector(seed: number): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[0] = seed;
  return values;
}

function countingClient(
  next: (text: string, index: number) => number[] = (_text, index) =>
    vector(index + 1),
) {
  const calls: string[][] = [];
  let index = 0;
  const client: EmbeddingClient = {
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => {
        const values = next(text, index);
        index += 1;
        return values;
      });
    },
  };
  return { client, calls };
}

function chunk(
  id: string,
  text: string,
  overrides: Partial<GuidanceChunk> = {},
): GuidanceChunk {
  const documentId = id.slice(0, id.lastIndexOf(":")) as GuidanceChunk["documentId"];
  const manifest = CORPUS.find((document) => document.id === documentId) ?? CORPUS[2]!;
  return {
    documentName: manifest.name,
    publisher: manifest.publisher,
    year: manifest.year,
    sourceUrl: manifest.sourceUrl,
    retrievedAt: "2026-10-07T00:00:00.000Z",
    sectionHeading: "Poultry",
    text,
    unitKind: "category",
    ...overrides,
    id,
    documentId,
  };
}

function hashes(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

async function indexFile(directory = ""): Promise<string> {
  const root = directory || (await tempDir());
  return join(root, GUIDANCE_DB_NAME);
}

function openRead(indexPath: string): Database.Database {
  return new Database(indexPath, { readonly: true, fileMustExist: true });
}

function readChunk(indexPath: string, id: string): {
  sectionHeading: string;
  text: string;
  embedding: number[];
  contentHash: string;
} {
  const db = openRead(indexPath);
  try {
    const row = db
      .prepare(
        `select c.section_heading, c.text, c.embedding, d.content_hash
         from chunks c
         join documents d on d.id = c.document_id
         where c.id = ?`,
      )
      .get(id) as
      | {
          section_heading: string;
          text: string;
          embedding: Buffer | Uint8Array;
          content_hash: string;
        }
      | undefined;
    if (!row) throw new Error(`missing chunk ${id}`);
    const blob = Buffer.isBuffer(row.embedding)
      ? row.embedding
      : Buffer.from(row.embedding);
    return {
      sectionHeading: row.section_heading,
      text: row.text,
      embedding: float32ToVector(blob),
      contentHash: row.content_hash,
    };
  } finally {
    db.close();
  }
}

async function expectUnchanged(indexPath: string, bytes: string): Promise<void> {
  expect(await readFile(indexPath, "utf8")).toBe(bytes);
}

async function expectNoTemp(directory: string): Promise<void> {
  const names = await readdir(directory);
  expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
}

describe("guidance index embeddings", () => {
  it("stores heading and text, and embeds heading, a blank line, then text", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    const { client, calls } = countingClient(() => vector(0.1));
    const logs: string[] = [];
    const source = chunk(
      "cold-storage-2023:1",
      "Cooked chicken keeps for 3 to 4 days.",
      { sectionHeading: "Poultry" },
    );

    const result = await writeGuidanceIndex({
      chunks: [source],
      contentHashes: hashes([["cold-storage-2023", "hash-1"]]),
      indexPath,
      client,
      log: (line) => logs.push(line),
    });

    expect(calls).toEqual([
      [embeddingInput("Poultry", "Cooked chicken keeps for 3 to 4 days.")],
    ]);
    expect(calls[0]?.[0]).toBe(
      "Poultry\n\nCooked chicken keeps for 3 to 4 days.",
    );
    const stored = readChunk(indexPath, source.id);
    expect(stored.text).toBe(source.text);
    expect(stored.sectionHeading).toBe("Poultry");
    expect(stored.text).not.toContain("Poultry\n\n");
    expect(stored.embedding[0]).toBe(Math.fround(0.1));
    expect(stored.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(stored.contentHash).toBe("hash-1");
    expect(result).toMatchObject({
      reused: 0,
      embedded: 1,
      batches: 1,
      counts: { "cold-storage-2023": 1 },
    });
    expect(logs).toContain("cold-storage-2023 chunks=1");

    const db = openRead(indexPath);
    try {
      const columns = db.prepare("pragma table_info(chunks)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "document_id",
        "document_name",
        "publisher",
        "year",
        "source_url",
        "retrieved_at",
        "section_heading",
        "unit_kind",
        "text",
        "embedding",
      ]);
    } finally {
      db.close();
    }
  });

  it("batches ingest and still embeds a query as one string", async () => {
    const indexPath = await indexFile();
    const { client, calls } = countingClient();
    const chunks = [
      chunk("cold-storage-2023:1", "one"),
      chunk("cold-storage-2023:2", "two"),
      chunk("cold-storage-2023:3", "three"),
    ];

    await writeGuidanceIndex({
      chunks,
      contentHashes: hashes([["cold-storage-2023", "hash-1"]]),
      indexPath,
      client,
      limits: { maxInputs: 2 },
    });

    expect(calls.map((batch) => batch.length)).toEqual([2, 1]);
    expect(calls[0]?.[0]).toBe(embeddingInput("Poultry", "one"));
    expect(calls[1]).toEqual([embeddingInput("Poultry", "three")]);
  });

  it("does not call the embedding API when the hash and input are unchanged", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    const first = countingClient(() => vector(0.5));
    const chunks = [
      chunk("cold-storage-2023:1", "Cooked chicken keeps for 3 to 4 days."),
      chunk("fsa-chill-2017:1", "Chill food within 90 minutes.", {
        sectionHeading: "Chilling food",
      }),
    ];
    const contentHashes = hashes([
      ["cold-storage-2023", "hash-cold"],
      ["fsa-chill-2017", "hash-fsa"],
    ]);
    await writeGuidanceIndex({
      chunks,
      contentHashes,
      indexPath,
      client: first.client,
    });
    const before = readChunk(indexPath, chunks[0]!.id).embedding;

    const logs: string[] = [];
    const second: EmbeddingClient = {
      async embed() {
        throw new Error("embedding API should not be called");
      },
    };
    const result = await writeGuidanceIndex({
      chunks,
      contentHashes,
      indexPath,
      client: second,
      log: (line) => logs.push(line),
    });

    expect(result.reused).toBe(2);
    expect(result.embedded).toBe(0);
    expect(result.batches).toBe(0);
    expect(logs.some((line) => line.startsWith("embed skipped:"))).toBe(true);
    expect(readChunk(indexPath, chunks[0]!.id).embedding).toEqual(before);
    const db = openRead(indexPath);
    try {
      expect(
        (db.prepare("select count(*) as count from chunks").get() as {
          count: number;
        }).count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it("re-embeds a chunk whose text or heading changed and reuses the rest", async () => {
    const indexPath = await indexFile();
    const original = [
      chunk("dgi-2024:1", "Visible fats stay with the oils section.", {
        sectionHeading: "Fats and oils",
      }),
      chunk("dgi-2024:2", "Use oils in moderation."),
    ];
    const contentHashes = hashes([["dgi-2024", "hash-dgi"]]);
    const first = countingClient();
    await writeGuidanceIndex({
      chunks: original,
      contentHashes,
      indexPath,
      client: first.client,
    });
    const kept = readChunk(indexPath, original[1]!.id);

    const changed = [
      chunk("dgi-2024:1", "Visible fats are listed with cooking oils.", {
        sectionHeading: "Fats and oils",
      }),
      original[1]!,
    ];
    const second = countingClient(() => vector(9));
    await writeGuidanceIndex({
      chunks: changed,
      contentHashes,
      indexPath,
      client: second.client,
    });

    expect(second.calls).toEqual([
      [
        embeddingInput(
          "Fats and oils",
          "Visible fats are listed with cooking oils.",
        ),
      ],
    ]);
    expect(readChunk(indexPath, original[1]!.id).embedding).toEqual(kept.embedding);
    expect(readChunk(indexPath, original[0]!.id).text).toBe(
      "Visible fats are listed with cooking oils.",
    );

    const headingChanged = [
      chunk("dgi-2024:1", "Visible fats are listed with cooking oils.", {
        sectionHeading: "Fats and oils › Visible fats",
      }),
      original[1]!,
    ];
    const third = countingClient(() => vector(4));
    await writeGuidanceIndex({
      chunks: headingChanged,
      contentHashes,
      indexPath,
      client: third.client,
    });
    expect(third.calls).toEqual([
      [
        embeddingInput(
          "Fats and oils › Visible fats",
          "Visible fats are listed with cooking oils.",
        ),
      ],
    ]);
  });

  it("re-embeds every chunk of a document whose content hash changed", async () => {
    const indexPath = await indexFile();
    const chunks = [
      chunk("dgi-2024:1", "Oils", { sectionHeading: "Fats and oils" }),
      chunk("cold-storage-2023:1", "Cooked chicken"),
    ];
    await writeGuidanceIndex({
      chunks,
      contentHashes: hashes([
        ["dgi-2024", "hash-dgi"],
        ["cold-storage-2023", "hash-cold"],
      ]),
      indexPath,
      client: countingClient().client,
    });
    const kept = readChunk(indexPath, "cold-storage-2023:1");

    const next = countingClient(() => vector(7));
    await writeGuidanceIndex({
      chunks,
      contentHashes: hashes([
        ["dgi-2024", "hash-dgi-new"],
        ["cold-storage-2023", "hash-cold"],
      ]),
      indexPath,
      client: next.client,
    });

    expect(next.calls).toEqual([
      [embeddingInput("Fats and oils", "Oils")],
    ]);
    expect(readChunk(indexPath, "dgi-2024:1").contentHash).toBe("hash-dgi-new");
    expect(readChunk(indexPath, "cold-storage-2023:1").embedding).toEqual(
      kept.embedding,
    );
  });

  it("rejects a short embedding and does not swap guidance.db", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    await writeGuidanceIndex({
      chunks: [chunk("cold-storage-2023:1", "Cooked chicken")],
      contentHashes: hashes([["cold-storage-2023", "hash-1"]]),
      indexPath,
      client: countingClient(() => vector(1)).client,
    });
    const before = await readFile(indexPath);

    const client: EmbeddingClient = {
      async embed() {
        return [[0.1, 0.2]];
      },
    };
    await expect(
      writeGuidanceIndex({
        chunks: [chunk("cold-storage-2023:1", "Cooked chicken, rewritten")],
        contentHashes: hashes([["cold-storage-2023", "hash-1"]]),
        indexPath,
        client,
      }),
    ).rejects.toBeInstanceOf(EmbeddingDimensionError);

    expect(await readFile(indexPath)).toEqual(before);
    expect(readChunk(indexPath, "cold-storage-2023:1").text).toBe(
      "Cooked chicken",
    );
    await expectNoTemp(directory);
  });

  it("leaves the previous index readable when a later batch throws", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    const chunks = [
      chunk("cold-storage-2023:1", "Cooked chicken"),
      chunk("cold-storage-2023:2", "Leftovers"),
    ];
    const contentHashes = hashes([["cold-storage-2023", "hash-1"]]);
    await writeGuidanceIndex({
      chunks,
      contentHashes,
      indexPath,
      client: countingClient().client,
    });

    let calls = 0;
    const client: EmbeddingClient = {
      async embed(texts) {
        calls += 1;
        if (calls >= 2) throw new Error("provider down");
        return texts.map(() => vector(3));
      },
    };
    await expect(
      writeGuidanceIndex({
        chunks: [
          chunk("cold-storage-2023:1", "Cooked chicken changed"),
          chunk("cold-storage-2023:2", "Leftovers changed"),
        ],
        contentHashes,
        indexPath,
        client,
        limits: { maxInputs: 1 },
      }),
    ).rejects.toThrow("provider down");

    expect(calls).toBe(2);
    const db = openRead(indexPath);
    try {
      const rows = db
        .prepare("select id, text from chunks order by id")
        .all() as Array<{ id: string; text: string }>;
      expect(rows).toEqual([
        { id: "cold-storage-2023:1", text: "Cooked chicken" },
        { id: "cold-storage-2023:2", text: "Leftovers" },
      ]);
    } finally {
      db.close();
    }
    await expectNoTemp(directory);
  });

  it("does not create guidance.db when embedding fails and no index exists", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    const client: EmbeddingClient = {
      async embed() {
        throw new Error("provider down");
      },
    };

    await expect(
      writeGuidanceIndex({
        chunks: [chunk("cold-storage-2023:1", "Cooked chicken")],
        contentHashes: hashes([["cold-storage-2023", "hash-1"]]),
        indexPath,
        client,
      }),
    ).rejects.toThrow("provider down");
    await expect(access(indexPath)).rejects.toThrow();
    await expectNoTemp(directory);
  });

  it("does not replace the index when the content hash or chunk id is unusable", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    await writeFile(indexPath, "previous-guidance-index");
    const client: EmbeddingClient = {
      async embed() {
        throw new Error("embedding API should not be called");
      },
    };

    await expect(
      writeGuidanceIndex({
        chunks: [chunk("cold-storage-2023:1", "Cooked chicken")],
        contentHashes: hashes([]),
        indexPath,
        client,
      }),
    ).rejects.toThrow("missing content hash");
    await expect(
      writeGuidanceIndex({
        chunks: [],
        contentHashes: hashes([]),
        indexPath,
        client,
      }),
    ).rejects.toThrow("no chunks");
    await expect(
      writeGuidanceIndex({
        chunks: [
          chunk("cold-storage-2023:1", "one"),
          chunk("cold-storage-2023:1", "two"),
        ],
        contentHashes: hashes([["cold-storage-2023", "hash-1"]]),
        indexPath,
        client,
      }),
    ).rejects.toThrow("duplicate chunk id");

    await expectUnchanged(indexPath, "previous-guidance-index");
  });

  it("embeds the chunk file and prints a skipped batch on the next run", async () => {
    const directory = await tempDir();
    const source = chunk("eatwell-2018:1", "Potatoes count as starchy food.", {
      sectionHeading: "Potatoes, bread, rice, pasta and other starchy carbohydrates",
      unitKind: "section",
    });
    await mkdir(join(directory, "chunks"), { recursive: true });
    await mkdir(join(directory, "raw", "eatwell-2018"), { recursive: true });
    await writeFile(
      join(directory, "chunks", "chunk.json"),
      `${JSON.stringify({ documents: [{ chunks: [source] }] })}\n`,
    );
    await writeFile(
      join(directory, "raw", "eatwell-2018", "fetch.json"),
      `${JSON.stringify({ contentHash: "hash-eatwell" })}\n`,
    );

    const first = countingClient(() => vector(0.3));
    const created = await embedGuidanceIndex({
      dataDir: directory,
      client: first.client,
    });
    expect(created.counts).toEqual({ "eatwell-2018": 1 });
    expect(readChunk(join(directory, GUIDANCE_DB_NAME), source.id).embedding[0]).toBe(
      Math.fround(0.3),
    );

    const logs: string[] = [];
    const second = await embedGuidanceIndex({
      dataDir: directory,
      client: {
        async embed() {
          throw new Error("embedding API should not be called");
        },
      },
      log: (line) => logs.push(line),
    });
    expect(second.batches).toBe(0);
    expect(logs).toContain(
      "embed skipped: content hash and embedding input unchanged (1 chunks)",
    );
    expect(logs).toContain("eatwell-2018 chunks=1");
  });

  it("fails closed when the chunk file is missing", async () => {
    const directory = await tempDir();
    await expect(
      embedGuidanceIndex({
        dataDir: directory,
        client: {
          async embed() {
            throw new Error("embedding API should not be called");
          },
        },
      }),
    ).rejects.toThrow("chunk file not readable");
    await expect(access(join(directory, GUIDANCE_DB_NAME))).rejects.toThrow();
  });
});
