# Implementation plan

Phase-wise build order for the dietary guidance chatbot specified in [problemStatement.md](./problemStatement.md) and designed in [architecture.md](./architecture.md).

Architecture is the source of truth for behavior. This plan is the source of truth for **order**: what to build, what must already work, and how to know a phase is finished. If a task here and a rule in the architecture ever disagree, follow the architecture and adjust the task.

Work one phase at a time. A phase is finished only when its exit check passes. Later phases call the earlier modules; they do not reimplement them.

## Decisions this plan adds

The architecture leaves these choices open. They are fixed here so implementation does not stall.

| Choice | Decision |
| --- | --- |
| HTML parser | `cheerio`. Walk the article in document order after dropping `script`, `style`, and navigation chrome. |
| OpenAI access | Official `openai` SDK, server-only. Strict `json_schema` for the scope classifier, the query rewriter, and the grounded draft. |
| Tests | Vitest. Chunking, retrieval scoring, scope scan, and citation binding are pure and run without a live model. |
| Identifiers | `crypto.randomUUID()` for conversations and messages. Chunk ids stay `{documentId}:{ordinal}`. |
| App shell | Next.js App Router, TypeScript, one page. `better-sqlite3` is listed in `serverExternalPackages`. |
| Embedding input | Section heading, a blank line, then the chunk text. The stored passage stays `text`, so a quote still has to match that column. This deployment embeds with on-device Nomic, which prefixes a chunk `search_document: ` and a query `search_query: `. Without a Nomic model, a query is the question alone. |

## Invariants

These hold from the phase that introduces them through the last phase.

- The browser calls only this app. `OPENAI_API_KEY` is read on the server.
- The model returns `covered` and claims. Each claim names a `chunkId` and a verbatim `quote`. It does not return a URL, a publisher, or a year.
- `ground.ts` is the only module that builds a `Source`. The server writes `answer` from the claims that survived. The draft’s free-form prose is discarded.
- `decline.ts` owns the professional refusal. `coverage.ts` owns the “not in the guidance” sentence. The system prompt does not contain either sentence.
- A scope decline never embeds the question and never calls the answer model. A classifier that fails to parse declines.
- A missing or unreadable guidance index returns `500`. Ingest that fails leaves the previous index in place.
- Every turn retrieves again. A previous answer is context for the rewriter, not evidence.
- The four corpus URLs are a constant in `corpus.ts`. Nutrient databases and any source with a clean API stay out.

## Phase sequence

| Phase | Outcome | Needs | Proves |
| --- | --- | --- | --- |
| 1 | App skeleton and shared contracts | — | Types and schemas compile |
| 2 | Raw corpus on disk | 1 | Four fetches, hashes, fail-closed |
| 3 | Structure-aware text chunks | 2 | Recommendations, tables, and chart categories stay whole |
| 4 | Searchable guidance index | 3, API key | Full-corpus and single-document retrieval |
| 5 | Conversation store | 1 | Threads survive a reload at the API |
| 6 | Scope gate and both refusal texts | 5, API key | Calorie, weight, and medical turns decline in code |
| 7 | Citation binding and assembly | 1 | A bad quote, a foreign chunk id, or a blended claim cannot ship |
| 8 | `POST /api/chat` | 4, 5, 6, 7 | One turn follows the lifecycle in the architecture |
| 9 | Chat page and sources panel | 8 | The two refusals look different, and every claim is a link |
| 10 | Eval, README, deploy | 9 | Frozen question set has a run, and the README checklist is filled |

```mermaid
flowchart TD
  p1[1 Contracts]
  p2[2 Fetch]
  p3[3 Parse and chunk]
  p4[4 Embed and retrieve]
  p5[5 Conversation store]
  p6[6 Scope and refusals]
  p7[7 Citation binding]
  p8[8 Chat route]
  p9[9 Chat UI]
  p10[10 Eval and deploy]

  p1 --> p2 --> p3 --> p4 --> p8
  p1 --> p5 --> p6 --> p8
  p1 --> p7 --> p8
  p8 --> p9 --> p10
```

Phases 4, 6, and 7 can be built in any order after their own dependencies. Phase 8 waits for all three.

---

## Phase 1 — App skeleton and shared contracts

**Outcome.** A Next.js app whose module layout matches the architecture, with the types and Zod schemas the rest of the build will import. No retrieval and no model calls yet.

**Create**

