# Dietary guidance assistant

A chatbot that answers from four official public guidance documents. Every claim that ships has a citation built by the server. Questions the documents do not cover, and questions that ask for a calorie target, a weight target, or medical advice, are refused in two different ways.

## Working prototype

The public app is live at https://web-production-d9aa5.up.railway.app

## Corpus

The four public URLs are a constant in `src/lib/corpus.ts`. Nutrient databases and any source with a clean API stay out. The timestamps below are `retrievedAt` in each document's `fetch.json`, from the fetch on 2026-10-13.

| Document | Publisher | Year | Public URL | Retrieved |
| --- | --- | --- | --- | --- |
| Dietary Guidelines for Indians | ICMR–National Institute of Nutrition | 2024 | https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf | 2026-10-13T19:10:47.208Z |
| The Eatwell Guide booklet | Public Health England (GOV.UK) | 2018 | https://assets.publishing.service.gov.uk/media/5ba8a50540f0b605084c9501/Eatwell_Guide_booklet_2018v4.pdf | 2026-10-13T19:10:48.123Z |
| Cold Food Storage Chart | FoodSafety.gov (USDA, FDA, and CDC) | 2023 | https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts | 2026-10-13T19:10:48.454Z |
| How to chill, freeze and defrost food safely | Food Standards Agency (GOV.UK) | 2017 | https://www.gov.uk/government/publications/how-to-chill-freeze-and-defrost-food-safely/how-to-chill-freeze-and-defrost-food-safely | 2026-10-13T19:10:48.511Z |

The first two are population dietary guidance. The last two are cold-food storage guidance. The en dash in “ICMR–National Institute of Nutrition” is part of the publisher string.

## Chunking

Fixed-size windows would slice a numbered recommendation or a storage-chart row in half. The splitter's unit is the structure the parser found: a headed section, a numbered recommendation, a table, or a storage-chart category.

| Parameter | Value |
| --- | --- |
| Target size | 1,200 characters |
| Hard max | 2,000 characters |
| Overlap | 200 characters, and only on the paragraph split of an oversized narrative section |

**What stays whole.** Numbered recommendations, tables that fit, storage-chart categories, and headed sections under 2,000 characters.

**What still gets split.** A long narrative section with no inner heading is cut on paragraph boundaries, with 200 characters of overlap, so the last 200 characters of a piece are embedded again in the next piece. A paragraph that is still over 2,000 characters stays whole. When the other paragraphs in that section are under 80 characters, they merge back and the chunk stays a `section`. A very large table is cut between rows and each piece repeats the header. Overlap is not applied to tables or to recommendations.

On this extract the only splits are 42 paragraph splits in Dietary Guidelines for Indians. No table was row-split. A storage-chart category stays one chunk even when the full chart is larger than the hard max; the split is between categories.

Counts from [docs/ingest-record.md](docs/ingest-record.md), collected 2026-10-08. The 2026-10-13 fetch left these chunk counts unchanged (637, 51, 14, 5).

| Document | Characters | Headings | Tables | Chunks | Paragraph splits | Row splits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dietary Guidelines for Indians | 313,408 | 616 | 166 | 637 | 42 | 0 |
| The Eatwell Guide booklet | 29,493 | 64 | 19 | 51 | 0 | 0 |
| Cold Food Storage Chart | 5,760 | 1 | 1 | 14 | 0 | 0 |
| How to chill, freeze and defrost food safely | 6,649 | 5 | 0 | 5 | 0 | 0 |

The Eatwell plate drawing contributes only its text layer. Prose pages and the food-group chart are present. The curved labels on the drawing are not reconstructed.

## Retrieval

| Choice | Value |
| --- | --- |
| Embedding model | On-device `nomic-ai/nomic-embed-text-v1.5` at 768 dimensions, set as `local:nomic-ai/nomic-embed-text-v1.5` with `EMBEDDING_DIMENSIONS=768`. Unset, the default is `text-embedding-3-small` at 1,536 dimensions. That API path does not pass `dimensions` |
| Index | Flat exact cosine over float32 vectors in SQLite (`guidance.db`), loaded into memory. No approximate index |
| `k` | 6 |
| `MIN_SCORE` | 0.30. Hits below this are not evidence |
| Filter | Full corpus, or one document when the raw user message names exactly one document |

A chunk is embedded as its section heading, a blank line, and then the chunk text. The Nomic model prefixes that string with `search_document: `. The stored passage stays `text`, so a quote has to match that column. A query is prefixed `search_query: ` and has no heading. Without a Nomic model, the query is the question alone.

