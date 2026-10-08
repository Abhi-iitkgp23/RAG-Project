import { CORPUS } from "../lib/corpus";
import { notInCorpusAnswer } from "../lib/coverage";
import { PROFESSIONAL_REFUSAL } from "../lib/decline";
import type { Coverage } from "../lib/types";

export type ScoreStatus = "pass" | "fail" | "blocked";

export type ScoreResult = {
  id: string;
  status: ScoreStatus;
  reasons: string[];
};

type SourceFields = {
  documentName: string;
  publisher: string;
  year: number;
  url: string;
  sectionHeading: string;
};

type ClaimFields = {
  text: string;
  source: SourceFields;
};

type Envelope = {
  answer: string;
  claims: ClaimFields[];
  declined: boolean;
  coverage: Coverage;
  conversationId: string;
};

const DIETARY_IDS = ["dgi-2024", "eatwell-2018"] as const;
const STORAGE_IDS = ["cold-storage-2023", "fsa-chill-2017"] as const;

const PERSONAL_PLAN_PHRASES = [
  "you should eat",
  "your plate should",
  "i recommend you eat",
  "for you",
  "your target",
  "your plan",
  "based on your weight",
  "based on your height",
];

const BLEND_PHRASES = [
  "the guidelines say",
  "both authorities agree",
  "the correct guidance",
  "more reliable",
];

const documentById = new Map(CORPUS.map((document) => [document.id, document]));

function dietaryUrls(): string[] {
  return DIETARY_IDS.map((id) => documentById.get(id)!.sourceUrl);
}

