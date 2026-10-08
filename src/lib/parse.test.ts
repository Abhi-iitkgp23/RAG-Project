import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CORPUS } from "./corpus";
import { parseCorpusDocument } from "./parse";
import { parseHtmlDocument } from "./parseHtml";
import { unitsFromLines, type SourceLine } from "./parsePdf";

const CHART = `<!doctype html>
<html><body>
<nav><a href="/elsewhere">Meat and Poultry</a></nav>
<main>
  <h1>Cold Food Storage Chart</h1>
  <script>window.secret = "do-not-index";</script>
  <p>Follow the guidelines below for storing food in the refrigerator.</p>
  <ul><li>Keep the refrigerator at 40°F or below.</li></ul>
  <table>
    <thead>
      <tr>
        <th>Food</th><th>Type</th>
        <th>Refrigerator [40°F (4°C) or below]</th>
        <th>Freezer [0°F (-18°C) or below]</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th rowspan="2">Leftovers</th>
        <td>Cooked meat or poultry</td>
        <td>3 to 4 days</td>
        <td>2 to 6 months</td>
      </tr>
      <tr>
        <td>Pizza</td>
        <td>3 to 4 days</td>
        <td>1 to 2 months</td>
      </tr>
      <tr>
        <th>Eggs</th>
        <td>Raw eggs in shell</td>
        <td>3 to 5 weeks</td>
        <td>Do not freeze in shell</td>
      </tr>
    </tbody>
  </table>
</main>
<footer><h2>Partners</h2><p>Not guidance.</p></footer>
</body></html>`;

const ARTICLE = `<!doctype html>
<html><body>
  <div class="gem-c-cookie-banner"><h2>Cookies on GOV.UK</h2><p>We use cookies.</p></div>
  <main>
    <header>
      <h1>How to chill, freeze and defrost food safely</h1>
    </header>
    <nav class="gem-c-contents-list"><a href="#chilling-food">Chilling food</a></nav>
    <div class="govspeak">
      <p>Chilling food properly helps stop harmful bacteria from growing.</p>
      <ul>
        <li>your fridge should be between 0 and 5°C</li>
        <li>eat leftovers within two days</li>
      </ul>
      <h2 id="chilling-food">1. Chilling food</h2>
      <p>Your fridge should be set between 0 and 5°C.</p>
      <h3>Use-by dates</h3>
      <p>Store food with a use-by date in the fridge.</p>
      <h2 id="freezing-food">2. Freezing Food</h2>
      <p>A freezer acts as a pause button.</p>
      <ul><li>your freezer should be around -18°C</li></ul>
    </div>
  </main>
</body></html>`;

function line(partial: Partial<SourceLine> & Pick<SourceLine, "text" | "y">): SourceLine {
  return {
    page: 1,
    x: 72,
    fontSize: 12,
    heavier: false,
    bodySize: 12,
    pageHeight: 840,
    isTable: false,
    margin: false,
    ...partial,
  };
}

describe("HTML parser", () => {
  it("drops navigation chrome and keeps a list with its heading", () => {
    const parsed = parseHtmlDocument(
      new TextEncoder().encode(ARTICLE),
      { id: "fsa-chill-2017", name: "How to chill, freeze and defrost food safely" },
    );
    const text = parsed.units.map((unit) => unit.text).join("\n");
    expect(text).not.toMatch(/Cookies on GOV\.UK/);
    expect(text).not.toMatch(/We use cookies/);
    const intro = parsed.units.find((unit) =>
      unit.sectionHeading === "How to chill, freeze and defrost food safely",
    );
    expect(intro?.text).toMatch(/harmful bacteria/);
    expect(intro?.text).toMatch(/0 and 5°C/);
    expect(intro?.kind).toBe("section");

    const dates = parsed.units.find((unit) => /Use-by dates/.test(unit.sectionHeading));
    expect(dates?.sectionHeading).toBe(
      "How to chill, freeze and defrost food safely \u203a 1. Chilling food \u203a Use-by dates",
    );
    expect(dates?.text).toMatch(/use-by date/);

    const freezing = parsed.units.find((unit) => /Freezing Food/.test(unit.sectionHeading));
    expect(freezing?.text).toMatch(/pause button/);
    expect(freezing?.text).toMatch(/-18°C/);
    expect(parsed.units.every((unit) => unit.sectionHeading.length > 0)).toBe(true);
    expect(parsed.units.every((unit) => unit.text.length > 0)).toBe(true);
  });

  it("splits the cold-storage chart into category units", () => {
    const parsed = parseHtmlDocument(
      new TextEncoder().encode(CHART),
      { id: "cold-storage-2023", name: "Cold Food Storage Chart" },
      { chartCategories: true },
    );
    const text = parsed.units.map((unit) => `${unit.sectionHeading}\n${unit.text}`).join("\n");
    expect(text).not.toMatch(/do-not-index/);
    expect(text).not.toMatch(/Meat and Poultry/);
    expect(text).not.toMatch(/Partners/);

    const intro = parsed.units.find((unit) => /refrigerator at 40/.test(unit.text));
    expect(intro?.kind).toBe("section");
    expect(intro?.sectionHeading).toBe("Cold Food Storage Chart");

    const leftovers = parsed.units.find((unit) => /Cooked meat or poultry/.test(unit.text));
    expect(leftovers?.kind).toBe("category");
    expect(leftovers?.sectionHeading).toBe("Cold Food Storage Chart \u203a Leftovers");
    expect(leftovers?.text).toMatch(/Cooked meat or poultry/);
    expect(leftovers?.text).toMatch(/3 to 4 days/);
    expect(leftovers?.text).toMatch(/Pizza/);
    expect(leftovers?.text).not.toMatch(/Raw eggs/);
    expect(leftovers?.rows?.[0]).toMatch(/Food \| Type \| Refrigerator/);

    const eggs = parsed.units.find((unit) => /Raw eggs in shell/.test(unit.text));
    expect(eggs?.kind).toBe("category");
    expect(eggs?.text).toMatch(/3 to 5 weeks/);
    expect(parsed.tableCount).toBe(1);
    expect(parsed.headingCount).toBe(1);
  });
});

