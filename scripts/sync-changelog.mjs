#!/usr/bin/env node
// Adds to CHANGELOG.md, in version order, the entry of each stable tag vX.Y.Z that its tagged commit's CHANGELOG.md has and this one lacks; prints the versions added.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const changelogPath = process.argv[2] ?? 'CHANGELOG.md';
const ENTRY_HEADER = /^## \[(\d+)\.(\d+)\.(\d+)\]/gm;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function entryHeaders(text) {
  return [...text.matchAll(ENTRY_HEADER)].map((match) => ({
    index: match.index,
    version: match.slice(1, 4).map(Number),
  }));
}

function entryOf(text, version) {
  const headers = entryHeaders(text);
  const position = headers.findIndex((header) => compareVersions(header.version, version) === 0);
  if (position === -1) return undefined;
  const end = headers[position + 1]?.index ?? text.length;
  return text.slice(headers[position].index, end).trimEnd();
}

function insertEntry(text, version, entry) {
  const firstOlder = entryHeaders(text).find((header) => compareVersions(header.version, version) < 0);
  if (firstOlder) return `${text.slice(0, firstOlder.index)}${entry}\n\n${text.slice(firstOlder.index)}`;
  return `${[text.trimEnd(), entry].filter(Boolean).join('\n\n')}\n`;
}

function changelogAtTag(tag) {
  try {
    return execFileSync('git', ['show', `${tag}:CHANGELOG.md`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

const releasedVersions = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n')
  .filter((tag) => STABLE_TAG.test(tag))
  .map((tag) => tag.slice(1).split('.').map(Number))
  .sort(compareVersions);

let changelog = readFileSync(changelogPath, 'utf8');
const added = [];
for (const version of releasedVersions) {
  if (entryOf(changelog, version) !== undefined) continue;
  const tag = `v${version.join('.')}`;
  const entry = entryOf(changelogAtTag(tag), version);
  if (entry === undefined) {
    console.error(`${tag}: its CHANGELOG.md has no entry for it`);
    continue;
  }
  changelog = insertEntry(changelog, version, entry);
  added.push(version.join('.'));
}

writeFileSync(changelogPath, changelog);
console.log(added.join(' '));
