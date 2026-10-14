import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { notInCorpusAnswer } from "../lib/coverage";
import { PROFESSIONAL_REFUSAL } from "../lib/decline";
import { HEADING_SEPARATOR } from "../lib/parsedDocument";
import type { Source } from "../lib/types";
import { HowItWorks } from "./site-chrome";
import { OfficialSources, SourcesChecked, SourcesPanel, UnsupportedAnswer } from "./sources-panel";

const water: Source = {
  documentName: "Dietary Guidelines for Indians",
  publisher: "ICMR–National Institute of Nutrition",
  year: 2024,
  url: "https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf",
  sectionHeading: [
    "GUIDELINE 14 Drink adequate quantity of water",
    "RATIONALE Adequate water is important for maintaining good health.",
    "needs to drink about eight | water including beverages per",
  ].join(HEADING_SEPARATOR),
};

describe("SourcesPanel", () => {
  it("renders title, publisher, year, and section as separate fields", () => {
    const html = renderToStaticMarkup(createElement(SourcesPanel, { sources: [water] }));
    expect(html).toContain('<p class="source-title">Dietary Guidelines for Indians</p>');
    expect(html).toContain(
      '<p class="source-publisher">ICMR–National Institute of Nutrition · 2024</p>',
    );
    expect(html).toContain(
      '<p class="source-section">Guideline 14: Drink adequate quantity of water</p>',
    );
    expect(html).toContain(`href="${water.url}"`);
    expect(html).not.toContain("needs to drink about eight");
    expect(html).not.toContain("RATIONALE");
    expect(html).not.toContain("|");
    expect(html).not.toContain("Page ");
    expect(html).not.toContain(water.sectionHeading);
  });

  it("omits a section when the heading is blank", () => {
    const source: Source = { ...water, sectionHeading: " " };
    const html = renderToStaticMarkup(createElement(SourcesPanel, { sources: [source] }));
    expect(html).not.toContain("source-section");
    expect(html).not.toContain("Page ");
    expect(html).toContain(`href="${source.url}"`);
  });
});

const APPROVED_SOURCES = [
  {
    title: "Dietary Guidelines for Indians (2024)",
    organization: "ICMR–National Institute of Nutrition",
    url: "https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf",
  },
  {
    title: "The Eatwell Guide booklet (2018)",
    organization: "Public Health England",
    url: "https://assets.publishing.service.gov.uk/media/5ba8a50540f0b605084c9501/Eatwell_Guide_booklet_2018v4.pdf",
  },
  {
    title: "Cold Food Storage Chart",
    organization: "FoodSafety.gov",
    url: "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
  },
  {
    title: "How to chill, freeze and defrost food safely (2017)",
    organization: "UK Food Standards Agency",
    url: "https://www.gov.uk/government/publications/how-to-chill-freeze-and-defrost-food-safely/how-to-chill-freeze-and-defrost-food-safely",
  },
];

describe("unsupported guidance", () => {
  it("replaces the long refusal with the short message and does not repeat the documents", () => {
    const html = renderToStaticMarkup(createElement(UnsupportedAnswer));
    expect(html).toContain("I couldn&#x27;t find enough guidance to answer this question.");
    expect(html).toContain(
      "Try rephrasing your question or asking about another dietary or food-safety topic.",
    );
    expect(html).not.toContain("I checked the available official sources");
    expect(html).not.toContain("I looked in");
    expect(html).not.toContain("Dietary Guidelines for Indians");
    expect(html).not.toContain("Eatwell");
    expect(html).not.toContain("Cold Food Storage");
    expect(html).not.toContain("defrost");
  });

  it("keeps the searched documents collapsed, with the four approved links", () => {
    const html = renderToStaticMarkup(
      createElement(SourcesChecked, { answer: notInCorpusAnswer("all") }),
    );
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
    expect(html).toContain("Sources checked · 4 documents");
    for (const source of APPROVED_SOURCES) {
      expect(html).toContain(source.title);
      expect(html).toContain(source.organization);
      expect(html).toContain(`href="${source.url}"`);
      expect(html).toContain(source.url);
    }
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("opens in a new tab");
    expect(html).not.toContain("I looked in");
  });

  it("lists only the document a filtered search actually checked", () => {
    const html = renderToStaticMarkup(
      createElement(SourcesChecked, { answer: notInCorpusAnswer("eatwell-2018") }),
    );
    expect(html).toContain("Sources checked · 1 document");
    expect(html).toContain("The Eatwell Guide booklet (2018)");
    expect(html).toContain(APPROVED_SOURCES[1]!.url);
    expect(html).not.toContain("Dietary Guidelines for Indians");
    expect(html).not.toContain("Cold Food Storage Chart");
    expect(html).not.toContain("defrost");
  });

  it("does not claim a search for a professional refusal", () => {
    const html = renderToStaticMarkup(
      createElement(SourcesChecked, { answer: PROFESSIONAL_REFUSAL }),
    );
    expect(html).toBe("");
  });
});

describe("OfficialSources", () => {
  it("lists the four approved documents with their public links", () => {
    const html = renderToStaticMarkup(createElement(OfficialSources));
    expect(html).toContain("Open official source");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    for (const source of APPROVED_SOURCES) {
      expect(html).toContain(source.title);
      expect(html).toContain(`href="${source.url}"`);
    }
    expect(html).toContain("FoodSafety.gov (USDA, FDA, and CDC)");
    expect(html).toContain("UK Food Standards Agency");
    expect(html).not.toContain("chunk");
    expect(html).not.toContain("indexed");
  });
});

describe("HowItWorks", () => {
  it("explains the assistant without listing the source library", () => {
    const html = renderToStaticMarkup(
      createElement(HowItWorks, { onViewSources: () => undefined }),
    );
    expect(html).toContain("01");
    expect(html).toContain("Ask a question");
    expect(html).toContain("Find relevant guidance");
    expect(html).toContain("Get a cited answer");
    expect(html).toContain("Check the evidence");
    expect(html).toContain("View all sources");
    expect(html).toContain("not personalized calorie targets");
    expect(html).not.toContain("Dietary Guidelines for Indians");
    expect(html).not.toContain("Eatwell Guide booklet");
    expect(html).not.toContain("Cold Food Storage Chart");
    expect(html).not.toContain("foodsafety.gov");
  });
});
