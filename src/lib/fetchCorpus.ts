import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusDocument } from "./corpus";

/** Raw response body for one corpus document. No file extension. */
export const RAW_BODY_NAME = "body";

/** Fetch metadata written beside the body. */
export const FETCH_JSON_NAME = "fetch.json";

const FETCH_TIMEOUT_MS = 180_000;

const MEDIA_TYPE: Record<CorpusDocument["form"], string> = {
  pdf: "application/pdf",
  html: "text/html",
};

export type FetchRecord = {
  url: string;
  status: number;
  retrievedAt: string;
  contentType: string;
  contentHash: string;
};

export type PreparedFetch = {
  id: string;
  bytes: Uint8Array;
  record: FetchRecord;
};

export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class CorpusFetchError extends Error {
  readonly documentId: string;

  constructor(documentId: string, message: string) {
    super(`${documentId}: ${message}`);
    this.name = "CorpusFetchError";
    this.documentId = documentId;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Media type without parameters, lowercased. */
export function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Why a response cannot be stored, or null when it is a non-empty success
 * with the media type the document form requires.
 */
export function rejectionReason(input: {
  form: CorpusDocument["form"];
  status: number;
  contentType: string | null;
  byteLength: number;
}): string | null {
  if (input.status < 200 || input.status >= 300) {
    return `HTTP ${input.status} is not a success status`;
  }

  const expected = MEDIA_TYPE[input.form];
  if (input.contentType === null || input.contentType.trim() === "") {
    return `content type missing, expected ${expected}`;
  }

  const actual = mediaType(input.contentType);
  if (actual !== expected) {
    return `content type ${actual}, expected ${expected}`;
  }

  if (input.byteLength === 0) {
    return "empty body";
  }

  return null;
}

export function formatFetchLine(input: {
  id: string;
  status: number;
  bytes: number;
  contentType: string;
  contentHash: string;
  retrievedAt: string;
}): string {
  return [
    input.id,
    `status=${input.status}`,
    `bytes=${input.bytes}`,
    `contentType=${input.contentType}`,
    `hash=${input.contentHash}`,
    `retrievedAt=${input.retrievedAt}`,
  ].join(" ");
}

export function rawDirectory(dataDir: string, id: string): string {
  return join(dataDir, "raw", id);
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

async function downloadDocument(
  document: CorpusDocument,
  fetchImpl: FetchImpl,
  now: () => Date,
): Promise<PreparedFetch> {
  let response: Response;
  try {
    response = await fetchImpl(document.sourceUrl, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept:
          document.form === "pdf"
            ? "application/pdf"
            : "text/html,application/xhtml+xml;q=0.9",
        "accept-language": "en",
        // Several corpus hosts reject the default Node user agent.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
  } catch (error) {
    throw new CorpusFetchError(
      document.id,
      `request failed (${errorText(error)})`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  const reason = rejectionReason({
    form: document.form,
    status: response.status,
    contentType,
    byteLength: bytes.byteLength,
  });
  if (reason) {
    throw new CorpusFetchError(document.id, reason);
  }

  return {
    id: document.id,
    bytes,
    record: {
      url: document.sourceUrl,
      status: response.status,
      retrievedAt: now().toISOString(),
      contentType: contentType!.trim(),
      contentHash: sha256Hex(bytes),
    },
  };
}

async function writeAtomic(
  filePath: string,
  data: Uint8Array | string,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, filePath);
}

async function writeRaw(dataDir: string, item: PreparedFetch): Promise<void> {
  const directory = rawDirectory(dataDir, item.id);
  await mkdir(directory, { recursive: true });
  await writeAtomic(join(directory, RAW_BODY_NAME), item.bytes);
  await writeAtomic(
    join(directory, FETCH_JSON_NAME),
    `${JSON.stringify(item.record, null, 2)}\n`,
  );
}

export type RunCorpusFetchOptions = {
  documents: readonly CorpusDocument[];
  dataDir: string;
  fetchImpl?: FetchImpl;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

/**
 * Fetch every document, then write `raw/<id>/body` and `fetch.json`.
 * Validation runs before any write, so a bad response leaves existing raw
 * files and `guidance.db` untouched. This phase never creates the index.
 * Returns 0 on success and 1 on failure.
 */
export async function runCorpusFetch(
  options: RunCorpusFetchOptions,
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  try {
    const prepared: PreparedFetch[] = [];
    for (const document of options.documents) {
      prepared.push(await downloadDocument(document, fetchImpl, now));
    }
    for (const item of prepared) {
      await writeRaw(options.dataDir, item);
    }
    for (const item of prepared) {
      stdout(
        formatFetchLine({
          id: item.id,
          status: item.record.status,
          bytes: item.bytes.byteLength,
          contentType: item.record.contentType,
          contentHash: item.record.contentHash,
          retrievedAt: item.record.retrievedAt,
        }),
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`Fetch failed: ${message}`);
    return 1;
  }
}
