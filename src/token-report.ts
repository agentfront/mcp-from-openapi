import type { McpOpenAPITool } from './types';

/**
 * Per-tool token estimate for the definition a client ships to the model.
 */
export interface ToolTokenEstimate {
  name: string;
  /** Estimated tokens for the full advertised definition */
  tokens: number;
}

/**
 * Context-budget report for a generated tool set.
 */
export interface ToolSetReport {
  toolCount: number;
  /** Sum of all per-tool estimates */
  estimatedTokens: number;
  /** Every tool, heaviest first */
  perTool: ToolTokenEstimate[];
  /** Human-readable budget warnings (empty when the set is comfortably sized) */
  warnings: string[];
}

/**
 * Thresholds for {@link analyzeToolSet} warnings.
 */
export interface AnalyzeToolSetOptions {
  /**
   * Estimated-token budget for the whole tool set before a warning fires.
   * ~1,000 tokens per tool is typical; ecosystem guidance flags pain beyond
   * ~10K tokens of definitions.
   * @default 10000
   */
  tokenBudget?: number;

  /**
   * Tool count beyond which model selection accuracy measurably degrades
   * (public evaluations put the cliff at ~30-40 tools).
   * @default 40
   */
  maxRecommendedTools?: number;

  /**
   * Per-tool estimate that marks a single tool as disproportionately heavy.
   * @default 2000
   */
  perToolWarning?: number;
}

/**
 * Estimate the context-window cost of ONE tool definition — the fields a
 * client advertises to the model (name, title, description, annotations,
 * input/output schemas), serialized as JSON.
 *
 * The estimate is `ceil(chars / 4)` — the common BPE average for JSON-heavy
 * English text. It is a sizing signal for curation decisions, not a
 * tokenizer: real counts vary by model within roughly ±20%.
 */
export function estimateToolTokens(tool: McpOpenAPITool): number {
  const advertised = {
    name: tool.name,
    ...(tool.title !== undefined && { title: tool.title }),
    description: tool.description,
    ...(tool.annotations !== undefined && { annotations: tool.annotations }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
  };
  return Math.ceil(JSON.stringify(advertised).length / 4);
}

/**
 * Analyze a generated tool set's context-window bill: per-tool estimates
 * (heaviest first), the total, and curation warnings when the set crosses
 * the thresholds where agent accuracy is known to degrade.
 *
 * ```ts
 * const report = analyzeToolSet(await generator.generateTools());
 * report.warnings.forEach((w) => console.warn(w));
 * ```
 */
export function analyzeToolSet(tools: McpOpenAPITool[], options: AnalyzeToolSetOptions = {}): ToolSetReport {
  const tokenBudget = options.tokenBudget ?? 10000;
  const maxRecommendedTools = options.maxRecommendedTools ?? 40;
  const perToolWarning = options.perToolWarning ?? 2000;

  const perTool = tools
    .map((tool) => ({ name: tool.name, tokens: estimateToolTokens(tool) }))
    .sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1));

  const estimatedTokens = perTool.reduce((sum, entry) => sum + entry.tokens, 0);
  const warnings: string[] = [];

  if (tools.length > maxRecommendedTools) {
    warnings.push(
      `${tools.length} tools exceeds the ~${maxRecommendedTools}-tool range where model selection accuracy degrades — curate with filters (tags, paths, readOnlyOnly) or split into focused servers.`,
    );
  }

  if (estimatedTokens > tokenBudget) {
    warnings.push(
      `Estimated ${estimatedTokens} tokens of tool definitions exceeds the ${tokenBudget}-token budget — trim schemas (maxSchemaDepth, maxProperties) or reduce the tool count.`,
    );
  }

  const heavy = perTool.filter((entry) => entry.tokens > perToolWarning);
  if (heavy.length > 0) {
    warnings.push(
      `${heavy.length} tool(s) exceed ${perToolWarning} tokens each (${heavy
        .slice(0, 3)
        .map((entry) => `${entry.name}: ~${entry.tokens}`)
        .join(', ')}${heavy.length > 3 ? ', …' : ''}) — consider schema trimming for these.`,
    );
  }

  return { toolCount: tools.length, estimatedTokens, perTool, warnings };
}
