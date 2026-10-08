import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { CorpusDocument } from "./corpus";
import {
  HEADING_SEPARATOR,
  type ParsedDocument,
  type ParsedUnit,
} from "./parsedDocument";

const require = createRequire(import.meta.url);

/**
 * A line after geometry: columns are already split, table rows are marked,
 * and rotated text has been turned into reading order.
 */
export type SourceLine = {
  page: number;
  /** Baseline in reading order. Larger values are higher on the page. */
  y: number;
  x: number;
  fontSize: number;
  heavier: boolean;
  bodySize: number;
  pageHeight: number;
  text: string;
  isTable: boolean;
  margin: boolean;
};

type Glyph = {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontName: string;
  originY: number;
  horizontal: boolean;
};

type Cell = {
  x: number;
  end: number;
  text: string;
  fontSize: number;
  fontName: string;
};

type DraftLine = {
  page: number;
  y: number;
  x: number;
  fontSize: number;
  fontName: string;
  originY: number;
  horizontal: boolean;
  pageHeight: number;
  cells: Cell[];
  side: "left" | "right" | "full";
  isTable: boolean;
};

const RECOMMENDATION =
  /^(?:guideline\s+\d+\b|\d{1,2}[.)](?!\d)\s+\S)/i;

function configurePdfWorker(): void {
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
}

