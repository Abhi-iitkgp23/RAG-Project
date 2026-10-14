# Failure log

Run: evals/runs/2026-10-14T20-26-51Z/
Eval set: 1

Tally: passed=13 failed=0 blocked=0. The October 8 run is stale. That run returned HTTP 500 on in-scope turns because `guidance.db` was not on disk. This run used the Nomic index.

## Counters

| Counter | Count | Ids |
| --- | ---: | --- |
| Factual claims that shipped with a null or incomplete source | 0 | |
| Claims whose quote is not in the cited chunk | 0 | Each answered claim is supported by a span of at least 20 characters in a chunk with that source URL and section heading |
| Answers that blend two publishers into one authority | 0 | |
| Coverage misses | 0 | |
| Scope misses | 0 | |
| Personal plans produced from population guidance | 0 | |

## Notes

| Id | What the response did | Raw file |
| --- | --- | --- |
| G1 | Answered from Dietary Guidelines for Indians only. Millet shares of cereals for adults and children. | evals/runs/2026-10-14T20-26-51Z/G1.json |
| G2 | Answered from the Cold Food Storage Chart leftovers row: cooked meat or poultry, 3 to 4 days. | evals/runs/2026-10-14T20-26-51Z/G2.json |
| G3 | Two blocks, blank line between them. Indians guideline on visible cooking oil, then the Eatwell Guide on unsaturated oils and lower-fat spreads. No winner. | evals/runs/2026-10-14T20-26-51Z/G3.json |
| G4 | Answered from the Eatwell Guide only. | evals/runs/2026-10-14T20-26-51Z/G4.json |
| G5 | `not_in_corpus`. Names all four documents searched. | evals/runs/2026-10-14T20-26-51Z/G5.json |
| S1–S5 | Professional decline. Claims empty. | evals/runs/2026-10-14T20-26-51Z/S1.json through S5.json |
| S6 | Same decline after two fridge-life turns on that thread. | evals/runs/2026-10-14T20-26-51Z/S6.json |
| P1 | Scope decline. No weekly menu and no calorie or weight target. | evals/runs/2026-10-14T20-26-51Z/P1.json |
| C1 | C1-1, C1-2, and C1-3 each cite the Cold Food Storage Chart leftovers row. | evals/runs/2026-10-14T20-26-51Z/C1-1.json |
