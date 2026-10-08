import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS, type CorpusDocument } from "./corpus";
import {
  FETCH_JSON_NAME,
  RAW_BODY_NAME,
  runCorpusFetch,
  sha256Hex,
} from "./fetchCorpus";

const INDEX_NAME = "guidance.db";
const PREVIOUS_INDEX = "previous-guidance-index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dietary-rag-fetch-"));
  directories.push(directory);
  return directory;
}

function httpResponse(
  body: Uint8Array | string,
  status: number,
  contentType: string,
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function pdfDocument(sourceUrl = "https://example.test/dgi.pdf"): CorpusDocument {
  return {
    ...CORPUS[0]!,
    sourceUrl,
  };
}

function htmlDocument(
  sourceUrl = "https://example.test/storage",
): CorpusDocument {
  return {
    ...CORPUS[2]!,
    sourceUrl,
  };
}

async function seedIndex(dataDir: string, bytes = PREVIOUS_INDEX): Promise<void> {
  await writeFile(join(dataDir, INDEX_NAME), bytes);
}

async function expectIndex(dataDir: string, bytes: string | null): Promise<void> {
  const path = join(dataDir, INDEX_NAME);
  if (bytes === null) {
    await expect(access(path)).rejects.toThrow();
    return;
  }
  expect(await readFile(path, "utf8")).toBe(bytes);
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("sha256", () => {
  it("hashes the raw bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("corpus fetch", () => {
  it("exits non-zero on an empty body and does not create guidance.db", async () => {
    const dataDir = await tempDir();
    const lines: string[] = [];
    const code = await runCorpusFetch({
      documents: [pdfDocument()],
      dataDir,
      stdout: (line) => lines.push(line),
      stderr: () => {},
      fetchImpl: async () => httpResponse(new Uint8Array(), 200, "application/pdf"),
    });

    expect(code).toBe(1);
    expect(lines).toEqual([]);
    await expectIndex(dataDir, null);
    await expect(
      access(join(dataDir, "raw", "dgi-2024", RAW_BODY_NAME)),
    ).rejects.toThrow();
  });

  it("keeps an existing guidance.db when the body is empty", async () => {
    const dataDir = await tempDir();
    await seedIndex(dataDir);
    const errors: string[] = [];
    const code = await runCorpusFetch({
      documents: [pdfDocument()],
      dataDir,
      stderr: (line) => errors.push(line),
      fetchImpl: async () => httpResponse(new Uint8Array(), 200, "application/pdf"),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("dgi-2024: empty body");
    await expectIndex(dataDir, PREVIOUS_INDEX);
  });

  it.each([404, 500])(
    "exits non-zero on HTTP %s and leaves the index untouched",
    async (status) => {
      const dataDir = await tempDir();
      await seedIndex(dataDir);
      const code = await runCorpusFetch({
        documents: [pdfDocument()],
        dataDir,
        stderr: () => {},
        fetchImpl: async () =>
          httpResponse("missing", status, "application/pdf"),
      });

      expect(code).toBe(1);
      await expectIndex(dataDir, PREVIOUS_INDEX);
    },
  );

  it("exits non-zero when a redirect ends in a non-success status", async () => {
    const dataDir = await tempDir();
    await seedIndex(dataDir);
    const server = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/missing" });
        response.end();
        return;
      }
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("missing");
    });

    try {
      const errors: string[] = [];
      const code = await runCorpusFetch({
        documents: [htmlDocument(`${server.origin}/start`)],
        dataDir,
        stderr: (line) => errors.push(line),
      });

      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("HTTP 404");
      await expectIndex(dataDir, PREVIOUS_INDEX);
      await expect(
        access(join(dataDir, "raw", "cold-storage-2023", RAW_BODY_NAME)),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("rejects a PDF booklet served as HTML and an HTML page served as PDF", async () => {
    const dataDir = await tempDir();
    await seedIndex(dataDir);
    const pdfAsHtml = await runCorpusFetch({
      documents: [pdfDocument()],
      dataDir,
      stderr: () => {},
      fetchImpl: async () =>
        httpResponse("<html>not a pdf</html>", 200, "text/html"),
    });
    expect(pdfAsHtml).toBe(1);

    const htmlAsPdf = await runCorpusFetch({
      documents: [htmlDocument()],
      dataDir,
      stderr: () => {},
      fetchImpl: async () =>
        httpResponse("%PDF-1.7", 200, "application/pdf"),
    });
    expect(htmlAsPdf).toBe(1);
    await expectIndex(dataDir, PREVIOUS_INDEX);
  });

  it("accepts a content type that includes parameters", async () => {
    const dataDir = await tempDir();
    const retrievedAt = "2026-10-08T00:00:00.000Z";
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 booklet");
    const htmlBytes = new TextEncoder().encode("<html>storage chart</html>");
    const code = await runCorpusFetch({
      documents: [pdfDocument(), htmlDocument()],
      dataDir,
      now: () => new Date(retrievedAt),
      fetchImpl: async (url) =>
        url.endsWith(".pdf")
          ? httpResponse(pdfBytes, 200, "application/pdf; charset=binary")
          : httpResponse(htmlBytes, 200, "text/html; charset=utf-8"),
    });

    expect(code).toBe(0);
    const pdfRecord = JSON.parse(
      await readFile(
        join(dataDir, "raw", "dgi-2024", FETCH_JSON_NAME),
        "utf8",
      ),
    );
    const htmlRecord = JSON.parse(
      await readFile(
        join(dataDir, "raw", "cold-storage-2023", FETCH_JSON_NAME),
        "utf8",
      ),
    );
    expect(pdfRecord.contentType).toBe("application/pdf; charset=binary");
    expect(pdfRecord.contentHash).toBe(sha256Hex(pdfBytes));
    expect(htmlRecord.contentType).toBe("text/html; charset=utf-8");
    expect(htmlRecord.contentHash).toBe(sha256Hex(htmlBytes));
    await expectIndex(dataDir, null);
  });

  it("does not swap guidance.db when three documents succeed and the fourth fails", async () => {
    const dataDir = await tempDir();
    await seedIndex(dataDir);
    const previousBody = "previous-dgi-body";
    await mkdir(join(dataDir, "raw", "dgi-2024"), { recursive: true });
    await writeFile(
      join(dataDir, "raw", "dgi-2024", RAW_BODY_NAME),
      previousBody,
    );

    const lines: string[] = [];
    const code = await runCorpusFetch({
      documents: CORPUS,
      dataDir,
      stdout: (line) => lines.push(line),
      stderr: () => {},
      fetchImpl: async (url) => {
        const document = CORPUS.find((item) => item.sourceUrl === url);
        if (!document || document.id === "fsa-chill-2017") {
          return httpResponse(new Uint8Array(), 200, "text/html");
        }
        const contentType =
          document.form === "pdf" ? "application/pdf" : "text/html";
        return httpResponse(`fresh ${document.id}`, 200, contentType);
      },
    });

    expect(code).toBe(1);
    expect(lines).toEqual([]);
    await expectIndex(dataDir, PREVIOUS_INDEX);
    expect(
      await readFile(join(dataDir, "raw", "dgi-2024", RAW_BODY_NAME), "utf8"),
    ).toBe(previousBody);
    await expect(
      access(join(dataDir, "raw", "eatwell-2018", RAW_BODY_NAME)),
    ).rejects.toThrow();
  });

  it("stores the redirected body and keeps the manifest URL", async () => {
    const dataDir = await tempDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nredirected booklet\n");
    const server = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/file.pdf" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(pdfBytes);
    });

    try {
      const document = pdfDocument(`${server.origin}/start`);
      const lines: string[] = [];
      const code = await runCorpusFetch({
        documents: [document],
        dataDir,
        stdout: (line) => lines.push(line),
        now: () => new Date("2026-10-08T12:00:00.000Z"),
      });

      expect(code).toBe(0);
      const stored = await readFile(
        join(dataDir, "raw", document.id, RAW_BODY_NAME),
      );
      expect(Buffer.from(stored).equals(pdfBytes)).toBe(true);
      const record = JSON.parse(
        await readFile(
          join(dataDir, "raw", document.id, FETCH_JSON_NAME),
          "utf8",
        ),
      );
      expect(record.url).toBe(document.sourceUrl);
      expect(record.status).toBe(200);
      expect(record.contentHash).toBe(sha256Hex(pdfBytes));
      expect(lines[0]).toContain(`hash=${record.contentHash}`);
      expect(lines[0]).toContain("status=200");
      expect(lines[0]).toContain(`bytes=${pdfBytes.byteLength}`);
      await expectIndex(dataDir, null);
    } finally {
      await server.close();
    }
  });

  it("follows redirects only when the request asks to follow", async () => {
    const dataDir = await tempDir();
    let redirectMode: RequestRedirect | undefined;
    const bytes = new TextEncoder().encode("%PDF-followed");
    const code = await runCorpusFetch({
      documents: [pdfDocument()],
      dataDir,
      fetchImpl: async (_url, init) => {
        redirectMode = init?.redirect;
        return httpResponse(bytes, 200, "application/pdf");
      },
    });

    expect(code).toBe(0);
    expect(redirectMode).toBe("follow");
  });

  it("keeps the same hash when the origin bytes are unchanged", async () => {
    const dataDir = await tempDir();
    const bytes = new TextEncoder().encode("%PDF-stable");
    const times = ["2026-10-08T00:00:00.000Z", "2026-10-08T01:00:00.000Z"];
    let tick = 0;
    const fetchImpl = async () =>
      httpResponse(bytes, 200, "application/pdf");

    const recordPath = join(dataDir, "raw", "dgi-2024", FETCH_JSON_NAME);
    expect(
      await runCorpusFetch({
        documents: [pdfDocument()],
        dataDir,
        fetchImpl,
        now: () => new Date(times[tick++]!),
      }),
    ).toBe(0);
    const first = JSON.parse(await readFile(recordPath, "utf8"));
    expect(
      await runCorpusFetch({
        documents: [pdfDocument()],
        dataDir,
        fetchImpl,
        now: () => new Date(times[tick++]!),
      }),
    ).toBe(0);
    const second = JSON.parse(await readFile(recordPath, "utf8"));

    expect(first.contentHash).toBe(sha256Hex(bytes));
    expect(second.contentHash).toBe(first.contentHash);
    expect(first.retrievedAt).toBe(times[0]);
    expect(second.retrievedAt).toBe(times[1]);
  });

  it("changes the hash when the origin bytes change", async () => {
    const firstDir = await tempDir();
    const secondDir = await tempDir();
    const firstBytes = new TextEncoder().encode("%PDF-version-a");
    const secondBytes = new TextEncoder().encode("%PDF-version-b");

    expect(
      await runCorpusFetch({
        documents: [pdfDocument()],
        dataDir: firstDir,
        fetchImpl: async () => httpResponse(firstBytes, 200, "application/pdf"),
      }),
    ).toBe(0);
    expect(
      await runCorpusFetch({
        documents: [pdfDocument()],
        dataDir: secondDir,
        fetchImpl: async () =>
          httpResponse(secondBytes, 200, "application/pdf"),
      }),
    ).toBe(0);

    const first = JSON.parse(
      await readFile(
        join(firstDir, "raw", "dgi-2024", FETCH_JSON_NAME),
        "utf8",
      ),
    );
    const second = JSON.parse(
      await readFile(
        join(secondDir, "raw", "dgi-2024", FETCH_JSON_NAME),
        "utf8",
      ),
    );
    expect(first.contentHash).toBe(sha256Hex(firstBytes));
    expect(second.contentHash).toBe(sha256Hex(secondBytes));
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("exits non-zero on a timeout and leaves the index untouched", async () => {
    const dataDir = await tempDir();
    await seedIndex(dataDir);
    const errors: string[] = [];
    const code = await runCorpusFetch({
      documents: [pdfDocument()],
      dataDir,
      stderr: (line) => errors.push(line),
      fetchImpl: async () => {
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        );
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("request failed");
    expect(errors.join("\n")).toContain("timeout");
    await expectIndex(dataDir, PREVIOUS_INDEX);
  });

  it("exits non-zero on a connection reset and leaves the index untouched", async () => {
    const dataDir = await tempDir();
    await seedIndex(dataDir);
    const errors: string[] = [];
    const code = await runCorpusFetch({
      documents: [pdfDocument()],
      dataDir,
      stderr: (line) => errors.push(line),
      fetchImpl: async () => {
        throw Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        });
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("socket hang up");
    await expectIndex(dataDir, PREVIOUS_INDEX);
    await expect(access(join(dataDir, "raw"))).rejects.toThrow();
  });
});
