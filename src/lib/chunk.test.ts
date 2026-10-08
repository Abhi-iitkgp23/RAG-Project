import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CHUNK_HARD_MAX_CHARS,
  CHUNK_MIN_PROSE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  buildChunks,
  chunkDocument,
  type ChunkSource,
  type GuidanceChunk,
} from "./chunk";
import { CORPUS, type CorpusDocumentId } from "./corpus";
import { parseCorpusDocument } from "./parse";
import type { ParsedDocument, ParsedUnit, ParsedUnitKind } from "./parsedDocument";

const source: ChunkSource = {
  id: "dgi-2024",
  name: "Dietary Guidelines for Indians",
  publisher: "ICMR\u2013National Institute of Nutrition",
  year: 2024,
  sourceUrl: "https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf",
  retrievedAt: "2026-10-07T19:19:36.345Z",
};

function textOfLength(length: number, seed: string): string {
  const token = seed.replace(/\s+/g, "") || "x";
  let value = "";
  while (value.length < length) value += token;
  return value.slice(0, length);
}

function unit(
  kind: ParsedUnitKind,
  text: string,
  sectionHeading = "Visible fats",
  rows?: string[],
): ParsedUnit {
  return {
    kind,
    text,
    sectionHeading,
    ...(rows ? { rows } : {}),
  };
}

function parsed(units: ParsedUnit[], id: CorpusDocumentId = "dgi-2024"): ParsedDocument {
  return {
    documentId: id,
    units,
    headingCount: units.length,
    tableCount: units.filter((item) => item.kind === "table" || item.kind === "category").length,
    characters: units.reduce((total, item) => total + item.text.length, 0),
  };
}

function chunk(units: ParsedUnit[], citation: ChunkSource = source): GuidanceChunk[] {
  return chunkDocument(parsed(units, citation.id), citation);
}

describe("chunk constants", () => {
  it("keeps the architecture sizes", () => {
    expect(CHUNK_TARGET_CHARS).toBe(1_200);
    expect(CHUNK_HARD_MAX_CHARS).toBe(2_000);
    expect(CHUNK_OVERLAP_CHARS).toBe(200);
    expect(CHUNK_MIN_PROSE_CHARS).toBe(80);
  });
});