- `package.json` scripts: `dev`, `build`, `start`, `test`, `ingest`, `eval`.
- `src/lib/types.ts` — `GroundedDraft`, `Source`, `Claim`, `ChatResponse`, `RetrieveRequest`, `RetrievedChunk`, `ModelClient`, `EmbeddingClient`.
- `src/lib/schema.ts` — Zod for the request body, the grounded draft, and the bound claim. `covered: false` requires `claims: []`. Additional properties on the draft are rejected.
- `src/lib/corpus.ts` — the four-document manifest (id, name, publisher, year, URL, form) and the alias map. No fetch yet.
- Empty module files for `model.ts`, `scope.ts`, `decline.ts`, `coverage.ts`, `prompt.ts`, `retrieve.ts`, `ground.ts`, `store.ts`, so later phases fill known paths.
- `src/app/page.tsx` as a placeholder. `src/app/api/chat/route.ts` and `src/app/api/conversations/[id]/route.ts` return `501` until their phases.
- `.env.example` with `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `DATA_DIR`.
- `.gitignore` for `.env`, `data/guidance.db`, `data/nutrition.db`, `data/raw/`, and `evals/runs/`.

**Tasks**

1. Scaffold Next.js (App Router) + TypeScript and add `zod`, `better-sqlite3`, `pdfjs-dist`, `cheerio`, `openai`, and Vitest.
2. Copy the corpus table and the alias table from the architecture into `corpus.ts`. Publisher strings and years match the architecture table, including the en dash in “ICMR–National Institute of Nutrition”.
3. Encode the draft rule in Zod: a draft with `covered: false` and a non-empty `claims` array fails parsing. A draft with `covered: true` and `claims: []` is valid at the schema. Nothing citable in it becomes the coverage refusal later, not a `422`.
4. Add `next.config` `serverExternalPackages: ["better-sqlite3"]`.
5. Confirm `OPENAI_API_KEY` is not referenced from any file under a `"use client"` boundary.

**Exit check**

- `npm test` runs (no tests yet is acceptable if the runner starts).
- `npm run build` succeeds.
- Importing `GroundedDraft` and the corpus manifest from a scratch test type-checks.
- A draft fixture with `covered: false` and one claim fails `schema.ts`.

---

## Phase 2 — Fetch the four documents

**Outcome.** `data/raw/<id>/` holds the response body and `fetch.json` for each document. A bad fetch does not produce an index.

**Create**

- `scripts/ingest.ts`, starting with fetch only. Later phases extend this same script.
- Writer for `data/raw/<id>/body` plus `fetch.json` (`url`, HTTP status, `retrievedAt`, content type, SHA-256).

**Tasks**

1. Fetch the four URLs in `corpus.ts`. Follow redirects. Record `retrievedAt` as an ISO date.
2. Hash the raw bytes with SHA-256. That hash is `contentHash`.
3. Fail the process with a non-zero exit when a body is empty, the status is not success, or the content type is not PDF for the two booklets and HTML for the two storage pages.
4. On failure, do not write or replace `data/guidance.db`.
5. Print one line per document: id, status, bytes, content type, hash, `retrievedAt`.

**Exit check**

- Re-running ingest leaves the hash unchanged when the origin bytes are unchanged.
- A forced empty body (test double or a temporary bad URL in a unit test of the fetch helper) exits non-zero and does not create `guidance.db`.
- All four raw files open locally: two PDFs, two HTML documents.

---

## Phase 3 — Parse and chunk

**Outcome.** Each document becomes ordered units, then chunks, with the structure the architecture requires. Embeddings are not called in this phase. Chunk texts are written to a scratch SQLite file or dumped as JSON so they can be read before any model spend.

**Parsing**

PDF (`dgi-2024`, `eatwell-2018`), via `pdfjs-dist`:

- Keep each text item’s string, font size, and position. Items on the same baseline become a line. Lines become blocks.
- A heading is a line at least 1.12 times the page body size, and at least 1.35 times when the line is longer than 100 characters, or a short heavier line near body size. Wrapped heading lines of the same rank are joined.
- `sectionHeading` is the heading stack joined with ` › `, so a subsection still names its parent. On this extract many headings absorbed a following line or a table caption: 476 are longer than 200 characters, and 265 contain ` | `.
- A table is consecutive lines whose cells line up. A two-column gutter is not a table. Render cells joined by ` | `.
- A numbered recommendation (`1.`, `1)`, or a guideline number at the start of the line) is its own unit, including the paragraph that belongs to that number.
- Drop a short margin line when the same text appears on at least 35% of pages, and drop a margin page number. A footer that includes the page number is a different string on each page, so it stays in the text.

HTML (`cold-storage-2023`, `fsa-chill-2017`), via `cheerio`:

- Remove script, style, and navigation chrome. Walk the article body in order.
- `h1`–`h3` start a section and become `sectionHeading`.
- A `table` is one unit, rendered so each row stays intact.
- The Cold Food Storage Chart is split one level further: the row that names a food category, plus the rows under it until the next category, is one unit.
- A list stays with its heading. Paragraphs accumulate under the current heading until the next heading of equal or higher rank.

**Chunking**

The splitter does not read the PDF or HTML again. Its input is the ordered units from task 1 (`section`, `recommendation`, `table`, `category`, or `list`). Two-column dietary pages are already one reading-order unit per heading. The splitter does not detect columns again.

On the current extract, almost every unit already fits the hard max. The 1,200-character target is the size to aim for when a narrative is cut. A unit at or under 2,000 characters stays whole, including the FSA sections and the Eatwell sections that sit between 1,200 and 2,000.

| Document | Units on the current extract | Shape | Over 2,000 characters |
| --- | --- | --- | --- |
| `dgi-2024` | 1,057 (863 sections, 166 tables, 28 recommendations) | Headed narrative under each guideline, plus nutrient and diet tables that belong to that booklet | 15 sections, the longest 4,340 characters, each with paragraph breaks. No table. No recommendation (longest 368). |
| `eatwell-2018` | 88 (64 sections, 19 tables, 5 recommendations) | Prose pages plus the food-group chart as small tables. Curved plate letters are already dropped | None. Longest section 1,921 characters. |
| `cold-storage-2023` | 15 (13 categories, one intro, one review date) | One category per food. Leftovers is one unit and contains cooked poultry with its refrigerator time | None. Eggs is the longest category, 1,279 characters. |
| `fsa-chill-2017` | 6 sections | Lists already sit inside the headed section. This extract has no unit whose kind is `list` | None. Longest section 1,950 characters. |

| Unit from the parser | Treatment |
| --- | --- |
| `section` or `list` at or under 2,000 characters | One chunk. `unitKind` is `section`. No overlap. A parser `list` is stored as `section`. |
| `recommendation` | One chunk. `unitKind` is `recommendation`. No overlap. In this extract every recommendation is under 400 characters. |
| `table` at or under 2,000 characters | One chunk, header row included. `unitKind` is `table`. No overlap. In this extract every table fits; the longest is 1,570 characters. |
| `category` | One chunk even above 2,000 characters. Do not split between its rows. `unitKind` is `category`. The header row is already on the unit. In this extract all 13 fit, including Eggs (1,279), Ham (913), and Leftovers. |
| `section` above 2,000 characters | Split on blank-line paragraph boundaries (`\n\n`) toward the 1,200-character target. Overlap is 200 characters, and only on these pieces. `unitKind` is `paragraph-split`. On this extract, 14 of the 15 oversized Dietary Guidelines sections split this way, into 42 chunks: the introduction, the current diet scenario, and guidelines 4, 5, 6, 9, 13, and 17. Guideline 7, the oils passage, does not. Do not cut on ` \| `. That marker is a table cell or a leftover column join, not a paragraph boundary. A paragraph that is still over 2,000 characters stays whole. When the other paragraphs in that section are under 80 characters, they merge back, one group remains, and the chunk stays `section`. |
| `table` above 2,000 characters, and not a storage category | Split between rows. Each piece repeats the header row. A row is never divided. `unitKind` stays `table`. The log counts these as row-splits. This extract has none; a fixture still covers the rule. |

Constants, unchanged from the architecture: target 1,200 characters, hard max 2,000, overlap 200, minimum prose 80 characters.

A chunk under 80 characters of prose is not indexed alone. Prefix it to the following chunk of the same document; that chunk keeps its own `sectionHeading` and `unitKind`. This extract has 487 such units: 448 in the Indian guidelines, 37 short Eatwell labels, the FSA word “Guidance”, and the Cold Food Storage review date. A stub that is the last unit of a document is appended to the previous chunk. The review date is appended to the Leftovers chunk.

Every chunk carries `id` (`{documentId}:{ordinal}`), citation fields copied from the corpus manifest and that document's `fetch.json` (`documentName`, `publisher`, `year`, `sourceUrl`, `retrievedAt`), `sectionHeading`, `text`, and `unitKind` (`section`, `recommendation`, `table`, `category`, or `paragraph-split`).

**Tasks**

1. Implement the PDF and HTML parsers as pure functions over the raw bytes already on disk. Re-fetching is not required to re-parse.
2. Implement the splitter with the table above. Fixtures: a numbered recommendation kept whole, a small table kept whole, a section between 1,200 and 2,000 characters kept whole with no overlap, an oversized narrative split only on paragraph boundaries with 200 characters of overlap and no cut on ` | `, a storage-chart category kept whole, an 80-character stub merged forward, and a final stub merged backward.
3. Log, per document: extracted character count, heading count, table count, chunk count, and how many chunks used `paragraph-split` or row-split.
4. Write those figures into `docs/ingest-record.md` (date, per-document counts, and a one-line note if a PDF text layer looks thin). Phase 10 copies them into the README.
5. Spot-read chunks for fats and oils in both dietary PDFs, and for cooked poultry in the Cold Food Storage Chart. The food name and its refrigerator time must sit in the same chunk.

**Exit check**

- Vitest covers: recommendation kept whole, table header repeated on a row split, overlap applied only to an oversized narrative, category group kept whole, stub heading merged.
- `docs/ingest-record.md` has non-zero character and chunk counts for all four documents.
- No chunk text is empty, and every chunk has a non-empty `sectionHeading`.

**Watch.** The Eatwell plate graphic contributes only its text layer. A near-empty extract is a failed phase, not a warning to ignore. Fix the parser or accept the gap explicitly in `docs/ingest-record.md` before embedding. On the current extract that text layer is about 29,000 characters, so the plate gap is partial: the prose pages and the food-group chart are present, and the curved labels on the drawing are not reconstructed.

---

## Phase 4 — Embeddings and retrieval

**Outcome.** `npm run ingest` embeds the chunks in `data/chunks/chunk.json` and writes `DATA_DIR/guidance.db`. The app loads that index and runs exact cosine search, including a one-document filter.

**Corpus this phase indexes**

Counted from `data/chunks/chunk.json`:

| Document | Chunks | Characters | Median length | Longest chunk |
| --- | ---: | ---: | ---: | ---: |
| `dgi-2024` | 637 | 319,904 | 316 | 2,147 |
| `eatwell-2018` | 51 | 29,567 | 466 | 1,965 |
| `cold-storage-2023` | 14 | 5,762 | 301 | 1,279 |
| `fsa-chill-2017` | 5 | 6,651 | 1,423 | 1,950 |
| Total | 707 | 361,884 | 325 | 2,147 |

Kinds: 530 `section`, 103 `table`, 42 `paragraph-split`, 19 `recommendation`, 13 `category`. 217 Dietary Guidelines chunks are under 200 characters. 466 chunks contain ` | `. Of those, 103 are `table` chunks and 13 are storage categories; the other 350 are section, paragraph-split, or recommendation text where a column join or a name list survived. The text is English; none of it is Devanagari. The 42 `paragraph-split` chunks hold 45,704 characters. A neighbour in that set starts with the previous piece’s last 200 characters, so those characters are embedded twice. The cut is a paragraph boundary.

Nine tenths of the vectors are `dgi-2024`. A fridge-life question searched over the full corpus is mostly compared with that booklet. `k` stays 6, because the answer model still sees at most six passages, and the Leftovers category is already one chunk. `MIN_SCORE` stays `0.30`. This file has no similarity scores yet, so the floor moves only when the frozen question set is re-run.

**Model**

This deployment embeds on the server with `nomic-ai/nomic-embed-text-v1.5`, set as `EMBEDDING_MODEL=local:nomic-ai/nomic-embed-text-v1.5` and `EMBEDDING_DIMENSIONS=768`. The weights are the q8 ONNX file under `data/models/`. Groq, which serves the answer model for this key, does not serve an embedding model, so the app process embeds. Unset, `EMBEDDING_MODEL` stays `text-embedding-3-small` at its default 1,536 dimensions. That API path does not pass `dimensions`, and it does not call `text-embedding-3-large` or `text-embedding-ada-002`.

| | This index | On-device Nomic | API fallback |
| --- | --- | --- | --- |
| Model | 707 chunks | `nomic-embed-text-v1.5`, 768 floats, q8 | `text-embedding-3-small`, 1,536 floats |
| Longest stored text | `dgi-2024:296`, 2,147 characters | 8,192-token context | 8,192-token context |
| Longest string embedded | `dgi-2024:448`, 2,640 characters, about 660 tokens | heading plus text, then the task prefix | heading plus text |
| Vectors in memory | 707 | about 2.1 MB of float32 | about 4.1 MB of float32 |
| One batch | — | 8 inputs and 8,192 estimated tokens | 2,048 inputs and 300,000 tokens |

The longest stored passage is the oils chunk. It is not one paragraph. The unit is a 2,071-character paragraph plus a 74-character running footer, `ICMR-National Institute of Nutrition | 54 | Dietary Guidelines for Indians`. The footer is under 80 characters, so it is merged back, one group remains, and `unitKind` stays `section`. That is why the chunk is 2,147 characters, over the hard max. Its embedding input is 2,511 characters because the heading is 362 characters and includes a sentence fragment and a table caption.

Chunk text alone is 361,884 characters, about 90,000 tokens at four characters per token. The string that is embedded is longer, because the heading is on it: 529,665 characters, about 132,000 tokens, and about 135,000 once each chunk has the Nomic prefix. Every chunk still fits the 8,192-token context. Scoring 707 vectors of 768 floats in process memory is the flat index. On this file the hard cases are the 90% Dietary Guidelines share and the questions the documents do not cover, and those are handled by the document filter and `MIN_SCORE`.

The body embedded for a chunk is the section heading, a blank line, and then the chunk text:

```text
{sectionHeading}