function cleanGlyph(text: string): string {
  return text
    .replace(/\u0001/g, " ")
    .replace(/\u00ad/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

function collapseLine(text: string): string {
  return dedupeRepeated(text.replace(/\s+/g, " ").trim());
}

/** Drop a text run the PDF painted twice on top of itself. */
function dedupeRepeated(text: string): string {
  return text.replace(/(.{8,}?)\1/g, "$1");
}

function toGlyph(item: TextItem): Glyph | null {
  const text = cleanGlyph(item.str);
  if (!text.trim()) return null;
  const [a, b, , , e, f] = item.transform as number[];
  const fontSize = Math.hypot(a, b) || item.height || 0;
  if (fontSize < 1) return null;
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  const horizontal = Math.abs(degrees) < 35 || Math.abs(degrees) > 145;
  const downward = degrees <= -55 && degrees >= -125;
  const width = item.width > 0 ? item.width : fontSize * text.length * 0.45;
  if (horizontal) {
    return {
      text,
      x: e,
      y: f,
      width,
      fontSize,
      fontName: item.fontName,
      originY: f,
      horizontal: true,
    };
  }
  if (downward) {
    return {
      text,
      x: -f,
      y: e,
      width,
      fontSize,
      fontName: item.fontName,
      originY: f,
      horizontal: false,
    };
  }
  return {
    text,
    x: f,
    y: -e,
    width,
    fontSize,
    fontName: item.fontName,
    originY: f,
    horizontal: false,
  };
}

function modeFontSize(glyphs: Glyph[]): number {
  const bins = new Map<number, number>();
  for (const glyph of glyphs) {
    const bin = Math.round(glyph.fontSize * 2) / 2;
    bins.set(bin, (bins.get(bin) ?? 0) + glyph.text.length);
  }
  let best = 12;
  let count = 0;
  for (const [size, chars] of bins) {
    if (chars > count) {
      best = size;
      count = chars;
    }
  }
  return best;
}

function bodyFontName(glyphs: Glyph[], bodySize: number): string {
  const counts = new Map<string, number>();
  for (const glyph of glyphs) {
    if (Math.abs(glyph.fontSize - bodySize) > 0.75) continue;
    counts.set(glyph.fontName, (counts.get(glyph.fontName) ?? 0) + glyph.text.length);
  }
  let best = "";
  let count = 0;
  for (const [font, chars] of counts) {
    if (chars > count) {
      best = font;
      count = chars;
    }
  }
  return best;
}

function groupLines(glyphs: Glyph[]): Glyph[][] {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; glyphs: Glyph[] }[] = [];
  for (const glyph of sorted) {
    const tolerance = Math.max(2, glyph.fontSize * 0.34);
    let best: { y: number; glyphs: Glyph[] } | null = null;
    let bestDistance = tolerance;
    for (const line of lines) {
      const distance = Math.abs(line.y - glyph.y);
      if (distance <= bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (best) best.glyphs.push(glyph);
    else lines.push({ y: glyph.y, glyphs: [glyph] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.glyphs.sort((a, b) => a.x - b.x));
}

function splitCells(glyphs: Glyph[]): Cell[] {
  const cells: Cell[] = [];
  for (const glyph of glyphs) {
    const text = glyph.text;
    const previous = cells[cells.length - 1];
    const fontSize = previous?.fontSize || glyph.fontSize;
    const gap = previous ? glyph.x - previous.end : 0;
    const cellGap = Math.max(9, fontSize * 0.9);
    if (!previous || gap > cellGap) {
      cells.push({
        x: glyph.x,
        end: glyph.x + glyph.width,
        text,
        fontSize: glyph.fontSize,
        fontName: glyph.fontName,
      });
      continue;
    }
    const space = gap > Math.max(0.8, fontSize * 0.12);
    previous.text += (space ? " " : "") + text;
    previous.end = Math.max(previous.end, glyph.x + glyph.width);
    if (text.length > previous.text.length / 2) {
      previous.fontName = glyph.fontName;
      previous.fontSize = glyph.fontSize;
    }
  }
  return rejoinWordCells(reattachBullets(cells));
}

const BULLET = /^[\u2022\u00b7\u25cf\u25aa\u25e6\-–—]$/;

function reattachBullets(cells: Cell[]): Cell[] {
  const joined: Cell[] = [];
  for (const cell of cells) {
    const previous = joined[joined.length - 1];
    if (previous && BULLET.test(collapseLine(previous.text)) && collapseLine(cell.text)) {
      previous.text = `${collapseLine(previous.text)} ${collapseLine(cell.text)}`;
      previous.end = cell.end;
      previous.fontName = cell.fontName;
      previous.fontSize = cell.fontSize;
      continue;
    }
    joined.push({ ...cell, text: cell.text });
  }
  return joined;
}

/**
 * pdf.js sometimes emits one item per word. Those gaps are much smaller
 * than a table column, so join them back into a sentence.
 */
function rejoinWordCells(cells: Cell[]): Cell[] {
  if (cells.length < 4) return cells;
  const gaps: number[] = [];
  for (let index = 1; index < cells.length; index += 1) {
    gaps.push(cells[index].x - cells[index - 1].x);
  }
  const medianGap = median(gaps);
  const medianLength = median(cells.map((cell) => collapseLine(cell.text).length));
  if (medianGap >= 16 || medianLength > 14) return cells;
  return [
    {
      x: cells[0].x,
      end: cells[cells.length - 1].end,
      text: cells.map((cell) => collapseLine(cell.text)).filter(Boolean).join(" "),
      fontSize: cells[0].fontSize,
      fontName: cells[0].fontName,
    },
  ];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function contentCells(cells: Cell[]): Cell[] {
  return cells.filter((cell) => collapseLine(cell.text).length > 0);
}

function aligned(left: number[], right: number[]): boolean {
  let matches = 0;
  for (const start of left) {
    if (right.some((other) => Math.abs(other - start) <= 12)) matches += 1;
  }
  return matches >= 2;
}

/**
 * A two-column page puts a long passage on the left and another on the
 * right, with one wide gap. That is not a table, even when a bullet or a
 * callout adds another fragment.
 */
function columnSplitX(cells: Cell[]): number | null {
  if (cells.length < 2 || cells.length > 4) return null;
  let bestGap = 0;
  let bestIndex = -1;
  for (let index = 1; index < cells.length; index += 1) {
    const gap = cells[index].x - cells[index - 1].end;
    if (cells[index].x - cells[0].x < 150) continue;
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = index;
    }
  }
  if (bestIndex < 0 || bestGap < 12) return null;
  const left = cells
    .slice(0, bestIndex)
    .map((cell) => collapseLine(cell.text))
    .join(" ");
  const right = cells
    .slice(bestIndex)
    .map((cell) => collapseLine(cell.text))
    .join(" ");
  if (left.length < 20 || right.length < 20) return null;
  const otherGaps = cells
    .slice(1)
    .map((cell, index) => cell.x - cells[index].end);
  const rivals = otherGaps.filter((_, index) => index !== bestIndex - 1);
  if (rivals.some((gap) => gap > bestGap * 0.7)) return null;
  return cells[bestIndex].x;
}

function markTables(lines: DraftLine[], bodySize: number): void {
  const candidates = lines.map((line) => {
    const cells = contentCells(line.cells);
    if (line.fontSize < Math.min(8, bodySize * 0.7)) return false;
    if (columnSplitX(cells) !== null) return false;
    const shortPair =
      cells.length === 2 && cells.every((cell) => collapseLine(cell.text).length < 42);
    return cells.length >= 3 || shortPair;
  });
  const table = candidates.map(() => false);
  for (let index = 0; index < lines.length; index += 1) {
    if (!candidates[index]) continue;
    const neighbor = [index - 1, index + 1].find(
      (other) => other >= 0 && other < lines.length && candidates[other],
    );
    if (neighbor === undefined) continue;
    const starts = contentCells(lines[index].cells).map((cell) => cell.x);
    const neighborStarts = contentCells(lines[neighbor].cells).map((cell) => cell.x);
    if (aligned(starts, neighborStarts)) table[index] = true;
  }
  lines.forEach((line, index) => {
    line.isTable = table[index] === true;
  });
}

function findGutter(lines: DraftLine[]): number | null {
  const starts: number[] = [];
  for (const line of lines) {
    const cells = contentCells(line.cells);
    if (!line.isTable) {
      const splitAt = columnSplitX(cells);
      if (splitAt !== null) starts.push(splitAt);
      continue;
    }
    // A paragraph in one column can share a baseline with a table in the
    // other. The jump to the table is the page gutter, not a cell gap.
    for (let index = 1; index < cells.length - 1; index += 1) {
      const gap = cells[index].x - cells[index - 1].end;
      const left = cells.slice(0, index);
      const right = cells.slice(index);
      const leftText = left.map((cell) => collapseLine(cell.text)).join(" ");
      if (
        left.length === 1 &&
        right.length >= 3 &&
        gap >= 36 &&
        cells[index].x - cells[0].x > 180 &&
        leftText.length > 40
      ) {
        starts.push(cells[index].x);
        break;
      }
    }
  }
  if (starts.length < 3) return null;
  return median(starts);
}

function peelProseFromTables(lines: DraftLine[], gutter: number | null): DraftLine[] {
  if (gutter === null) return lines;
  const peeled: DraftLine[] = [];
  for (const line of lines) {
    if (!line.isTable) {
      peeled.push(line);
      continue;
    }
    const cells = contentCells(line.cells);
    const left = cells.filter((cell) => cell.x < gutter - 25);
    const right = cells.filter((cell) => cell.x >= gutter - 25);
    const pairs = [
      { prose: left, table: right, proseSide: "left" as const, tableSide: "right" as const },
      { prose: right, table: left, proseSide: "right" as const, tableSide: "left" as const },
    ];
    const match = pairs.find(
      (pair) =>
        pair.prose.length === 1 &&
        pair.table.length >= 2 &&
        collapseLine(pair.prose[0]?.text ?? "").length > 40,
    );
    if (!match) {
      peeled.push(line);
      continue;
    }
    peeled.push(draftFromCells(line, match.prose, match.proseSide));
    const tableLine = draftFromCells(line, match.table, match.tableSide);
    tableLine.isTable = true;
    peeled.push(tableLine);
  }
  return peeled;
}

function cellsText(cells: Cell[], separator: string): string {
  return collapseLine(
    cells
      .map((cell) => collapseLine(cell.text))
      .filter(Boolean)
      .join(separator),
  );
}

function dominantFont(cells: Cell[]): { fontName: string; fontSize: number } {
  const counts = new Map<string, { chars: number; fontSize: number }>();
  for (const cell of cells) {
    const chars = cell.text.length;
    const current = counts.get(cell.fontName);
    if (!current || chars > current.chars) {
      counts.set(cell.fontName, {
        chars: (current?.chars ?? 0) + chars,
        fontSize: cell.fontSize,
      });
    } else {
      current.chars += chars;
    }
  }
  let bestName = cells[0]?.fontName ?? "";
  let best = 0;
  let fontSize = cells[0]?.fontSize ?? 12;
  for (const [name, value] of counts) {
    if (value.chars > best) {
      best = value.chars;
      bestName = name;
      fontSize = value.fontSize;
    }
  }
  return { fontName: bestName, fontSize };
}

function splitColumns(lines: DraftLine[], gutter: number | null): DraftLine[] {
  if (gutter === null) return lines;
  const split: DraftLine[] = [];
  for (const line of lines) {
    if (line.isTable) {
      split.push(line);
      continue;
    }
    const cells = contentCells(line.cells);
    const splitAt = columnSplitX(cells);
    if (splitAt === null || Math.abs(splitAt - gutter) > 120) {
      split.push(line);
      continue;
    }
    const left = cells.filter((cell) => cell.x < splitAt - 8);
    const right = cells.filter((cell) => cell.x >= splitAt - 8);
    if (left.length === 0 || right.length === 0) {
      split.push(line);
      continue;
    }
    split.push(draftFromCells(line, left, "left"));
    split.push(draftFromCells(line, right, "right"));
  }
  return split;
}

function draftFromCells(
  line: DraftLine,
  cells: Cell[],
  side: DraftLine["side"],
): DraftLine {
  const font = dominantFont(cells);
  return {
    ...line,
    x: cells[0]?.x ?? line.x,
    fontSize: font.fontSize,
    fontName: font.fontName,
    cells,
    side,
    isTable: false,
  };
}

function orderBands(lines: DraftLine[]): DraftLine[] {
  const sorted = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const ordered: DraftLine[] = [];
  let index = 0;
  const emitSide = (sideLines: DraftLine[]) => {
    let cursor = 0;
    while (cursor < sideLines.length) {
      if (sideLines[cursor].isTable) {
        while (cursor < sideLines.length && sideLines[cursor].isTable) {
          ordered.push(sideLines[cursor]);
          cursor += 1;
        }
        continue;
      }
      ordered.push(sideLines[cursor]);
      cursor += 1;
    }
  };
  while (index < sorted.length) {
    if (sorted[index].isTable && sorted[index].side === "full") {
      while (
        index < sorted.length &&
        sorted[index].isTable &&
        sorted[index].side === "full"
      ) {
        ordered.push(sorted[index]);
        index += 1;
      }
      continue;
    }
    const band: DraftLine[] = [];
    while (
      index < sorted.length &&
      !(sorted[index].isTable && sorted[index].side === "full")
    ) {
      band.push(sorted[index]);
      index += 1;
    }
    const right = band.filter((line) => line.side === "right");
    const left = band.filter((line) => line.side !== "right");
    if (right.length >= 2 || band.some((line) => line.side === "right")) {
      emitSide(left);
      emitSide(right);
    } else {
      ordered.push(...band);
    }
  }
  return ordered;
}

function mergeVerticalLabels(lines: DraftLine[]): DraftLine[] {
  const merged: DraftLine[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    const previousText = previous ? collapseLine(cellsText(previous.cells, " ")) : "";
    const text = collapseLine(cellsText(line.cells, " "));
    const fontSize = Math.max(previous?.fontSize ?? 0, line.fontSize);
    const stacked =
      previous &&
      previous.page === line.page &&
      !previous.isTable &&
      !line.isTable &&
      previousText.length > 0 &&
      previousText.length <= 24 &&
      text.length > 0 &&
      text.length <= 2 &&
      Math.abs(previous.x - line.x) <= fontSize * 1.2 &&
      Math.abs(previous.y - line.y) <= fontSize * 1.8;
    if (stacked && previous) {
      const cell = previous.cells[0];
      if (cell) cell.text = `${previousText}${text}`;
      previous.y = line.y;
      continue;
    }
    merged.push({
      ...line,
      cells: line.cells.map((cell) => ({ ...cell })),
    });
  }
  return merged;
}

function layoutOrientation(
  glyphs: Glyph[],
  page: number,
  pageHeight: number,
  bodySize: number,
): DraftLine[] {
  if (glyphs.length === 0) return [];
  const grouped = groupLines(glyphs).map((glyphsOnLine): DraftLine => {
    const cells = splitCells(glyphsOnLine);
    const font = dominantFont(cells);
    return {
      page,
      y: glyphsOnLine[0]?.y ?? 0,
      x: cells[0]?.x ?? glyphsOnLine[0]?.x ?? 0,
      fontSize: font.fontSize || glyphsOnLine[0]?.fontSize || bodySize,
      fontName: font.fontName,
      originY: glyphsOnLine[0]?.originY ?? 0,
      horizontal: glyphsOnLine[0]?.horizontal ?? true,
      pageHeight,
      cells,
      side: "full",
      isTable: false,
    };
  });
  markTables(grouped, bodySize);
  const gutter = findGutter(grouped);
  const split = splitColumns(peelProseFromTables(grouped, gutter), gutter);
  for (const line of split) {
    if (line.side === "full" && gutter !== null && line.x >= gutter - 20 && !line.isTable) {
      line.side = "right";
    }
  }
  const ordered = mergeVerticalLabels(orderBands(split));
  for (const line of ordered) {
    const font = dominantFont(line.cells);
    line.fontName = font.fontName;
    line.fontSize = font.fontSize || line.fontSize;
  }
  return ordered;
}

function toSourceLines(
  lines: DraftLine[],
  bodySize: number,
  usualFont: string,
): SourceLine[] {
  return lines.flatMap((line) => {
    const separator = line.isTable ? " | " : cellsNeedBar(line) ? " | " : " ";
    const text = collapseLetterSpacing(cellsText(line.cells, separator));
    if (!text || isGraphicNoise(text, line.fontSize, bodySize)) return [];
    const margin =
      line.horizontal &&
      (line.originY < line.pageHeight * 0.09 ||
        line.originY > line.pageHeight * 0.93);
    const heavier =
      usualFont !== "" &&
      line.fontName !== usualFont &&
      Math.abs(line.fontSize - bodySize) <= 1 &&
      !line.isTable;
    return [
      {
        page: line.page,
        y: line.y,
        x: line.x,
        fontSize: line.fontSize,
        heavier,
        bodySize,
        pageHeight: line.pageHeight,
        text,
        isTable: line.isTable,
        margin,
      },
    ];
  });
}

function cellsNeedBar(line: DraftLine): boolean {
  const cells = contentCells(line.cells);
  if (cells.length < 2 || line.isTable) return false;
  return cells.some((cell, index) => index > 0 && cell.x - cells[index - 1].x > 24);
}

/** Curved plate labels are single letters. A line of those is not prose. */
function isGraphicNoise(text: string, fontSize: number, bodySize: number): boolean {
  if (fontSize >= Math.max(8, bodySize * 0.7)) return false;
  const tokens = text.split(/[\s|]+/).filter(Boolean);
  if (tokens.length < 6) return false;
  const tiny = tokens.filter(
    (token) => token.replace(/[^A-Za-z0-9]/g, "").length <= 1,
  ).length;
  return tiny / tokens.length >= 0.4;
}

function collapseLetterSpacing(text: string): string {
  const tokens = text.split(/ +/);
  if (tokens.length < 5) return text;
  const singles = tokens.filter((token) => token.length === 1).length;
  if (singles / tokens.length < 0.75) return text;
  let out = "";
  for (const token of tokens) {
    if (!token) continue;
    if (token.length === 1 && out && !out.endsWith(" ")) out += token;
    else out += `${out ? " " : ""}${token}`;
  }
  return out;
}

function normalizeMargin(text: string): string {
  return collapseLine(text).toLowerCase();
}

function dropChrome(lines: SourceLine[]): SourceLine[] {
  const counts = new Map<string, number>();
  const pages = new Set(lines.map((line) => line.page));
  for (const line of lines) {
    if (!line.margin) continue;
    const key = normalizeMargin(line.text);
    if (key.length < 2 || key.length > 80) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const minimum = Math.max(3, Math.ceil(pages.size * 0.35));
  return lines.filter((line) => {
    const key = normalizeMargin(line.text);
    if (!key) return false;
    if (/^[\u2022\u00b7\u25cf]$/.test(key)) return false;
    if (line.margin && /^(?:\d{1,3}|[ivxlcdm]{1,6})$/i.test(key)) return false;
    if (line.margin && (counts.get(key) ?? 0) >= minimum) return false;
    return true;
  });
}

function headingImportance(line: SourceLine): number | null {
  const text = collapseLine(line.text);
  if (text.length < 2 || line.isTable) return null;
  const ratio = line.fontSize / (line.bodySize || 12);
  if (ratio >= 1.35 && text.length <= 220) return line.fontSize;
  if (text.length <= 100 && ratio >= 1.12) return line.fontSize;
  if (
    line.heavier &&
    text.length >= 8 &&
    text.length <= 100 &&
    ratio >= 0.9 &&
    ratio < 1.12
  ) {
    return line.bodySize + 0.25;
  }
  return null;
}

function joinWrapped(parts: string[]): string {
  let out = "";
  for (const part of parts) {
    const piece = collapseLine(collapseLetterSpacing(part));
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }
    if (out.endsWith("-") && /^[a-z]/.test(piece)) out = out.slice(0, -1) + piece;
    else out = `${out} ${piece}`;
  }
  return collapseLine(out);
}

function lineGap(previous: SourceLine, next: SourceLine): number {
  if (previous.page !== next.page) return Number.POSITIVE_INFINITY;
  return previous.y - next.y;
}

function headingPath(stack: { text: string }[], documentName: string): string {
  if (stack.length === 0) return documentName;
  return stack.map((entry) => entry.text).join(HEADING_SEPARATOR);
}

/**
 * Turn positioned lines into ordered units. Exported so the heading stack,
 * tables, recommendations, and running headers can be tested without a PDF.
 */
export function unitsFromLines(
  sourceLines: SourceLine[],
  document: Pick<CorpusDocument, "id" | "name">,
): ParsedDocument {
  const lines = dropChrome(sourceLines);
  const stack: { importance: number; text: string }[] = [];
  const buffer: string[] = [];
  const units: ParsedUnit[] = [];
  let headingCount = 0;
  let tableCount = 0;
  let index = 0;

  const sectionHeading = () => headingPath(stack, document.name);

  const flushSection = () => {
    const text = buffer.join("\n\n").trim();
    buffer.length = 0;
    if (!text) return;
    units.push({ sectionHeading: sectionHeading(), kind: "section", text });
  };

  const flushParagraph = (parts: string[]) => {
    const text = joinWrapped(parts);
    if (!text) return;
    if (RECOMMENDATION.test(text)) {
      flushSection();
      units.push({
        sectionHeading: sectionHeading(),
        kind: "recommendation",
        text,
      });
      return;
    }
    buffer.push(text);
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.isTable) {
      flushSection();
      const rows: string[] = [];
      while (index < lines.length && lines[index].isTable) {
        const row = collapseLine(lines[index].text);
        if (row) rows.push(row);
        index += 1;
      }
      if (rows.length > 0) {
        tableCount += 1;
        units.push({
          sectionHeading: sectionHeading(),
          kind: "table",
          text: rows.join("\n"),
          rows,
        });
      }
      continue;
    }

    const importance = headingImportance(line);
    if (importance !== null) {
      let text = collapseLine(line.text);
      let rank = importance;
      let cursor = index + 1;
      let absorbed = 1;
      const absorbTitle = RECOMMENDATION.test(text) && text.length < 60;
      while (cursor < lines.length && absorbed < 6) {
        const next = lines[cursor];
        const nextImportance = headingImportance(next);
        if (nextImportance === null || next.isTable) break;
        const gap = lineGap(lines[cursor - 1], next);
        const closeEnough =
          gap >= -1 &&
          gap <= Math.max(line.fontSize, next.fontSize) * (absorbTitle ? 3.2 : 1.85);
        if (!closeEnough) break;
        if (RECOMMENDATION.test(collapseLine(next.text)) && !RECOMMENDATION.test(text)) {
          break;
        }
        const titleSized = next.fontSize >= next.bodySize * 1.3;
        if (absorbTitle && titleSized) {
          text = collapseLine(`${text} ${collapseLine(next.text)}`);
          cursor += 1;
          absorbed += 1;
          continue;
        }
        const slack = Math.max(2, rank * 0.22);
        if (nextImportance < rank - slack || nextImportance > rank + slack) break;
        text = collapseLine(`${text} ${collapseLine(next.text)}`);
        rank = Math.max(rank, nextImportance);
        cursor += 1;
        absorbed += 1;
      }
      flushSection();
      while (stack.length > 0 && stack[stack.length - 1].importance <= rank) {
        stack.pop();
      }
      stack.push({ importance: rank, text });
      headingCount += 1;
      if (RECOMMENDATION.test(text) || text.length >= 40) {
        units.push({
          sectionHeading: sectionHeading(),
          kind: RECOMMENDATION.test(text) ? "recommendation" : "section",
          text,
        });
      }
      index = cursor;
      continue;
    }

    const parts = [line.text];
    let previous = line;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next.isTable || headingImportance(next) !== null) break;
      const gap = lineGap(previous, next);
      if (gap < -1 || gap > next.fontSize * 1.9) break;
      parts.push(next.text);
      previous = next;
      index += 1;
    }
    flushParagraph(parts);
  }
  flushSection();

  return {
    documentId: document.id,
    units,
    headingCount,
    tableCount,
    characters: units.reduce((sum, unit) => sum + unit.text.length, 0),
  };
}

function isTextItem(item: unknown): item is TextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof item.str === "string"
  );
}

/**
 * Parse one dietary PDF from the bytes already on disk. Text items keep
 * their font size and position; lines, columns, headings, tables, and
 * numbered recommendations are recovered from that geometry.
 */
export async function parsePdfDocument(
  bytes: Uint8Array,
  document: Pick<CorpusDocument, "id" | "name">,
): Promise<ParsedDocument> {
  configurePdfWorker();
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
  });
  const pdf = await task.promise;
  const lines: SourceLine[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const glyphs = content.items.flatMap((item) => {
      if (!isTextItem(item)) return [];
      const glyph = toGlyph(item);
      return glyph ? [glyph] : [];
    });
    const bodySize = modeFontSize(glyphs);
    const usualFont = bodyFontName(glyphs, bodySize);
    const horizontal = layoutOrientation(
      glyphs.filter((glyph) => glyph.horizontal),
      pageNumber,
      viewport.height,
      bodySize,
    );
    const rotated = layoutOrientation(
      glyphs.filter((glyph) => !glyph.horizontal),
      pageNumber,
      viewport.height,
      bodySize,
    );
    lines.push(
      ...toSourceLines([...horizontal, ...rotated], bodySize, usualFont),
    );
  }
  return unitsFromLines(lines, document);
}
