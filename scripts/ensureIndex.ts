import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertRuntimeKey,
  corpusManifestPath,
  guidanceIndexPath,
  prepareIndex,
} from "../src/lib/release";

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

function runIngest(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npm", ["run", "ingest"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ingest exited ${code ?? "null"}`));
    });
  });
}

async function main(): Promise<void> {
  loadLocalEnv();
  assertRuntimeKey();
  const result = await prepareIndex({
    indexPath: guidanceIndexPath(),
    manifestPath: corpusManifestPath(),
    ingest: runIngest,
  });
  console.log(result === "skipped" ? "guidance index is current" : "guidance index rebuilt");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
