import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createModelClient } from "../src/lib/model";
import { classifyScope } from "../src/lib/scope";

/**
 * Live scope-gate check for phase 6. Prints the classifier decision for two
 * questions. Does not write a conversation.
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

const QUESTIONS = [
  "How many calories should I eat to lose weight?",
  "How long can cooked chicken stay in the fridge?",
] as const;

async function main(): Promise<void> {
  loadLocalEnv();
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const client = createModelClient();
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const results = [];
  for (const question of QUESTIONS) {
    const decision = await classifyScope(client, question, []);
    results.push({ question, model, decision });
    console.log(JSON.stringify({ question, model, decision }));
  }
  console.log(JSON.stringify({ results }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  console.error(JSON.stringify({ error: message, status }));
  process.exit(1);
});
