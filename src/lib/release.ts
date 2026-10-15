import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { GUIDANCE_DB_NAME } from "./embed";
import { dataDirectory } from "./store";

/** The corpus manifest. An index older than this file is rebuilt on release. */
export function corpusManifestPath(cwd = process.cwd()): string {
  return resolve(cwd, "src/lib/corpus.ts");
}

export function guidanceIndexPath(dataDir = dataDirectory()): string {
  return join(dataDir, GUIDANCE_DB_NAME);
}

/**
 * True when `guidance.db` is absent or older than the corpus manifest.
 * A failed ingest must not be treated as a reason to delete the previous file.
 */
export function indexNeedsIngest(indexPath: string, manifestPath: string): boolean {
  if (!existsSync(manifestPath)) {
    throw new Error(`corpus manifest is missing (${manifestPath})`);
  }
  if (!existsSync(indexPath)) return true;
  return statSync(indexPath).mtimeMs < statSync(manifestPath).mtimeMs;
}

/**
 * `INGEST_ON_RELEASE=0` keeps an index that is already on disk. A missing
 * file still ingests. Use this when the corpus host blocks the release
 * fetch and the volume already holds `guidance.db`.
 */
export function releaseIngestDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.INGEST_ON_RELEASE?.trim() === "0";
}

/**
 * Run ingest only when the index is missing or stale. The ingest callback
 * owns the temp-file swap. This function does not write `guidance.db`.
 */
export async function prepareIndex(options: {
  indexPath: string;
  manifestPath: string;
  ingest: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
}): Promise<"skipped" | "ingested"> {
  if (
    releaseIngestDisabled(options.env) &&
    existsSync(options.indexPath)
  ) {
    return "skipped";
  }
  if (!indexNeedsIngest(options.indexPath, options.manifestPath)) return "skipped";
  await options.ingest();
  return "ingested";
}

/** Release and ingest both refuse to start without a provider key. */
export function assertRuntimeKey(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is not set");
  }
}
