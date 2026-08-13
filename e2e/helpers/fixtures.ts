/** Fixture loading for the e2e story suite. */
import { readFileSync } from 'fs';
import { join } from 'path';

export const fixturePath = (name: string): string => join(__dirname, '..', 'fixtures', name);

export const loadFixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');

export const loadJsonFixture = <T = unknown>(name: string): T => JSON.parse(loadFixture(name)) as T;
