import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatBudget,
  GPT_OSS_120B_LIMITS,
  LlmLimitError,
  completionTokenReserve,
  estimateRequestTokens,
  trimMessagesToLimit,
  usesGptOss120bLimits,
} from "./llmBudget";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function clock(start = Date.parse("2026-10-15T12:00:00.000Z")) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("gpt-oss-120b request estimate", () => {
  it("applies the published caps only to that model id", () => {
    expect(usesGptOss120bLimits("openai/gpt-oss-120b")).toBe(true);
    expect(usesGptOss120bLimits(" openai/gpt-oss-120b ")).toBe(true);
    expect(usesGptOss120bLimits("gpt-4o-mini")).toBe(false);
    expect(GPT_OSS_120B_LIMITS).toEqual({
      requestsPerMinute: 30,
      requestsPerDay: 1_000,
      tokensPerMinute: 8_000,
      tokensPerDay: 200_000,
    });
    expect(completionTokenReserve("grounded_draft")).toBeGreaterThan(
      completionTokenReserve("scope_decision"),
    );
  });

  it("counts characters, schema, and the completion reserve", () => {
    const tokens = estimateRequestTokens(
      [{ content: "abcd" }],
      { type: "object" },
      10,
    );
    expect(tokens).toBeGreaterThan(10);
    expect(estimateRequestTokens([{ content: "" }], {}, 0)).toBeGreaterThan(0);
  });

  it("drops the oldest turns and keeps the system prompt and the latest message", () => {
    const schema = { type: "object" };
    const messages = [
      { content: "system" },
      { content: "old" },
      { content: "x".repeat(40_000) },
      { content: "latest" },
    ];
    const trimmed = trimMessagesToLimit(messages, schema, "scope_decision");
    expect(trimmed[0]?.content).toBe("system");
    expect(trimmed.at(-1)?.content).toBe("latest");
    expect(trimmed.some((message) => message.content === "old")).toBe(false);
  });
});

describe("chat budget", () => {
  it("reserves a call that fits and replaces the estimate with actual usage", async () => {
    const budget = ChatBudget.memory(clock());
    const reservation = await budget.acquire(500);
    expect(budget.snapshot()).toMatchObject({
      minuteRequests: 1,
      minuteTokens: 500,
      dayRequests: 1,
      dayTokens: 500,
    });

    await budget.reconcile(reservation.id, 120);
    expect(budget.snapshot().dayTokens).toBe(120);
    expect(budget.snapshot().minuteTokens).toBe(120);
  });

  it("refuses a single call larger than the minute token cap", async () => {
    const budget = ChatBudget.memory(clock());
    await expect(budget.acquire(GPT_OSS_120B_LIMITS.tokensPerMinute + 1)).rejects.toBeInstanceOf(
      LlmLimitError,
    );
    await expect(budget.acquire(GPT_OSS_120B_LIMITS.tokensPerMinute + 1)).rejects.toMatchObject({
      reason: "too_large",
    });
    expect(budget.snapshot().dayRequests).toBe(0);
  });

  it("waits until the oldest request leaves the minute window", async () => {
    const time = clock();
    const budget = ChatBudget.memory(time);
    for (let index = 0; index < GPT_OSS_120B_LIMITS.requestsPerMinute; index += 1) {
      await budget.acquire(1);
    }
    expect(time.sleeps).toEqual([]);

    await budget.acquire(1);
    expect(time.sleeps[0]).toBeGreaterThanOrEqual(60_000);
    expect(budget.snapshot().minuteRequests).toBe(1);
    expect(budget.snapshot().dayRequests).toBe(GPT_OSS_120B_LIMITS.requestsPerMinute + 1);
  });

  it("waits when the next call would exceed tokens per minute", async () => {
    const time = clock();
    const budget = ChatBudget.memory(time);
    await budget.acquire(7_000);
    await budget.acquire(2_000);
    expect(time.sleeps.length).toBe(1);
    expect(budget.snapshot()).toMatchObject({
      minuteTokens: 2_000,
      dayTokens: 9_000,
    });
  });

  it("stops at 1,000 requests and 200,000 tokens for the UTC day", async () => {
    const requests = clock();
    const requestBudget = ChatBudget.memory(requests);
    for (let index = 0; index < GPT_OSS_120B_LIMITS.requestsPerDay; index += 1) {
      await requestBudget.acquire(1);
    }
    await expect(requestBudget.acquire(1)).rejects.toMatchObject({ reason: "day" });

    const tokens = clock();
    const tokenBudget = ChatBudget.memory(tokens);
    for (let index = 0; index < GPT_OSS_120B_LIMITS.tokensPerDay / 8_000; index += 1) {
      await tokenBudget.acquire(8_000);
      tokens.advance(61_000);
    }
    await expect(tokenBudget.acquire(1)).rejects.toMatchObject({ reason: "day" });
    expect(tokenBudget.snapshot().dayTokens).toBe(GPT_OSS_120B_LIMITS.tokensPerDay);
  });

  it("clears the ledger at UTC midnight", async () => {
    const time = clock(Date.parse("2026-10-15T23:50:00.000Z"));
    const budget = ChatBudget.memory(time);
    await budget.acquire(400);
    time.advance(20 * 60_000);
    expect(budget.snapshot()).toMatchObject({
      dayRequests: 0,
      dayTokens: 0,
      dayExhausted: false,
    });
  });

  it("keeps a rejected request and pauses, and closes the day when the provider says so", async () => {
    const time = clock();
    const budget = ChatBudget.memory(time);
    const reservation = await budget.acquire(500);
    await budget.reject(reservation.id, { daily: false, blockMs: 5_000 });
    expect(budget.snapshot()).toMatchObject({ dayRequests: 1, dayTokens: 0 });

    await budget.acquire(10);
    expect(time.sleeps[0]).toBeGreaterThanOrEqual(5_000);

    const daily = ChatBudget.memory(clock());
    const spent = await daily.acquire(10);
    await daily.reject(spent.id, { daily: true, blockMs: 0 });
    await expect(daily.acquire(10)).rejects.toMatchObject({ reason: "day" });
  });

  it("reloads today's spend from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dietary-rag-budget-"));
    directories.push(directory);
    const path = join(directory, "llm-budget.json");
    const time = clock();
    const first = ChatBudget.open(path, time);
    await first.acquire(400);

    const second = ChatBudget.open(path, time);
    expect(second.snapshot()).toMatchObject({ dayRequests: 1, dayTokens: 400 });
    await expect(second.acquire(GPT_OSS_120B_LIMITS.tokensPerDay)).rejects.toMatchObject({
      reason: "too_large",
    });
    expect(second.snapshot().dayTokens).toBe(400);
  });
});
