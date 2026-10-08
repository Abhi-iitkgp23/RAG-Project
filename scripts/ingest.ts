import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORPUS } from "../src/lib/corpus";
import { embedGuidanceIndex } from "../src/lib/embed";
import { runCorpusFetch } from "../src/lib/fetchCorpus";
import { ThinExtractError, prepareChunkCorpus } from "../src/lib/prepareChunks";

/**
 * Offline ingest. Fetches the four corpus documents, parses and chunks
 * those bytes into DATA_DIR/chunks/chunk.json, updates docs/ingest-record.md
 * when the counts change, then embeds and swaps in DATA_DIR/guidance.db.
 * A failed fetch, a thin PDF text layer, or a failed embed leaves any
 * previous index in place.
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

async function main(): Promise<void> {
  loadLocalEnv();
  const dataDir = resolve(process.env.DATA_DIR?.trim() || "data");
  const exitCode = await runCorpusFetch({
    documents: CORPUS,
    dataDir,
  });
  if (exitCode !== 0) process.exit(exitCode);

  const log = (line: string) => console.log(line);
  try {
    await prepareChunkCorpus({
      dataDir,
      documents: CORPUS,
      recordPath: resolve("docs/ingest-record.md"),
      log,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const label = error instanceof ThinExtractError ? "Ingest stopped" : "Ingest failed";
    console.error(`${label}: ${message}`);
    process.exit(1);
  }

  try {
    await embedGuidanceIndex({
      dataDir,
      log,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Embed failed: ${message}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ingest failed: ${message}`);
  process.exit(1);
});
