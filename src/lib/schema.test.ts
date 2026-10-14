import { describe, expect, it } from "vitest";
import { CORPUS, DOCUMENT_ALIASES } from "./corpus";
import {
  boundClaimSchema,
  chatRequestSchema,
  groundedDraftSchema,
} from "./schema";
import type { GroundedDraft } from "./types";

const uncoveredWithClaim: GroundedDraft = {
  covered: false,
  claims: [
    {
      text: "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
      quote: "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
      chunkId: "cold-storage-2023:1",
    },
  ],
};

describe("shared contracts", () => {
  it("imports GroundedDraft and the corpus manifest", () => {
    const draft: GroundedDraft = { covered: true, claims: [] };
    expect(groundedDraftSchema.safeParse(draft).success).toBe(true);
    expect(CORPUS.map((document) => document.id)).toEqual([
      "dgi-2024",
      "eatwell-2018",
      "cold-storage-2023",
      "fsa-chill-2017",
    ]);
    expect(
      CORPUS.find((document) => document.id === "dgi-2024")?.publisher,
    ).toBe("ICMR\u2013National Institute of Nutrition");
    expect(Object.keys(DOCUMENT_ALIASES)).toEqual([
      "dgi-2024",
      "eatwell-2018",
      "cold-storage-2023",
      "fsa-chill-2017",
    ]);
  });

  it("rejects a draft with covered false and a claim", () => {
    expect(groundedDraftSchema.safeParse(uncoveredWithClaim).success).toBe(
      false,
    );
  });

  it("accepts covered true with an empty claims array", () => {
    const draft: GroundedDraft = { covered: true, claims: [] };
    expect(groundedDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("accepts covered false with an empty claims array", () => {
    const draft: GroundedDraft = { covered: false, claims: [] };
    expect(groundedDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("rejects additional properties on the draft", () => {
    const result = groundedDraftSchema.safeParse({
      covered: true,
      claims: [],
      prose: "This sentence must not survive.",
    });
    expect(result.success).toBe(false);
  });

  it("parses a chat request and rejects unknown fields", () => {
    expect(
      chatRequestSchema.safeParse({
        message: "How long can cooked chicken stay in the fridge?",
      }).success,
    ).toBe(true);
    expect(
      chatRequestSchema.safeParse({
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        message: "And leftovers?",
      }).success,
    ).toBe(true);
    expect(
      chatRequestSchema.safeParse({ message: "ok", extra: true }).success,
    ).toBe(false);
  });

  it("requires a complete source on a bound claim", () => {
    expect(
      boundClaimSchema.safeParse({
        text: "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
        source: {
          documentName: "Cold Food Storage Chart",
          publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
          year: 2023,
          url: "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
          sectionHeading: "Poultry",
        },
      }).success,
    ).toBe(true);
    expect(
      boundClaimSchema.safeParse({
        text: "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
        source: {
          documentName: "Cold Food Storage Chart",
          publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
          year: 2023,
          sectionHeading: "Poultry",
        },
      }).success,
    ).toBe(false);
    expect(
      boundClaimSchema.safeParse({
        text: "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
        source: {
          documentName: "Cold Food Storage Chart",
          publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
          year: 2023,
          url: "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
          sectionHeading: "",
        },
      }).success,
    ).toBe(true);
  });
});
