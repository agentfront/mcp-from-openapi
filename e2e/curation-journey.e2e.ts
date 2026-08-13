/**
 * Curation story on the big GitHub fixture: measure the context bill,
 * patch the spec with an overlay (without forking it), trim aggressively,
 * and filter — asserting the budget actually shrinks and every schema stays
 * valid along the way.
 */
import { OpenAPIToolGenerator, analyzeToolSet, lintDocument } from '../src';
import type { OpenAPIDocument } from '../src';
import { loadJsonFixture } from './helpers/fixtures';
import { compileAll } from './helpers/ajv';

describe('story: curation journey over the GitHub fixture', () => {
  const document = () => loadJsonFixture<OpenAPIDocument>('github-trimmed-3.0.json');

  it('measures, patches, trims, and filters the tool set', async () => {
    // 1. Baseline: the raw context bill
    const baseline = await (await OpenAPIToolGenerator.fromJSON(document())).generateTools();
    const baselineTokens = analyzeToolSet(baseline).estimatedTokens;
    expect(baseline).toHaveLength(78);
    expect(baselineTokens).toBeGreaterThan(500_000); // ~600k measured — a real phone book

    // 2. Overlay: fix a lint finding without forking the spec
    const rawLint = lintDocument(document());
    const vague = rawLint.findings.filter((finding) => finding.code === 'vague-description');
    expect(vague.length).toBeGreaterThan(0);
    // finding.path is "METHOD /path" — validate the parse and pin the exact
    // operation so a fixture regeneration fails loudly here, not downstream
    const parsed = vague[0].path?.match(/^([A-Z]+) (\/\S+)$/);
    expect(parsed).not.toBeNull();
    const [, method, opPath] = parsed!;
    expect(method).toBe('DELETE');
    expect(opPath).toBe('/gists/{gist_id}');

    const generator = await OpenAPIToolGenerator.fromJSON(document(), {
      overlays: {
        overlay: '1.0.0',
        info: { title: 'Expand a vague description', version: '1.0.0' },
        actions: [
          {
            target: `$.paths['${opPath}'].${method.toLowerCase()}`,
            update: {
              description:
                'Curated via overlay: deletes the referenced gist permanently for the authenticated user; requires the gist id path parameter and returns 204 on success.',
            },
          },
        ],
      },
    });
    const patchedLint = await generator.lint();
    expect(patchedLint.findings.filter((finding) => finding.code === 'vague-description')).toHaveLength(
      vague.length - 1,
    );

    // 3. Trimming: the budget shrinks by more than half, schemas stay valid
    const trimmed = await generator.generateTools({
      stripExamples: true,
      maxDescriptionLength: 200,
      maxProperties: 40,
      maxSchemaDepth: 4,
    });
    const trimmedTokens = analyzeToolSet(trimmed).estimatedTokens;
    expect(trimmedTokens).toBeLessThan(0.5 * baselineTokens);
    expect(
      compileAll(
        trimmed.flatMap((tool) => [
          { label: `${tool.name} input`, schema: tool.inputSchema },
          ...(tool.outputSchema ? [{ label: `${tool.name} output`, schema: tool.outputSchema }] : []),
        ]),
      ),
    ).toEqual([]);

    // 4. Filtering: a curated slice instead of the phone book
    const gistsOnly = await generator.generateTools({ includeTags: ['gists'] });
    expect(gistsOnly).toHaveLength(20);
    expect(analyzeToolSet(gistsOnly).estimatedTokens).toBeLessThan(baselineTokens / 3);
  });
});
