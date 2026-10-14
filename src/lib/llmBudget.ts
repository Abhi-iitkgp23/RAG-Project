import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Groq limits for `openai/gpt-oss-120b` on this deployment.
 * Minute windows slide. Day windows reset at 00:00 UTC, matching Groq.
 */
export const GPT_OSS_120B_LIMITS = {
  requestsPerMinute: 30,
  requestsPerDay: 1_000,
  tokensPerMinute: 8_000,
  tokensPerDay: 200_000,
} as const;

/** Do not hold one chat turn open longer than this for minute-window room. */
export const MAX_BUDGET_WAIT_MS = 65_000;

const MINUTE_MS = 60_000;

/** These caps apply only to this model id. Other chat models are unchanged. */
export function usesGptOss120bLimits(model: string): boolean {
  return model.trim().toLowerCase().includes("gpt-oss-120b");
}

/**
 * Completion tokens reserved before the call, and sent as `max_completion_tokens`.
 * On gpt-oss this cap includes the reasoning channel, so the draft reserve is larger.
 */
export function completionTokenReserve(schemaName: string): number {
  if (schemaName === "grounded_draft") return 2_048;
  return 512;
}

/**
 * About four characters per token, plus a small framing allowance per message.
 * The reserve is included so one call is sized against the full minute cap.
 */
export function estimateRequestTokens(
  messages: readonly { content: string }[],
  schema: unknown,
  reserve: number,
): number {
  const schemaText = JSON.stringify(schema);
  const chars =
    schemaText.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  const framing = 16 + messages.length * 8;
  return Math.max(1, Math.ceil(chars / 4) + framing + Math.max(0, reserve));
}

/**
 * Drop the oldest turns until the call fits in the per-minute token cap.
 * The first message (the system prompt) and the latest message stay.
 */
export function trimMessagesToLimit<T extends { content: string }>(
  messages: readonly T[],
  schema: unknown,
  schemaName: string,
): T[] {
  const reserve = completionTokenReserve(schemaName);
  const ceiling = GPT_OSS_120B_LIMITS.tokensPerMinute;
  const kept = [...messages];
  while (kept.length > 2 && estimateRequestTokens(kept, schema, reserve) > ceiling) {
    kept.splice(1, 1);
  }
  return kept;
}

export class LlmLimitError extends Error {
  readonly reason: "minute" | "day" | "too_large";

  constructor(reason: "minute" | "day" | "too_large") {
    super(
      reason === "day"
        ? "daily llm limit reached"
        : reason === "too_large"
          ? "llm request exceeds the per-minute token limit"
          : "llm minute limit reached",
    );
    this.name = "LlmLimitError";
    this.reason = reason;
  }
}

type Spend = { id: number; at: number; tokens: number };

type BudgetState = {
  day: string;
  nextId: number;
  events: Spend[];
  blockedUntil: number;
  dayExhausted: boolean;
};

export type BudgetReservation = { id: number; tokens: number };

type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyState(now: number): BudgetState {
  return {
    day: utcDay(now),
    nextId: 1,
    events: [],
    blockedUntil: 0,
    dayExhausted: false,
  };
}

function sumTokens(events: readonly Spend[]): number {
  return events.reduce((sum, event) => sum + event.tokens, 0);
}

/**
 * Process-wide ledger for gpt-oss-120b chat completions.
 * Each HTTP attempt reserves estimated tokens before it is sent.
 * A provider 429 releases the tokens and still counts the request.
 */
export class ChatBudget {
  private tail: Promise<unknown> = Promise.resolve();
  private state: BudgetState;

  private constructor(
    private readonly clock: Clock,
    private readonly persist: ((state: BudgetState) => void) | null,
    loaded: BudgetState | null,
  ) {
    this.state = loaded ?? emptyState(clock.now());
    this.roll(clock.now());
  }

  static memory(clock?: Partial<Clock>): ChatBudget {
    return new ChatBudget(normalizeClock(clock), null, null);
  }

  /** Reload today's spend so a restart does not open a second full window. */
  static open(path: string, clock?: Partial<Clock>): ChatBudget {
    const full = normalizeClock(clock);
    return new ChatBudget(full, (state) => writeState(path, state), readState(path));
  }

  acquire(tokens: number): Promise<BudgetReservation> {
    const cost = Math.max(1, Math.ceil(tokens));
    return this.enqueue(() => this.acquireLocked(cost));
  }

  /** Replace a reservation with the provider's `usage.total_tokens` when present. */
  reconcile(id: number, actualTokens: number | undefined): Promise<void> {
    return this.enqueue(async () => {
      if (actualTokens === undefined || !Number.isFinite(actualTokens) || actualTokens < 0) return;
      const event = this.state.events.find((item) => item.id === id);
      if (!event) return;
      event.tokens = Math.ceil(actualTokens);
      this.save();
    });
  }

