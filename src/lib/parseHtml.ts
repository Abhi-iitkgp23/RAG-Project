import { load } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { CorpusDocument } from "./corpus";
import {
  HEADING_SEPARATOR,
  type ParsedDocument,
  type ParsedUnit,
  type ParsedUnitKind,
} from "./parsedDocument";

const HEADING_RANK: Record<string, number> = { h1: 1, h2: 2, h3: 3 };

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "nav",
  "footer",
  "button",
  "input",
  "select",
  "textarea",
  "img",
  "picture",
  "video",
  "canvas",
  "link",
  "meta",
]);

/**
 * Block-level tags. An element that contains one of these is walked in
 * order; an element that doesn't is one paragraph.
 */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "ul",
  "ol",
  "li",
  "table",
  "h1",
  "h2",
  "h3",
  "blockquote",
  "figure",
  "header",
  "aside",
  "address",
]);

const CHROME_SELECTOR = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "nav",
  "footer",
  "button",
  ".gem-c-cookie-banner",
  ".gem-c-feedback",
  ".gem-c-contents-list",
  ".gem-c-devolved-nations",
  ".gem-c-print-link",
  ".print-metadata",
  ".organisation-logos",
  ".gem-c-back-to-top",
  ".social-media-sharing",
  ".govuk-visually-hidden",
  ".hidden",
  "[hidden]",
  "a.usa-button",
].join(", ");

type HtmlBlock =
  | { type: "heading"; rank: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; text: string }
  | { type: "table"; header: string[][]; body: string[][]; categories: boolean[] };

type Cell = {
  text: string;
  header: boolean;
  rowspan: number;
  colspan: number;
};

type RawRow = {
  cells: Cell[];
  inHead: boolean;
  categoryStart: boolean;
};

function collapse(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function isTag(node: AnyNode): node is Element {
  return node.type === "tag";
}

function hasBlockChild(node: Element): boolean {
  return (node.childNodes ?? []).some(
    (child) => isTag(child) && BLOCK_TAGS.has(child.tagName.toLowerCase()),
  );
}

function listText(node: Element, ordered: boolean): string {
  const items: string[] = [];
  for (const child of node.childNodes ?? []) {
    if (!isTag(child) || child.tagName.toLowerCase() !== "li") continue;
    const text = collapse(collectText(child));
    if (!text) continue;
    const prefix = ordered ? `${items.length + 1}. ` : "\u2022 ";
    items.push(prefix + text);
  }
  return items.join("\n");
}

function collectText(node: AnyNode): string {
  if (node.type === "text") return node.data ?? "";
  if (!isTag(node)) return "";
  return (node.childNodes ?? []).map((child) => collectText(child)).join(" ");
}

function ancestorTag(node: Element, tagName: string): boolean {
  let parent = node.parent;
  while (parent && isTag(parent)) {
    if (parent.tagName.toLowerCase() === tagName) return true;
    if (parent.tagName.toLowerCase() === "table") return false;
    parent = parent.parent;
  }
  return false;
}

function readRow(node: Element): RawRow {
  const cells: Cell[] = [];
  for (const child of node.childNodes ?? []) {
    if (!isTag(child)) continue;
    const tag = child.tagName.toLowerCase();
    if (tag !== "th" && tag !== "td") continue;
    const rowspan = positiveInt(child.attribs?.rowspan, 1);
    const colspan = positiveInt(child.attribs?.colspan, 1);
    cells.push({
      text: collapse(collectText(child)),
      header: tag === "th",
      rowspan,
      colspan,
    });
  }
  const inHead = ancestorTag(node, "thead");
  return {
    cells,
    inHead,
    categoryStart: !inHead && cells[0]?.header === true && cells[0].text !== "",
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readTable(node: Element): HtmlBlock | null {
  const rawRows: RawRow[] = [];
  const visit = (current: Element) => {
    for (const child of current.childNodes ?? []) {
      if (!isTag(child)) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "tr") rawRows.push(readRow(child));
      else if (tag === "thead" || tag === "tbody" || tag === "tfoot") visit(child);
    }
  };
  visit(node);
  if (rawRows.length === 0) return null;

  const width = rawRows.reduce((max, row) => {
    const span = row.cells.reduce((sum, cell) => sum + cell.colspan, 0);
    return Math.max(max, span);
  }, 0);
  const grid: string[][] = rawRows.map(() => Array.from({ length: width }, () => ""));
  rawRows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.cells) {
      while (column < width && grid[rowIndex][column] !== "") column += 1;
      for (let rowOffset = 0; rowOffset < cell.rowspan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < cell.colspan; columnOffset += 1) {
          const targetRow = grid[rowIndex + rowOffset];
          if (!targetRow) continue;
          const targetColumn = column + columnOffset;
          if (targetColumn < width && targetRow[targetColumn] === "") {
            targetRow[targetColumn] = cell.text;
          }
        }
      }
      column += cell.colspan;
    }
  });

  let headerRows = rawRows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.inHead);
  let bodyEntries = rawRows
    .map((row, index) => ({ row, index }))
    .filter((entry) => !entry.row.inHead);
  if (
    headerRows.length === 0 &&
    bodyEntries[0] &&
    bodyEntries[0].row.cells.length > 0 &&
    bodyEntries[0].row.cells.every((cell) => cell.header)
  ) {
    headerRows = [bodyEntries[0]];
    bodyEntries = bodyEntries.slice(1);
  }

  const header = (headerRows.length > 0 ? headerRows : []).map((entry) =>
    trimRow(grid[entry.index] ?? []),
  );
  const body = bodyEntries.map((entry) => trimRow(grid[entry.index] ?? []));
  const categories = bodyEntries.map((entry) => entry.row.categoryStart);
  if (header.length === 0 && body.length === 0) return null;
  return { type: "table", header, body, categories };
}

