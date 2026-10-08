import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chunkDocument, type GuidanceChunk } from "../src/lib/chunk";
import { CORPUS } from "../src/lib/corpus";
import { parseCorpusDocument } from "../src/lib/parse";

type FetchRecord = {
  retrievedAt: string;
};

/**
 * Write the chunker output for the four documents already on disk.
 * JSON is the full chunk list. Markdown is the same text, easier to read.
 */
async function main(): Promise<void> {
  const outDir = resolve("data/chunks");
  await mkdir(outDir, { recursive: true });
  const documents: {
    documentId: string;
    name: string;
    chunkCount: number;
    chunks: GuidanceChunk[];
  }[] = [];

  for (const document of CORPUS) {
    const [bytes, fetchText] = await Promise.all([
      readFile(resolve("data/raw", document.id, "body")),
      readFile(resolve("data/raw", document.id, "fetch.json"), "utf8"),
    ]);
    const fetchRecord = JSON.parse(fetchText) as FetchRecord;
    const parsed = await parseCorpusDocument(bytes, document);
    const chunks = chunkDocument(parsed, {
      id: document.id,
      name: document.name,
      publisher: document.publisher,
      year: document.year,
      sourceUrl: document.sourceUrl,
      retrievedAt: fetchRecord.retrievedAt,
    });
    const kinds = countKinds(chunks);

    await writeFile(
      resolve(outDir, `${document.id}.json`),
      `${JSON.stringify(
        {
          documentId: document.id,
          name: document.name,
          publisher: document.publisher,
          year: document.year,
          retrievedAt: fetchRecord.retrievedAt,
          chunkCount: chunks.length,
          kinds,
          chunks,
        },
        null,
        2,
      )}\n`,
    );

    const body = chunks
      .map(
        (item) =>
          `## ${item.id} ${item.unitKind}\n\n**${item.sectionHeading}**\n\n${item.text}`,
      )
      .join("\n\n---\n\n");
    const markdown = [
      `# ${document.name}`,
      "",
      `${document.publisher}, ${document.year}. Retrieved ${fetchRecord.retrievedAt}.`,
      "",
      `${chunks.length} chunks. ${formatKinds(kinds)}.`,
      "",
      body,
      "",
    ].join("\n");
    await writeFile(resolve(outDir, `${document.id}.md`), markdown);
    documents.push({
      documentId: document.id,
      name: document.name,
      chunkCount: chunks.length,
      chunks,
    });
    console.log(`${document.id}: ${chunks.length} chunks -> data/chunks/${document.id}.json`);
  }

  await writeFile(
    resolve(outDir, "chunk.json"),
    `${JSON.stringify({ documents }, null, 2)}\n`,
  );
  console.log("all four documents -> data/chunks/chunk.json");
}

function countKinds(chunks: GuidanceChunk[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chunk of chunks) {
    counts[chunk.unitKind] = (counts[chunk.unitKind] ?? 0) + 1;
  }
  return counts;
}

function formatKinds(kinds: Record<string, number>): string {
  return Object.entries(kinds)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Chunk dump failed: ${message}`);
  process.exit(1);
});
