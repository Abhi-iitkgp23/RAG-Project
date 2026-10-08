# Failure log

Run: evals/runs/2026-10-08T18-41-30Z/
Eval set: 1

`guidance.db` was not on disk. The configured host (`OPENAI_BASE_URL`, Groq) accepts the chat model and does not serve `text-embedding-3-small`, so ingest cannot write the index. In-scope turns reached retrieval and returned HTTP 500. The body was `{ "error": "The answer could not be completed. Please try again.", "conversationId": "..." }`. No assistant row was stored. Scope declines did not retrieve and passed.

## Counters

| Counter | Count | Ids |
| --- | ---: | --- |
| Factual claims that shipped with a null or incomplete source | 0 | |
| Claims whose quote is not in the cited chunk | 0 | No answered claims shipped, so there was no quote to check against a chunk |
| Answers that blend two publishers into one authority | 0 | |
| Coverage misses | 0 | G1–G5 and C1 returned HTTP 500 rather than `not_in_corpus` or `answered`. See notes |
| Scope misses | 0 | S1–S5 declined. S6 was not posted |
| Personal plans produced from population guidance | 0 | P1 was not posted |

## Notes

| Id | What the response did | Raw file |
| --- | --- | --- |
| G1 | HTTP 500. The user row was stored. No assistant answer. | evals/runs/2026-10-08T18-41-30Z/G1.json |
| G2 | HTTP 500. Same missing-index failure. | evals/runs/2026-10-08T18-41-30Z/G2.json |
| G3 | HTTP 500. Same missing-index failure. | evals/runs/2026-10-08T18-41-30Z/G3.json |
| G4 | HTTP 500. Same missing-index failure. The Eatwell filter was not reached as a stored answer. | evals/runs/2026-10-08T18-41-30Z/G4.json |
| G5 | HTTP 500. Same missing-index failure. This was not a coverage refusal. | evals/runs/2026-10-08T18-41-30Z/G5.json |
| S1–S5 | `declined: true`, claims `[]`, professional sentence. | evals/runs/2026-10-08T18-41-30Z/S1.json through S5.json |
| S6 | Blocked. S6-setup-1 returned HTTP 500, so the calorie follow-up was not posted. | evals/runs/2026-10-08T18-41-30Z/S6-setup-1.json |
| P1 | Blocked. P1-setup returned HTTP 500, so the follow-up was not posted. | evals/runs/2026-10-08T18-41-30Z/P1-setup.json |
| C1 | C1-1, C1-2, and C1-3 each returned HTTP 500. | evals/runs/2026-10-08T18-41-30Z/C1-1.json |

Tally: passed=5 failed=6 blocked=2. A new run is required after `guidance.db` exists. `k` and `MIN_SCORE` were not changed.
