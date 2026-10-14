import { describe, expect, it } from "vitest";
import {
  GREETING_ANSWER,
  NONSENSE_ANSWER,
  PROFANITY_ANSWER,
  UNRELATED_MATHS_ANSWER,
  classifyInquiry,
  isUnclearInquiry,
  normalizeQuery,
} from "./clarify";

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

  it("asks for clarification on a token that is not a word", () => {
    expect(isUnclearInquiry("GAVSV")).toBe(true);
    expect(isUnclearInquiry("GAVSV", { hasEarlierUserMessage: true })).toBe(true);
  });

  it("lets hydration, daily diet, storage, and food-nutrient questions through", () => {
    for (const message of [
      "How much water should I drink daily?",
      "Hey what should I eat on daily basis?",
      "How long can cooked leftovers stay in the fridge?",
      "How many calories are in 100 g of an apple?",
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

describe("classifyInquiry", () => {
  it("normalizes case and surrounding whitespace before classifying", () => {
    expect(normalizeQuery("  HEY  ")).toBe("hey");
    expect(classifyInquiry("HEY")).toEqual(classifyInquiry(" hey "));
    expect(classifyInquiry("  Hello  ")).toEqual(classifyInquiry("hello"));
    expect(classifyInquiry("WHAT SHOULD I EAT DAILY?")).toEqual(
      classifyInquiry("  what should I eat daily?  "),
    );
  });

  it("treats greetings as greetings, including a one-edit typo of hey", () => {
    for (const message of ["Hi", "Hey ", " hello ", "HEY", "hney", "Hey there", "Hey!"]) {
      expect(classifyInquiry(message), message).toEqual({
        outcome: "respond",
        reason: "greeting",
        answer: GREETING_ANSWER,
      });
    }
  });

  it("does not treat every short message as a greeting", () => {
    for (const message of ["rice", "oil", "help", "ok", "hot", "hay", "honey", "water"]) {
      const decision = classifyInquiry(message);
      if (decision.outcome === "respond") {
        expect(decision.reason, message).not.toBe("greeting");
      }
    }
  });

  it("does not treat a greeting that asks a dietary question as a greeting alone", () => {
    for (const message of [
      "Hey what should I eat on daily basis?",
      "HELLO how much water should I drink daily?",
      "Hi, how long can cooked rice stay in the fridge?",
    ]) {
      expect(classifyInquiry(message), message).toEqual({ outcome: "proceed" });
    }
  });

  it("asks a specific clarification for a single food keyword", () => {
    expect(classifyInquiry("water")).toMatchObject({
      outcome: "respond",
      reason: "ambiguous",
      answer:
        "What would you like to know about water—daily intake, hydration, or something else?",
    });
    expect(classifyInquiry("Honey")).toMatchObject({
      outcome: "respond",
      reason: "ambiguous",
      answer: "Are you asking about honey's role in dietary guidance or how to store it?",
    });
    expect(classifyInquiry(" rice ")).toMatchObject({
      outcome: "respond",
      reason: "ambiguous",
      answer:
        "Would you like to know about rice as part of a balanced diet or how to store cooked rice safely?",
    });
    expect(classifyInquiry("what is honey")).toEqual({ outcome: "proceed" });
    expect(classifyInquiry("Is honey part of a balanced diet?")).toEqual({ outcome: "proceed" });
  });

  it("asks for clarification on gibberish and does not treat it as a food question", () => {
    for (const message of ["GAVSV", "asdfgh", "xyz123"]) {
      expect(classifyInquiry(message), message).toEqual({
        outcome: "respond",
        reason: "nonsense",
        answer: NONSENSE_ANSWER,
      });
      expect(classifyInquiry(message, { hasEarlierUserMessage: true }), message).toMatchObject({
        reason: "nonsense",
      });
    }
  });

  it("redirects profanity alone and still allows a dietary question that includes it", () => {
    expect(classifyInquiry("bsdk")).toEqual({
      outcome: "respond",
      reason: "profanity",
      answer: PROFANITY_ANSWER,
    });
    expect(classifyInquiry("BSDk!!!")).toMatchObject({ reason: "profanity" });
    expect(classifyInquiry("what the fuck should I eat daily?")).toEqual({
      outcome: "proceed",
    });
  });

  it("treats a bare sum as unrelated and keeps dietary questions that contain numbers", () => {
    expect(classifyInquiry("6+6")).toEqual({
      outcome: "respond",
      reason: "unrelated",
      answer: UNRELATED_MATHS_ANSWER,
    });
    for (const message of [
      "How much water should I drink daily?",
      "How long can cooked rice stay in the fridge?",
      "Can I keep leftovers 3+4 days?",
      "What should I eat daily?",
    ]) {
      expect(classifyInquiry(message), message).toEqual({ outcome: "proceed" });
    }
  });

  it("keeps a pronoun follow-up on the retrieval path when an earlier turn exists", () => {
    expect(classifyInquiry("what about it?")).toMatchObject({ reason: "unclear" });
    expect(classifyInquiry("what about it?", { hasEarlierUserMessage: true })).toEqual({
      outcome: "proceed",
    });
  });
});
