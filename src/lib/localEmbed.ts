import { join } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { dataDirectory } from "./store";

const loaded = new Map<string, Promise<FeatureExtractionPipeline>>();

function extractor(modelId: string): Promise<FeatureExtractionPipeline> {
  env.cacheDir = join(dataDirectory(), "models");
  let pending = loaded.get(modelId);
  if (!pending) {
    pending = pipeline("feature-extraction", modelId);
    loaded.set(modelId, pending);
  }
  return pending;
}

function asRows(value: unknown, count: number): number[][] {
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error(`local embedding returned ${Array.isArray(value) ? value.length : "no"} rows; expected ${count}`);
  }
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.some((item) => typeof item !== "number")) {
      throw new Error(`local embedding row ${index} is not a number vector`);
    }
    return row as number[];
  });
}

/** Mean-pooled, normalized vectors for one already-sized batch. */
export async function embedWithLocalModel(
  modelId: string,
  texts: readonly string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extract = await extractor(modelId);
  const output = await extract([...texts], { pooling: "mean", normalize: true });
  return asRows(output.tolist(), texts.length);
}
