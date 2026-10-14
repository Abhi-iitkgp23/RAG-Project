import { describe, expect, it } from "vitest";
import { documentsNamedInCoverageAnswer, notInCorpusAnswer } from "./coverage";
import { PROFESSIONAL_REFUSAL } from "./decline";

const FULL_CORPUS =
  "The guidance I searched does not cover that. I looked in: Dietary Guidelines for Indians (ICMR\u2013National Institute of Nutrition, 2024); The Eatwell Guide booklet (Public Health England, 2018); Cold Food Storage Chart (FoodSafety.gov, 2023); How to chill, freeze and defrost food safely (Food Standards Agency, 2017).";

describe("refusal copy", () => {
  it("pins the professional sentence", () => {
    expect(PROFESSIONAL_REFUSAL).toBe(
      "I can't give calorie targets, weight recommendations, or medical advice. A registered dietitian or a clinician is the right person to ask.",
    );
  });

  it("names all four documents for the full corpus", () => {
    expect(notInCorpusAnswer("all")).toBe(FULL_CORPUS);
    expect(notInCorpusAnswer()).toBe(FULL_CORPUS);
    expect(notInCorpusAnswer(undefined)).toBe(FULL_CORPUS);
  });

  it("names only the filtered document, with the coverage publisher", () => {
    expect(notInCorpusAnswer("eatwell-2018")).toBe(
      "The guidance I searched does not cover that. I looked in: The Eatwell Guide booklet (Public Health England, 2018).",
    );
    expect(notInCorpusAnswer("eatwell-2018")).not.toContain("GOV.UK");
    expect(notInCorpusAnswer("eatwell-2018")).not.toContain(
      "Dietary Guidelines",
    );
    expect(notInCorpusAnswer("dgi-2024")).toBe(
      "The guidance I searched does not cover that. I looked in: Dietary Guidelines for Indians (ICMR\u2013National Institute of Nutrition, 2024).",
    );
    expect(notInCorpusAnswer("cold-storage-2023")).toBe(
      "The guidance I searched does not cover that. I looked in: Cold Food Storage Chart (FoodSafety.gov, 2023).",
    );
    expect(notInCorpusAnswer("cold-storage-2023")).not.toContain("USDA");
    expect(notInCorpusAnswer("fsa-chill-2017")).toBe(
      "The guidance I searched does not cover that. I looked in: How to chill, freeze and defrost food safely (Food Standards Agency, 2017).",
    );
    expect(notInCorpusAnswer("fsa-chill-2017")).not.toContain("GOV.UK");
  });
});

describe("documents named in a coverage refusal", () => {
  it("lists every document the full-corpus sentence says was searched", () => {
    expect(documentsNamedInCoverageAnswer(notInCorpusAnswer("all"))).toEqual([
      "dgi-2024",
      "eatwell-2018",
      "cold-storage-2023",
      "fsa-chill-2017",
    ]);
  });

  it("lists only the document a filtered search names", () => {
    expect(documentsNamedInCoverageAnswer(notInCorpusAnswer("eatwell-2018"))).toEqual([
      "eatwell-2018",
    ]);
    expect(documentsNamedInCoverageAnswer(notInCorpusAnswer("dgi-2024"))).toEqual([
      "dgi-2024",
    ]);
  });

  it("does not treat a decline or another answer as a search", () => {
    expect(documentsNamedInCoverageAnswer(PROFESSIONAL_REFUSAL)).toEqual([]);
    expect(
      documentsNamedInCoverageAnswer(
        "Dietary Guidelines for Indians recommend a varied diet.",
      ),
    ).toEqual([]);
  });
});
