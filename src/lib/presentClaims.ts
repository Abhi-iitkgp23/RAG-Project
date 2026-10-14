import type { Claim, Source } from "./types";

/**
 * Same wording from one document is one claim. Spacing, case, and a
 * trailing period do not make a second claim.
 */
export function claimTextKey(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([–—-])\s*/g, "$1")
    .replace(/[.!?]+$/g, "")
    .toLowerCase();
}

export function withoutRepeatedClaims<T extends { text: string }>(
  claims: readonly T[],
  documentKey: (claim: T) => string,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const claim of claims) {
    const key = `${documentKey(claim)}\n${claimTextKey(claim.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(claim);
  }
  return kept;
}

/**
 * Clickable citation label. Section text stays on the source object.
 * A missing section is omitted here so the label does not invent one.
 */
export function citationLabel(source: Source): string {
  return `${source.documentName} (${source.publisher}, ${source.year})`;
}

/** Locator under a source card. An empty section is left out. */
export function sourceLocator(source: Source): string {
  const published = `${source.publisher}, ${source.year}`;
  const section = source.sectionHeading.trim();
  return section.length > 0 ? `${published} · ${section}` : published;
}

const HEADING_SPLIT = /\s*\u203a\s*/;
const BRIDGE_HEADING = /^(a closer look at|helping you eat a healthy, balanced diet)$/i;
const BOILERPLATE_HEADING = /^(rationale|points to register)$/i;

/**
 * Heading lines safe to show. The stored breadcrumb sometimes absorbed the
 * next line or a table cell; those pieces are omitted. A missing heading
 * stays missing.
 */
export function readableSections(sectionHeading: string, documentName = ""): string[] {
  const usable = sectionHeading
    .split(HEADING_SPLIT)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => isSectionTitle(part) && !isAbsorbedProse(part));
  const specific = usable.filter(
    (part) => !repeatsDocument(part, documentName) && !BRIDGE_HEADING.test(part),
  );
  const chosen = specific.length > 0 ? specific : usable.filter((part) => !repeatsDocument(part, documentName));
  const labels = chosen.map(presentSectionTitle).filter((part, index, all) => all.indexOf(part) === index);
  if (labels.length <= 1) return labels;
  const parent = labels[0]!;
  const child = labels[labels.length - 1]!;
  return parent === child ? [parent] : [parent, child];
}

function isSectionTitle(text: string): boolean {
  if (text.length < 3 || text.length > 280) return false;
  if (text.includes("|")) return false;
  if (/^[a-z(]/.test(text)) return false;
  if (!/\p{L}/u.test(text)) return false;
  if (BOILERPLATE_HEADING.test(text)) return false;
  return true;
}

function isAbsorbedProse(text: string): boolean {
  if (/^GUIDELINE\s+\d+\b/i.test(text)) return false;
  if (/^Table\s+[\dIVXLC]+\b/i.test(text) && text.length <= 160) return false;
  if (/^(RATIONALE|POINTS TO REGISTER)\b/i.test(text) && text.split(/\s+/).length > 2) return true;
  const words = text.split(/\s+/);
  if (words.length > 24 && !text.endsWith("?")) return true;
  return /[.!?]\s+\p{Lu}/u.test(text) && text.length > 110;
}

function repeatsDocument(segment: string, documentName: string): boolean {
  const heading = segment.trim().toLowerCase();
  const document = documentName.trim().toLowerCase();
  if (!heading || !document) return false;
  if (heading === document) return true;
  if (heading.length >= 12 && (document.startsWith(heading) || document.includes(heading))) return true;
  return document.length >= 12 && heading.startsWith(document);
}

function presentSectionTitle(text: string): string {
  const cleaned = text.replace(/[.\s]+$/g, "").trim();
  const guideline = cleaned.match(/^GUIDELINE\s+(\d+)\s+(.+)$/i);
  if (!guideline) return cleaned;
  const body = guideline[2]!.replace(/[.\s]+$/g, "").trim();
  return body.length > 0 ? `Guideline ${guideline[1]}: ${body}` : `Guideline ${guideline[1]}`;
}

/** One link per claim, in claim order, using only that claim's source. */
export function citationLinks(
  claims: readonly { source: Source }[],
): { href: string; label: string }[] {
  return claims.map((claim) => ({
    href: claim.source.url,
    label: citationLabel(claim.source),
  }));
}

/** One card per document section. A repeated claim does not cite it again. */
export function uniqueSources(sources: readonly Source[]): Source[] {
  const seen = new Set<string>();
  const kept: Source[] = [];
  for (const source of sources) {
    const key = [
      source.documentName,
      source.publisher,
      source.year,
      source.url,
      source.sectionHeading,
    ].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(source);
  }
  return kept;
}

/**
 * One document: each claim is its own paragraph, with no document prefix.
 * Several documents: a heading, then that document's claims as separate paragraphs.
 */
export function assembleCited<T extends { text: string; source: Source }>(
  claims: readonly T[],
  documentKey: (claim: T) => string,
): string {
  const unique = withoutRepeatedClaims(claims, documentKey);
  const groups: T[][] = [];
  for (const claim of unique) {
    const current = groups[groups.length - 1];
    if (current && documentKey(current[0]!) === documentKey(claim)) current.push(claim);
    else groups.push([claim]);
  }

  if (groups.length === 0) return "";
  if (groups.length === 1) return textsOf(groups[0]!);

  return groups
    .map((group) => {
      const source = group[0]!.source;
      return `**${source.documentName}** (${source.publisher}, ${source.year})\n\n${textsOf(group)}`;
    })
    .join("\n\n");
}

/** Answer text for claims already bound to sources. Repeated wording is omitted. */
export function answerFromClaims(claims: readonly Claim[]): string {
  return assembleCited(claims, (claim) => claim.source.url);
}

function textsOf(claims: readonly { text: string }[]): string {
  return claims.map((claim) => claim.text).join("\n\n");
}
