// main.ts — driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts`: read every case from
// /input/cases.json, render each case's markdown with parse() from
// ./parse.js, and write the resulting HTML strings, in order, as a JSON
// array to /output/html.json. Outside the sandbox the MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR environment variables stand in for /input and /output,
// which is how the local practice runs below use it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];

const rendered = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
