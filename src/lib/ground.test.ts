import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORPUS, type CorpusDocumentId } from "./corpus";
import { notInCorpusAnswer } from "./coverage";
import { PROFESSIONAL_REFUSAL } from "./decline";
import { collapseWhitespace, ground, MIN_QUOTE_CHARS } from "./ground";
import { answerFromClaims, uniqueSources } from "./presentClaims";
import type { DraftClaim, GroundedDraft, RetrievedChunk } from "./types";

const CHICKEN = "Cooked chicken keeps for 3 to 4 days in the refrigerator.";
const QUOTE_20 = "Cooked chicken keeps";
const QUOTE_19 = "Cooked chicken keep";

function manifest(id: CorpusDocumentId) {
  const document = CORPUS.find((item) => item.id === id);
  if (!document) throw new Error(`unknown document ${id}`);
  return document;
}

function chunk(
  id: string,
  text: string,
  overrides: Partial<RetrievedChunk> = {},
): RetrievedChunk {
  const documentId = id.slice(0, id.lastIndexOf(":")) as CorpusDocumentId;
  const document = manifest(documentId);
  return {
    id,
    documentId,
    documentName: document.name,
    publisher: document.publisher,
    year: document.year,
    sourceUrl: document.sourceUrl,
    sectionHeading: "Section",
    text,
    score: 0.91,
    ...overrides,
  };
}

function draftClaim(
  text: string,
  quote: string,
  chunkId: string,
): DraftClaim {
  return { text, quote, chunkId };
}

function urlsIn(value: unknown): string[] {
  return JSON.stringify(value).match(/https?:\/\/[^"\\]+/g) ?? [];
}

describe("citation binding", () => {
  it("ships one valid claim with the source copied from the chunk", () => {
    const retrieved = chunk("cold-storage-2023:4", CHICKEN, {
      sectionHeading: "Leftovers › Cooked poultry",
    });
    const result = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, CHICKEN, retrieved.id)],
      },
      [retrieved],
      "all",
    );

    expect(result).toEqual({
      answer: CHICKEN,
      claims: [
        {
          text: CHICKEN,
          source: {
            documentName: retrieved.documentName,
            publisher: retrieved.publisher,
            year: retrieved.year,
            url: retrieved.sourceUrl,
            sectionHeading: "Leftovers › Cooked poultry",
          },
        },
      ],
      declined: false,
      coverage: "answered",
    });
    expect(result.answer.startsWith("**")).toBe(false);
    expect(result.answer).not.toContain(retrieved.documentName);
    expect(urlsIn(result)).toEqual([retrieved.sourceUrl]);
    expect(result.claims[0]?.source.url).toBe(retrieved.sourceUrl);
  });

  it("drops a quote that is not a verbatim span of that chunk", () => {
    const retrieved = chunk("cold-storage-2023:4", CHICKEN);
    const paraphrase = draftClaim(
      "Cooked turkey keeps for 3 to 4 days in the refrigerator.",
      "Cooked turkey keeps for 3 to 4 days in the refrigerator.",
      retrieved.id,
    );
    const differentCase = draftClaim(
      CHICKEN,
      CHICKEN.toLowerCase(),
      retrieved.id,
    );

    for (const claim of [paraphrase, differentCase]) {
      const result = ground(
        { covered: true, claims: [claim] },
        [retrieved],
        "all",
      );
      expect(result.coverage, claim.quote).toBe("not_in_corpus");
      expect(result.claims).toEqual([]);
      expect(result.declined).toBe(false);
    }
  });

  it("keeps a quote that matches only after whitespace is collapsed", () => {
    const retrieved = chunk(
      "cold-storage-2023:4",
      "Cooked chicken\nkeeps   for 3 to 4 days in the refrigerator.",
    );
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim(
            CHICKEN,
            "Cooked   chicken\n\nkeeps for 3 to 4 days",
            retrieved.id,
          ),
        ],
      },
      [retrieved],
      undefined,
    );

    expect(collapseWhitespace("Cooked   chicken\n\nkeeps for 3 to 4 days").length).toBeGreaterThanOrEqual(
      MIN_QUOTE_CHARS,
    );
    expect(result.coverage).toBe("answered");
    expect(result.claims).toHaveLength(1);
  });

  it("drops a quote that matches a different retrieved chunk than chunkId", () => {
    const chicken = chunk("cold-storage-2023:4", CHICKEN);
    const oils = chunk(
      "dgi-2024:12",
      "Adults are advised to limit visible fats in the daily diet.",
    );
    const result = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, CHICKEN, oils.id)],
      },
      [chicken, oils],
      "all",
    );

    expect(result.coverage).toBe("not_in_corpus");
    expect(result.claims).toEqual([]);
  });

  it("drops a quote of 19 characters and keeps a quote of 20", () => {
    const retrieved = chunk("cold-storage-2023:4", CHICKEN);
    expect(QUOTE_19.length).toBe(19);
    expect(QUOTE_20.length).toBe(20);
    expect(MIN_QUOTE_CHARS).toBe(20);

    const short = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, `  ${QUOTE_19}  `, retrieved.id)],
      },
      [retrieved],
      "all",
    );
    expect(collapseWhitespace(`  ${QUOTE_19}  `)).toHaveLength(19);
    expect(short.coverage).toBe("not_in_corpus");
    expect(short.claims).toEqual([]);

    const exact = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, `Cooked\n\nchicken   keeps`, retrieved.id)],
      },
      [retrieved],
      "all",
    );
    expect(collapseWhitespace("Cooked\n\nchicken   keeps")).toBe(QUOTE_20);
    expect(exact.coverage).toBe("answered");
    expect(exact.claims.map((claim) => claim.text)).toEqual([CHICKEN]);
  });

  it("drops a chunkId that was not in this retrieval", () => {
    const retrieved = chunk("cold-storage-2023:4", CHICKEN);
    const result = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, CHICKEN, "cold-storage-2023:99")],
      },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("not_in_corpus");
    expect(result.claims).toEqual([]);
  });

  it("drops empty or whitespace claim text", () => {
    const retrieved = chunk("cold-storage-2023:4", CHICKEN);
    const result = ground(
      {
        covered: true,
        claims: [draftClaim("   \n  ", CHICKEN, retrieved.id)],
      },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("not_in_corpus");
    expect(result.claims).toEqual([]);
  });

  it("drops a quote that matches only the section heading", () => {
    const heading = "Cooked chicken keeps for 3 to 4 days in the refrigerator.";
    const retrieved = chunk(
      "cold-storage-2023:4",
      "See the category row for the food and its refrigerator time.",
      { sectionHeading: heading },
    );
    const result = ground(
      {
        covered: true,
        claims: [draftClaim(heading, heading, retrieved.id)],
      },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("not_in_corpus");
    expect(result.claims).toEqual([]);
  });
});