describe("chunkDocument", () => {
  it("keeps a numbered recommendation whole and copies the citation", () => {
    const recommendation =
      "GUIDELINE 7 Use oils and fats in moderation; choose a variety of oil seeds, nuts, and legumes.";
    const following = textOfLength(200, "rationale");
    const chunks = chunk([
      unit("recommendation", recommendation, "GUIDELINE 7"),
      unit("section", following, "RATIONALE"),
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      id: "dgi-2024:1",
      documentId: "dgi-2024",
      documentName: source.name,
      publisher: source.publisher,
      year: 2024,
      sourceUrl: source.sourceUrl,
      retrievedAt: source.retrievedAt,
      sectionHeading: "GUIDELINE 7",
      text: recommendation,
      unitKind: "recommendation",
    });
    expect(chunks[1]?.id).toBe("dgi-2024:2");
    expect(chunks[1]?.unitKind).toBe("section");
    expect(chunks[1]?.text).toBe(following);
  });

  it("keeps a small table whole, including its header row", () => {
    const rows = ["Food | Fridge", "Rice | 1 day", "Beans | 2 days"];
    const built = buildChunks(
      parsed([unit("table", rows.join("\n"), "Storage", rows)]),
      source,
    );

    expect(built.chunks).toHaveLength(1);
    expect(built.rowSplits).toBe(0);
    expect(built.chunks[0]?.unitKind).toBe("table");
    expect(built.chunks[0]?.text).toBe(rows.join("\n"));
  });

  it("keeps a section between 1,200 and 2,000 characters whole with no overlap", () => {
    const text = `${textOfLength(800, "vegetables")}\n\n${textOfLength(800, "legumes")}`;
    expect(text.length).toBeGreaterThan(CHUNK_TARGET_CHARS);
    expect(text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS);

    const chunks = chunk([unit("section", text, "GUIDELINE 6")]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.unitKind).toBe("section");
    expect(chunks[0]?.text).toBe(text);
  });

  it("splits an oversized narrative on paragraph boundaries and overlaps only those pieces", () => {
    const marker = "left side | right side";
    const first = `${marker} ${textOfLength(1_400, "oil")}`;
    const second = textOfLength(900, "nut");
    const narrative = `${first}\n\n${second}`;
    expect(narrative.length).toBeGreaterThan(CHUNK_HARD_MAX_CHARS);
    const recommendation =
      "GUIDELINE 8 Eat nuts and oil seeds in moderation as part of a balanced diet each day.";

    const chunks = chunk([
      unit("section", narrative, "GUIDELINE 7 › Visible fats"),
      unit("recommendation", recommendation, "GUIDELINE 8"),
    ]);

    const pieces = chunks.filter((item) => item.unitKind === "paragraph-split");
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((item) => item.sectionHeading === "GUIDELINE 7 › Visible fats")).toBe(
      true,
    );
    expect(pieces[0]?.text).toContain(marker);
    expect(pieces[1]?.text).not.toContain(marker);
    expect(pieces[1]?.text.startsWith(pieces[0]?.text.slice(-CHUNK_OVERLAP_CHARS) ?? "")).toBe(
      true,
    );
    expect(pieces[1]?.text.slice(CHUNK_OVERLAP_CHARS, CHUNK_OVERLAP_CHARS + 2)).toBe("\n\n");

    const guideline = chunks.find((item) => item.unitKind === "recommendation");
    expect(guideline?.text).toBe(recommendation);
  });

  it("keeps one oversized paragraph whole", () => {
    const text = `alpha oils | refined seeds ${textOfLength(2_100, "fat")}`;
    expect(text.length).toBeGreaterThan(CHUNK_HARD_MAX_CHARS);
    const chunks = chunk([unit("section", text)]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.unitKind).toBe("section");
    expect(chunks[0]?.text).toContain("alpha oils | refined seeds");
  });

  it("repeats the table header on each row split and never divides a row", () => {
    const header = "Food | Refrigerator";
    const rows = [header];
    for (let index = 0; index < 24; index += 1) {
      rows.push(`Dish ${String(index).padStart(2, "0")} | ${"cold ".repeat(20)}${index}`);
    }
    const giant = `Stew | ${"a".repeat(CHUNK_HARD_MAX_CHARS + 40)}`;
    const follow = `Rice | ${"1day".repeat(20)}`;
    const wide = [header, giant, follow];

    const built = buildChunks(
      parsed([
        unit("table", rows.join("\n"), "Diet table", rows),
        unit("table", wide.join("\n"), "Wide table", wide),
      ]),
      source,
    );
    const chunks = built.chunks;
    expect(built.rowSplits).toBe(chunks.length);
    expect(built.paragraphSplits).toBe(0);

    const diet = chunks.filter((item) => item.sectionHeading === "Diet table");
    expect(diet.length).toBeGreaterThan(1);
    expect(diet.every((item) => item.unitKind === "table")).toBe(true);
    expect(diet.every((item) => item.text.startsWith(`${header}\n`))).toBe(true);
    for (const row of rows.slice(1)) {
      const owners = diet.filter((item) => item.text.split("\n").includes(row));
      expect(owners).toHaveLength(1);
    }
    expect(diet[1]?.text.startsWith(diet[0]?.text.slice(-CHUNK_OVERLAP_CHARS) ?? "overlap")).toBe(
      false,
    );

    const wideChunks = chunks.filter((item) => item.sectionHeading === "Wide table");
    expect(wideChunks.length).toBeGreaterThan(1);
    const stew = wideChunks.find((item) => item.text.includes(giant));
    expect(stew?.text.startsWith(`${header}\n`)).toBe(true);
    expect(stew?.text).toContain(giant);
    const rice = wideChunks.find((item) => item.text.includes(follow));
    expect(rice?.text.startsWith(`${header}\n`)).toBe(true);
    expect(rice).not.toBe(stew);
  });

  it("keeps a storage-chart category whole above the hard max", () => {
    const text = [
      "Food | Type | Refrigerator",
      "Cooked meat or poultry | Leftovers | 3 to 4 days",
      textOfLength(2_200, "storage"),
    ].join("\n");
    expect(text.length).toBeGreaterThan(CHUNK_HARD_MAX_CHARS);

    const chunks = chunk(
      [unit("category", text, "Cold Food Storage Chart › Leftovers", text.split("\n"))],
      {
        ...source,
        id: "cold-storage-2023",
        name: "Cold Food Storage Chart",
      },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.id).toBe("cold-storage-2023:1");
    expect(chunks[0]?.unitKind).toBe("category");
    expect(chunks[0]?.text).toBe(text);
    expect(chunks[0]?.text).toMatch(/Cooked meat or poultry/);
    expect(chunks[0]?.text).toMatch(/3 to 4 days/);
  });

  it("merges a stub under 80 characters into the following chunk", () => {
    const stub = "Former Director, ICMR-NIN";
    const body = textOfLength(200, "visible fat");
    expect(stub.length).toBeLessThan(CHUNK_MIN_PROSE_CHARS);

    const chunks = chunk([
      unit("section", stub, "Committee"),
      unit("section", body, "How much visible fats do we need?"),
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionHeading).toBe("How much visible fats do we need?");
    expect(chunks[0]?.unitKind).toBe("section");
    expect(chunks[0]?.text).toBe(`${stub}\n\n${body}`);
  });

  it("keeps a chunk of exactly 80 characters on its own", () => {
    const exact = "y".repeat(CHUNK_MIN_PROSE_CHARS);
    const body = textOfLength(200, "body");
    const chunks = chunk([
      unit("section", exact, "Label"),
      unit("section", body, "Body"),
    ]);

    expect(chunks.map((item) => item.text)).toEqual([exact, body]);
  });

  it("appends a final stub to the previous chunk", () => {
    const body = textOfLength(200, "refrigerator");
    const stub = "Date Last Reviewed September 19, 2023";
    expect(stub.length).toBeLessThan(CHUNK_MIN_PROSE_CHARS);

    const chunks = chunk(
      [
        unit("section", body, "Cold Food Storage Chart"),
        unit("section", stub, "Cold Food Storage Chart"),
      ],
      { ...source, id: "cold-storage-2023", name: "Cold Food Storage Chart" },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionHeading).toBe("Cold Food Storage Chart");
    expect(chunks[0]?.text).toBe(`${body}\n\n${stub}`);
  });

  it("stores a parser list as a section", () => {
    const text = textOfLength(400, "fridge");
    const chunks = chunk([unit("list", text, "1. Chilling food")]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.unitKind).toBe("section");
    expect(chunks[0]?.text).toBe(text);
  });
});

