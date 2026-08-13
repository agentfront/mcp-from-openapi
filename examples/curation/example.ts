/**
 * Curation: turning a phone book into a menu.
 *
 * Auto-converting a whole API degrades tool-calling accuracy past ~30-40
 * tools. This example measures the context bill, patches the spec with an
 * OpenAPI Overlay (no fork needed), trims schemas, lints for agent
 * readiness, and filters down to a curated slice.
 */
import { OpenAPIToolGenerator, analyzeToolSet, lintDocument } from 'mcp-from-openapi';
import type { GenerateOptions, LintResult, McpOpenAPITool, OpenAPIDocument, OverlayDocument, ToolSetReport } from 'mcp-from-openapi';

export interface CurationReport {
  baseline: ToolSetReport;
  lint: LintResult;
  curated: McpOpenAPITool[];
  curatedReport: ToolSetReport;
}

const TRIMMING: GenerateOptions = {
  stripExamples: true, // examples are the heaviest schema freight
  maxDescriptionLength: 200, // cap prose, keep the lead sentence
  maxProperties: 40, // drop pathological property lists (root inputs exempt)
  maxSchemaDepth: 4, // deep response trees collapse with a note
};

/**
 * Measure everything, then produce a curated tool set: overlay-patched,
 * trimmed, and filtered to the given tags.
 */
export async function curate(
  spec: OpenAPIDocument,
  options: { tags: string[]; overlays?: OverlayDocument },
): Promise<CurationReport> {
  // Baseline: what would shipping everything cost?
  const everything = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTools();
  const baseline = analyzeToolSet(everything); // warns past 40 tools / 10K per tool

  // Lint the RAW spec: vague descriptions, unpaginated lists, missing params
  const lint = lintDocument(spec);

  // Overlays apply at load time, before validation — regeneration-safe spec
  // patches instead of a forked document
  const generator = await OpenAPIToolGenerator.fromJSON(spec, {
    ...(options.overlays && { overlays: options.overlays }),
  });
  const curated = await generator.generateTools({ ...TRIMMING, includeTags: options.tags });

  return { baseline, lint, curated, curatedReport: analyzeToolSet(curated) };
}
