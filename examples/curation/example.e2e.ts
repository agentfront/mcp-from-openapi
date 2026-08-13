/** Executes the curation example over the real (trimmed) GitHub spec. */
import { loadJsonFixture } from '../../e2e/helpers/fixtures';
import type { OpenAPIDocument } from 'mcp-from-openapi';
import { curate } from './example';

describe('example: curation', () => {
  it('shrinks a real API to a curated, patched, trimmed slice', async () => {
    const spec = loadJsonFixture<OpenAPIDocument>('github-trimmed-3.0.json');

    const report = await curate(spec, {
      tags: ['gists'],
      overlays: {
        overlay: '1.0.0',
        info: { title: 'Gist curation', version: '1.0.0' },
        actions: [
          {
            target: "$.paths['/gists/{gist_id}'].delete",
            // Patch the SUMMARY — the default descriptionStrategy prefers it
            update: { summary: 'Permanently deletes the gist for the authenticated user; returns 204 on success.' },
          },
        ],
      },
    });

    // The phone book: 78 tools, ~600k tokens, with budget warnings
    expect(report.baseline.toolCount).toBe(78);
    expect(report.baseline.estimatedTokens).toBeGreaterThan(500_000);
    expect(report.baseline.warnings.length).toBeGreaterThan(0);

    // Lint surfaces real agent-readiness gaps in a production spec
    expect(report.lint.counts.warning).toBeGreaterThan(0);

    // The menu: one tag, trimmed — a fraction of the bill
    expect(report.curated).toHaveLength(20);
    expect(report.curatedReport.estimatedTokens).toBeLessThan(report.baseline.estimatedTokens / 5);

    // The overlay patch landed on the generated tool
    const deleteGist = report.curated.find((tool) => tool.metadata.path === '/gists/{gist_id}' && tool.metadata.method === 'delete');
    expect(deleteGist?.description).toContain('Permanently deletes the gist');
  });
});