function trimRow(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === "") end -= 1;
  return cells.slice(0, Math.max(end, 1));
}

function renderRow(cells: string[]): string {
  return cells.map((cell) => cell.trim()).join(" | ");
}

function walk(node: AnyNode, blocks: HtmlBlock[]): void {
  if (node.type === "text") {
    const text = collapse(node.data ?? "");
    if (text) blocks.push({ type: "paragraph", text });
    return;
  }
  if (!isTag(node)) return;
  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (tag === "a") {
    const className = node.attribs?.class ?? "";
    if (/\bbutton\b|usa-button/.test(className)) return;
  }
  const rank = HEADING_RANK[tag];
  if (rank) {
    const text = collapse(collectText(node));
    if (text) blocks.push({ type: "heading", rank, text });
    return;
  }
  if (tag === "p") {
    const text = collapse(collectText(node));
    if (text) blocks.push({ type: "paragraph", text });
    return;
  }
  if (tag === "ul" || tag === "ol") {
    const text = listText(node, tag === "ol");
    if (text) blocks.push({ type: "list", text });
    return;
  }
  if (tag === "table") {
    const table = readTable(node);
    if (table) blocks.push(table);
    return;
  }
  if (!hasBlockChild(node)) {
    const text = collapse(collectText(node));
    if (text) blocks.push({ type: "paragraph", text });
    return;
  }
  for (const child of node.childNodes ?? []) walk(child, blocks);
}

function isStorageChart(table: Extract<HtmlBlock, { type: "table" }>): boolean {
  const label = table.header.flat().join(" ").toLowerCase();
  const groups = table.categories.filter(Boolean).length;
  return (
    groups >= 1 &&
    label.includes("food") &&
    (label.includes("refrigerat") || label.includes("freezer"))
  );
}

function headingPath(stack: { text: string }[], documentName: string): string {
  if (stack.length === 0) return documentName;
  return stack.map((entry) => entry.text).join(HEADING_SEPARATOR);
}

function pushUnit(
  units: ParsedUnit[],
  sectionHeading: string,
  kind: ParsedUnitKind,
  text: string,
  rows?: string[],
): void {
  const collapsed = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!collapsed) return;
  units.push({
    sectionHeading,
    kind,
    text: collapsed,
    ...(rows ? { rows } : {}),
  });
}

/**
 * Parse one HTML guidance page. Script, style, and navigation chrome are
 * dropped. The article is walked in document order.
 */
export function parseHtmlDocument(
  bytes: Uint8Array,
  document: Pick<CorpusDocument, "id" | "name">,
  options?: { chartCategories?: boolean },
): ParsedDocument {
  const html = new TextDecoder("utf-8").decode(bytes);
  const $ = load(html);
  $(CHROME_SELECTOR).remove();
  const root = $("main").first().length
    ? $("main").first().get(0)
    : $("article").first().length
      ? $("article").first().get(0)
      : $.root().get(0);
  const blocks: HtmlBlock[] = [];
  if (root?.type === "root") {
    for (const child of root.childNodes ?? []) walk(child, blocks);
  } else if (root) {
    walk(root, blocks);
  }

  const chartCategories = options?.chartCategories === true;
  const stack: { rank: number; text: string }[] = [];
  const parts: { kind: "paragraph" | "list"; text: string }[] = [];
  const units: ParsedUnit[] = [];
  let headingCount = 0;
  let tableCount = 0;

  const flush = () => {
    if (parts.length === 0) return;
    const text = parts.map((part) => part.text).join("\n\n");
    const kind: ParsedUnitKind = parts.every((part) => part.kind === "list")
      ? "list"
      : "section";
    parts.length = 0;
    pushUnit(units, headingPath(stack, document.name), kind, text);
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      flush();
      while (stack.length > 0 && stack[stack.length - 1].rank >= block.rank) {
        stack.pop();
      }
      stack.push({ rank: block.rank, text: block.text });
      headingCount += 1;
      continue;
    }
    if (block.type === "paragraph") {
      parts.push({ kind: "paragraph", text: block.text });
      continue;
    }
    if (block.type === "list") {
      parts.push({ kind: "list", text: block.text });
      continue;
    }

    flush();
    tableCount += 1;
    const path = headingPath(stack, document.name);
    const headerLines = block.header.map((row) => renderRow(row));
    if (chartCategories && isStorageChart(block)) {
      let group: string[][] = [];
      let categoryName = "";
      const emitGroup = () => {
        if (group.length === 0) return;
        const rows = [...headerLines, ...group.map((row) => renderRow(row))];
        const heading = categoryName
          ? `${path}${HEADING_SEPARATOR}${categoryName}`
          : path;
        pushUnit(units, heading, "category", rows.join("\n"), rows);
        group = [];
      };
      block.body.forEach((row, index) => {
        if (block.categories[index] || group.length === 0) {
          emitGroup();
          categoryName = row[0] ?? "";
        }
        group.push(row);
      });
      emitGroup();
      continue;
    }

    const rows = [
      ...headerLines,
      ...block.body.map((row) => renderRow(row)),
    ].filter((row) => row.replace(/\|/g, "").trim() !== "");
    pushUnit(units, path, "table", rows.join("\n"), rows);
  }
  flush();

  return {
    documentId: document.id,
    units,
    headingCount,
    tableCount,
    characters: units.reduce((sum, unit) => sum + unit.text.length, 0),
  };
}
