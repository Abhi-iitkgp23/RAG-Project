import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notInCorpusAnswer } from "./coverage";
import { PROFESSIONAL_REFUSAL } from "./decline";
import { createModelClient, ModelOutputError } from "./model";
import {
  SCOPE_CLASSIFIER_PROMPT,
  SCOPE_SCHEMA_NAME,
  classifyScope,
  interpretScopeDecision,
  scanOutputClaims,
  type OutputClaim,
  type OutputScanResult,
  type ScopeTurn,
} from "./scope";
import type { ModelClient } from "./types";

function claim(text: string, documentId: string): OutputClaim {
  return { text, documentId };
}

/**
 * The turn the route will store once phase 7 calls this scan.
 * A decline uses the professional sentence. An empty keep is the coverage
 * refusal. Surviving claims are not assembled here.
 */
function turnFromScan(result: OutputScanResult) {
  if (result.action === "decline") {
    return {
      answer: PROFESSIONAL_REFUSAL,
      claims: [] as OutputClaim[],
      declined: true,
      coverage: "declined" as const,
    };
  }
  if (result.claims.length === 0) {
    return {
      answer: notInCorpusAnswer("all"),
      claims: [] as OutputClaim[],
      declined: false,
      coverage: "not_in_corpus" as const,
    };
  }
  return {
    claims: result.claims,
    declined: false,
    coverage: "answered" as const,
  };
}

function clientReturning(body: unknown): ModelClient {
  return {
    async complete() {
      return body;
    },
  };
}

