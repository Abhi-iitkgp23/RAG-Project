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
 * One document: claim texts in order, with no document prefix.
 * Several documents: one block each, in the order given, separated by a blank line.
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
      return `**${source.documentName}** (${source.publisher}, ${source.year}): ${textsOf(group)}`;
    })
    .join("\n\n");
}

/** Answer text for claims already bound to sources. Repeated wording is omitted. */
export function answerFromClaims(claims: readonly Claim[]): string {
  return assembleCited(claims, (claim) => claim.source.url);
}

function textsOf(claims: readonly { text: string }[]): string {
  return claims.map((claim) => claim.text).join(" ");
}