describe("coverage refusal", () => {
  const retrieved = chunk("eatwell-2018:3", CHICKEN);

  it("refuses immediately when covered is false", () => {
    const result = ground(
      {
        covered: false,
        claims: [draftClaim("Avoid sugar for your diabetes.", CHICKEN, retrieved.id)],
      },
      [retrieved],
      "eatwell-2018",
    );

    expect(result).toEqual({
      answer: notInCorpusAnswer("eatwell-2018"),
      claims: [],
      declined: false,
      coverage: "not_in_corpus",
    });
  });

  it("refuses when covered is true and claims is empty", () => {
    const result = ground({ covered: true, claims: [] }, [retrieved], "all");

    expect(result).toEqual({
      answer: notInCorpusAnswer("all"),
      claims: [],
      declined: false,
      coverage: "not_in_corpus",
    });
  });

  it("names the scope when every claim fails verification", () => {
    const full = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, "not in the chunk at all here", "missing")],
      },
      [retrieved],
      undefined,
    );
    const filtered = ground(
      {
        covered: true,
        claims: [draftClaim(CHICKEN, QUOTE_19, retrieved.id)],
      },
      [retrieved],
      "eatwell-2018",
    );

    expect(full.answer).toBe(notInCorpusAnswer("all"));
    expect(full.answer).toContain("Dietary Guidelines for Indians");
    expect(full.answer).toContain("Food Standards Agency, 2017");
    expect(filtered.answer).toBe(
      "The guidance I searched does not cover that. I looked in: The Eatwell Guide booklet (Public Health England, 2018).",
    );
    expect(filtered.answer).not.toContain("Dietary Guidelines");
    expect(filtered.claims).toEqual([]);
    expect(filtered.declined).toBe(false);
  });
});