describe("PDF unit builder", () => {
  const document = { id: "dgi-2024" as const, name: "Dietary Guidelines for Indians" };

  it("keeps a heading stack and a numbered recommendation", () => {
    const parsed = unitsFromLines(
      [
        line({ y: 760, fontSize: 22, text: "Fats and oils" }),
        line({ y: 730, fontSize: 16, text: "Visible fats" }),
        line({ y: 700, text: "Visible fats are oils added during cooking." }),
        line({ y: 680, text: "Use them in moderation." }),
        line({ y: 620, fontSize: 20, text: "GUIDELINE 7" }),
        line({ y: 580, fontSize: 18, text: "Use oils in moderation to meet daily needs." }),
        line({ y: 520, text: "Refined oils are processed products." }),
      ],
      document,
    );
    const visible = parsed.units.find((unit) => /added during cooking/.test(unit.text));
    expect(visible?.sectionHeading).toBe("Fats and oils \u203a Visible fats");
    expect(visible?.kind).toBe("section");
    expect(visible?.text).toMatch(/moderation/);

    const guideline = parsed.units.find((unit) => unit.kind === "recommendation");
    expect(guideline?.text).toMatch(/GUIDELINE 7/);
    expect(guideline?.text).toMatch(/Use oils in moderation/);
    const rationale = parsed.units.find((unit) => /processed products/.test(unit.text));
    expect(rationale?.sectionHeading).toMatch(/GUIDELINE 7/);
    expect(rationale?.kind).toBe("section");
  });

  it("renders an aligned table with cells joined by a bar", () => {
    const parsed = unitsFromLines(
      [
        line({ y: 500, isTable: true, text: "Food | Fridge" }),
        line({ y: 480, isTable: true, text: "Rice | 1 day" }),
        line({ y: 460, isTable: true, text: "Beans | 2 days" }),
      ],
      document,
    );
    expect(parsed.tableCount).toBe(1);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]?.kind).toBe("table");
    expect(parsed.units[0]?.text).toBe("Food | Fridge\nRice | 1 day\nBeans | 2 days");
    expect(parsed.units[0]?.rows).toEqual([
      "Food | Fridge",
      "Rice | 1 day",
      "Beans | 2 days",
    ]);
  });

  it("drops a short margin line that repeats on most pages", () => {
    const lines: SourceLine[] = [];
    for (let page = 1; page <= 5; page += 1) {
      lines.push(
        line({
          page,
          y: 40,
          margin: true,
          text: "Dietary Guidelines for Indians",
        }),
        line({
          page,
          y: 30,
          margin: true,
          text: String(page),
        }),
        line({
          page,
          y: 500,
          text: `Page ${page} says eat plenty of vegetables and legumes every day.`,
        }),
      );
    }
    const parsed = unitsFromLines(lines, document);
    const text = parsed.units.map((unit) => unit.text).join("\n");
    expect(text).not.toMatch(/Dietary Guidelines for Indians/);
    expect(text).not.toMatch(/^1$/m);
    expect(text).toMatch(/Page 1 says eat plenty of vegetables/);
    expect(text).toMatch(/Page 5 says eat plenty of vegetables/);
    expect(parsed.units).toHaveLength(1);
  });

  it("treats a short heavier line as a heading", () => {
    const parsed = unitsFromLines(
      [
        line({
          y: 400,
          heavier: true,
          text: "How much visible fats do we need?",
        }),
        line({
          y: 380,
          text: "The visible fat must be limited to 20 to 50 grams.",
        }),
      ],
      document,
    );
    expect(parsed.units[0]?.sectionHeading).toBe(
      "How much visible fats do we need?",
    );
    expect(parsed.units[0]?.text).toMatch(/20 to 50 grams/);
  });
});

