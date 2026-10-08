# Dietary guidance assistant

A chatbot that answers from four official public guidance documents. Every claim that ships has a citation built by the server. Questions the documents do not cover, and questions that ask for a calorie target, a weight target, or medical advice, are refused in two different ways.

## Corpus

Retrieved 2026-10-07. The timestamps below are `retrievedAt` in each document's `fetch.json`.

| Document | Publisher | Year | Public URL | Retrieved |
| --- | --- | --- | --- | --- |
| Dietary Guidelines for Indians | ICMR–National Institute of Nutrition | 2024 | https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf | 2026-10-07T19:19:36.345Z |
| The Eatwell Guide booklet | Public Health England (GOV.UK) | 2018 | https://assets.publishing.service.gov.uk/media/5ba8a50540f0b605084c9501/Eatwell_Guide_booklet_2018v4.pdf | 2026-10-07T19:19:37.156Z |
| Cold Food Storage Chart | FoodSafety.gov (USDA, FDA, and CDC) | 2023 | https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts | 2026-10-07T19:19:37.236Z |
| How to chill, freeze and defrost food safely | Food Standards Agency (GOV.UK) | 2017 | https://www.gov.uk/government/publications/how-to-chill-freeze-and-defrost-food-safely/how-to-chill-freeze-and-defrost-food-safely | 2026-10-07T19:19:37.297Z |

Nutrient databases and any source with a clean API are not part of this corpus.

## Chunking

Chunks are the structures the parser found: a headed section, a numbered recommendation, a table, or a storage-chart category. They are not fixed-size windows.

| Parameter | Value |
| --- | --- |
| Target size | 1,200 characters |
| Hard max | 2,000 characters |
| Overlap | 200 characters, and only on the paragraph split of an oversized narrative section |

**What stays whole.** Numbered recommendations, tables that fit, storage-chart categories (even when the full chart is larger than the hard max; the split is between categories), and headed sections at or under 2,000 characters. Overlap is not applied to those units.

**What still gets split.** A long narrative section with no inner heading is cut on paragraph boundaries, with 200 characters of overlap, so a sentence at the cut can appear in both neighbours. A very large table with no category groups is cut between rows, and each piece repeats the header. A row is never divided. On this extract the only splits are 42 paragraph splits in Dietary Guidelines for Indians. No table was row-split.

Counts from [docs/ingest-record.md](docs/ingest-record.md), collected 2026-10-08:

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
| Embedding model | On-device `onnx-community/all-MiniLM-L6-v2-ONNX` (384 dimensions), set as `local:onnx-community/all-MiniLM-L6-v2-ONNX` with `EMBEDDING_DIMENSIONS=384`. Groq does not serve an embedding model for this key. Unset, the default stays `text-embedding-3-small` at 1,536. The request does not set `dimensions` |
| Index | Flat exact cosine over float32 vectors in SQLite (`guidance.db`), loaded into memory. No approximate index |
| `k` | 6 |
| `MIN_SCORE` | 0.30. Hits below this are not evidence |
| Filter | Full corpus, or one document when the raw user message names exactly one document |

A chunk is embedded as its section heading, a blank line, and then the chunk text. The stored passage stays `text`, so a quote has to match that column. A query is embedded as the question alone.

## Answer rule

The model drafts `covered` and claims. Each claim names a `chunkId` and a verbatim `quote`. It does not return a URL, a publisher, or a year.

`ground.ts` is the only module that builds a citation. A claim ships only when the chunk was just retrieved, the quote is a verbatim span of that chunk's text of at least 20 characters, and the output scan lets it through. The server writes `answer` from the claims that survived. The draft's free-form prose is discarded. Two documents become two blocks, in corpus order, with no sentence that picks a winner.

The two refusals are fixed strings in code. They are not in the system prompt.

| Situation | Module | Sentence |
| --- | --- | --- |
| Calorie target, weight target, or medical advice | `decline.ts` | I can't give calorie targets, weight recommendations, or medical advice. A registered dietitian or a clinician is the right person to ask. |
| Nothing citable in the searched scope | `coverage.ts` | The guidance I searched does not cover that. I looked in: … (the documents actually searched, with publisher and year) |

## Success criteria

| Criterion | Demonstrated in |
| --- | --- |
| 1. Four public URLs, each with publisher, year, source URL, and retrieval date | Phase 2 fetch records; this README |
| 2. Chunks keep document name, publisher, year, and section heading; the chunking cost is explained | Phase 3; the chunking section above |
| 3. The vector index retrieves across the corpus and within one named document | Phase 4 |
| 4. Chunk size, overlap, embedding model, index type, and k are stated | This README; values fixed in phases 3 and 4 |
| 5. Answers use only retrieved text, and every claim has a citation with name, publisher, year, and a link | Phases 7 and 8 |
| 6. Two documents are answered per document; disagreement is shown, not resolved | Phase 7 assembly; phase 10 G3 |
| 7. Uncovered questions produce a “not in the guidance” refusal that names the search scope | Phase 6 template; phase 8 |
| 8. Medical, calorie-target, and weight-target questions are refused in code and redirected to a professional | Phases 6 and 8 |
| 9. Population guidance is not turned into a personal recommendation | Phase 6 output scan; phase 10 P1 |

## Run

```bash
npm install
npm test
npm run ingest   # writes DATA_DIR/guidance.db; a failed run leaves the previous index
npm run dev
npm run eval     # posts the frozen set to EVAL_BASE_URL or http://localhost:3000
```

`OPENAI_API_KEY` is required. `OPENAI_MODEL` is optional. `EMBEDDING_MODEL` defaults to `text-embedding-3-small` (1,536 dimensions). This repo's `.env` points chat at Groq, which has no embedding model, so embeddings run on device: `EMBEDDING_MODEL=local:onnx-community/all-MiniLM-L6-v2-ONNX` and `EMBEDDING_DIMENSIONS=384`. `DATA_DIR` defaults to `./data` and holds both `guidance.db` and `nutrition.db`. `OPENAI_BASE_URL` is optional when the provider is an OpenAI-compatible host. Chat uses that host. Embeddings use it only when `EMBEDDING_MODEL` is not a `local:` id. The key is read on the server. The browser calls only this app.

`docs/failure-log.md` is filled from `evals/runs/<timestamp>/` after `npm run eval`. A prompt edit, a chunking change, or a change to `k` or `MIN_SCORE` is unfinished until that command has been run again.

## Deploy

Railway. Mount a persistent disk and set `DATA_DIR` to that mount so `guidance.db` and `nutrition.db` survive a restart. The release command is `sh scripts/release.sh`: it runs `npm run ingest` when `guidance.db` is absent or older than `src/lib/corpus.ts`, then `next start`. A failed ingest does not replace a good index, and the process exits before `next start`. A missing `OPENAI_API_KEY` fails the release the same way. No environment variable is exposed to the browser.
