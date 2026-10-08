export type CorpusDocumentId =
  | "dgi-2024"
  | "eatwell-2018"
  | "cold-storage-2023"
  | "fsa-chill-2017";

export type CorpusDocument = {
  id: CorpusDocumentId;
  name: string;
  publisher: string;
  year: number;
  sourceUrl: string;
  form: "pdf" | "html";
};

/** The four public guidance documents, in citation order. */
export const CORPUS: readonly CorpusDocument[] = [
  {
    id: "dgi-2024",
    name: "Dietary Guidelines for Indians",
    publisher: "ICMR–National Institute of Nutrition",
    year: 2024,
    sourceUrl:
      "https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf",
    form: "pdf",
  },
  {
    id: "eatwell-2018",
    name: "The Eatwell Guide booklet",
    publisher: "Public Health England (GOV.UK)",
    year: 2018,
    sourceUrl:
      "https://assets.publishing.service.gov.uk/media/5ba8a50540f0b605084c9501/Eatwell_Guide_booklet_2018v4.pdf",
    form: "pdf",
  },
  {
    id: "cold-storage-2023",
    name: "Cold Food Storage Chart",
    publisher: "FoodSafety.gov (USDA, FDA, and CDC)",
    year: 2023,
    sourceUrl:
      "https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts",
    form: "html",
  },
  {
    id: "fsa-chill-2017",
    name: "How to chill, freeze and defrost food safely",
    publisher: "Food Standards Agency (GOV.UK)",
    year: 2017,
    sourceUrl:
      "https://www.gov.uk/government/publications/how-to-chill-freeze-and-defrost-food-safely/how-to-chill-freeze-and-defrost-food-safely",
    form: "html",
  },
];

/**
 * Case-insensitive aliases matched against the raw user message.
 * Exactly one document named selects that filter; any other result searches
 * the full corpus.
 */
export const DOCUMENT_ALIASES: Record<
  CorpusDocumentId,
  readonly string[]
> = {
  "dgi-2024": [
    "dietary guidelines for indians",
    "ICMR",
    "national institute of nutrition",
  ],
  "eatwell-2018": ["eatwell"],
  "cold-storage-2023": ["cold food storage", "foodsafety.gov"],
  "fsa-chill-2017": ["food standards agency", "chill, freeze and defrost"],
};

/**
 * Search scope for one raw user message.
 * One named document returns that id. Zero names, or two or more, returns
 * undefined so retrieval searches the full corpus. Matching is case-insensitive
 * and uses this message, not a rewritten query.
 */
export function documentFilter(message: string): CorpusDocumentId | undefined {
  const haystack = message.toLowerCase();
  const matched = CORPUS.filter((document) =>
    DOCUMENT_ALIASES[document.id].some((alias) =>
      haystack.includes(alias.toLowerCase()),
    ),
  );
  return matched.length === 1 ? matched[0]!.id : undefined;
}