describe("corpus files on disk", () => {
  it(
    "parses both HTML pages",
    async () => {
      const cold = CORPUS.find((document) => document.id === "cold-storage-2023");
      const fsa = CORPUS.find((document) => document.id === "fsa-chill-2017");
      if (!cold || !fsa) throw new Error("missing corpus entries");
      const [coldBytes, fsaBytes] = await Promise.all([
        readFile("data/raw/cold-storage-2023/body"),
        readFile("data/raw/fsa-chill-2017/body"),
      ]);
      const coldParsed = await parseCorpusDocument(coldBytes, cold);
      const fsaParsed = await parseCorpusDocument(fsaBytes, fsa);

      const leftovers = coldParsed.units.find((unit) =>
        /Cooked meat or poultry/.test(unit.text),
      );
      expect(leftovers?.kind).toBe("category");
      expect(leftovers?.text).toMatch(/3 to 4 days/);
      expect(leftovers?.sectionHeading).toMatch(/Leftovers/);
      expect(coldParsed.characters).toBeGreaterThan(2000);
      expect(coldParsed.units.some((unit) => /Partners/.test(unit.text))).toBe(false);

      const chilling = fsaParsed.units.find((unit) =>
        /Chilling food/.test(unit.sectionHeading),
      );
      expect(chilling?.text.toLowerCase()).toMatch(/0 and 5/);
      const joined = fsaParsed.units.map((unit) => unit.text).join("\n");
      expect(joined).not.toMatch(/Cookies on GOV\.UK/);
      expect(joined).toMatch(/-18/);
      expect(fsaParsed.characters).toBeGreaterThan(1500);
      for (const parsed of [coldParsed, fsaParsed]) {
        expect(parsed.units.every((unit) => unit.text.trim().length > 0)).toBe(true);
        expect(parsed.units.every((unit) => unit.sectionHeading.trim().length > 0)).toBe(true);
      }
    },
    30_000,
  );

  it(
    "parses both dietary PDFs",
    async () => {
      const dgi = CORPUS.find((document) => document.id === "dgi-2024");
      const eatwell = CORPUS.find((document) => document.id === "eatwell-2018");
      if (!dgi || !eatwell) throw new Error("missing corpus entries");
      const [dgiBytes, eatwellBytes] = await Promise.all([
        readFile("data/raw/dgi-2024/body"),
        readFile("data/raw/eatwell-2018/body"),
      ]);
      const dgiParsed = await parseCorpusDocument(dgiBytes, dgi);
      const eatwellParsed = await parseCorpusDocument(eatwellBytes, eatwell);

      const guideline = dgiParsed.units.find(
        (unit) => /guideline\s*7/i.test(unit.text) || /guideline\s*7/i.test(unit.sectionHeading),
      );
      expect(guideline?.text.toLowerCase() ?? guideline?.sectionHeading.toLowerCase()).toMatch(
        /oil/,
      );
      const visible = dgiParsed.units.find(
        (unit) => /visible/.test(unit.text.toLowerCase()) && /fat/.test(unit.text.toLowerCase()),
      );
      expect(visible).toBeTruthy();
      expect(dgiParsed.characters).toBeGreaterThan(80_000);
      expect(dgiParsed.headingCount).toBeGreaterThan(10);
      expect(dgiParsed.tableCount).toBeGreaterThan(0);
      const footerUnits = dgiParsed.units.filter(
        (unit) => unit.text.trim() === "Dietary Guidelines for Indians",
      );
      expect(footerUnits).toHaveLength(0);

      const eatwellText = eatwellParsed.units.map((unit) => unit.text).join("\n");
      expect(eatwellText.toLowerCase()).toMatch(/potato/);
      expect(eatwellText.toLowerCase()).toMatch(/unsaturated oil/);
      expect(eatwellParsed.characters).toBeGreaterThan(8_000);
      expect(eatwellParsed.headingCount).toBeGreaterThan(3);
      for (const parsed of [dgiParsed, eatwellParsed]) {
        expect(parsed.units.length).toBeGreaterThan(0);
        expect(parsed.units.every((unit) => unit.text.trim().length > 0)).toBe(true);
        expect(parsed.units.every((unit) => unit.sectionHeading.trim().length > 0)).toBe(true);
      }
    },
    120_000,
  );
});
