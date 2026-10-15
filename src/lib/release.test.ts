import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRuntimeKey, indexNeedsIngest, prepareIndex } from "./release";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-release-"));
  directories.push(directory);
  return directory;
}

describe("release index check", () => {
  it("ingests when guidance.db is absent", async () => {
    const directory = await tempDir();
    const manifestPath = join(directory, "corpus.ts");
    const indexPath = join(directory, "guidance.db");
    writeFileSync(manifestPath, "export {}");
    let called = false;

    const result = await prepareIndex({
      indexPath,
      manifestPath,
      ingest: async () => {
        called = true;
        writeFileSync(indexPath, "built");
      },
    });

    expect(result).toBe("ingested");
    expect(called).toBe(true);
    expect(readFileSync(indexPath, "utf8")).toBe("built");
  });

  it("skips ingest when the index is newer than the manifest", async () => {
    const directory = await tempDir();
    const manifestPath = join(directory, "corpus.ts");
    const indexPath = join(directory, "guidance.db");
    writeFileSync(manifestPath, "export {}");
    writeFileSync(indexPath, "current");
    const later = new Date(Date.now() + 60_000);
    utimesSync(indexPath, later, later);
    let called = false;

    const result = await prepareIndex({
      indexPath,
      manifestPath,
      ingest: async () => {
        called = true;
      },
    });

    expect(indexNeedsIngest(indexPath, manifestPath)).toBe(false);
    expect(result).toBe("skipped");
    expect(called).toBe(false);
  });

  it("leaves the previous index bytes unchanged when a stale rebuild fails", async () => {
    const directory = await tempDir();
    mkdirSync(directory, { recursive: true });
    const manifestPath = join(directory, "corpus.ts");
    const indexPath = join(directory, "guidance.db");
    writeFileSync(indexPath, "good-index");
    writeFileSync(manifestPath, "export const changed = true;");
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(indexPath, earlier, earlier);

    await expect(
      prepareIndex({
        indexPath,
        manifestPath,
        ingest: async () => {
          throw new Error("embed failed");
        },
      }),
    ).rejects.toThrow("embed failed");

    expect(readFileSync(indexPath, "utf8")).toBe("good-index");
  });

  it("keeps a stale index when release ingest is turned off", async () => {
    const directory = await tempDir();
    const manifestPath = join(directory, "corpus.ts");
    const indexPath = join(directory, "guidance.db");
    writeFileSync(indexPath, "kept");
    writeFileSync(manifestPath, "export const changed = true;");
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(indexPath, earlier, earlier);
    let called = false;

    const result = await prepareIndex({
      indexPath,
      manifestPath,
      env: { INGEST_ON_RELEASE: "0" },
      ingest: async () => {
        called = true;
      },
    });

    expect(result).toBe("skipped");
    expect(called).toBe(false);
    expect(readFileSync(indexPath, "utf8")).toBe("kept");
  });

  it("still ingests when release ingest is turned off but the index is missing", async () => {
    const directory = await tempDir();
    const manifestPath = join(directory, "corpus.ts");
    const indexPath = join(directory, "guidance.db");
    writeFileSync(manifestPath, "export {}");
    let called = false;

    const result = await prepareIndex({
      indexPath,
      manifestPath,
      env: { INGEST_ON_RELEASE: "0" },
      ingest: async () => {
        called = true;
        writeFileSync(indexPath, "built");
      },
    });

    expect(result).toBe("ingested");
    expect(called).toBe(true);
  });

  it("fails closed when the provider key is missing", () => {
    expect(() =>
      assertRuntimeKey({ OPENAI_API_KEY: "  " } as unknown as NodeJS.ProcessEnv),
    ).toThrow("OPENAI_API_KEY is not set");
  });
});
