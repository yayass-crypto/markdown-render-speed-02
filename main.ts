// Driver for the markdown-render-speed-02 entry: it loads every case from
// the input directory, renders each one on its own with parse() from
// parse.js, and writes the HTML strings, in case order, to html.json in
// the output directory. The directories default to /input and /output and
// may be overridden with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);
const rendered = new Array(cases.length);
for (let n = 0; n < cases.length; n++) {
  rendered[n] = parse(cases[n].markdown);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