describe("scope classifier", () => {
  it("sends the current message and at most the 12 preceding turns", async () => {
    const seen: ScopeTurn[] = [];
    const client: ModelClient = {
      async complete(input) {
        seen.push(...input.messages);
        expect(input.schemaName).toBe(SCOPE_SCHEMA_NAME);
        expect(input.system).toBe(SCOPE_CLASSIFIER_PROMPT);
        return { decision: "allow", category: "none" };
      },
    };
    const preceding = Array.from({ length: 13 }, (_, index) => ({
      role: "user" as const,
      content: `turn ${index}`,
    }));

    const decision = await classifyScope(client, "current question", preceding);

    expect(decision).toEqual({ outcome: "allow" });
    expect(seen.map((message) => message.content)).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `turn ${index + 1}`),
      "current question",
    ]);
  });

  it("declines when the current message is out of scope among benign history", async () => {
    const client: ModelClient = {
      async complete(input) {
        const current = input.messages.at(-1)?.content ?? "";
        if (current.includes("calories should I eat")) {
          return { decision: "decline", category: "calorie_target" };
        }
        return { decision: "allow", category: "none" };
      },
    };
    const preceding = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const,
      content: `What does the guidance say about fruit ${index}?`,
    }));

    await expect(
      classifyScope(
        client,
        "How many calories should I eat to lose weight?",
        preceding,
      ),
    ).resolves.toEqual({
      outcome: "decline",
      category: "calorie_target",
    });
  });

  it("allows a benign current message when the dangerous turn is outside the 12", async () => {
    const client: ModelClient = {
      async complete(input) {
        const blob = input.messages.map((message) => message.content).join("\n");
        if (blob.includes("calories should I eat")) {
          return { decision: "decline", category: "calorie_target" };
        }
        return { decision: "allow", category: "none" };
      },
    };
    const preceding = [
      {
        role: "user" as const,
        content: "How many calories should I eat to lose weight?",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: "user" as const,
        content: `Ordinary food question ${index}`,
      })),
    ];

    await expect(
      classifyScope(client, "How long can cooked chicken stay in the fridge?", preceding),
    ).resolves.toEqual({ outcome: "allow" });
  });

  it("declines when the dangerous turn is still inside the 12", async () => {
    const client: ModelClient = {
      async complete(input) {
        const blob = input.messages.map((message) => message.content).join("\n");
        if (blob.includes("calories should I eat")) {
          return { decision: "decline", category: "calorie_target" };
        }
        return { decision: "allow", category: "none" };
      },
    };
    const preceding = [
      {
        role: "user" as const,
        content: "How many calories should I eat to lose weight?",
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        role: "assistant" as const,
        content: `Stored dietary answer ${index}`,
      })),
    ];

    await expect(
      classifyScope(client, "How long can cooked chicken stay in the fridge?", preceding),
    ).resolves.toEqual({
      outcome: "decline",
      category: "calorie_target",
    });
  });

  it("does not overturn an allow with a second scan of the user message", async () => {
    const client = clientReturning({ decision: "allow", category: "none" });
    const messages = [
      "1500 calories",
      "2000 kcal a day",
      "a 500 calorie deficit",
      "What should I weigh?",
      "target BMI 22",
      "get down to 65 kg",
      "lose 10 kg",
      "What should I eat for my diabetes?",
      "What calorie figure does the guidance give for the population?",
    ];

    for (const message of messages) {
      await expect(classifyScope(client, message, [])).resolves.toEqual({
        outcome: "allow",
      });
    }
  });

  it("keeps a decline category from the classifier", async () => {
    await expect(
      classifyScope(
        clientReturning({
          decision: "decline",
          category: "weight_recommendation",
        }),
        "What should I weigh?",
        [],
      ),
    ).resolves.toEqual({
      outcome: "decline",
      category: "weight_recommendation",
    });
    await expect(
      classifyScope(
        clientReturning({ decision: "decline", category: "medical_advice" }),
        "What should I eat for my diabetes?",
        [],
      ),
    ).resolves.toEqual({ outcome: "decline", category: "medical_advice" });
  });

  it("declines when the classifier JSON does not match the decision schema", () => {
    expect(interpretScopeDecision({ decision: "maybe", category: "none" })).toEqual({
      outcome: "decline",
      category: "unparsed",
    });
    expect(interpretScopeDecision({ decision: "decline", category: "none" })).toEqual({
      outcome: "decline",
      category: "unparsed",
    });
    expect(interpretScopeDecision("allow")).toEqual({
      outcome: "decline",
      category: "unparsed",
    });
    expect(
      interpretScopeDecision({
        decision: "allow",
        category: "none",
        answer: "extra",
      }),
    ).toEqual({ outcome: "decline", category: "unparsed" });
  });

  it("still allows when the classifier says allow and also fills a category", () => {
    expect(
      interpretScopeDecision({
        decision: "allow",
        category: "calorie_target",
      }),
    ).toEqual({ outcome: "allow" });
  });

  it("declines when the completion body is not JSON", async () => {
    const client = createModelClient({
      completions: {
        async create() {
          return { choices: [{ message: { content: "not json {" } }] };
        },
      },
    });

    await expect(
      classifyScope(client, "How long can cooked chicken stay in the fridge?", []),
    ).resolves.toEqual({ outcome: "decline", category: "unparsed" });
  });

  it("rethrows a provider failure instead of declining", async () => {
    const client = createModelClient({
      completions: {
        async create() {
          throw new Error("timeout");
        },
      },
    });

    await expect(classifyScope(client, "hello", [])).rejects.toThrow("timeout");
    await expect(classifyScope(client, "hello", [])).rejects.not.toBeInstanceOf(
      ModelOutputError,
    );
  });
});