describe("answer assembly", () => {
  const fats = "Adults are advised to limit visible fats in the daily diet.";
  const oils = "The guide describes oils and spreads as foods to use in small amounts.";
  const chill = "Chill food within two hours of cooking and serving.";
  const defrost = "Defrost food in the fridge, not on the kitchen counter.";

  function claimOn(retrieved: RetrievedChunk, text: string): DraftClaim {
    return draftClaim(text, text, retrieved.id);
  }

  it("keeps surviving claim texts in draft order and drops a bad quote", () => {
    const retrieved = chunk(
      "dgi-2024:8",
      `${fats} ${oils} A third sentence that is long enough to quote.`,
    );
    const third = "A third sentence that is long enough to quote.";
    const result = ground(
      {
        covered: true,
        claims: [
          claimOn(retrieved, fats),
          draftClaim(oils, "this quote is not in the chunk", retrieved.id),
          claimOn(retrieved, third),
        ],
      },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("answered");
    expect(result.answer).toBe(`${fats} ${third}`);
    expect(result.claims.map((claim) => claim.text)).toEqual([fats, third]);
  });

  it("writes one document as claim texts with no document prefix", () => {
    const retrieved = chunk(
      "cold-storage-2023:4",
      `${CHICKEN} Leftovers belong in a covered container in the fridge. The chart lists the food beside its refrigerator time.`,
    );
    const second = "Leftovers belong in a covered container in the fridge.";
    const third = "The chart lists the food beside its refrigerator time.";
    const result = ground(
      {
        covered: true,
        claims: [
          claimOn(retrieved, third),
          claimOn(retrieved, CHICKEN),
          claimOn(retrieved, second),
        ],
      },
      [retrieved],
      "all",
    );

    expect(result.answer).toBe(`${third} ${CHICKEN} ${second}`);
    expect(result.answer).not.toContain("**");
    expect(result.answer).not.toContain(retrieved.documentName);
  });

  it("writes several documents as blocks in corpus order", () => {
    const dgi = chunk("dgi-2024:8", fats);
    const eatwell = chunk("eatwell-2018:2", oils);
    const storage = chunk("cold-storage-2023:4", CHICKEN);
    const fsa = chunk("fsa-chill-2017:1", `${chill} ${defrost}`);
    const result = ground(
      {
        covered: true,
        claims: [
          claimOn(eatwell, oils),
          claimOn(fsa, defrost),
          claimOn(dgi, fats),
          claimOn(storage, CHICKEN),
          claimOn(fsa, chill),
        ],
      },
      [dgi, eatwell, storage, fsa],
      "all",
    );

    expect(result.answer).toBe(
      [
        `**${dgi.documentName}** (${dgi.publisher}, ${dgi.year}): ${fats}`,
        `**${eatwell.documentName}** (${eatwell.publisher}, ${eatwell.year}): ${oils}`,
        `**${storage.documentName}** (${storage.publisher}, ${storage.year}): ${CHICKEN}`,
        `**${fsa.documentName}** (${fsa.publisher}, ${fsa.year}): ${defrost} ${chill}`,
      ].join("\n\n"),
    );
    expect(result.answer).not.toMatch(
      /more reliable|the guidelines say|the correct guidance|both authorities agree|winner/i,
    );
    expect(urlsIn(result.answer)).toEqual([]);
    expect(urlsIn(result.claims)).toEqual([
      dgi.sourceUrl,
      eatwell.sourceUrl,
      storage.sourceUrl,
      fsa.sourceUrl,
      fsa.sourceUrl,
    ]);
    expect(eatwell.publisher).toBe("Public Health England (GOV.UK)");
  });

  it("shows both blocks when the documents disagree", () => {
    const dgiText = "Visible oils are limited to a small share of the day's diet.";
    const eatwellText = "Oils and spreads are a food group used only in small amounts.";
    const dgi = chunk("dgi-2024:8", dgiText);
    const eatwell = chunk("eatwell-2018:2", eatwellText);
    const result = ground(
      {
        covered: true,
        claims: [claimOn(eatwell, eatwellText), claimOn(dgi, dgiText)],
      },
      [eatwell, dgi],
      "all",
    );

    expect(result.answer).toContain(dgiText);
    expect(result.answer).toContain(eatwellText);
    expect(result.answer.indexOf(dgi.documentName)).toBeLessThan(
      result.answer.indexOf(eatwell.documentName),
    );
    expect(result.claims).toHaveLength(2);
    expect(result.answer).not.toMatch(/more reliable|prefer|instead|winner/i);
  });

  it("keeps one copy when the same document states the same sentence twice", () => {
    const passage = [
      "Food | Type | Refrigerator [40°F (4°C) or below] | Freezer [0°F (-18°C) or below]",
      "Fin Fish | Fatty Fish (bluefish, catfish, mackerel, mullet, salmon, tuna, etc.) | 1 - 3 Days | 2 - 3 Months",
      "Fin Fish | Lean Fish (cod, flounder, haddock, halibut, sole, etc.) | 1 - 3 Days | 6 - 8 Months",
    ].join("\n");
    const retrieved = chunk("cold-storage-2023:10", passage, {
      sectionHeading: "Cold Food Storage Chart › Fin Fish",
    });
    const sentence = "Fin fish can be kept in the refrigerator for 1 - 3 days.";
    const fatty =
      "Fin Fish | Fatty Fish (bluefish, catfish, mackerel, mullet, salmon, tuna, etc.) | 1 - 3 Days";
    const lean =
      "Fin Fish | Lean Fish (cod, flounder, haddock, halibut, sole, etc.) | 1 - 3 Days";
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim(sentence, fatty, retrieved.id),
          draftClaim(`  ${sentence.toLowerCase()}  `, lean, retrieved.id),
        ],
      },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("answered");
    expect(result.answer).toBe(sentence);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.source.sectionHeading).toBe(
      "Cold Food Storage Chart › Fin Fish",
    );
    expect(uniqueSources(result.claims.map((claim) => claim.source))).toHaveLength(1);
    expect(answerFromClaims(result.claims)).toBe(sentence);

    const source = result.claims[0]!.source;
    expect(
      answerFromClaims([
        { text: sentence, source },
        { text: sentence, source },
      ]),
    ).toBe(sentence);
    expect(uniqueSources([source, source])).toEqual([source]);
  });

  it("keeps the same sentence when two documents each state it", () => {
    const sentence = "Chill leftovers within two hours of cooking.";
    const storage = chunk("cold-storage-2023:4", sentence);
    const fsa = chunk("fsa-chill-2017:1", sentence);
    const result = ground(
      {
        covered: true,
        claims: [claimOn(fsa, sentence), claimOn(storage, sentence)],
      },
      [storage, fsa],
      "all",
    );

    expect(result.claims).toHaveLength(2);
    expect(result.answer).toBe(
      [
        `**${storage.documentName}** (${storage.publisher}, ${storage.year}): ${sentence}`,
        `**${fsa.documentName}** (${fsa.publisher}, ${fsa.year}): ${sentence}`,
      ].join("\n\n"),
    );
    expect(answerFromClaims(result.claims)).toBe(result.answer);
  });
});

