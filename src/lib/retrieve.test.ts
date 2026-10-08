import Database from "better-sqlite3";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuidanceChunk } from "./chunk";
import { CORPUS, documentFilter } from "./corpus";
import { GUIDANCE_DB_NAME, embeddingInput, writeGuidanceIndex } from "./embed";
import { EMBEDDING_DIMENSIONS } from "./model";
import {
  DEFAULT_K,
  GuidanceIndexError,
  MIN_SCORE,
  cosineSimilarity,
  createRetriever,
  loadGuidanceIndex,
  rankChunks,
  type IndexedChunk,
} from "./retrieve";
import type { EmbeddingClient } from "./types";

const CHICKEN = "how long does cooked chicken last in the refrigerator";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-retrieve-"));
  directories.push(directory);
  return directory;
}

function axis(dimension: number): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[dimension] = 1;
  return values;
}

function unitVector(cosine: number): number[] {
  return [cosine, Math.sqrt(1 - cosine * cosine)];
}

function chunk(
  id: string,
  text: string,
  overrides: Partial<GuidanceChunk> = {},
): GuidanceChunk {
  const documentId = id.slice(0, id.lastIndexOf(":")) as GuidanceChunk["documentId"];
  const manifest = CORPUS.find((document) => document.id === documentId);
  if (!manifest) throw new Error(`unknown document ${documentId}`);
  return {
    documentName: manifest.name,
    publisher: manifest.publisher,
    year: manifest.year,
    sourceUrl: manifest.sourceUrl,
    retrievedAt: "2026-10-07T00:00:00.000Z",
    sectionHeading: "Section",
    text,
    unitKind: "section",
    ...overrides,
    id,
    documentId,
  };
}

function indexed(
  id: string,
  documentId: string,
  embedding: number[],
): IndexedChunk {
  return {
    id,
    documentId,
    documentName: documentId,
    publisher: "Publisher",
    year: 2024,
    sourceUrl: "https://example.test",
    sectionHeading: "Section",
    text: id,
    embedding,
  };
}

function recordingClient(vectorFor: (text: string) => number[]) {
  const calls: string[][] = [];
  const client: EmbeddingClient = {
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => vectorFor(text));
    },
  };
  return { client, calls };
}

