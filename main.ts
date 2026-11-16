// Driver for the markdown-render-speed-02 entry.
//
// It reads every case from the input directory, renders each one on its
// own with parse() from parse.js, and writes the HTML strings, in case
// order, to html.json in the output directory. The directories default to
// /input and /output and may be overridden with MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