describe("output scan while binding", () => {
  const cleanText = "Adults are advised to limit visible fats in the daily diet.";

  it("refuses the whole turn when one claim is medical advice", () => {
    const clean = chunk("dgi-2024:8", cleanText);
    const medical = chunk(
      "dgi-2024:9",
      "The booklet discusses sugar alongside other carbohydrate foods.",
    );
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim(cleanText, cleanText, clean.id),
          draftClaim(
            "Avoid sugar for your diabetes.",
            "The booklet discusses sugar alongside other carbohydrate foods.",
            medical.id,
          ),
        ],
      },
      [clean, medical],
      "all",
    );

    expect(result).toEqual({
      answer: PROFESSIONAL_REFUSAL,
      claims: [],
      declined: true,
      coverage: "declined",
    });
    expect(result.answer).not.toContain(cleanText);
  });

  it("refuses the whole turn when a sibling claim states a calorie target", () => {
    const clean = chunk("cold-storage-2023:4", CHICKEN);
    const calorie = chunk(
      "eatwell-2018:6",
      "Energy needs differ across the population described in the guide.",
    );
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim(CHICKEN, CHICKEN, clean.id),
          draftClaim(
            "Eat 1,500 calories a day to lose weight.",
            "Energy needs differ across the population described in the guide.",
            calorie.id,
          ),
        ],
      },
      [clean, calorie],
      "all",
    );

    expect(result.coverage).toBe("declined");
    expect(result.declined).toBe(true);
    expect(result.answer).toBe(PROFESSIONAL_REFUSAL);
    expect(result.claims).toEqual([]);
  });

  it("drops a personal-plan claim and still ships the sibling", () => {
    const storage = chunk("cold-storage-2023:4", CHICKEN);
    const clean = chunk("dgi-2024:8", cleanText);
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim(
            "You should eat the leftovers within 4 days.",
            CHICKEN,
            storage.id,
          ),
          draftClaim(cleanText, cleanText, clean.id),
        ],
      },
      [storage, clean],
      "all",
    );

    expect(result.coverage).toBe("answered");
    expect(result.declined).toBe(false);
    expect(result.answer).toBe(cleanText);
    expect(result.claims.map((claim) => claim.text)).toEqual([cleanText]);
    expect(result.answer).not.toBe(PROFESSIONAL_REFUSAL);
  });

  it("uses the coverage refusal when the only claim is a personal plan", () => {
    const storage = chunk("fsa-chill-2017:1", CHICKEN);
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim("I recommend you eat the leftovers tonight.", CHICKEN, storage.id),
        ],
      },
      [storage],
      "fsa-chill-2017",
    );

    expect(result).toEqual({
      answer: notInCorpusAnswer("fsa-chill-2017"),
      claims: [],
      declined: false,
      coverage: "not_in_corpus",
    });
    expect(result.answer).not.toBe(PROFESSIONAL_REFUSAL);
  });

  it("drops a blend-pattern claim and keeps a sibling", () => {
    const blended = chunk("dgi-2024:8", cleanText);
    const clean = chunk("eatwell-2018:2", "The guide describes oils and spreads as foods to use in small amounts.");
    const blends = [
      "The guidelines say oil should be limited.",
      "ICMR and Public Health England both limit saturated fat.",
    ];

    for (const text of blends) {
      const result = ground(
        {
          covered: true,
          claims: [
            draftClaim(text, cleanText, blended.id),
            draftClaim(clean.text, clean.text, clean.id),
          ],
        },
        [blended, clean],
        "all",
      );
      expect(result.coverage, text).toBe("answered");
      expect(result.claims.map((claim) => claim.text)).toEqual([clean.text]);
      expect(result.answer).toBe(clean.text);
    }
  });

  it("keeps a chill-within storage sentence", () => {
    const text = "Chill food within 2 hours of cooking and serving.";
    const retrieved = chunk("cold-storage-2023:1", text, {
      sectionHeading: "Chilling",
    });
    const result = ground(
      { covered: true, claims: [draftClaim(text, text, retrieved.id)] },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("answered");
    expect(result.answer).toBe(text);
    expect(result.claims[0]?.source.documentName).toBe("Cold Food Storage Chart");
  });

  it("keeps a population energy figure that is not a personal target", () => {
    const text = "A reference diet is about 2000 kcal.";
    const retrieved = chunk("dgi-2024:20", text);
    const result = ground(
      { covered: true, claims: [draftClaim(text, text, retrieved.id)] },
      [retrieved],
      "dgi-2024",
    );

    expect(result.coverage).toBe("answered");
    expect(result.answer).toBe(text);
  });

  it("does not decline when the only medical sentence fails the quote check", () => {
    const retrieved = chunk("dgi-2024:8", cleanText);
    const result = ground(
      {
        covered: true,
        claims: [
          draftClaim(
            "Avoid sugar for your diabetes.",
            "this quote is not a span of the chunk",
            retrieved.id,
          ),
        ],
      },
      [retrieved],
      "all",
    );

    expect(result.coverage).toBe("not_in_corpus");
    expect(result.declined).toBe(false);
  });
});

