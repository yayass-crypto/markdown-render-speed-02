# SwiftMark — a fast drop-in for marked

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/yayass-crypto/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/yayass-crypto/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free JavaScript module whose `parse(markdown)` returns exactly
the HTML that [marked 18.1.3](https://github.com/markedjs/marked) renders
with its default options (GFM on, breaks off, pedantic off, async off) — and
renders it faster than marked itself. It is the entry for
[make.fun's "Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02)
($250 prize, 20 places).

## How it works

`parse.js` is a from-scratch CommonMark + GFM parser written for speed:

- A single fused scan pass collects delimiter runs, code spans and link
  brackets, so the inline layer rarely re-scans text.
- Emphasis is resolved opener-first with a lazy mask, so plain paragraphs
  pay almost nothing for delimiter handling.
- ASCII lookup tables and hoisted regular expressions keep the hot paths
  free of allocations.
- No dependencies, no build step: `parse.js` is a plain ES module.

It matches marked byte for byte on the whole practice set (680 CommonMark
and GFM spec examples plus 40 generated documents), including marked's
departures from the spec — where marked and the spec disagree, marked's
output is the target.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json`), renders each one with `parse`, and writes
the HTML strings in order to `/output/html.json` (or
`$MAKEFUN_OUTPUT_DIR/html.json`).

## Files

- `parse.js` — the parser; `parse(markdown)` returns the HTML string.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`, Node 22).
- `package.json` — module metadata (ES module, MIT).
- `LICENSE` — MIT.

## License

MIT. See [LICENSE](LICENSE).
