import { describe, expect, it } from "vitest";
import { isUnclearInquiry } from "./clarify";

describe("isUnclearInquiry", () => {
  it("treats a fragment with no topic as unclear", () => {
    for (const message of ["what is ?", "what is", "What is ?", "huh", "??", "tell me", "hi"]) {
      expect(isUnclearInquiry(message), message).toBe(true);
      expect(isUnclearInquiry(message, { hasEarlierUserMessage: true }), message).toBe(true);
    }
  });

  it("keeps a question that names a food, a condition, or a document", () => {
    for (const message of [
      "how many days can honey be stored",
      "what is honey",
      "what about the freezer?",
      "how long?",
      "and cooked rice?",
      "what should I weigh",
      "what is the Eatwell Guide",
    ]) {
      expect(isUnclearInquiry(message), message).toBe(false);
    }
  });

  it("lets a pronoun follow-up through only when an earlier user message exists", () => {
    for (const message of ["what about it?", "and that?", "the same?"]) {
      expect(isUnclearInquiry(message), message).toBe(true);
      expect(isUnclearInquiry(message, { hasEarlierUserMessage: true }), message).toBe(false);
    }
  });
});
