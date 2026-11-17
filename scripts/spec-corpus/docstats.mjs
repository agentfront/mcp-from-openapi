// usage: node docstats.mjs <specFile> <outJson> [<root>]  - statically counts the operations of a spec (data only).
// <root> is the folder (multi-file spec) or the file (single-file spec) its `$ref`s may read; default: the spec's folder.
import fs from 'node:fs';
import { analyzeFile } from './stats.mjs';
const [file, out, root] = process.argv.slice(2);
try { fs.writeFileSync(out, JSON.stringify(analyzeFile(file, root ? { root } : {}))); } catch (e) { fs.writeFileSync(out, JSON.stringify({ error: String(e.message).slice(0, 300) })); }