  /**
   * The provider rejected the call. Drop the token reservation.
   * Keep the request, and pause new calls until `blockMs` has passed.
   * `daily` closes the rest of the UTC day.
   */
  reject(id: number, options: { daily: boolean; blockMs: number }): Promise<void> {
    return this.enqueue(async () => {
      const now = this.clock.now();
      this.roll(now);
      const event = this.state.events.find((item) => item.id === id);
      if (event) event.tokens = 0;
      if (options.daily) this.state.dayExhausted = true;
      if (options.blockMs > 0) {
        this.state.blockedUntil = Math.max(this.state.blockedUntil, now + options.blockMs);
      }
      this.save();
    });
  }

  snapshot(): {
    minuteRequests: number;
    minuteTokens: number;
    dayRequests: number;
    dayTokens: number;
    dayExhausted: boolean;
  } {
    const now = this.clock.now();
    this.roll(now);
    const minute = this.minuteEvents(now);
    return {
      minuteRequests: minute.length,
      minuteTokens: sumTokens(minute),
      dayRequests: this.state.events.length,
      dayTokens: sumTokens(this.state.events),
      dayExhausted: this.state.dayExhausted,
    };
  }

  private async acquireLocked(tokens: number): Promise<BudgetReservation> {
    if (tokens > GPT_OSS_120B_LIMITS.tokensPerMinute) {
      throw new LlmLimitError("too_large");
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const now = this.clock.now();
      this.roll(now);
      if (
        this.state.dayExhausted ||
        this.state.events.length >= GPT_OSS_120B_LIMITS.requestsPerDay
      ) {
        throw new LlmLimitError("day");
      }
      if (sumTokens(this.state.events) + tokens > GPT_OSS_120B_LIMITS.tokensPerDay) {
        throw new LlmLimitError("day");
      }

      const wait = this.waitMs(tokens, now);
      if (wait <= 0) {
        const reservation: Spend = { id: this.state.nextId, at: now, tokens };
        this.state.nextId += 1;
        this.state.events.push(reservation);
        this.save();
        return { id: reservation.id, tokens };
      }
      if (wait > MAX_BUDGET_WAIT_MS) throw new LlmLimitError("minute");
      await this.clock.sleep(wait);
    }

    throw new LlmLimitError("minute");
  }

  private waitMs(tokens: number, now: number): number {
    let wait = 0;
    if (now < this.state.blockedUntil) wait = this.state.blockedUntil - now;

    const minute = this.minuteEvents(now);
    if (minute.length >= GPT_OSS_120B_LIMITS.requestsPerMinute) {
      const oldest = [...minute].sort((left, right) => left.at - right.at)[0];
      if (oldest) wait = Math.max(wait, oldest.at + MINUTE_MS - now + 25);
    }

    const overflow = sumTokens(minute) + tokens - GPT_OSS_120B_LIMITS.tokensPerMinute;
    if (overflow > 0) {
      const sorted = [...minute].sort((left, right) => left.at - right.at);
      let freed = 0;
      let until = now;
      for (const event of sorted) {
        freed += event.tokens;
        until = event.at + MINUTE_MS;
        if (freed >= overflow) break;
      }
      wait = Math.max(wait, until - now + 25);
    }

    return wait;
  }

  private minuteEvents(now: number): Spend[] {
    return this.state.events.filter((event) => event.at > now - MINUTE_MS);
  }

  private roll(now: number): void {
    const day = utcDay(now);
    if (this.state.day === day) return;
    this.state = {
      day,
      nextId: this.state.nextId,
      events: [],
      blockedUntil: 0,
      dayExhausted: false,
    };
    this.save();
  }

  private save(): void {
    this.persist?.(this.state);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function normalizeClock(clock?: Partial<Clock>): Clock {
  return {
    now: clock?.now ?? (() => Date.now()),
    sleep:
      clock?.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function readState(path: string): BudgetState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetState>;
    if (!parsed || typeof parsed.day !== "string" || !Array.isArray(parsed.events)) return null;
    const events = parsed.events.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const id = event.id;
      const at = event.at;
      const tokens = event.tokens;
      if (typeof id !== "number" || typeof at !== "number" || typeof tokens !== "number") return [];
      return [{ id, at, tokens }];
    });
    return {
      day: parsed.day,
      nextId: typeof parsed.nextId === "number" ? parsed.nextId : events.length + 1,
      events,
      blockedUntil: typeof parsed.blockedUntil === "number" ? parsed.blockedUntil : 0,
      dayExhausted: parsed.dayExhausted === true,
    };
  } catch {
    return null;
  }
}

function writeState(path: string, state: BudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, path);
}
