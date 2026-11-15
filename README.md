# markdown-render-speed-02

A fast, dependency-free drop-in replacement for marked 18.1.3: `parse.js` exports
`parse(markdown)`, returning exactly the HTML marked renders with its default
options (GFM on, breaks off, pedantic off, async off), but faster. `main.ts`
is the harness driver: it reads every case from `/input/cases.json`, renders
each with `parse`, and writes `/output/html.json`.

Built for the make.fun competition "Make Markdown rendering faster" ($250 USDC).