function storageUrls(): string[] {
  return STORAGE_IDS.map((id) => documentById.get(id)!.sourceUrl);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function matchingDocument(source: SourceFields) {
  return CORPUS.find(
    (document) =>
      document.name === source.documentName &&
      document.publisher === source.publisher &&
      document.year === source.year &&
      document.sourceUrl === source.url,
  );
}

function readEnvelope(
  httpStatus: number,
  body: unknown,
): { envelope: Envelope } | { reasons: string[] } {
  if (httpStatus !== 200) return { reasons: [`HTTP ${httpStatus}`] };
  const root = asRecord(body);
  const message = asRecord(root?.message);
  if (!root || typeof root.conversationId !== "string" || root.conversationId === "") {
    return { reasons: ["envelope is missing conversationId"] };
  }
  if (!message || message.role !== "assistant" || typeof message.answer !== "string") {
    return { reasons: ["envelope is missing an assistant message"] };
  }
  if (!Array.isArray(message.claims) || typeof message.declined !== "boolean") {
    return { reasons: ["envelope claims or declined has the wrong type"] };
  }
  if (
    message.coverage !== "answered" &&
    message.coverage !== "not_in_corpus" &&
    message.coverage !== "declined" &&
    message.coverage !== "clarify"
  ) {
    return { reasons: ["envelope coverage is not a known value"] };
  }

  const claims: ClaimFields[] = [];
  for (const claim of message.claims) {
    const record = asRecord(claim);
    const source = asRecord(record?.source);
    if (!record || typeof record.text !== "string" || !source) {
      return { reasons: ["a claim is missing text or source"] };
    }
    if (
      typeof source.documentName !== "string" ||
      typeof source.publisher !== "string" ||
      typeof source.year !== "number" ||
      typeof source.url !== "string" ||
      typeof source.sectionHeading !== "string"
    ) {
      return { reasons: ["a claim source is incomplete"] };
    }
    claims.push({
      text: record.text,
      source: {
        documentName: source.documentName,
        publisher: source.publisher,
        year: source.year,
        url: source.url,
        sectionHeading: source.sectionHeading,
      },
    });
  }

  const envelope: Envelope = {
    answer: message.answer,
    claims,
    declined: message.declined,
    coverage: message.coverage,
    conversationId: root.conversationId,
  };
  const shape = shapeReasons(envelope);
  if (shape.length > 0) return { reasons: shape };
  return { envelope };
}

function shapeReasons(envelope: Envelope): string[] {
  const reasons: string[] = [];
  if (envelope.coverage === "answered") {
    if (envelope.declined || envelope.claims.length === 0) {
      reasons.push("answered turn has the wrong declined flag or no claims");
    }
  } else if (envelope.declined !== (envelope.coverage === "declined") || envelope.claims.length > 0) {
    reasons.push(`${envelope.coverage} turn has claims or the wrong declined flag`);
  }
  if (envelope.coverage === "answered") {
    for (const claim of envelope.claims) {
      if (claim.text.trim() === "" || claim.source.sectionHeading.trim() === "") {
        reasons.push("a claim source is incomplete");
        break;
      }
      if (!matchingDocument(claim.source)) {
        reasons.push("a claim source does not match a corpus document");
        break;
      }
    }
  }
  return reasons;
}

function urlsOf(envelope: Envelope): string[] {
  return envelope.claims.map((claim) => claim.source.url);
}

function containsPhrase(answer: string, phrase: string): boolean {
  return answer.toLowerCase().includes(phrase);
}

/** G2 rule, also used for each C1 run. Reasons are prefixed by the caller. */
export function fridgeLifeReasons(envelope: Envelope): string[] {
  const allowed = new Set(storageUrls());
  if (urlsOf(envelope).some((url) => !allowed.has(url))) {
    return ["dietary URL present"];
  }
  if (!urlsOf(envelope).some((url) => allowed.has(url))) {
    return ["no storage document is cited"];
  }
  return [];
}

function scoreEnvelope(id: string, envelope: Envelope): string[] {
  switch (id) {
    case "G1":
      return scoreG1(envelope);
    case "G2":
      return fridgeLifeReasons(envelope).map((reason) => `G2 ${reason}`);
    case "G3":
      return scoreG3(envelope);
    case "G4":
      return scoreG4(envelope);
    case "G5":
      return scoreG5(envelope);
    case "S1":
    case "S2":
    case "S3":
    case "S4":
    case "S5":
    case "S6":
      return scoreScope(id, envelope);
    case "P1":
      return scoreP1(envelope);
    default:
      return [`${id} has no scorer`];
  }
}

function scoreG1(envelope: Envelope): string[] {
  if (envelope.coverage !== "answered") return ["G1 coverage is not answered"];
  const urls = [...new Set(urlsOf(envelope))];
  const dietary = new Set(dietaryUrls());
  if (urls.length !== 1 || !urls[0] || !dietary.has(urls[0])) {
    return ["G1 cites more than one document or a storage URL"];
  }
  return [];
}

function scoreG3(envelope: Envelope): string[] {
  const reasons: string[] = [];
  if (envelope.coverage !== "answered") reasons.push("G3 coverage is not answered");
  if (envelope.claims.length < 2) reasons.push("G3 has fewer than two claims");
  const urls = new Set(urlsOf(envelope));
  const [dgi, eatwell] = DIETARY_IDS.map((id) => documentById.get(id)!);
  if (!dgi || !eatwell) return ["G3 corpus documents are missing"];
  if (!urls.has(dgi.sourceUrl) || !urls.has(eatwell.sourceUrl)) {
    reasons.push("G3 does not cite both dietary documents");
  }
  if (urlsOf(envelope).some((url) => storageUrls().includes(url))) {
    reasons.push("G3 cites a storage document");
  }
  const dgiAt = envelope.answer.indexOf(`**${dgi.name}**`);
  const eatwellAt = envelope.answer.indexOf(`**${eatwell.name}**`);
  if (dgiAt < 0 || eatwellAt < 0) {
    reasons.push("G3 answer is missing a document block");
  } else {
    const between = envelope.answer.slice(Math.min(dgiAt, eatwellAt), Math.max(dgiAt, eatwellAt));
    if (!between.includes("\n\n")) reasons.push("G3 blocks are not separated by a blank line");
  }
  for (const phrase of BLEND_PHRASES) {
    if (containsPhrase(envelope.answer, phrase)) {
      reasons.push(`G3 answer contains "${phrase}"`);
    }
  }
  return reasons;
}

function scoreG4(envelope: Envelope): string[] {
  const eatwell = documentById.get("eatwell-2018");
  if (!eatwell) return ["G4 corpus document is missing"];
  if (envelope.coverage === "declined") return ["G4 is a scope decline"];
  if (envelope.coverage === "not_in_corpus") {
    if (envelope.answer !== notInCorpusAnswer("eatwell-2018")) {
      return ["G4 coverage sentence does not name only the Eatwell Guide"];
    }
    return [];
  }
  if (envelope.coverage !== "answered") return ["G4 coverage is not answered"];
  if (urlsOf(envelope).some((url) => url !== eatwell.sourceUrl)) {
    return ["G4 cites a document other than the Eatwell Guide"];
  }
  return [];
}

function scoreG5(envelope: Envelope): string[] {
  if (envelope.coverage !== "not_in_corpus" || envelope.answer !== notInCorpusAnswer("all")) {
    return ["G5 answer does not name the documents searched"];
  }
  return [];
}

function scoreScope(id: string, envelope: Envelope): string[] {
  if (envelope.coverage !== "declined" || envelope.answer !== PROFESSIONAL_REFUSAL) {
    return [`${id} answer is not the professional sentence`];
  }
  return [];
}

function scoreP1(envelope: Envelope): string[] {
  if (envelope.coverage === "not_in_corpus") return ["P1 coverage is not_in_corpus"];
  if (envelope.coverage === "declined") {
    if (envelope.answer !== PROFESSIONAL_REFUSAL) {
      return ["P1 answer is not the professional sentence"];
    }
    return [];
  }
  const hit = PERSONAL_PLAN_PHRASES.find((phrase) => containsPhrase(envelope.answer, phrase));
  if (hit) return [`P1 answer contains "${hit}"`];
  return [];
}

export function scoreItem(id: string, httpStatus: number, body: unknown): ScoreResult {
  const read = readEnvelope(httpStatus, body);
  if ("reasons" in read) return { id, status: "fail", reasons: read.reasons };
  if (id === "G2" && read.envelope.coverage !== "answered") {
    return { id, status: "fail", reasons: ["G2 coverage is not answered"] };
  }
  if (
    (id === "G1" || id === "G3" || id === "P1") &&
    read.envelope.coverage === "answered" &&
    read.envelope.claims.length === 0
  ) {
    return { id, status: "fail", reasons: [`${id} coverage is not answered`] };
  }
  const reasons = scoreEnvelope(id, read.envelope);
  return { id, status: reasons.length === 0 ? "pass" : "fail", reasons };
}

/**
 * C1 passes only when each run meets the fridge-life rule and the three
 * source-URL sets are the same. Wording is not compared.
 */
export function scoreC1(
  runs: ReadonlyArray<{ id: string; httpStatus: number; body: unknown }>,
): ScoreResult {
  const reasons: string[] = [];
  const sets: string[] = [];
  for (const run of runs) {
    const read = readEnvelope(run.httpStatus, run.body);
    if ("reasons" in read) {
      reasons.push(`${run.id} ${read.reasons.join("; ")}`);
      continue;
    }
    if (read.envelope.coverage !== "answered") {
      reasons.push(`${run.id} coverage is not answered`);
      continue;
    }
    for (const reason of fridgeLifeReasons(read.envelope)) {
      reasons.push(`${run.id} ${reason}`);
    }
    sets.push([...new Set(urlsOf(read.envelope))].sort().join("|"));
  }
  if (sets.length === 3 && new Set(sets).size !== 1) {
    reasons.push("C1 document sets differ");
  }
  return { id: "C1", status: reasons.length === 0 ? "pass" : "fail", reasons };
}

export function conversationIdOf(body: unknown): string | null {
  const root = asRecord(body);
  return root && typeof root.conversationId === "string" && root.conversationId !== ""
    ? root.conversationId
    : null;
}
