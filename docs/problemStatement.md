# Problem Statement: Dietary Guidance Retrieval Assistant

## Brief

Build a prototype chatbot that answers questions about food, nutrition, and food safety. It answers only from official public dietary guidance documents. Every claim carries a citation. When the guidance does not cover a question, the assistant says so.

In the final project this service answers two kinds of questions:

- “Is this a reasonable way to eat?”
- “How long can I keep this in the fridge?”

## Context

People already ask chatbots what to eat and how to store food. General models answer from training data, so the reply can mix official guidance with folklore, outdated advice, or a personal recommendation the user never asked for. The claim is rarely tied to a specific document a person can open and check.

The real guidance already exists. National nutrition institutes, food safety regulators, and international health bodies publish long, careful documents on diet and food storage. Those documents are written prose, usually PDFs. There is no API. Almost nobody reads them.

That gap is what retrieval-augmented generation (RAG) is for. The assistant should search the published guidance, answer from the passages it finds, and show the reader exactly which document, publisher, year, and link each claim comes from.

Nutrient numbers for individual foods are a different kind of data and do not belong in this corpus.

## Problem

A chatbot for food, nutrition, and food safety that answers from model memory does not ground those answers in official dietary guidance. Without retrieval over the published documents:

- Answers can come from the model’s own knowledge rather than a published document.
- Claims ship without a citation the user can verify.
- Two authorities can be blended into one sentence about what “the guidelines say.”
- Questions outside the published guidance still get an answer.
- Population-level advice can be rewritten as a personal plan, including calorie targets, weight targets, or medical advice.

The user cannot tell which sentences are backed by a named authority and which are not.

## Goal

Build a prototype chatbot over a small corpus of official public dietary guidance. It answers questions about food, nutrition, and food safety. The assistant:

1. Retrieves relevant passages from that corpus.
2. Answers only from those passages.
3. Cites every claim with document name, publisher, year, and a link.
4. Keeps each document’s position separate when more than one document speaks to the question.
5. Refuses in two distinct ways: when the corpus does not cover the question, and when the question is out of scope by design.

Model knowledge is not a source. A claim without a citation does not ship.

## What to build

### 1. Corpus

The brief allows 3 to 5 public guidance documents from recognised authorities, one public URL per document. This project uses the four below. National nutrition institutes, food safety regulators, and international health bodies all qualify.

Constraints:

- Written prose only. A source with a clean API behind it does not belong here.
- Store publisher, year, source URL, and retrieval date with every document.

These four public URLs are the corpus. Record the retrieval date when each one is collected.


