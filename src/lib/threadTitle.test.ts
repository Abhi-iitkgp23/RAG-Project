import { describe, expect, it } from "vitest";
import { conversationTitle } from "./threadTitle";

describe("conversationTitle", () => {
  it("names the welcome questions concisely", () => {
    expect(conversationTitle(["What should I eat daily?"])).toBe("Daily dietary guidance");
    expect(conversationTitle(["Daily water intake"])).toBe("Water intake");
    expect(conversationTitle(["Food storage and leftovers"])).toBe(
      "Food storage and leftovers",
    );
    expect(conversationTitle(["Explore an official guide"])).toBe("The Eatwell Guide");
  });

  it("skips a greeting or mash and titles the later question", () => {
    expect(conversationTitle(["Hey"])).toBeNull();
    expect(conversationTitle(["Het"])).toBeNull();
    expect(conversationTitle(["abshe"])).toBeNull();
    expect(conversationTitle(["Hey", "What should I eat daily?"])).toBe(
      "Daily dietary guidance",
    );
    expect(conversationTitle(["abshe", "How long can cooked chicken stay in the fridge?"])).toBe(
      "How long can cooked chicken stay in the fridge",
    );
  });

  it("keeps a long question on one logical line", () => {
    const title = conversationTitle([
      "What does official dietary guidance say about choosing vegetables, fruit, pulses, and whole grains across a normal week at home?",
    ]);
    expect(title).toBeTruthy();
    expect(title!.length).toBeLessThanOrEqual(72);
    expect(title).not.toBe("What");
  });
});
