/**
 * Real-world documents, imported as JSON modules (so TypeScript infers their
 * type from the data, as it does for a consumer's own `import spec from
 * './openapi.json'`), must be assignable to the OpenAPI types. Compiled by
 * `yarn typecheck`, never executed (see README.md).
 */
import type { OAS30, OAS31, OpenAPIDocument } from 'mcp-from-openapi';
import discord from '../fixtures/discord-trimmed-3.1.json';
import github from '../fixtures/github-trimmed-3.0.json';

/** The GitHub REST API description, trimmed: an OpenAPI 3.0 document. */
export const githubAs30: OAS30.OpenAPIObject = github;
export const githubAsDocument: OpenAPIDocument = github;

/** The Discord API description, trimmed: an OpenAPI 3.1 document. */
export const discordAs31: OAS31.OpenAPIObject = discord;
export const discordAsDocument: OpenAPIDocument = discord;

// @ts-expect-error control: an import is typed from its data, so a shape the document lacks is still rejected
export const notADocument: { openapi: number } = github;
