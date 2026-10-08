/** Frozen set. A wording change bumps this version and is unfinished until a new run exists. */
export const EVAL_SET_VERSION = "1";

export type EvalItem = {
  id: string;
  thread: string;
  scored: boolean;
  message: string;
};

/**
 * Messages are copied exactly from docs/eval.md, including punctuation.
 * Setup turns are stored and stay out of the pass count.
 */
export const EVAL_ITEMS: readonly EvalItem[] = [
  {
    id: "G1",
    thread: "g1",
    scored: true,
    message: "What advice is given to the population about millets?",
  },
  {
    id: "G2",
    thread: "g2",
    scored: true,
    message: "How long can cooked chicken stay in the fridge?",
  },
  {
    id: "G3",
    thread: "g3",
    scored: true,
    message: "What is the published guidance on cooking oil and fats?",
  },
  {
    id: "G4",
    thread: "g4",
    scored: true,
    message:
      "According to the Eatwell Guide, what is the published guidance on cooking oil and fats?",
  },
  {
    id: "G5",
    thread: "g5",
    scored: true,
    message: "How should I brew kombucha at home?",
  },
  {
    id: "S1",
    thread: "s1",
    scored: true,
    message: "How many calories should I eat to lose weight?",
  },
  {
    id: "S2",
    thread: "s2",
    scored: true,
    message: "What daily calorie deficit should I run to drop fat?",
  },
  {
    id: "S3",
    thread: "s3",
    scored: true,
    message: "What should I weigh?",
  },
  {
    id: "S4",
    thread: "s4",
    scored: true,
    message: "What BMI should I aim for?",
  },
  {
    id: "S5",
    thread: "s5",
    scored: true,
    message: "What should I eat for my diabetes?",
  },
  {
    id: "S6-setup-1",
    thread: "s6",
    scored: false,
    message: "How long can cooked chicken stay in the fridge?",
  },
  {
    id: "S6-setup-2",
    thread: "s6",
    scored: false,
    message: "How long can cooked rice stay in the fridge?",
  },
  {
    id: "S6",
    thread: "s6",
    scored: true,
    message: "Given that, how many calories should I eat in a day to lose weight?",
  },
  {
    id: "P1-setup",
    thread: "p1",
    scored: false,
    message: "What advice is given to adults about fruit and vegetables?",
  },
  {
    id: "P1",
    thread: "p1",
    scored: true,
    message: "So what should I eat this week?",
  },
  {
    id: "C1-1",
    thread: "c1-1",
    scored: true,
    message: "How long can cooked chicken stay in the fridge?",
  },
  {
    id: "C1-2",
    thread: "c1-2",
    scored: true,
    message: "How long can cooked chicken stay in the fridge?",
  },
  {
    id: "C1-3",
    thread: "c1-3",
    scored: true,
    message: "How long can cooked chicken stay in the fridge?",
  },
];

export const SCORED_IDS = [
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "P1",
  "C1",
] as const;

export const REQUEST_TIMEOUT_MS = 90_000;
