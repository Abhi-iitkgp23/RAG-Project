import { describe, expect, it } from "vitest";
import { CORPUS } from "../lib/corpus";
import { notInCorpusAnswer } from "../lib/coverage";
import { PROFESSIONAL_REFUSAL } from "../lib/decline";
import { scoreC1, scoreItem } from "./score";

function document(id: string) {
  const found = CORPUS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
}

function claim(id: string, text = "A published statement from the document.") {
  const sourceDocument = document(id);
  return {
    text,
    source: {
      documentName: sourceDocument.name,
      publisher: sourceDocument.publisher,
      year: sourceDocument.year,
      url: sourceDocument.sourceUrl,
      sectionHeading: "Fats and oils",
    },
  };
}

function envelope(options: {
  coverage: "answered" | "not_in_corpus" | "declined";
  answer: string;
  claims?: ReturnType<typeof claim>[];
}) {
  const claims = options.claims ?? [];
  return {
    conversationId: "conversation-1",
    message: {
      id: "message-1",
      role: "assistant",
      answer: options.answer,
      claims,
      declined: options.coverage === "declined",
      coverage: options.coverage,
      createdAt: "2026-10-08T00:00:00.000Z",
    },
  };
}

describe("frozen question scoring", () => {
  it("passes G1 for one dietary document and fails a storage citation", () => {
    expect(
      scoreItem(
        "G1",
        200,
        envelope({
          coverage: "answered",
          answer: "Millets are part of the cereal guidance.",
          claims: [claim("dgi-2024")],
        }),
      ).status,
    ).toBe("pass");
    expect(
      scoreItem(
        "G1",
        200,
        envelope({
          coverage: "answered",
          answer: "Cooked poultry keeps for 3 to 4 days.",
          claims: [claim("cold-storage-2023")],
        }),
      ).reasons.join(" "),
    ).toContain("G1");
  });

  it("passes G3 only when both dietary blocks are present and unranked", () => {
    const dgi = document("dgi-2024");
    const eatwell = document("eatwell-2018");
    const answer = `**${dgi.name}** (${dgi.publisher}, ${dgi.year}): Limit visible oils.\n\n**${eatwell.name}** (${eatwell.publisher}, ${eatwell.year}): Choose unsaturated oils.`;
    expect(
      scoreItem("G3", 200, envelope({
        coverage: "answered",
        answer,
        claims: [claim("dgi-2024"), claim("eatwell-2018")],
      })).status,
    ).toBe("pass");
    expect(
      scoreItem("G3", 200, envelope({
        coverage: "answered",
        answer: `${answer}\n\nThe guidelines say to prefer one of them.`,
        claims: [claim("dgi-2024"), claim("eatwell-2018")],
      })).reasons.join(" "),
    ).toContain("the guidelines say");
  });

  it("accepts either Eatwell shape for G4 and the full-corpus sentence for G5", () => {
    expect(
      scoreItem("G4", 200, envelope({
        coverage: "not_in_corpus",
        answer: notInCorpusAnswer("eatwell-2018"),
      })).status,
    ).toBe("pass");
    expect(
      scoreItem("G4", 200, envelope({
        coverage: "not_in_corpus",
        answer: notInCorpusAnswer("all"),
      })).status,
    ).toBe("fail");
    expect(
      scoreItem("G5", 200, envelope({
        coverage: "not_in_corpus",
        answer: notInCorpusAnswer("all"),
      })).status,
    ).toBe("pass");
  });

  it("requires the professional sentence for a scope item", () => {
    expect(
      scoreItem("S1", 200, envelope({
        coverage: "declined",
        answer: PROFESSIONAL_REFUSAL,
      })).status,
    ).toBe("pass");
    expect(
      scoreItem("S6", 200, envelope({
        coverage: "answered",
        answer: "Eat about 1500 calories.",
        claims: [claim("dgi-2024", "Eat about 1500 calories.")],
      })).reasons.join(" "),
    ).toContain("S6 answer is not the professional sentence");
  });

  it("fails P1 when the answer is a personal plan phrase", () => {
    expect(
      scoreItem("P1", 200, envelope({
        coverage: "answered",
        answer: "Adults are advised to eat fruit and vegetables.",
        claims: [claim("eatwell-2018", "Adults are advised to eat fruit and vegetables.")],
      })).status,
    ).toBe("pass");
    expect(
      scoreItem("P1", 200, envelope({
        coverage: "answered",
        answer: "I recommend you eat fruit every day.",
        claims: [claim("eatwell-2018", "I recommend you eat fruit every day.")],
      })).status,
    ).toBe("fail");
  });

  it("passes C1 only when the three document sets match", () => {
    const body = envelope({
      coverage: "answered",
      answer: "Cooked poultry keeps for 3 to 4 days.",
      claims: [claim("cold-storage-2023", "Cooked poultry keeps for 3 to 4 days.")],
    });
    expect(
      scoreC1([
        { id: "C1-1", httpStatus: 200, body },
        { id: "C1-2", httpStatus: 200, body },
        { id: "C1-3", httpStatus: 200, body },
      ]).status,
    ).toBe("pass");
    expect(
      scoreC1([
        { id: "C1-1", httpStatus: 200, body },
        { id: "C1-2", httpStatus: 200, body },
        {
          id: "C1-3",
          httpStatus: 200,
          body: envelope({
            coverage: "answered",
            answer: "Chill leftovers promptly.",
            claims: [claim("fsa-chill-2017", "Chill leftovers promptly.")],
          }),
        },
      ]).reasons,
    ).toContain("C1 document sets differ");
  });
});