describe("chunked corpus pages", () => {
  it("keeps cooked poultry with its refrigerator time and folds the short HTML stubs", async () => {
    const cold = CORPUS.find((document) => document.id === "cold-storage-2023");
    const fsa = CORPUS.find((document) => document.id === "fsa-chill-2017");
    if (!cold || !fsa) throw new Error("missing corpus entries");

    const [coldBytes, fsaBytes, coldFetch, fsaFetch] = await Promise.all([
      readFile("data/raw/cold-storage-2023/body"),
      readFile("data/raw/fsa-chill-2017/body"),
      readFile("data/raw/cold-storage-2023/fetch.json", "utf8"),
      readFile("data/raw/fsa-chill-2017/fetch.json", "utf8"),
    ]);
    const coldRecord = JSON.parse(coldFetch) as { retrievedAt: string };
    const fsaRecord = JSON.parse(fsaFetch) as { retrievedAt: string };
    const coldParsed = await parseCorpusDocument(coldBytes, cold);
    const fsaParsed = await parseCorpusDocument(fsaBytes, fsa);
    const coldChunks = chunkDocument(coldParsed, {
      id: cold.id,
      name: cold.name,
      publisher: cold.publisher,
      year: cold.year,
      sourceUrl: cold.sourceUrl,
      retrievedAt: coldRecord.retrievedAt,
    });
    const fsaChunks = chunkDocument(fsaParsed, {
      id: fsa.id,
      name: fsa.name,
      publisher: fsa.publisher,
      year: fsa.year,
      sourceUrl: fsa.sourceUrl,
      retrievedAt: fsaRecord.retrievedAt,
    });

    const leftovers = coldChunks.filter((item) => /Cooked meat or poultry/.test(item.text));
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]?.unitKind).toBe("category");
    expect(leftovers[0]?.text).toMatch(/3 to 4 days/);
    expect(leftovers[0]?.sectionHeading).toMatch(/Leftovers/);
    expect(coldChunks.some((item) => item.text.trim() === "Date Last Reviewed September 19, 2023")).toBe(
      false,
    );
    expect(coldChunks.at(-1)?.text).toMatch(/Date Last Reviewed/);
    expect(coldChunks.at(-1)?.text).toMatch(/September 19, 2023/);
    expect(coldChunks.every((item) => item.unitKind !== "paragraph-split")).toBe(true);

    expect(fsaChunks.some((item) => item.unitKind === "paragraph-split")).toBe(false);
    expect(fsaChunks.some((item) => item.text.trim() === "Guidance")).toBe(false);
    expect(fsaChunks[0]?.text).toMatch(/^Guidance\n\n/);
    expect(fsaChunks.some((item) => /0 and 5/.test(item.text))).toBe(true);

    for (const item of [...coldChunks, ...fsaChunks]) {
      expect(item.text.trim().length).toBeGreaterThan(0);
      expect(item.sectionHeading.trim().length).toBeGreaterThan(0);
      expect(item.text.length).toBeGreaterThanOrEqual(CHUNK_MIN_PROSE_CHARS);
      expect(item.retrievedAt.length).toBeGreaterThan(0);
    }
  });
});
