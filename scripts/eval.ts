import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVAL_ITEMS,
  EVAL_SET_VERSION,
  REQUEST_TIMEOUT_MS,
  SCORED_IDS,
} from "../src/evals/questions";
import {
  conversationIdOf,
  scoreC1,
  scoreItem,
  type ScoreResult,
} from "../src/evals/score";

/**
 * Posts the frozen question set to a running app. This script does not edit
 * the prompt, the chunker, the scope rules, k, or MIN_SCORE, and it does not
 * read OPENAI_API_KEY.
 */
type ItemFile = {
  id: string;
  thread: string;
  scored: boolean;
  request: { message: string; conversationId?: string } | null;
  httpStatus: number | null;
  response: unknown;
  elapsedMs: number;
  error?: string;
};

type ThreadState = {
  conversationId?: string;
  blockedReason?: string;
};

function timestampDir(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

async function postTurn(
  baseUrl: string,
  body: { message: string; conversationId?: string },
): Promise<{ httpStatus: number; response: unknown; elapsedMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/api/chat", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("response was not JSON");
      }
    }
    return {
      httpStatus: response.status,
      response: parsed,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function blocksThread(httpStatus: number, body: unknown): boolean {
  return httpStatus === 422 || httpStatus === 500 || conversationIdOf(body) === null;
}

async function main(): Promise<void> {
  const baseUrl = process.env.EVAL_BASE_URL?.trim() || "http://localhost:3000";
  const timestamp = timestampDir();
  const directory = join("evals", "runs", timestamp);
  mkdirSync(directory, { recursive: true });

  const threads = new Map<string, ThreadState>();
  const results = new Map<string, ScoreResult>();
  const c1Runs: Array<{ id: string; httpStatus: number; body: unknown }> = [];

  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        evalSetVersion: EVAL_SET_VERSION,
        baseUrl,
        timestamp,
        questionIds: EVAL_ITEMS.map((item) => item.id),
      },
      null,
      2,
    ),
  );

  for (const item of EVAL_ITEMS) {
    const thread = threads.get(item.thread) ?? {};
    threads.set(item.thread, thread);
    const filePath = join(directory, `${item.id}.json`);

    if (thread.blockedReason) {
      const blocked: ItemFile = {
        id: item.id,
        thread: item.thread,
        scored: item.scored,
        request: null,
        httpStatus: null,
        response: null,
        elapsedMs: 0,
        error: thread.blockedReason,
      };
      writeFileSync(filePath, JSON.stringify(blocked, null, 2));
      if (item.scored && !item.id.startsWith("C1-")) {
        results.set(item.id, {
          id: item.id,
          status: "blocked",
          reasons: [thread.blockedReason],
        });
      }
      continue;
    }

    const request = thread.conversationId
      ? { conversationId: thread.conversationId, message: item.message }
      : { message: item.message };

    const started = Date.now();
    try {
      const posted = await postTurn(baseUrl, request);
      const file: ItemFile = {
        id: item.id,
        thread: item.thread,
        scored: item.scored,
        request,
        httpStatus: posted.httpStatus,
        response: posted.response,
        elapsedMs: posted.elapsedMs,
      };
      writeFileSync(filePath, JSON.stringify(file, null, 2));

      const conversationId = conversationIdOf(posted.response);
      if (blocksThread(posted.httpStatus, posted.response)) {
        thread.blockedReason = `${item.id} returned HTTP ${posted.httpStatus} or no conversationId`;
      } else if (conversationId) {
        thread.conversationId = conversationId;
      }

      if (item.id.startsWith("C1-")) {
        c1Runs.push({
          id: item.id,
          httpStatus: posted.httpStatus,
          body: posted.response,
        });
      } else if (item.scored) {
        results.set(item.id, scoreItem(item.id, posted.httpStatus, posted.response));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const file: ItemFile = {
        id: item.id,
        thread: item.thread,
        scored: item.scored,
        request,
        httpStatus: null,
        response: null,
        elapsedMs: Date.now() - started,
        error: message,
      };
      writeFileSync(filePath, JSON.stringify(file, null, 2));
      if (!item.scored || item.id.startsWith("C1-")) {
        thread.blockedReason = `${item.id} request failed: ${message}`;
      }
      if (item.id.startsWith("C1-")) {
        c1Runs.push({ id: item.id, httpStatus: 0, body: null });
      } else if (item.scored) {
        results.set(item.id, {
          id: item.id,
          status: "fail",
          reasons: [`${item.id} request failed: ${message}`],
        });
      } else {
        thread.blockedReason = `${item.id} request failed: ${message}`;
      }
    }
  }

  results.set("C1", scoreC1(c1Runs));

  const ordered: ScoreResult[] = SCORED_IDS.map((id) => {
    return (
      results.get(id) ?? {
        id,
        status: "fail" as const,
        reasons: [`${id} was not scored`],
      }
    );
  });
  const summary = {
    evalSetVersion: EVAL_SET_VERSION,
    passed: ordered.filter((result) => result.status === "pass").length,
    failed: ordered.filter((result) => result.status === "fail").length,
    blocked: ordered.filter((result) => result.status === "blocked").length,
    results: ordered,
  };
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2));

  for (const result of ordered) {
    if (result.status === "pass") console.log(`${result.id} pass`);
    else console.log(`${result.id} ${result.status} — ${result.reasons.join("; ")}`);
  }
  console.log(
    `passed=${summary.passed} failed=${summary.failed} blocked=${summary.blocked}`,
  );
  console.log(directory);

  if (summary.failed > 0 || summary.blocked > 0) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
