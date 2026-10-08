import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORPUS } from "../src/lib/corpus";
import { GUIDANCE_DB_NAME } from "../src/lib/embed";
import {
  GuidanceIndexError,
  loadGuidanceIndex,
  type IndexedChunk,
} from "../src/lib/retrieve";

const PREVIEW = 8;

/**
 * Print one stored embedding from each document in DATA_DIR/guidance.db.
 * The vector is the float32 blob on the chunk row. The passage stays in `text`.
 */
function loadLocalEnv(file = resolve(".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (key === "" || process.env[key] !== undefined) continue;
    let value = withoutExport.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function main(): void {
  loadLocalEnv();
  const indexPath = resolve(process.env.DATA_DIR?.trim() || "data", GUIDANCE_DB_NAME);
  let chunks: IndexedChunk[];
  try {
    chunks = loadGuidanceIndex(indexPath);
  } catch (error: unknown) {
    if (error instanceof GuidanceIndexError) {
      console.error(error.message);
      console.error("Run npm run ingest to write the index.");
      process.exit(1);
    }
    throw error;
  }

  const sample = oneChunkPerDocument(chunks);
  const dimensions = chunks[0]?.embedding.length ?? 0;
  console.log(indexPath);
  console.log(
    `${chunks.length} chunks, ${dimensions} floats each (${dimensions * 4} bytes)`,
  );

  for (const chunk of sample) {
    const preview = chunk.embedding
      .slice(0, PREVIEW)
      .map((value) => value.toFixed(6))
      .join(", ");
    const text = chunk.text.replace(/\s+/g, " ").slice(0, 120);
    console.log("");
    console.log(`${chunk.id}  ${chunk.sectionHeading}`);
    console.log(text);
    console.log(`norm=${l2(chunk.embedding).toFixed(4)}  [${preview}, …]`);
  }
}

function oneChunkPerDocument(chunks: readonly IndexedChunk[]): IndexedChunk[] {
  const sample: IndexedChunk[] = [];
  for (const document of CORPUS) {
    const chunk = chunks.find((item) => item.documentId === document.id);
    if (chunk) sample.push(chunk);
  }
  return sample;
}

function l2(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum);
}

main();
