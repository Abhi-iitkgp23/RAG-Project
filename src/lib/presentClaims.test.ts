import { describe, expect, it } from "vitest";
import { HEADING_SEPARATOR } from "./parsedDocument";
import { readableSections } from "./presentClaims";

const waterHeading = [
  "GUIDELINE 14 Drink adequate quantity of water",
  "RATIONALE Adequate water is important for maintaining good health.",
  "needs to drink about eight | water including beverages per",
].join(HEADING_SEPARATOR);

describe("readableSections", () => {
  it("keeps the guideline and drops the broken breadcrumb tail", () => {
    expect(readableSections(waterHeading, "Dietary Guidelines for Indians")).toEqual([
      "Guideline 14: Drink adequate quantity of water",
    ]);
  });

  it("keeps a real subsection under its guideline", () => {
    const heading = [
      "GUIDELINE 14 Drink adequate quantity of water",
      "RATIONALE Adequate water is important for maintaining good health.",
      "Why do we need water?",
    ].join(HEADING_SEPARATOR);
    expect(readableSections(heading, "Dietary Guidelines for Indians")).toEqual([
      "Guideline 14: Drink adequate quantity of water",
      "Why do we need water?",
    ]);
  });

  it("names a short parent with its subsection", () => {
    expect(readableSections("Fats and oils › Visible fats")).toEqual([
      "Fats and oils",
      "Visible fats",
    ]);
  });

  it("omits a heading that only repeats the document title", () => {
    expect(readableSections("Cold Food Storage Chart", "Cold Food Storage Chart")).toEqual([]);
    expect(
      readableSections("Cold Food Storage Chart › Leftovers", "Cold Food Storage Chart"),
    ).toEqual(["Leftovers"]);
  });

  it("omits an empty heading", () => {
    expect(readableSections("   ")).toEqual([]);
  });
});
