import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimCitations } from "../app/chat";
import { SourcesPanel } from "../app/sources-panel";
import { POST } from "../app/api/chat/route";
import { NONSENSE_ANSWER, isUnclearInquiry } from "./clarify";
import { dietRetrievalQuery, setChatDependencies } from "./chat";
import { CORPUS } from "./corpus";
import { notInCorpusAnswer } from "./coverage";
import { GROUNDED_DRAFT_SCHEMA_NAME } from "./prompt";
import { citationLinks, sourceLocator } from "./presentClaims";
import { REWRITE_SCHEMA_NAME } from "./rewrite";
import {
  allowDespiteDecline,
  isFoodNutrientLookup,
  isGeneralDietQuestion,
  isPopulationFluidQuestion,
  SCOPE_SCHEMA_NAME,
} from "./scope";
import {
  nutritionDbPath,
  openConversationStore,
  setConversationStore,
  type ConversationStore,
} from "./store";
import type { Claim, ModelClient, RetrievedChunk, Source } from "./types";

const directories: string[] = [];
const stores: ConversationStore[] = [];

afterEach(async () => {
  setChatDependencies(null);
  setConversationStore(null);
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type CompleteInput = {
  schemaName: string;
  messages: { role: string; content: string }[];
};

function indexedPassage(file: string, id: string): { heading: string; text: string } {
  const body = readFileSync(join(process.cwd(), file), "utf8");
  const marker = `## ${id} `;
  const start = body.indexOf(marker);
  if (start < 0) throw new Error(`missing ${id} in ${file}`);
  const rest = body.slice(start);
  const next = rest.indexOf("\n---\n");
  const block = next < 0 ? rest : rest.slice(0, next);
  const parts = block.split(/\n\n/);
  const heading = parts[1]?.replace(/^\*\*|\*\*$/g, "").trim() ?? "";
  const text = parts.slice(2).join("\n\n").trim();
  if (heading.length === 0 || text.length === 0) {
    throw new Error(`unreadable indexed passage ${id}`);
  }
  return { heading, text };
}

function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function spanBetween(text: string, start: string, end: string): string {
  const collapsed = flat(text);
  const from = collapsed.indexOf(start);
  const to = collapsed.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`missing span "${start}" .. "${end}"`);
  return collapsed.slice(from, to + end.length);
}

function passageChunk(
  documentId: RetrievedChunk["documentId"],
  id: string,
  passage: { heading: string; text: string },
  overrides: Partial<RetrievedChunk> = {},
): RetrievedChunk {
  const document = CORPUS.find((item) => item.id === documentId);
  if (!document) throw new Error(documentId);
  return {
    id,
    documentId,
    documentName: document.name,
    publisher: document.publisher,
    year: document.year,
    sourceUrl: document.sourceUrl,
    sectionHeading: passage.heading,
    text: passage.text,
    score: 0.84,
    ...overrides,
  };
}

function scriptedModel(
  respond: (input: CompleteInput) => unknown,
): ModelClient & { calls: CompleteInput[] } {
  const calls: CompleteInput[] = [];
  return {
    calls,
    async complete(input) {
      const recorded = {
        schemaName: input.schemaName,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
      calls.push(recorded);
      return respond(recorded);
    },
  };
}

function wire(model: ModelClient, chunks: RetrievedChunk[]) {
  const retrieved: { query: string; documentId?: string }[] = [];
  setChatDependencies({
    model,
    retrieve: async (request) => {
      retrieved.push({ query: request.query, documentId: request.documentId });
      return chunks;
    },
  });
  return retrieved;
}

async function tempStore(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-quality-"));
  directories.push(directory);
  const store = openConversationStore(nutritionDbPath(directory));
  stores.push(store);
  setConversationStore(store);
}

async function post(message: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function messageOf(json: Record<string, unknown>): {
  answer: string;
  claims: Claim[];
  coverage: string;
  declined: boolean;
} {
  return json.message as {
    answer: string;
    claims: Claim[];
    coverage: string;
    declined: boolean;
  };
}

describe("answer quality", () => {
  it("answers a hydration question from the indexed water and fluid passages", async () => {
    const question = "How much water should I drink daily?";
    expect(isUnclearInquiry(question)).toBe(false);
    expect(isPopulationFluidQuestion(question)).toBe(true);
    expect(allowDespiteDecline(question, "calorie_target")).toBe(true);
    const query = dietRetrievalQuery(question, question);
    expect(query).toContain("adequate water");
    expect(query).toContain("glasses of fluid");

    const dgi = indexedPassage("data/chunks/dgi-2024.md", "dgi-2024:434");
    const eatwell = indexedPassage("data/chunks/eatwell-2018.md", "eatwell-2018:14");
    const waterQuote = spanBetween(
      dgi.text,
      "about eight",
      "of water including beverages per day",
    );
    const heatQuote = spanBetween(
      dgi.text,
      "During very hot weather",
      "lost through sweat.",
    );
    const fluidQuote = spanBetween(
      eatwell.text,
      "Aim to drink 6-8 glasses of fluid every day",
      "tea and coffee all count.",
    );
    const dgiChunk = passageChunk("dgi-2024", "dgi-2024:434", dgi);
    const eatwellChunk = passageChunk("eatwell-2018", "eatwell-2018:14", eatwell);

    await tempStore();
    const retrieved = wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "decline", category: "calorie_target" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) {
          return { query: question };
        }
        if (input.schemaName === GROUNDED_DRAFT_SCHEMA_NAME) {
          return {
            covered: true,
            claims: [
              {
                text: "Drink about eight glasses, approximately two litres, of water including beverages per day.",
                quote: waterQuote,
                chunkId: dgiChunk.id,
              },
              {
                text: "During very hot weather and vigorous physical activity, this requirement increases because water is lost through sweat.",
                quote: heatQuote,
                chunkId: dgiChunk.id,
              },
              {
                text: "Aim to drink 6-8 glasses of fluid every day. Water, lower fat milk and sugar-free drinks including tea and coffee all count.",
                quote: fluidQuote,
                chunkId: eatwellChunk.id,
              },
            ],
          };
        }
        throw new Error(input.schemaName);
      }),
      [dgiChunk, eatwellChunk],
    );

    const { status, json } = await post(question);
    expect(status).toBe(200);
    expect(retrieved).toEqual([{ query, documentId: undefined }]);
    const message = messageOf(json);
    expect(message.coverage).toBe("answered");
    expect(message.declined).toBe(false);
    expect(message.claims).toHaveLength(3);
    expect(message.answer).toContain("water including beverages");
    expect(message.answer).toContain("6-8 glasses of fluid");
    expect(message.answer).not.toMatch(/conflict/i);
    expect(message.answer.indexOf("**Dietary Guidelines for Indians**")).toBeLessThan(
      message.answer.indexOf("**The Eatwell Guide booklet**"),
    );
    expect(message.answer).toContain("\n\n");

    const [water, heat, fluid] = message.claims;
    expect(water?.source).toMatchObject({
      documentName: dgiChunk.documentName,
      publisher: dgiChunk.publisher,
      year: dgiChunk.year,
      url: dgiChunk.sourceUrl,
      sectionHeading: dgi.heading,
    });
    expect(heat?.source.url).toBe(dgiChunk.sourceUrl);
    expect(fluid?.source).toMatchObject({
      documentName: eatwellChunk.documentName,
      publisher: eatwellChunk.publisher,
      year: eatwellChunk.year,
      url: eatwellChunk.sourceUrl,
      sectionHeading: eatwell.heading,
    });
    expect(fluid?.text).toContain("fluid");
    expect(fluid?.text).not.toMatch(/\bwater only\b/i);
    expect(Object.keys(water?.source ?? {})).toEqual([
      "documentName",
      "publisher",
      "year",
      "url",
      "sectionHeading",
    ]);

    const links = citationLinks(message.claims);
    expect(links.map((link) => link.href)).toEqual([
      dgiChunk.sourceUrl,
      dgiChunk.sourceUrl,
      eatwellChunk.sourceUrl,
    ]);
    const html = renderToStaticMarkup(
      createElement(ClaimCitations, { claims: message.claims }),
    );
    expect(html).toContain(`href="${dgiChunk.sourceUrl}"`);
    expect(html).toContain(`href="${eatwellChunk.sourceUrl}"`);
    expect(html).toContain("<a ");
  });

  it("lets a general daily diet question reach both dietary documents", async () => {
    const question = "Hey what should I eat on daily basis?";
    expect(isUnclearInquiry(question)).toBe(false);
    expect(isGeneralDietQuestion(question)).toBe(true);
    expect(allowDespiteDecline(question, "medical_advice")).toBe(true);
    expect(allowDespiteDecline("What should I eat for my diabetes?", "medical_advice")).toBe(
      false,
    );
    const query = dietRetrievalQuery(question, question);
    expect(query).toContain("balanced diet");
    expect(query).toContain("Eatwell Guide");

    const dgi = indexedPassage("data/chunks/dgi-2024.md", "dgi-2024:22");
    const eatwell = indexedPassage("data/chunks/eatwell-2018.md", "eatwell-2018:4");
    const dgiQuote = spanBetween(
      dgi.text,
      "Adequate intake of all the essential nutrients",
      "maintain good health.",
    );
    const eatwellQuote = spanBetween(
      eatwell.text,
      "Eat at least 5 portions of a variety of fruit and vegetables every day",
      "every day",
    );
    const dgiChunk = passageChunk("dgi-2024", "dgi-2024:22", dgi);
    const eatwellChunk = passageChunk("eatwell-2018", "eatwell-2018:4", eatwell);

    await tempStore();
    const retrieved = wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "decline", category: "calorie_target" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: question };
        return {
          covered: true,
          claims: [
            {
              text: "Adequate intake of essential nutrients through a balanced diet is needed to maintain good health.",
              quote: dgiQuote,
              chunkId: dgiChunk.id,
            },
            {
              text: "Eat at least 5 portions of a variety of fruit and vegetables every day.",
              quote: eatwellQuote,
              chunkId: eatwellChunk.id,
            },
          ],
        };
      }),
      [dgiChunk, eatwellChunk],
    );

    const { status, json } = await post(question);
    expect(status).toBe(200);
    expect(retrieved[0]?.documentId).toBeUndefined();
    expect(retrieved[0]?.query).toBe(query);
    const message = messageOf(json);
    expect(message.coverage).toBe("answered");
    expect(message.claims.map((claim) => claim.source.url)).toEqual([
      dgiChunk.sourceUrl,
      eatwellChunk.sourceUrl,
    ]);
    expect(message.answer).not.toMatch(/\b\d[\d,]*(?:\.\d+)?\s*(?:k?cal|calories)\b/i);
    expect(message.answer).not.toMatch(/you should eat|your target|your plan/i);
    expect(message.claims[1]?.text).toContain("5 portions");
  });

  it("keeps leftover storage conditions and cites the supporting passage", async () => {
    const question = "How long can cooked leftovers stay in the fridge?";
    const storage = indexedPassage(
      "data/chunks/cold-storage-2023.md",
      "cold-storage-2023:14",
    );
    const fsa = indexedPassage("data/chunks/fsa-chill-2017.md", "fsa-chill-2017:2");
    const storageQuote = spanBetween(
      storage.text,
      "Refrigerator",
      "Leftovers | Cooked meat or poultry | 3 to 4 days",
    );
    const fsaQuote = spanBetween(
      fsa.text,
      "Leftovers can be eaten cold",
      "within 48 hours",
    );
    const storageChunk = passageChunk("cold-storage-2023", "cold-storage-2023:14", storage);
    const fsaChunk = passageChunk("fsa-chill-2017", "fsa-chill-2017:2", fsa);

    await tempStore();
    wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "allow", category: "none" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: question };
        return {
          covered: true,
          claims: [
            {
              text: "Cooked meat or poultry leftovers keep for 3 to 4 days in the refrigerator.",
              quote: storageQuote,
              chunkId: storageChunk.id,
            },
            {
              text: "Leftovers that were cooked properly, cooled, and put in the fridge within two hours should be eaten within 48 hours.",
              quote: fsaQuote,
              chunkId: fsaChunk.id,
            },
          ],
        };
      }),
      [storageChunk, fsaChunk],
    );

    const { status, json } = await post(question);
    expect(status).toBe(200);
    const message = messageOf(json);
    expect(message.coverage).toBe("answered");
    expect(message.answer).toContain("3 to 4 days");
    expect(message.answer).toContain("48 hours");
    expect(message.answer).toContain("within two hours");
    expect(message.claims.map((claim) => claim.source.url)).toEqual([
      storageChunk.sourceUrl,
      fsaChunk.sourceUrl,
    ]);
    expect(message.claims[0]?.source.sectionHeading).toBe(storage.heading);
    expect(message.claims[1]?.source.sectionHeading).toBe(fsa.heading);
  });

  it("abstains on an individual-food calorie lookup instead of inventing a number", async () => {
    const question = "How many calories are in 100 g of an apple?";
    expect(isFoodNutrientLookup(question)).toBe(true);
    expect(isUnclearInquiry(question)).toBe(false);
    expect(allowDespiteDecline(question, "calorie_target")).toBe(true);
    expect(allowDespiteDecline("How many calories should I eat to lose weight?", "calorie_target")).toBe(
      false,
    );

    const eatwell = indexedPassage("data/chunks/eatwell-2018.md", "eatwell-2018:4");
    const quote = spanBetween(
      eatwell.text,
      "Have some dairy or dairy alternatives",
      "lower sugar options",
    );
    expect(quote).not.toContain("52");
    const chunk = passageChunk("eatwell-2018", "eatwell-2018:4", eatwell);

    await tempStore();
    const retrieved = wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "decline", category: "calorie_target" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: question };
        return {
          covered: true,
          claims: [
            {
              text: "An apple has 52 calories in 100 g.",
              quote,
              chunkId: chunk.id,
            },
          ],
        };
      }),
      [chunk],
    );

    const { status, json } = await post(question);
    expect(status).toBe(200);
    expect(retrieved).toHaveLength(1);
    const message = messageOf(json);
    expect(message.coverage).toBe("not_in_corpus");
    expect(message.claims).toEqual([]);
    expect(message.declined).toBe(false);
    expect(message.answer).toBe(notInCorpusAnswer("all"));
    expect(message.answer).not.toContain("52");
    expect(JSON.stringify(message)).not.toContain("52");
  });

  it("asks for clarification on GAVSV and does not retrieve", async () => {
    await tempStore();
    const calls: string[] = [];
    const retrieved = wire(
      scriptedModel((input) => {
        calls.push(input.schemaName);
        return { decision: "allow", category: "none" };
      }),
      [],
    );

    const { status, json } = await post("GAVSV");
    expect(status).toBe(200);
    expect(messageOf(json)).toMatchObject({
      answer: NONSENSE_ANSWER,
      claims: [],
      declined: false,
      coverage: "clarify",
    });
    expect(calls).toEqual([]);
    expect(retrieved).toEqual([]);
  });

  it("cites title and URL when the chunk has no section and invents neither", async () => {
    const question = "How long can cooked chicken stay in the fridge?";
    const storage = indexedPassage(
      "data/chunks/cold-storage-2023.md",
      "cold-storage-2023:14",
    );
    const quote = spanBetween(
      storage.text,
      "Leftovers | Cooked meat or poultry | 3 to 4 days",
      "3 to 4 days",
    );
    const chunk = passageChunk("cold-storage-2023", "cold-storage-2023:14", storage, {
      sectionHeading: " ",
    });

    await tempStore();
    wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "allow", category: "none" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: question };
        return {
          covered: true,
          claims: [
            {
              text: "Cooked meat or poultry leftovers keep for 3 to 4 days.",
              quote,
              chunkId: chunk.id,
            },
          ],
        };
      }),
      [chunk],
    );

    const { status, json } = await post(question);
    expect(status).toBe(200);
    const message = messageOf(json);
    const source = message.claims[0]?.source as Source;
    expect(source.documentName).toBe(chunk.documentName);
    expect(source.url).toBe(chunk.sourceUrl);
    expect(source.publisher).toBe(chunk.publisher);
    expect(source.year).toBe(chunk.year);
    expect(source.sectionHeading).toBe("");
    expect(source).not.toHaveProperty("page");
    expect(sourceLocator(source)).toBe(`${source.publisher}, ${source.year}`);
    expect(citationLinks(message.claims)[0]).toEqual({
      href: chunk.sourceUrl,
      label: `${chunk.documentName} (${chunk.publisher}, ${chunk.year})`,
    });
    const panel = renderToStaticMarkup(
      createElement(SourcesPanel, { sources: [source] }),
    );
    expect(panel).toContain(`href="${chunk.sourceUrl}"`);
    expect(panel).not.toContain("Page ");
  });

  it("abstains when the retrieved passages do not support the question", async () => {
    const question = "How long can opened juice stay in the fridge?";
    const eatwell = indexedPassage("data/chunks/eatwell-2018.md", "eatwell-2018:4");
    const quote = spanBetween(
      eatwell.text,
      "Have some dairy or dairy alternatives",
      "lower sugar options",
    );
    const chunk = passageChunk("eatwell-2018", "eatwell-2018:4", eatwell);

    await tempStore();
    wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "allow", category: "none" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: question };
        return { covered: false, claims: [] };
      }),
      [chunk],
    );

    const uncovered = await post(question);
    expect(uncovered.status).toBe(200);
    expect(messageOf(uncovered.json).coverage).toBe("not_in_corpus");
    expect(messageOf(uncovered.json).claims).toEqual([]);

    await tempStore();
    wire(
      scriptedModel((input) => {
        if (input.schemaName === SCOPE_SCHEMA_NAME) {
          return { decision: "allow", category: "none" };
        }
        if (input.schemaName === REWRITE_SCHEMA_NAME) return { query: question };
        return {
          covered: true,
          claims: [
            {
              text: "Opened juice keeps for 9 days in the refrigerator.",
              quote,
              chunkId: chunk.id,
            },
          ],
        };
      }),
      [chunk],
    );

    const invented = await post(question);
    expect(invented.status).toBe(200);
    const message = messageOf(invented.json);
    expect(message.coverage).toBe("not_in_corpus");
    expect(message.claims).toEqual([]);
    expect(message.answer).not.toContain("9 days");
    expect(message.answer).not.toContain(chunk.sourceUrl);
  });
});