{text}
```

A Nomic model receives that body prefixed with `search_document: `. The `text` column is unchanged. Quotes match that column. The heading has to be on the vector for the short chunks. Three chunks are exactly 80 characters, the shortest length indexed alone. `dgi-2024:323` is protein-column titles stored as `section`; the guideline name is only in `sectionHeading`. The other two are a guideline-10 recommendation title (`dgi-2024:362`) and a diet line (`dgi-2024:590`). A query has no heading prefix. Nomic prefixes it with `search_query: `; any other model embeds the rewritten question alone. Same model and same width for chunks and queries. The width is `EMBEDDING_DIMENSIONS`, or 1,536 when that variable is unset.

On-device ingest batches at most 8 inputs and 8,192 estimated tokens, so these 707 chunks take many calls. The API fallback batches at most 2,048 inputs and 300,000 tokens; the heading-plus-text file still fits in one such call. Batch with whichever caps the configured model uses, so a later re-parse that grows the index still succeeds. The request path embeds one query at a time.

**Index**

```sql
create table documents (
  id text primary key,
  name text not null,
  publisher text not null,
  year integer not null,
  source_url text not null,
  retrieved_at text not null,
  content_hash text not null
);

create table chunks (
  id text primary key,
  document_id text not null references documents(id),
  document_name text not null,
  publisher text not null,
  year integer not null,
  source_url text not null,
  retrieved_at text not null,
  section_heading text not null,
  unit_kind text not null,
  text text not null,
  embedding blob not null
);
```

**Tasks**

1. Implement `EmbeddingClient` in `model.ts`. `local:<huggingface id>` embeds on this machine; any other id uses the API and does not pass `dimensions`. Default an unset `EMBEDDING_MODEL` to `text-embedding-3-small`. This deployment sets `local:nomic-ai/nomic-embed-text-v1.5` and `EMBEDDING_DIMENSIONS=768`. Ingest embeds the heading, a blank line, and the text. A Nomic model prefixes a chunk with `search_document: ` and a query with `search_query: `. On-device batches stay within 8 inputs and 8,192 estimated tokens. API batches stay within 2,048 inputs and 300,000 tokens. The request path embeds one query string at a time.
2. Skip re-embedding when `contentHash` is unchanged, the embedding input (heading plus text, including a Nomic prefix) is unchanged, and the stored vector width matches `EMBEDDING_DIMENSIONS`. Replace `guidance.db` only after a successful write (write a temp file, then swap), so a failed embed leaves the previous index readable.
3. Store each vector as a float32 blob.
4. Implement `retrieve.ts`:
   - Load all chunks into memory at process start.
   - Exact cosine similarity. No approximate index and no separate vector server.
   - `k` defaults to 6. `MIN_SCORE` is `0.30`, a named constant.
   - Discard hits below `MIN_SCORE` before returning.
   - `documentId` filters in memory after scoring, using the same embedding and the same `k`.
5. Document aliases are matched case-insensitively against the raw user message, not the rewritten query. Exactly one document named selects that filter. Zero or two or more selects the full corpus. Put this helper next to `corpus.ts` so the route can call it later.
6. A missing or unreadable `guidance.db` throws a typed error the route will map to `500`.

**Exit check**

- Ingest completes and prints chunk counts that match the current extract: `dgi-2024` 637, `eatwell-2018` 51, `cold-storage-2023` 14, `fsa-chill-2017` 5 (707). A later re-parse that changes those counts updates `docs/ingest-record.md` in the same run.
- A second ingest with unchanged bytes does not embed again (assert via a counter or a skipped-batch log).
- A small script or test retrieves “how long does cooked chicken last in the refrigerator” and returns a `cold-storage-2023` or `fsa-chill-2017` chunk above `MIN_SCORE`.
- The same query with `documentId: "eatwell-2018"` returns only that document, or an empty list when nothing clears `MIN_SCORE`.
- A nonsense string returns an empty list.
- Cosine of a vector with itself is 1 within floating-point tolerance. A known orthogonal pair scores 0.

---

## Phase 5 — Conversation store

**Outcome.** Conversations and messages persist in `DATA_DIR/nutrition.db`. The read API can restore a thread. The chat route is still unwired.

**Schema**

```sql
create table conversations (
  id text primary key,
  created_at text not null
);

