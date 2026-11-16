# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/madara200599/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/madara200599/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Entry for the make.fun bounty [Make Markdown rendering faster](https://make.fun/bounty/markdown-render-speed-02).

A dependency-free Markdown-to-HTML parser in a single JavaScript module
(`parse.js`) whose `parse(markdown)` returns, byte for byte, the HTML that
**marked 18.1.3** renders with its default options (GFM on, breaks off,
pedantic off) — only faster. Written from scratch for the make.fun
`markdown-render-speed-02` competition: every case in the set must match
marked's output exactly before speed counts at all, and prizes require
beating marked itself on CPU time.

`main.ts` is the harness driver: it reads `/input/cases.json`
(`[{id, markdown}]`, or `$MAKEFUN_INPUT_DIR/cases.json` outside the
sandbox), renders each case with `parse()`, and writes the HTML strings,
in order, as a JSON array to `/output/html.json`.

## Design

Two phases, mirroring how marked itself is structured, but implemented
with hand-written scanners instead of a regex-per-token lexer:

**Block phase** (`lexBlocks` and friends) turns the source into block
tokens: ATX/setext headings, paragraphs, fenced and indented code,
blockquotes, lists (with marked's exact item-content slicing, lazy
continuations and looseness rules), tables, HTML blocks, link reference
definitions and thematic breaks. A first-character dispatch routes each
line start to the one or two token kinds it can actually be, so plain
paragraph lines don't pay for a chain of failed probes. Containers
(blockquotes, list items) are dedented into sub-documents that are lexed
recursively against the same definition table, exactly like marked.

**Inline phase** (`renderInline`) scans a block's text once into a node
list — text runs, code spans, raw HTML, autolinks, delimiter runs for
`*`/`_`, `~~` spans and bracket openers. Links form at each `]` using
marked's rules (nearest opener, link-in-link rejection via an emission
counter, reference resolution, destination/title grammar). Emphasis is
resolved by a faithful port of marked's `emStrong` algorithm, including
its masked-source lookahead: a mask of the text is built the same way
marked builds it (code spans, escapes, resolved reflinks and tags
blanked out), and closer matching, the rule of three and the
intraword-underscore gates all read from the mask.

Output conventions are marked's own: its escaping split
(`escapeNoEncode` for text — `&` is only escaped when it doesn't start
an entity — vs full escaping for code), numeric character reference
decoding in text, `encodeURI`-based URL cleaning, and its exact
heading/list/table/code HTML shapes, attribute order included.

## Speed

The parser is built to win cold, single-pass executions (the heat runs
each entry fresh):

- plain-text runs are located with one native regex scan for the next
  construct candidate instead of per-character JS loops, with each
  candidate verified in JS;
- inline texts with no constructs at all take a fast path straight to
  escaping;
- the emphasis mask is only built when a delimiter run exists, and its
  expensive passes are skipped when the text has no backticks,
  backslashes, brackets or tags for them to act on;
- emphasis bounds are computed by a native run-finding regex;
- hot character-class tests are char-code arithmetic, not set lookups
  or regexes.

Verified locally against the kit's practice set: **720/720 cases
byte-identical** to marked (all CommonMark 0.31.2 and GFM 0.29 spec
examples plus 40 generated READMEs), and a cold single pass over the
set takes ~1.1× less CPU than the vendored marked baseline on the
same machine.

## Files

- `parse.js` — the parser (the entry; no dependencies, Node builtins
  only, no build step).
- `main.ts` — the harness driver described above.
- `package.json` — `{"type": "module"}` so Node treats the files as
  ES modules.

Entered via referral code tvfbjxfd