describe("output scan", () => {
  const clean = claim(
    "Cooked chicken keeps for 3 to 4 days in the refrigerator.",
    "cold-storage-2023",
  );

  it("replaces the whole turn when a claim is a calorie, weight, or medical target", () => {
    const sentences = [
      "Eat 1,500 calories a day to lose weight.",
      "Aim for a 500 calorie deficit.",
      "A goal weight of 65 kg is a common target weight.",
      "Aim for a BMI of 22.",
      "People should weigh 70 kg.",
      "Lose 10 kg over the next month.",
      "Get down to 65 kg.",
      "Avoid sugar for your diabetes.",
      "Take the prescribed dosage with meals.",
      "Seek a diagnosis before changing what you eat.",
    ];

    for (const text of sentences) {
      const result = scanOutputClaims([
        clean,
        claim(text, "dgi-2024"),
      ]);
      expect(turnFromScan(result), text).toEqual({
        answer: PROFESSIONAL_REFUSAL,
        claims: [],
        declined: true,
        coverage: "declined",
      });
    }
  });

  it("drops a personal-plan claim and keeps a sibling", () => {
    const result = scanOutputClaims([
      claim("You should eat more greens at lunch.", "eatwell-2018"),
      claim(
        "The booklet describes fruit and vegetables as one food group.",
        "eatwell-2018",
      ),
    ]);

    expect(turnFromScan(result)).toEqual({
      claims: [
        claim(
          "The booklet describes fruit and vegetables as one food group.",
          "eatwell-2018",
        ),
      ],
      declined: false,
      coverage: "answered",
    });
  });

  it("drops each personal-plan phrase, including on a storage document", () => {
    const phrases = [
      "you should eat",
      "your plate should",
      "I recommend you eat",
      "for you",
      "your target",
      "your plan",
      "based on your weight",
      "based on your height",
    ];

    for (const phrase of phrases) {
      const result = scanOutputClaims([
        claim(`Storage note: ${phrase} the leftovers tonight.`, "fsa-chill-2017"),
        clean,
      ]);
      expect(result, phrase).toEqual({ action: "keep", claims: [clean] });
    }
  });

  it("keeps a chill-within storage sentence", () => {
    const storage = claim(
      "Chill food within 2 hours.",
      "cold-storage-2023",
    );
    const fsa = claim(
      "Chill within two hours of cooking.",
      "fsa-chill-2017",
    );

    expect(scanOutputClaims([storage, fsa])).toEqual({
      action: "keep",
      claims: [storage, fsa],
    });
  });

  it("drops you-should-eat on a storage document and keeps the sibling", () => {
    const result = scanOutputClaims([
      claim(
        "You should eat the leftovers within 4 days.",
        "cold-storage-2023",
      ),
      clean,
    ]);

    expect(result).toEqual({ action: "keep", claims: [clean] });
  });

  it("drops blend patterns and a claim that names two publishers", () => {
    const blends = [
      "The guidelines say oil should be limited.",
      "Both authorities agree on chilling leftovers.",
      "The correct guidance is to use less oil.",
      "The Eatwell booklet is more reliable than the other document.",
      "ICMR and Public Health England both limit saturated fat.",
      "FDA and the Food Standards Agency describe the same chill time.",
    ];

    for (const text of blends) {
      const result = scanOutputClaims([claim(text, "dgi-2024"), clean]);
      expect(result, text).toEqual({ action: "keep", claims: [clean] });
    }
  });

  it("turns a turn with only dropped claims into the coverage path", () => {
    const result = scanOutputClaims([
      claim("The guidelines say oil should be limited.", "eatwell-2018"),
    ]);

    expect(turnFromScan(result)).toEqual({
      answer: notInCorpusAnswer("all"),
      claims: [],
      declined: false,
      coverage: "not_in_corpus",
    });
  });

  it("keeps one publisher and a population calorie or BMI description", () => {
    const kept = [
      claim(
        "ICMR–National Institute of Nutrition describes visible fats in the dietary guidelines.",
        "dgi-2024",
      ),
      claim(
        "A reference diet is about 2000 kcal.",
        "dgi-2024",
      ),
      claim(
        "The booklet describes a BMI of 18.5 to 23 for the reference population.",
        "dgi-2024",
      ),
      claim(
        "Choose a portion for your household from each food group.",
        "eatwell-2018",
      ),
    ];

    expect(scanOutputClaims(kept)).toEqual({ action: "keep", claims: kept });
  });
});

describe("refusal sentences stay out of the answer prompt", () => {
  it("does not put either sentence in prompts/system.md or the classifier prompt", () => {
    const prompt = readFileSync("prompts/system.md", "utf8");
    const banned = [
      PROFESSIONAL_REFUSAL,
      "The guidance I searched does not cover that.",
      notInCorpusAnswer("all"),
      notInCorpusAnswer("eatwell-2018"),
    ];

    for (const sentence of banned) {
      expect(prompt).not.toContain(sentence);
      expect(SCOPE_CLASSIFIER_PROMPT).not.toContain(sentence);
    }
  });
});
