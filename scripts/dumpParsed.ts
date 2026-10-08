import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CORPUS } from "../src/lib/corpus";
import { parseCorpusDocument } from "../src/lib/parse";

/**
 * Write the parser output for the four documents already on disk.
 * JSON is the full unit list. Markdown is the same text, easier to read.
 */
async function main(): Promise<void> {
  const outDir = resolve("data/parsed");
  await mkdir(outDir, { recursive: true });

  for (const document of CORPUS) {
    const bytes = await readFile(resolve("data/raw", document.id, "body"));
    const parsed = await parseCorpusDocument(bytes, document);
    const units = parsed.units.map((unit, index) => ({
      ordinal: index + 1,
      kind: unit.kind,
      sectionHeading: unit.sectionHeading,
      text: unit.text,
      ...(unit.rows ? { rows: unit.rows } : {}),
    }));

    await writeFile(
      resolve(outDir, `${document.id}.json`),
      `${JSON.stringify(
        {
          documentId: parsed.documentId,
          name: document.name,
          publisher: document.publisher,
          year: document.year,
          headingCount: parsed.headingCount,
          tableCount: parsed.tableCount,
          characters: parsed.characters,
          unitCount: units.length,
          units,
        },
        null,
        2,
      )}\n`,
    );

    const body = units
      .map(
        (unit) =>
          `## ${unit.ordinal}. ${unit.kind}\n\n**${unit.sectionHeading}**\n\n${unit.text}`,
      )
      .join("\n\n---\n\n");
    const markdown = [
      `# ${document.name}`,
      "",
      `${document.publisher}, ${document.year}`,
      "",
      `${units.length} units, ${parsed.headingCount} headings, ${parsed.tableCount} tables, ${parsed.characters} characters.`,
      "",
      body,
      "",
    ].join("\n");
    await writeFile(resolve(outDir, `${document.id}.md`), markdown);

    console.log(
      `${document.id}: ${units.length} units, ${parsed.characters} characters -> data/parsed/${document.id}.md`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Parse dump failed: ${message}`);
  process.exit(1);
});
