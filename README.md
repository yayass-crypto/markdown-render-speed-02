# markdown-render-speed-02

A fast, dependency-free, drop-in replacement for marked 18.1.3. `parse.js`
exports a single function, `parse(markdown)`, which returns exactly the HTML
that marked renders with its default options (GFM on, breaks off, pedantic
off, async off) — but faster. `main.ts` is the harness driver: it reads every
case from `/input/cases.json`, renders each one with `parse`, and writes the
HTML strings, in case order, to `/output/html.json`.

Built for the make.fun competition "Make Markdown rendering faster"
($250 USDC). The scorer requires byte-identical output on 720 cases, so
correctness is the whole game; speed is what wins once the output matches.

## Layout

- `parse.js` — the entire parser, written from scratch (no dependencies, no
  copied code from any other renderer). One module, about 2,500 lines.
- `main.ts` — the driver described above. It sets `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` to override the default `/input` and `/output`.
- `package.json` — `{"type": "module"}` and nothing else; the entry needs no
  install step and no build step.

## How the parser works

### Block level

`parse` splits the input into lines once and walks them with a small set of
matchers. Each block type is recognised by its own predicate, in the order a
reader would expect: fenced code, ATX headings, thematic breaks, blockquotes,
lists, HTML blocks, link definitions, tables, setext headings, paragraphs,
and indented code. A paragraph is gathered line by line until a blank line or
a line that interrupts it; link definitions are stripped out of the gathered
lines and recorded in a per-document reference table before any inline
rendering happens.

Lists are handled recursively: an item's lines are dedented and re-parsed as
a fresh block stream, which is what makes nested lists, blockquotes inside
list items, and loose versus tight list spacing come out right. A list item
that contains a blank line followed by more content is "loose" and its
paragraphs are wrapped in `<p>` tags; without the blank line it is "tight"
and the paragraphs stay bare.

Tables are recognised from a paragraph's first two lines: a header line
followed by a delimiter line whose cells are made of hyphens with optional
colons. The delimiter must contain a colon or a pipe (a bare run of hyphens
is a setext underline, not a table). Once a table has started, every
following line is a row until a blank line or a line that starts another
block — including a line that is only a tab, which becomes a row of empty
cells, and a line of `=` signs, which is a row rather than a setext heading.

### Inline level

`parseInline` walks one leaf block's text once, left to right, and builds a
flat list of items: plain text strings, HTML tokens (links, images, code
spans, raw tags, hard breaks), and delimiter runs (`*`, `_`, `~`). Backslash
escapes, code spans (matched by equal-length backtick runs), autolinks
(`<...>`), extended autolinks (bare `www.` / `http(s)://` / `ftp://` URLs and
email addresses), and links/images (inline and reference, with nested
brackets and code spans in labels) are all consumed as tokens as the walk
passes them, so the delimiter characters inside them never become emphasis
candidates.

Emphasis and strikethrough are resolved afterwards, opener-driven, over the
item list. For each opener run the resolver scans forward for a closer,
keeping a running balance: runs that cannot close inflate the balance, runs
that can close spend it, and the "rule of three" skips a candidate when the
opener and closer lengths would combine to a multiple of three. An emphasis
match takes one delimiter per side, a strong match two, and the rest of the
two runs stays inside the interior, which is re-parsed from scratch — so
nested emphasis resolves inside-out, exactly as a reader would nest it.

The closer scan reads its candidates from a *masked* copy of the source,
not from the token list. In that copy, code-span contents, link spans and
HTML tags are replaced by filler, so a delimiter run hidden inside one of
them is invisible to the scan. The masking is a single left-to-right pass:
a backtick run pairs with the next run of the same length, even across a
link label, which means a code span with mismatched runs inside a link label
leaves the link unmasked and its backticks free to pair with a later run and
swallow whatever lies between them. That one behaviour is responsible for a
surprising number of otherwise inexplicable literal `*` and `_` runs.

Two more scan details matter. First, the scan has a bound: the last
delimiter run of the same character whose preceding character is not
whitespace. A closer past that bound is never reached, so an opener with no
closer in range stays literal. Second, the scan's opening alternative
swallows a lone `*` sitting between two `__` runs (or a lone `_` between
two `**` runs) right after the opener, so that run is never a candidate.

Extended autolinks get a backpedal pass: after the URL is matched, trailing
punctuation is trimmed by repeatedly applying a small rule — plain runs,
balanced `(...)` groups and lone `&` characters are kept, a punctuation run
is kept only when more text follows it — until the URL stops shrinking.
That is what turns `https://example.com/foo..)` into a link to
`https://example.com/foo` with `..)` left as text, while leaving a `]` or a
`)` that is followed by more text inside the URL.

### What is deliberately not cached

`parse` keeps nothing between calls. Every call builds its own reference
table, its own item list and its own masked copy, and the interior of an
emphasis match is re-parsed by a fresh `parseInline` call. There is no
memoisation, no cross-call state, and no lookup of any kind by case text or
content hash: the output is always computed from the markdown given.

## Speed

The parser is written to be fast in the ordinary sense, not with tricks:

- One line split per document, one left-to-right walk per leaf block, and
  no regular expression with catastrophic backtracking anywhere in the hot
  path. The inline walk is a hand-written character loop, not a cascade of
  regex `exec` calls.
- No intermediate token tree for blocks: a paragraph is a list of lines, a
  table is a header plus rows, and rendering writes straight into a string.
- Emphasis resolution is linear in the number of delimiter runs: each
  opener scans forward once, and the masked copy that bounds the scan is
  built in a single pass.
- Everything is plain JavaScript with no dependencies, so there is no
  startup cost beyond loading one module.

On the practice set the entry parses in roughly 600 ms where marked takes
roughly 720 ms, and the whole grading driver runs in about 1.7 s against
marked's 1.9 s — a little over 1.1x end to end, with byte-identical output
on the cases it passes.

## Running it

```sh
node --check parse.js
```

Grade locally against the practice kit (the kit directory holds the scorer;
the entry directory is passed with `--bot`):

```sh
cd <kit dir>
node cli/makefun.mjs grade-local --kit . \
  --bot /path/to/markdown-render-speed-02-entry --driver process
```

Or render a single document from Node:

```js
import { parse } from './parse.js';
console.log(parse('# Hello\n\nSome *emphasised* text.\n'));
```

## Status

The entry passes 707 of the 720 practice cases. The remaining failures are
concentrated in a few areas: reference-link resolution in very long
documents with duplicate definitions, fenced code blocks indented inside
list items, a handful of autolink edge cases inside list items, the
whitespace-only line at the end of a blockquote, and HTML blocks that need
their trailing newline preserved. None of them involves a transaction, a
network call, or any state beyond the markdown given.
