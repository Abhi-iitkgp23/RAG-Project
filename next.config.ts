import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers", "onnxruntime-node"],
  // `next dev` otherwise writes AGENTS.md on startup.
  agentRules: false,
};

export default nextConfig;