| Document                                     | Publisher                                                                                                                          | Year | Public URL                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dietary Guidelines for Indians               | ICMR–National Institute of Nutrition                                                                                               | 2024 | [https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf](https://nin.res.in/dietaryguidelines/pdfjs/locale/DGI_2024.pdf)                                                                                                                                         |
| The Eatwell Guide booklet                    | Public Health England (GOV.UK)                                                                                                     | 2018 | [https://assets.publishing.service.gov.uk/media/5ba8a50540f0b605084c9501/Eatwell_Guide_booklet_2018v4.pdf](https://assets.publishing.service.gov.uk/media/5ba8a50540f0b605084c9501/Eatwell_Guide_booklet_2018v4.pdf)                                                     |
| Cold Food Storage Chart                      | FoodSafety.gov (U.S. Department of Agriculture, U.S. Food and Drug Administration, and Centers for Disease Control and Prevention) | 2023 | [https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts](https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts)                                                                                                                         |
| How to chill, freeze and defrost food safely | Food Standards Agency (GOV.UK)                                                                                                     | 2017 | [https://www.gov.uk/government/publications/how-to-chill-freeze-and-defrost-food-safely/how-to-chill-freeze-and-defrost-food-safely](https://www.gov.uk/government/publications/how-to-chill-freeze-and-defrost-food-safely/how-to-chill-freeze-and-defrost-food-safely) |


The first two are population dietary guidance, including fats and cooking oils. The last two are food-safety guidance on how long food can be kept cold. A question such as cooking oil or leftover storage can therefore be answered per document, with separate citations.

### 2. Chunking

Split each document into chunks that retrieval can return as evidence.

Every chunk carries:

- document name
- publisher
- year
- section heading

These documents are full of tables and numbered recommendations. Fixed-size chunking will cut those units in half. Choose a chunking approach that keeps a recommendation, table, or headed section intact when that is what the answer depends on.

State in the README what was chosen and what it cost: what kinds of passages stay whole, and what still gets split.

### 3. Retrieval

Build a vector index over the chunks.

The index must support:

- retrieval across all documents
- retrieval filtered to one named document

State in the README:

- chunk size
- overlap
- embedding model
- index type
- k value (how many chunks are retrieved per query)

### 4. Answer layer

The assistant answers only from retrieved chunks. Model knowledge is not a source.

Every claim carries a citation showing:

- document name
- publisher
- year
- a link

No citation means the claim does not ship.

Population-level guidance stays population-level. The assistant does not turn a public recommendation into a personal plan for the person asking.

### 5. Cross-document questions

Some questions have two documents with something to say. Cooking oil is the example in the brief: a nutrition institute and a food safety regulator may both weigh in, on different grounds.

For those questions:

- Answer per document.
- Give each document its own citation.
- When two documents disagree, show both with their publishers and years.
- Do not pick a winner.
- Do not blend two sources into one claim about what “the guidelines say.”

### 6. Two kinds of refusal

Both refusals are required, and they are not the same response.

**Not in the corpus.** When the retrieved chunks do not hold the answer, the assistant says the guidance does not cover it and names what it searched. It does not fill the gap from model knowledge.

**Out of scope by design.** No medical advice, no calorie or weight targets, and nothing about what anyone should weigh. The assistant declines and points the person to a qualified professional. Enforce this in code, so the refusal does not depend on the model choosing to decline.

## Rules

These rules apply to every answer, including follow-up turns.


| Rule                              | What it means                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Retrieved text only               | Answers come from retrieved chunks. Model knowledge is not a source.                        |
| Citation or nothing               | Every claim carries a citation. A claim without one does not ship.                          |
| Stay population-level             | Public guidance is not rewritten as a personal recommendation.                              |
| No clinical or body-target advice | No calorie targets, no weight targets, and no medical advice, anywhere in the conversation. |
| Disagreement stays visible        | When two documents disagree, show both with publisher and year. Do not pick a winner.       |
| Corpus size                       | The four public URLs in the corpus section.                                                 |


## Out of scope

- Nutrient numbers for individual foods. They do not belong in this corpus.
- Any source that is already exposed through a clean API. This prototype is for written public guidance.
- Medical advice, diagnosis, calorie targets, weight targets, and personal “what you should weigh” answers.
- Choosing which authority is right when two documents disagree.

## Success criteria

The prototype is done when all of the following hold:

1. The corpus is the four public URLs listed above: prose guidance from recognised authorities, each stored with publisher, year, source URL, and retrieval date.
2. Chunks retain document name, publisher, year, and section heading, and the README explains the chunking choice and its cost.
3. A vector index can retrieve across the whole corpus and can retrieve from one named document.
4. The README states chunk size, overlap, embedding model, index type, and k.
5. Answers use only retrieved text, and every claim has a citation with document name, publisher, year, and a link.
6. A question that two documents address is answered per document, with separate citations, and a disagreement is shown rather than resolved.
7. A question the retrieved chunks do not cover produces a “not in the guidance” refusal that names what was searched.
8. A medical, calorie-target, or weight-target question is refused in code and redirected to a qualified professional.
9. Population-level guidance is not turned into a personal recommendation.

## Relationship to the rest of the project


| Piece           | Role                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| This prototype  | A chatbot for food, nutrition, and food safety. Answers come from official public guidance, with citations and the two refusals above.   |
| Final project   | This service answers whether a way of eating is consistent with published guidance, and how long a food can be kept in the fridge.        |