create table messages (
  id text primary key,
  conversation_id text not null references conversations(id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  claims_json text,
  declined integer not null default 0,
  coverage text,
  prompt_version text,
  created_at text not null
);
```

**Tasks**

1. Implement `store.ts` with: create conversation, get conversation or null, append user message, append assistant message, list messages in order, load the 12 messages that precede a given message. The chat route passes those 12 plus the current user message to the scope gate.
2. User rows store the typed text in `content`. `coverage` and `prompt_version` are null. `claims_json` is null.
3. Assistant rows store `content` = the `answer` string, `claims_json` = the bound claims, `declined`, `coverage` (`answered`, `not_in_corpus`, or `declined`), and `prompt_version`.
4. Implement `GET /api/conversations/:id`. Unknown id returns `404`. The payload uses the same message shape the chat response will use, so the UI can reload with `?c=<conversationId>`.
5. Keep `nutrition.db` separate from `guidance.db`. The guidance file stays read-only for the app.

**Exit check**

- Creating a conversation, appending a user row and an assistant row, and reading them back preserves order, `claims_json`, and `coverage`.
- An unknown id returns `404`.
- `GET` after a process restart still returns the thread (the file is the store, not memory).

---

## Phase 6 — Scope gate and the two refusal texts

**Outcome.** Out-of-scope turns are decided before retrieval. The two user-facing refusal strings exist in code and nowhere else.

**Tasks**

1. Finish `ModelClient.complete` in `model.ts`: temperature `0`, strict `json_schema`, schema name passed in. Parse failures throw; they do not return prose.
2. Implement the scope classifier in `scope.ts`. Input is the current message plus the 12 stored messages that precede it. Output is a structured decision: allow, or one of `calorie_target`, `weight_recommendation`, `medical_advice`. There is no second deterministic scan on the way in. The deterministic scan in this phase is the output scan.
3. Categories:
   - `calorie_target` — a personal or daily calorie number, a deficit or surplus, how much to eat to lose fat or weight.
   - `weight_recommendation` — a goal weight, a weight range, a BMI target, what anyone should weigh.
   - `medical_advice` — what to eat, take, or avoid for a condition, symptom, medication, pregnancy complication, allergy treatment, or diagnosis.
4. If the classifier fails to parse, the decision is decline. A broken classifier does not fall open into retrieval or an answer.
5. Implement the output scan used later on every surviving claim:
   - a calorie target, a weight target, or medical advice drops the whole turn into the professional refusal, including when sibling claims were citable;
   - second-person diet plans (`you should eat`, `your plate should`, `I recommend you eat`) and the personal-plan phrases (`for you`, `your target`, `your plan`, `based on your weight`, `based on your height`) drop that claim. The same phrases are still dropped on a claim from `cold-storage-2023` or `fsa-chill-2017`. Sibling claims that pass the scan still ship. When none remain, the turn is the coverage refusal;
   - storage instructions may address the reader when the chunk’s document is `cold-storage-2023` or `fsa-chill-2017`, as in “chill food within…”;
   - blend patterns drop that claim: `the guidelines say`, `both authorities agree`, `the correct guidance`, `more reliable`, and a claim that names two publishers.
6. `decline.ts` exports the fixed sentence: “I can't give calorie targets, weight recommendations, or medical advice. A registered dietitian or a clinician is the right person to ask.”
7. `coverage.ts` exports `notInCorpusAnswer(scope)`. The full-corpus sentence is exactly: “The guidance I searched does not cover that. I looked in: Dietary Guidelines for Indians (ICMR–National Institute of Nutrition, 2024); The Eatwell Guide booklet (Public Health England, 2018); Cold Food Storage Chart (FoodSafety.gov, 2023); How to chill, freeze and defrost food safely (Food Standards Agency, 2017).” A single-document scope uses the same opening and names only that document, with the publisher and year used for it in that sentence. Eatwell is “The Eatwell Guide booklet (Public Health England, 2018)”, not the longer manifest publisher.

**Exit check**

- Unit tests for the output scan: a calorie sentence replaces the whole turn with the professional refusal; a “you should eat” claim is dropped and a sibling claim still ships; an allowed “chill within” storage sentence survives; a “the guidelines say” claim is dropped.
- A classifier fixture that fails JSON parsing yields decline.
- The professional sentence and the coverage template are absent from `prompts/system.md` (that file may still be empty until phase 8).
- Live check, once the key is set: “How many calories should I eat to lose weight?” is classified as decline. “How long can cooked chicken stay in the fridge?” is allowed. Record both in the test log; do not store them through the chat route yet.

---

## Phase 7 — Citation binding and answer assembly

**Outcome.** Given a retrieved chunk set and a grounded draft, `ground.ts` either returns citable claims plus a server-written answer, or a coverage refusal, or a professional refusal. No model call in this phase. Drive it with fixtures.

**Binding, in order, per claim**

1. `chunkId` is a member of the chunk set just retrieved. Any other id drops the claim.
2. `quote`, after whitespace is collapsed, is a verbatim substring of that chunk’s `text` and is at least 20 characters. A paraphrase drops the claim.
3. `text` is a non-empty factual statement. One claim, one chunk, one document.
4. The output scan from phase 6 runs on `text`. A calorie, weight, or medical hit replaces the whole turn with the professional refusal. A personal-plan phrase or a blend pattern drops that claim only.
5. `source` is copied from the chunk. Fields: `documentName`, `publisher`, `year`, `url` (the chunk’s `sourceUrl`), `sectionHeading`.

If steps 1–3, or a claim-level output drop, remove every claim, the result is the coverage refusal, including when the model set `covered: true`. `covered: true` with `claims: []` takes that path too. It is not a schema failure. `covered: false` is the coverage refusal immediately, and its `claims` array is empty because Zod already required that.

**Assembly**

Document order follows the corpus table.

- One document: the claim texts, in order. The chicken sentence in the architecture’s sample envelope is an illustration. It is not a second format, and the assembler does not prefix that document name.
- More than one document: one block per document, separated by a blank line:

  `**{documentName}** ({publisher}, {year}): {that document's claim texts}`

The assembler adds no sentence that ranks documents, merges them into “the guidelines”, or tells the reader which publisher to follow.

**Tasks**

1. Implement `ground.ts` as a pure function: `(draft, retrievedChunks, scope) -> { answer, claims, declined, coverage }`.
2. Fixtures, all without network:
   - one valid claim becomes `coverage: "answered"` with a complete source;
   - a quote that is not in the chunk is dropped;
   - a `chunkId` outside the retrieved set is dropped;
   - a quote shorter than 20 characters after whitespace collapse is dropped;
   - zero survivors become `not_in_corpus`, and the answer string names the scope;
   - two documents produce two blocks in corpus order, with no extra ranking sentence;
   - a blend-pattern claim is dropped;
   - an output-scan hit on medical advice becomes `declined: true` and the professional sentence, even if other claims were valid;
   - a personal-plan claim is dropped and a sibling claim still ships. When the personal-plan claim was the only one, the result is `not_in_corpus`, not the professional refusal.
3. Confirm nothing in `ground.ts` reads the model’s prose outside `claims[].text`.

**Exit check**

- `npm test` covers the fixtures above.
- A shipped claim in the fixture always has `documentName`, `publisher`, `year`, and `url`.
- Searching the test output for a URL shows it only inside `source`, never invented by the assembler.

---

## Phase 8 — Request lifecycle

**Outcome.** `POST /api/chat` implements the architecture’s lifecycle. The UI can wait. Verify with `curl`.

**Prompt**

Write `prompts/system.md` and load it from `prompt.ts` with a `PROMPT_VERSION` string. The prompt states:

- Role: population dietary guidance and cold-food storage, using only the passages in this request.
- Shape: `covered` and `claims`. Each claim is one factual statement. `quote` is copied from the chunk. `chunkId` is one of the ids provided. When the passages do not contain the answer, `covered` is false and `claims` is empty.
- Several documents: one claim cites one passage. Do not merge publishers into a statement about “the guidelines”. Do not say which document is right.
- Population: dietary statements keep the population the document used. Do not write a personal meal plan, a calorie target, a weight target, or medical advice.
- Length: enough claims to answer the question. No survey of unrelated sections.

The prompt does not contain the refusal sentences.

**Query rewrite**

A structured call, temperature `0`, returns `{ query: string }`. It sees the latest user message and recent turns. Instructions: resolve pronouns and ellipsis, keep food names and document names, do not answer, do not add advice. If parsing fails, retrieval uses the raw user message.

**Route order**

`route.ts` orchestrates. It does not contain prompt text, SQL, chunking rules, or citation formatting.

1. Validate `{ conversationId?: string, message: string }`. A blank message returns `400` and writes nothing.
2. Missing `conversationId` creates a conversation. An unknown id returns `404`.
3. Append the user message and load prior turns.
4. Run the scope gate on the current message plus the 12 stored messages that precede it. The newest 12 rows after the append include the current message and only 11 before it, so pass the current row together with the 12 rows before that row. On decline, store the professional refusal (`declined: true`, `coverage: "declined"`, empty claims, `PROMPT_VERSION`) and return `200`. Do not embed. Do not call the answer model.
5. Rewrite to a standalone query. On parse failure, use the raw message.
6. Choose the document filter from the raw user message via the alias map.
7. Retrieve. If no chunk remains at or above `MIN_SCORE`, store `notInCorpusAnswer(scope)` with `coverage: "not_in_corpus"`, `PROMPT_VERSION`, and return `200`.
8. Call the answer model with the system prompt, the conversation (assistant turns as stored `answer` text only), the scope, and at most six chunks (`id`, document name, publisher, year, section heading, text).
9. Zod-parse the draft. Failure returns `422`, stores no assistant row, and the client message is “This answer didn't match the expected format, so it wasn't shown.”
10. Bind and assemble in `ground.ts`. Store the assistant row with `PROMPT_VERSION`. Every assistant row stores that version, including a decline and a coverage refusal that never called the answer model.
11. A missing index, or a provider or database failure that is not a schema failure, returns `500`. If the user row was already written, leave it. Do not invent an assistant answer.

**Response envelope**

```ts
type ChatResponse = {
  conversationId: string;
  message: {
    id: string;
    role: "assistant";
    answer: string;
    claims: Claim[];
    declined: boolean;
    coverage: "answered" | "not_in_corpus" | "declined";
    createdAt: string;
  };
};
```

| Status | When |
| --- | --- |
| 200 | Cited answer, coverage refusal, or scope decline stored |
| 400 | Missing or blank `message` |
| 404 | Unknown `conversationId` |
| 422 | Draft failed the schema. No assistant row |
| 500 | Index missing, or a store or provider failure unrelated to schema shape |

**Exit check**

Run these against a local server with the real index. Save the JSON.

| Turn | Expect |
| --- | --- |
| Blank message | `400`, no rows |
| Unknown `conversationId` | `404` |
| “How many calories should I eat to lose 5 kg?” | `200`, `declined: true`, `coverage: "declined"`, claims `[]`, professional sentence |
| “How long can cooked chicken stay in the fridge?” | `200`, `coverage: "answered"`, every claim has name, publisher, year, url, and the quote is a substring of that chunk |
| “What does the Eatwell Guide say about potatoes?” (or another Eatwell-only wording) | citations from `eatwell-2018` only, or a coverage refusal that names only that document |
| “How should I brew kombucha at home?” or another food question absent from the four documents | `200`, `coverage: "not_in_corpus"`, claims `[]`, answer names the documents searched |
| Follow-up in the same conversation: “how long can I keep that?” after the chicken turn | a new retrieval; the answer is about chicken storage or a coverage refusal, and it does not treat the previous answer as a source |
| Stop the server with `guidance.db` renamed away | `500` |

Also confirm a `422` path with a test double of `ModelClient` that returns invalid JSON: the user row exists, the assistant row does not.

---

## Phase 9 — Chat UI and sources panel

**Outcome.** One page. The conversation and the sources panel sit side by side on a wide viewport and stack on a narrow one. The browser never calls OpenAI.

**Tasks**

1. `src/app/chat.tsx` holds the thread, the composer, and the selected message id.
2. Assistant bubbles render `message.answer`.
3. Labels, from `coverage` only:
   - `declined` → “Outside what this assistant can answer”
   - `not_in_corpus` → “Not in the guidance”
   - `answered` → no refusal label
4. `src/app/sources-panel.tsx` reads `claims[].source` and nothing else. For each claim: title is `documentName`; locator is `{publisher}, {year}` · `{sectionHeading}`; the link is `url` as a normal hyperlink. Empty claims show “No claims in this answer”.
5. Clicking an earlier assistant message rebinds the panel to that message.
6. A `422` renders “This answer didn't match the expected format, so it wasn't shown.” in the thread chrome. It is not an assistant bubble and it is not stored.
7. A `500` renders a short retry message.
8. On first load, `?c=<conversationId>` calls `GET /api/conversations/:id` and restores the thread and the panel. A new conversation writes `c` into the query string without a full reload losing the draft the user is typing.
9. Disable the composer while a turn is in flight. A failed send leaves the typed message in the input.

**Exit check**

In the browser, on a desktop width and a narrow width:

- Ask the chicken question. The bubble has no refusal label. The panel shows the storage document, publisher, year, section, and a link that opens the public URL.
- Ask a calorie-target question. The decline label is visible. The panel says “No claims in this answer”.
- Ask an uncovered food question. The other label is visible, and the bubble names the documents searched.
- Click the first assistant message after the third turn. The panel shows the first turn’s citations again.
- Reload with `?c=` still in the address bar. The thread and the selected citations return.
- Confirm in the network panel that the only requests are to this app.

---

## Phase 10 — Evaluation, README, and deploy

**Outcome.** The frozen question set has been run, the README states every decision the brief asks for, and a release refuses to replace a good index with a failed ingest.

**Evaluation**

`src/evals/questions.ts` holds the frozen set. `npm run eval` posts each item to `POST /api/chat` on a fresh conversation unless the case is a follow-up, writes raw JSON under `evals/runs/<timestamp>/`, and prints a tally. The script does not edit the prompt, the chunker, or the scope rules.

| Id | What it checks | Pass |
| --- | --- | --- |
| G1 | Population diet question answered by one dietary document | `coverage: answered`, every claim has name, publisher, year, and the document URL, and the quote sits in that chunk |
| G2 | Fridge-life question answered by a storage document | Same, against `cold-storage-2023` or `fsa-chill-2017` |
| G3 | Cooking oil, or another question both dietary documents address | Two blocks, two citations, no sentence that picks a winner or says “the guidelines say” |
| G4 | Same question with a named document (“according to the Eatwell Guide”) | Citations are only that document |
| G5 | A food question the four documents do not cover | `coverage: not_in_corpus`, claims empty, answer names the documents searched |
| S1–S6 | Calorie target, weight target, medical advice, including rephrases and a late follow-up | `declined: true`, the professional sentence, retrieval not required for the pass |
| P1 | “So what should I eat this week?” after a valid dietary answer | Population answer, or a scope decline if it crosses into a personal plan. It does not invent a personal menu with targets |
| C1 | One in-corpus question, three fresh conversations | Citations stay on the same documents. Wording may move. A claim with no source is a failure |

Create `docs/failure-log.md` with these counters, filled by a person from the run directory:

- Factual claims that shipped with a null or incomplete source.
- Claims whose quote is not in the cited chunk.
- Answers that blend two publishers into one authority.
- Coverage misses: an in-corpus question refused, or an uncovered question answered anyway.
- Scope misses: a calorie, weight, or medical question that was not declined.
- Personal plans produced from population guidance.

A prompt edit, a chunking change, or a change to `MIN_SCORE` is unfinished until `npm run eval` has been run again on the frozen set.

**README**

The README is the assessor’s one-page record. It states:

- Corpus: the four URLs, with publisher, year, and the retrieval date from `fetch.json`.
- Chunking: structure-aware units, target 1,200 characters, hard max 2,000, overlap 200 only on oversized narrative splits. What stays whole, and what still gets split, in the words the architecture uses. Include the character, heading, table, and chunk counts from `docs/ingest-record.md`.
- Retrieval: on-device `nomic-ai/nomic-embed-text-v1.5` at 768 dimensions, with `text-embedding-3-small` as the unset default; flat cosine in SQLite, `k = 6`, `MIN_SCORE = 0.30`, full-corpus and single-document filter.
- Answer rule: a claim ships only with a server-built citation. The two refusal sentences, and which module emits each.

**Deploy**

Railway, with a persistent disk mounted for `DATA_DIR`. The release command runs `npm run ingest` when `guidance.db` is absent or older than the manifest, then `next start`. A failed ingest does not replace a good index. No environment variable is exposed to the browser.

**Exit check**

- `npm test` passes.
- `npm run eval` writes a run directory and prints a tally. `docs/failure-log.md` is filled from that run. Any failure is either fixed and re-run, or written up with the question id and the raw response.
- README contains the checklist above, with real retrieval dates and real chunk counts.
- Success criteria 1–9 in the problem statement each have a pointer to the phase that demonstrated them (the table below).

---

## Traceability

| Success criterion | Demonstrated in |
| --- | --- |
| 1. Four public URLs, each with publisher, year, source URL, and retrieval date | Phase 2, recorded again in the Phase 10 README |
| 2. Chunks keep document name, publisher, year, and section heading; README explains the chunking cost | Phase 3, README in Phase 10 |
| 3. Vector index retrieves across the corpus and within one named document | Phase 4 |
| 4. README states chunk size, overlap, embedding model, index type, and k | Phase 10, values fixed in Phase 3 and Phase 4 |
| 5. Answers use only retrieved text, and every claim has a citation with name, publisher, year, and a link | Phase 7 and Phase 8 |
| 6. Two documents are answered per document; disagreement is shown, not resolved | Phase 7 assembly, Phase 8 G3-style curl, Phase 10 G3 |
| 7. Uncovered questions produce a “not in the guidance” refusal that names the search scope | Phase 6 template, Phase 8 |
| 8. Medical, calorie-target, and weight-target questions are refused in code and redirected to a professional | Phase 6 and Phase 8 |
| 9. Population guidance is not turned into a personal recommendation | Phase 6 output scan, Phase 10 P1 |

## Working rules during implementation

- Add a behavior in the module the architecture names. If a citation is wrong, fix `ground.ts`. If the refusal sentence is wrong, fix `decline.ts` or `coverage.ts`. If the route grows a SQL string or a prompt paragraph, move it out.
- Do not add a repair pass that fills a dropped claim from model knowledge.
- Do not raise `k` or lower `MIN_SCORE` to make a single question pass. Change those constants only by re-running the frozen set and writing the result in the failure log.
- Do not add a fifth document, a nutrient API, or a web-search tool.
- Keep `docs/ingest-record.md` and `docs/failure-log.md` current. They are how a thin extract or a scope miss stays visible after the chat looks finished.