## Answer rule

A claim ships only with a server-built citation. The model drafts `covered` and claims. Each claim names a `chunkId` and a verbatim `quote`. It does not return a URL, a publisher, or a year.

`ground.ts` is the only module that builds a citation. A claim ships only when the chunk was just retrieved, the quote is a verbatim span of that chunk's text of at least 20 characters, and the output scan lets it through. The server writes `answer` from the claims that survived. The draft's free-form prose is discarded. Two documents become two blocks, in corpus order, with no sentence that picks a winner.

The two refusals are fixed strings in code. They are not in the system prompt.

| Situation | Module | Sentence |
| --- | --- | --- |
| Calorie target, weight target, or medical advice | `decline.ts` | I can't give calorie targets, weight recommendations, or medical advice. A registered dietitian or a clinician is the right person to ask. |
| Nothing citable in the searched scope | `coverage.ts` | The guidance I searched does not cover that. I looked in: Dietary Guidelines for Indians (ICMR–National Institute of Nutrition, 2024); The Eatwell Guide booklet (Public Health England, 2018); Cold Food Storage Chart (FoodSafety.gov, 2023); How to chill, freeze and defrost food safely (Food Standards Agency, 2017). |

A single-document scope uses the same opening and names only that document. Eatwell is “The Eatwell Guide booklet (Public Health England, 2018)” in that sentence, not the longer manifest publisher.

## Success criteria

| Criterion | Demonstrated in |
| --- | --- |
| 1. Four public URLs, each with publisher, year, source URL, and retrieval date | Phase 2, recorded again in this README |
| 2. Chunks keep document name, publisher, year, and section heading; the README explains the chunking cost | Phase 3, and the chunking section above |
| 3. The vector index retrieves across the corpus and within one named document | Phase 4 |
| 4. The README states chunk size, overlap, embedding model, index type, and k | This README; values fixed in phases 3 and 4 |
| 5. Answers use only retrieved text, and every claim has a citation with name, publisher, year, and a link | Phases 7 and 8 |
| 6. Two documents are answered per document; disagreement is shown, not resolved | Phase 7 assembly, Phase 8, Phase 10 G3 |
| 7. Uncovered questions produce a “not in the guidance” refusal that names the search scope | Phase 6 template, Phase 8 |
| 8. Medical, calorie-target, and weight-target questions are refused in code and redirected to a professional | Phases 6 and 8 |
| 9. Population guidance is not turned into a personal recommendation | Phase 6 output scan, Phase 10 P1 |

## Run

```bash
npm install
npm test
npm run ingest   # writes DATA_DIR/guidance.db; a failed run leaves the previous index
npm run dev
npm run eval     # posts the frozen set to EVAL_BASE_URL or http://localhost:3000
```

`OPENAI_API_KEY` is required. `OPENAI_MODEL` is optional. `EMBEDDING_MODEL` defaults to `text-embedding-3-small` (1,536 dimensions). This repo's `.env` points chat at Groq, which has no embedding model, so embeddings run in the app process: `EMBEDDING_MODEL=local:nomic-ai/nomic-embed-text-v1.5` and `EMBEDDING_DIMENSIONS=768`. `DATA_DIR` defaults to `./data` and holds `guidance.db`, `nutrition.db`, and the ONNX weights under `models/`. `OPENAI_BASE_URL` is optional when the provider is an OpenAI-compatible host. Chat uses that host. Embeddings use it only when `EMBEDDING_MODEL` is not a `local:` id. The key is read on the server. The browser calls only this app.

`docs/failure-log.md` is filled from `evals/runs/<timestamp>/` after `npm run eval`. The latest local run, `evals/runs/2026-10-14T20-26-51Z/`, scored 13 passed, 0 failed, 0 blocked. A prompt edit, a chunking change, or a change to `k` or `MIN_SCORE` is unfinished until that command has been run again.

## Deploy

The live prototype is https://web-production-d9aa5.up.railway.app

Railway, with a persistent disk mounted for `DATA_DIR`. The steps, variables, volume layout, and the checks to run on the public URL are in [docs/deployment.md](docs/deployment.md).

The release command is `sh scripts/release.sh`. It runs `npm run ingest` when `guidance.db` is absent or older than `src/lib/corpus.ts`, then `next start`. A failed ingest does not replace a good index, and the process exits before `next start`. No environment variable is exposed to the browser. The current check compares file times, so a new image re-ingests even when the four URLs did not change.
