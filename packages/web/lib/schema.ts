import { z } from "zod";

const RedactionRuleSchema = z.object({
  id: z.string().min(1, "Rule id is required"),
  pattern: z.string().min(1, "Pattern is required"),
  replacement: z.string().min(1, "Replacement is required"),
  context: z.array(z.string()).optional(),
  contextWindow: z.number().min(1).optional(),
});

const AllowlistSchema = z.object({
  strings: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
});

const PathsSchema = z.object({
  only: z.array(z.string()).optional(),
  skip: z.array(z.string()).optional(),
});

const DetectorSchema = z.object({
  mode: z.enum(["rules", "llm", "hybrid", "auto"]).optional(),
  llmModel: z.enum(["gliner-small", "gliner-base", "distilbert-pii", "phi3-mini"]).optional(),
  modelPath: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  llmThreshold: z.number().min(0).max(1).optional(),
  llmLabels: z.array(z.string()).optional(),
});

export const policySchema = z.object({
  extends: z.enum(["secrets", "pii", "strict"]),
  rules: z.array(RedactionRuleSchema).optional(),
  allowlist: AllowlistSchema.optional(),
  paths: PathsSchema.optional(),
  detector: DetectorSchema.optional(),
});

export type PolicySchema = z.infer<typeof policySchema>;