describe("cosine similarity", () => {
  it("scores a vector with itself as 1 and an orthogonal pair as 0", () => {
    const vector = [0.2, -0.5, 0.8, 1.25];
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(cosineSimilarity([2, 0], [0, -4])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it("rejects vectors of different lengths", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/equal non-empty/);
  });
});

describe("rankChunks", () => {
  it("drops hits below MIN_SCORE and keeps a hit on the floor", () => {
    const hits = rankChunks(
      [
        indexed("above", "eatwell-2018", unitVector(0.31)),
        indexed("below", "eatwell-2018", unitVector(0.25)),
      ],
      [1, 0],
    );

    expect(MIN_SCORE).toBe(0.3);
    expect(hits.map((hit) => hit.id)).toEqual(["above"]);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(hits[0]).not.toHaveProperty("embedding");
  });

  it("applies k after the document filter and uses the same query vector", () => {
    const chunks = [
      ...Array.from({ length: 8 }, (_, index) =>
        indexed(`dgi-2024:${index + 1}`, "dgi-2024", [1, 0]),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        indexed(`eatwell-2018:${index + 1}`, "eatwell-2018", [1, 0]),
      ),
    ];

    const full = rankChunks(chunks, [1, 0]);
    const eatwell = rankChunks(chunks, [1, 0], { documentId: "eatwell-2018" });

    expect(full).toHaveLength(DEFAULT_K);
    expect(full.every((hit) => hit.documentId === "dgi-2024")).toBe(true);
    expect(eatwell.map((hit) => hit.id)).toEqual([
      "eatwell-2018:1",
      "eatwell-2018:2",
      "eatwell-2018:3",
      "eatwell-2018:4",
      "eatwell-2018:5",
      "eatwell-2018:6",
    ]);
    expect(eatwell.every((hit) => hit.score === 1)).toBe(true);
  });

  it("orders a higher cosine first", () => {
    const hits = rankChunks(
      [
        indexed("weaker", "dgi-2024", [1, 1]),
        indexed("stronger", "cold-storage-2023", [1, 0]),
      ],
      [1, 0],
    );

    expect(hits.map((hit) => hit.id)).toEqual(["stronger", "weaker"]);
    expect(hits[0]?.score).toBeCloseTo(1, 10);
    expect(hits[1]?.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(hits[1]?.score).toBeLessThan(hits[0]?.score ?? 0);
  });

  it("rejects a k that is not a positive integer", () => {
    expect(() => rankChunks([], [1, 0], { k: 0 })).toThrow(/positive integer/);
  });

  it("returns an empty list for an unknown document id", () => {
    const hits = rankChunks([indexed("dgi-2024:1", "dgi-2024", [1, 0])], [1, 0], {
      documentId: "not-a-document",
    });
    expect(hits).toEqual([]);
  });
});

describe("document aliases", () => {
  it("selects the only named document, ignoring case", () => {
    expect(documentFilter("What does the Eatwell Guide say about potatoes?")).toBe(
      "eatwell-2018",
    );
    expect(documentFilter("what does ICMR say about oil?")).toBe("dgi-2024");
    expect(
      documentFilter(
        "The ICMR dietary guidelines for Indians mention visible fats",
      ),
    ).toBe("dgi-2024");
    expect(documentFilter("See the COLD FOOD STORAGE chart")).toBe(
      "cold-storage-2023",
    );
    expect(documentFilter("from foodsafety.gov")).toBe("cold-storage-2023");
    expect(documentFilter("The Food Standards Agency says to chill food")).toBe(
      "fsa-chill-2017",
    );
    expect(documentFilter("how to chill, freeze and defrost leftovers")).toBe(
      "fsa-chill-2017",
    );
  });

  it("searches the full corpus when zero documents or two or more are named", () => {
    expect(documentFilter(CHICKEN)).toBeUndefined();
    expect(documentFilter("")).toBeUndefined();
    expect(documentFilter("Compare ICMR and the Eatwell Guide on potatoes")).toBeUndefined();
    expect(
      documentFilter("cold food storage advice from the Food Standards Agency"),
    ).toBeUndefined();
  });
});

describe("guidance index retrieval", () => {
  it("throws a typed error when guidance.db is missing or unreadable and does not create it", async () => {
    const directory = await tempDir();
    const missing = join(directory, GUIDANCE_DB_NAME);

    expect(() => loadGuidanceIndex(missing)).toThrow(GuidanceIndexError);
    expect(() => loadGuidanceIndex(missing)).toThrow(/guidance index is missing/);
    await expect(access(missing)).rejects.toThrow();

    const unreadable = join(directory, "broken.db");
    await writeFile(unreadable, "not a sqlite database");
    expect(() => loadGuidanceIndex(unreadable)).toThrow(GuidanceIndexError);
    expect(() => loadGuidanceIndex(unreadable)).toThrow(/unreadable/);

    const indexPath = await writeIndex(directory, [
      chunk("cold-storage-2023:1", "Cooked chicken keeps for 3 to 4 days.", {
        sectionHeading: "Leftovers",
      }),
    ]);
    const db = new Database(indexPath);
    try {
      db.prepare("update chunks set embedding = ?").run(Buffer.alloc(8));
    } finally {
      db.close();
    }
    expect(() => loadGuidanceIndex(indexPath)).toThrow(GuidanceIndexError);
    expect(() => loadGuidanceIndex(indexPath)).toThrow(/dimensions/);
  });

  it("returns an empty list when the chunks table has no rows", async () => {
    const directory = await tempDir();
    const indexPath = join(directory, GUIDANCE_DB_NAME);
    const db = new Database(indexPath);
    try {
      db.exec(`
        create table chunks (
          id text primary key,
          document_id text not null,
          document_name text not null,
          publisher text not null,
          year integer not null,
          source_url text not null,
          section_heading text not null,
          text text not null,
          embedding blob not null
        );
      `);
    } finally {
      db.close();
    }

    expect(loadGuidanceIndex(indexPath)).toEqual([]);
    const { client, calls } = recordingClient(() => axis(2));
    const retriever = createRetriever({ indexPath, client });
    await expect(
      retriever.retrieve({ query: "brew kombucha at home under moonlight" }),
    ).resolves.toEqual([]);
    expect(calls).toEqual([["brew kombucha at home under moonlight"]]);
  });

  it("retrieves cooked chicken from a storage document and filters in memory", async () => {
    const directory = await tempDir();
    const chunks = [
      chunk("cold-storage-2023:1", "Cooked chicken keeps for 3 to 4 days.", {
        sectionHeading: "Leftovers",
        unitKind: "category",
      }),
      chunk("fsa-chill-2017:1", "Chill cooked meat within 90 minutes.", {
        sectionHeading: "Chilling food",
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        chunk(`dgi-2024:${index + 1}`, `Dietary passage ${index + 1}.`),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        chunk(`eatwell-2018:${index + 1}`, `Eatwell passage ${index + 1}.`),
      ),
    ];
    const indexPath = await writeIndex(directory, chunks, (source) =>
      source.documentId === "cold-storage-2023" ||
      source.documentId === "fsa-chill-2017"
        ? axis(0)
        : axis(1),
    );
    const { client, calls } = recordingClient((text) => {
      if (text === CHICKEN) return axis(0);
      if (text === "potatoes in the eatwell guide") return axis(1);
      return axis(2);
    });
    const retriever = createRetriever({ indexPath, client });
    await rm(indexPath);

    const chicken = await retriever.retrieve({ query: CHICKEN });
    const eatwellOnly = await retriever.retrieve({
      query: CHICKEN,
      documentId: "eatwell-2018",
    });
    const nonsense = await retriever.retrieve({
      query: "brew kombucha at home under moonlight",
    });
    const namedEatwell = await retriever.retrieve({
      query: "potatoes in the eatwell guide",
      documentId: "eatwell-2018",
    });

    expect(calls).toEqual([
      [CHICKEN],
      [CHICKEN],
      ["brew kombucha at home under moonlight"],
      ["potatoes in the eatwell guide"],
    ]);
    expect(calls.every((batch) => batch.length === 1)).toBe(true);
    expect(chicken.map((hit) => hit.documentId)).toEqual([
      "cold-storage-2023",
      "fsa-chill-2017",
    ]);
    expect(chicken.every((hit) => hit.score >= MIN_SCORE)).toBe(true);
    expect(chicken[0]).toMatchObject({
      id: "cold-storage-2023:1",
      documentName: "Cold Food Storage Chart",
      publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
      year: 2023,
      sectionHeading: "Leftovers",
      text: "Cooked chicken keeps for 3 to 4 days.",
      score: 1,
    });
    expect(chicken[0]?.text).not.toContain("Leftovers");
    expect(eatwellOnly).toEqual([]);
    expect(nonsense).toEqual([]);
    expect(namedEatwell).toHaveLength(DEFAULT_K);
    expect(namedEatwell.every((hit) => hit.documentId === "eatwell-2018")).toBe(
      true,
    );
  });
});

async function writeIndex(
  directory: string,
  chunks: GuidanceChunk[],
  vectorFor: (chunk: GuidanceChunk) => number[] = () => axis(0),
): Promise<string> {
  const indexPath = join(directory, GUIDANCE_DB_NAME);
  const byInput = new Map(
    chunks.map((source) => [
      embeddingInput(source.sectionHeading, source.text),
      vectorFor(source),
    ]),
  );
  const client: EmbeddingClient = {
    async embed(texts) {
      return texts.map((text) => {
        const vector = byInput.get(text);
        if (!vector) throw new Error(`missing vector for ${text}`);
        return vector;
      });
    },
  };
  await writeGuidanceIndex({
    chunks,
    contentHashes: new Map(
      [...new Set(chunks.map((source) => source.documentId))].map((id) => [
        id,
        `hash-${id}`,
      ]),
    ),
    indexPath,
    client,
  });
  return indexPath;
}