describe("answer text comes only from surviving claim text", () => {
  it("does not copy free-form draft prose or invent a link", () => {
    const retrieved = chunk("cold-storage-2023:4", CHICKEN, {
      sectionHeading: "Leftovers",
    });
    const draft = {
      covered: true as const,
      claims: [
        draftClaim(
          "Cooked chicken keeps for 3 to 4 days. See https://evil.example/chart.",
          CHICKEN,
          retrieved.id,
        ),
      ],
      answer: "MODEL PROSE THAT MUST NOT SHIP https://invented.example/a",
    } satisfies GroundedDraft & { answer: string };

    const result = ground(draft, [retrieved], "all");

    expect(result.answer).toBe(
      "Cooked chicken keeps for 3 to 4 days. See https://evil.example/chart.",
    );
    expect(result.answer).not.toContain("MODEL PROSE");
    expect(result.answer).not.toContain("invented.example");
    expect(result.answer).not.toContain(retrieved.sourceUrl);
    expect(result.claims[0]?.source.url).toBe(retrieved.sourceUrl);
    expect(result.answer).not.toMatch(/\]\(/);
  });

  it("does not read the refusal sentences out of ground.ts", () => {
    const source = readFileSync(new URL("./ground.ts", import.meta.url), "utf8");
    expect(source).not.toContain("I can't give calorie targets");
    expect(source).not.toContain("The guidance I searched does not cover that");
  });
});
