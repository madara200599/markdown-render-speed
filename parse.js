// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML that marked 18.1.3 renders with default options (GFM on).
//
// Written from scratch as a two-phase scanner: a block phase that walks the
// source chunk by chunk (fences, headings, quotes, lists, tables, ...) and an
// inline phase (delimiter-stack emphasis, bracket matching for links) that
// renders each block's text. No dependencies, no regular-expression monsters:
// the hot paths are index-based scans over the source string.

// ---------------------------------------------------------------------------
// Character classes and small helpers
// ---------------------------------------------------------------------------

const CC = {
  tab: 9, lf: 10, cr: 13, space: 32, bang: 33, quote: 34, hash: 35, amp: 38,
  apos: 39, lparen: 40, rparen: 41, star: 42, plus: 43, comma: 44, dash: 45,
  dot: 46, slash: 47, colon: 58, semi: 59, lt: 60, eq: 61, gt: 62, quest: 63,
  at: 64, lbrack: 91, backslash: 92, rbrack: 93, caret: 94, under: 95,
  backtick: 96, lbrace: 123, pipe: 124, rbrace: 125, tilde: 126,
};

function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isHex(c) { return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
// ASCII punctuation (for backslash escapes and flanking rules)
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode whitespace test on a code point (used by flanking rules)
function isUnicodeSpace(cp) {
  return cp === 32 || cp === 9 || cp === 10 || cp === 11 || cp === 12 || cp === 13 ||
    cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 ||
    cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff;
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(cp) {
  if (cp < 128) return isPunct(cp);
  return PUNCT_RE.test(String.fromCodePoint(cp));
}

// ---------------------------------------------------------------------------
// HTML escaping — marked's two flavours.
// escapeHtml(s, true):  & < > " ' all become entities.
// escapeHtml(s, false): the "no encode" flavour — & is only escaped when it
// does not begin something that looks like an entity reference (&#123;,
// &#x1F; or &name;), the rest are always escaped.
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE_TEST_RE = /[&<>"']/;
function escapeFull(s) {
  if (!ESCAPE_TEST_RE.test(s)) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ESCAPES[s[i]];
    if (e !== undefined) { out += s.slice(last, i) + e; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Does an entity reference start at s[i] === '&'? Mirrors marked's lookahead:
// &# + 1-7 digits + ';' | &#x/X + 1-6 hex + ';' | & + \w+ + ';'
function entityAt(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      let n = 0;
      while (j < s.length && isHex(s.charCodeAt(j)) && n < 7) { j++; n++; }
      return n >= 1 && n <= 6 && s[j] === ';';
    }
    let n = 0;
    while (j < s.length && isDigit(s.charCodeAt(j)) && n < 8) { j++; n++; }
    return n >= 1 && n <= 7 && s[j] === ';';
  }
  let n = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 95) { j++; n++; } else break;
  }
  return n >= 1 && s[j] === ';';
}

function escapeNoEncode(s) {
  if (!ESCAPE_TEST_RE.test(s)) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (!entityAt(s, i)) { out += s.slice(last, i) + '&amp;'; last = i + 1; }
    } else if (c === 60) { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === 62) { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === 34) { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === 39) { out += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---------------------------------------------------------------------------
// Text entity handling — marked decodes numeric character references inside
// text runs (and only those): &#123; / &#x1F; become the code point, with 0,
// surrogates and values above U+10FFFF becoming U+FFFD, and &#38; becoming
// the literal text "&amp;". A bare & that does not start an entity becomes
// "&amp;". Named references are left untouched. The result is later escaped
// with escapeNoEncode, which leaves all of the above intact.
// ---------------------------------------------------------------------------

function decodeTextEntities(s) {
  if (!s.includes('&#')) {
    // fast path: still need bare-& handling? No — escapeNoEncode does that.
    return s;
  }
  let out = '', i = 0, last = 0;
  const len = s.length;
  while (i < len) {
    if (s.charCodeAt(i) !== CC.amp) { i++; continue; }
    // numeric reference?
    if (s.charCodeAt(i + 1) === 35) { // '#'
      let j = i + 2, cp = -1;
      if (s[j] === 'x' || s[j] === 'X') {
        j++;
        let n = 0, v = 0;
        while (j < len && isHex(s.charCodeAt(j)) && n < 6) { v = v * 16 + parseInt(s[j], 16); j++; n++; }
        if (n >= 1 && s[j] === ';') cp = v;
        else j = -1;
      } else {
        let n = 0, v = 0;
        while (j < len && isDigit(s.charCodeAt(j)) && n < 7) { v = v * 10 + (s.charCodeAt(j) - 48); j++; n++; }
        if (n >= 1 && s[j] === ';') cp = v;
        else j = -1;
      }
      if (cp >= 0) {
        out += s.slice(last, i);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) out += '\uFFFD';
        else if (cp === 38) out += '&amp;';
        else out += String.fromCodePoint(cp);
        i = j + 1; last = i;
        continue;
      }
    }
    // bare & not starting an entity -> &amp; ; entity-looking & -> leave
    if (!entityAt(s, i)) {
      out += s.slice(last, i) + '&amp;';
      i++; last = i;
      continue;
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---------------------------------------------------------------------------
// Line utilities. Lines are handled by index: lineEnd finds the index of the
// next '\n' (or src.length); a "line" includes no newline unless stated.
// indentOf measures the indentation of a line start in columns, expanding
// tabs to the next multiple of 4. skipCols consumes `cols` columns of
// indentation from a line start and returns the new index.
// ---------------------------------------------------------------------------

function lineEnd(src, pos) {
  const i = src.indexOf('\n', pos);
  return i === -1 ? src.length : i;
}

function indentOf(src, pos, end) {
  let col = 0;
  while (pos < end) {
    const c = src.charCodeAt(pos);
    if (c === CC.space) { col++; pos++; }
    else if (c === CC.tab) { col += 4 - (col % 4); pos++; }
    else break;
  }
  return col;
}

// Consume up to `cols` columns of leading whitespace starting at pos.
function skipCols(src, pos, end, cols) {
  let col = 0;
  while (pos < end && col < cols) {
    const c = src.charCodeAt(pos);
    if (c === CC.space) { col++; pos++; }
    else if (c === CC.tab) {
      const w = 4 - (col % 4);
      if (col + w > cols) {
        // partial tab: the remainder is spaces in the content; represent by
        // returning a position plus leftover spaces count via an object.
        return { pos: pos + 1, extra: col + w - cols };
      }
      col += w; pos++;
    } else break;
  }
  return { pos, extra: 0 };
}

function isBlankLine(src, pos, end) {
  while (pos < end) {
    const c = src.charCodeAt(pos);
    if (c !== CC.space && c !== CC.tab) return false;
    pos++;
  }
  return true;
}

// Trim trailing spaces/tabs of a line range, return new end.
function rtrimLine(src, pos, end) {
  while (end > pos) {
    const c = src.charCodeAt(end - 1);
    if (c === CC.space || c === CC.tab) end--;
    else break;
  }
  return end;
}

// ---------------------------------------------------------------------------
// Block tokens
//   { t:'code', text, lang }        { t:'heading', depth, text }
//   { t:'hr' }                      { t:'html', text }
//   { t:'paragraph', text }         { t:'blockquote', tokens }
//   { t:'list', ordered, start, loose, items:[{tokens, task, checked}] }
//   { t:'table', header, align, rows }
// Link reference definitions are collected into `defs` (null-prototype map
// from normalised label to {href, title}) and produce no token.
// ---------------------------------------------------------------------------

function normalizeLabel(s) {
  // fast path: no whitespace runs/edges, no case, no foldable chars
  if (!/[ \t\nA-Zßςﬀ-ﬆ]/.test(s) && s === s.toLowerCase()) return s;
  return s.replace(/[ \t\n]+/g, ' ').replace(/^ | $/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/ς/g, 'σ')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Try to parse a link reference definition starting at pos (pos is at a line
// start with at most 3 columns of indentation). Mirrors marked's def regex:
// the label may span lines (but not across a blank line, no unescaped '['),
// the destination is <...> on one line or a run of non-whitespace, and an
// optional title must be whitespace-separated; a title that is present but
// followed by junk invalidates only when the no-title parse also fails.
function scanDef(src, pos) {
  const len = src.length;
  const end0 = lineEnd(src, pos);
  let p = skipCols(src, pos, end0, 3).pos;
  if (src.charCodeAt(p) !== CC.lbrack) return null;
  // label
  let i = p + 1, labelEnd = -1;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c === CC.backslash) { i += 2; continue; }
    if (c === CC.lbrack) return null;
    if (c === CC.rbrack) { labelEnd = i; break; }
    if (c === CC.lf) {
      const ne = lineEnd(src, i + 1);
      if (isBlankLine(src, i + 1, ne)) return null;
      i++; continue;
    }
    i++;
  }
  if (labelEnd === -1) return null;
  const label = src.slice(p + 1, labelEnd);
  if (label.length === 0 || label.length > 999 || !/\S/.test(label)) return null;
  i = labelEnd + 1;
  if (src.charCodeAt(i) !== CC.colon) return null;
  i++;
  // spaces (only) after the colon, then at most one line ending + indent
  while (src.charCodeAt(i) === CC.space) i++;
  if (src.charCodeAt(i) === CC.lf) {
    i++;
    while (src.charCodeAt(i) === CC.space || src.charCodeAt(i) === CC.tab) i++;
  }
  // destination
  let href;
  if (src.charCodeAt(i) === CC.lt) {
    let j = i + 1, ok = false;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === CC.lf) return null;
      if (c === CC.gt) { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    href = src.slice(i + 1, j);
    i = j + 1;
  } else {
    let j = i;
    const c0 = src.charCodeAt(j);
    if (j >= len || c0 <= 32 || isUnicodeSpace(c0)) return null;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c <= 32 || isUnicodeSpace(c)) break;
      j++;
    }
    href = src.slice(i, j);
    i = j;
  }
  const afterHref = i;
  // optional title: separator is (spaces + optional newline+indent) or
  // (spaces? + newline + indent); then only spaces may follow the title
  // before the line ends. If the title path fails, fall back to no title.
  const finish = (endPos) => {
    // endPos is at a '\n' or EOF; consume all consecutive newlines like
    // marked's (?:\n+|$) — harmless: they are blank lines either way.
    let e = endPos;
    while (e < len && src.charCodeAt(e) === CC.lf) e++;
    return e;
  };
  {
    let j = i, sep = false;
    let spaces = 0;
    while (src.charCodeAt(j) === CC.space) { j++; spaces++; }
    if (src.charCodeAt(j) === CC.lf) {
      j++;
      while (src.charCodeAt(j) === CC.space || src.charCodeAt(j) === CC.tab) j++;
      sep = true;
    } else if (spaces > 0) sep = true;
    if (sep) {
      const t = parseDefTitleAt(src, j);
      if (t) {
        let q = t.end;
        while (src.charCodeAt(q) === CC.space) q++;
        if (q >= len || src.charCodeAt(q) === CC.lf) {
          return { end: finish(q), label, href, title: t.title };
        }
      }
    }
  }
  // no title: only spaces before the line ends
  {
    let q = afterHref;
    while (src.charCodeAt(q) === CC.space) q++;
    if (q >= len || src.charCodeAt(q) === CC.lf) {
      return { end: finish(q), label, href, title: null };
    }
  }
  return null;
}

// A definition title at src[i], with marked's per-quote-form rules:
// "..." anything but " or \; '...' newlines only when not followed by
// another newline; (...) anything but ( ) or \.
function parseDefTitleAt(src, i) {
  const open = src.charCodeAt(i);
  const len = src.length;
  if (open === CC.quote) {
    let j = i + 1;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === CC.backslash) { j += 2; continue; }
      if (c === CC.quote) return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (open === CC.apos) {
    let j = i + 1;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === CC.backslash) { j += 2; continue; }
      if (c === CC.apos) return { title: src.slice(i + 1, j), end: j + 1 };
      if (c === CC.lf && src.charCodeAt(j + 1) === CC.lf) return null;
      j++;
    }
    return null;
  }
  if (open === CC.lparen) {
    let j = i + 1;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === CC.backslash) { j += 2; continue; }
      if (c === CC.lparen) return null;
      if (c === CC.rparen) return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Parse a link title at src[i]: "..." '...' or (...). Returns {title, end}.
function parseTitleAt(src, i) {
  const open = src.charCodeAt(i);
  let close;
  if (open === CC.quote) close = CC.quote;
  else if (open === CC.apos) close = CC.apos;
  else if (open === CC.lparen) close = CC.rparen;
  else return null;
  let j = i + 1;
  const len = src.length;
  while (j < len) {
    const c = src.charCodeAt(j);
    if (c === CC.backslash) { j += 2; continue; }
    if (c === close) return { title: src.slice(i + 1, j), end: j + 1 };
    if (open === CC.lparen && c === CC.lparen) return null;
    j++;
  }
  return null;
}

// Resolve backslash escapes of ASCII punctuation — the only cleaning
// marked applies to link destinations and titles (character references in
// them are passed through untouched and the renderer escapes around them).
function cleanLinkText(s) {
  if (!s.includes('\\')) return s;
  let out = '', i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CC.backslash && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1]; i += 2; continue;
    }
    out += s[i]; i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block-start scanners shared by the lexer and by paragraph continuation.
// Each takes (src, pos) with pos at a line start and returns null or a
// result object with at least { end } (index just past the consumed text,
// including the final newline when one was consumed).
// ---------------------------------------------------------------------------

// Fenced code: ``` or ~~~ , at most 3 columns of indentation.
function scanFenceStart(src, pos) {
  const end = lineEnd(src, pos);
  const ind = indentOf(src, pos, end);
  if (ind > 3) return null;
  const p = skipCols(src, pos, end, ind).pos;
  const c = src.charCodeAt(p);
  if (c !== CC.backtick && c !== CC.tilde) return null;
  let q = p;
  while (q < end && src.charCodeAt(q) === c) q++;
  if (q - p < 3) return null;
  const info = src.slice(q, end);
  if (c === CC.backtick && info.includes('`')) return null;
  return { indent: ind, ch: c, len: q - p, info: info.trim(), lineEndPos: end, runStart: p };
}

function tryFences(src, pos) {
  const f = scanFenceStart(src, pos);
  if (!f) return null;
  const len = src.length;
  const lines = [];
  let p = f.lineEndPos < len ? f.lineEndPos + 1 : len;
  let closedEnd = -1;
  while (p < len) {
    const end = lineEnd(src, p);
    // closing fence?
    const ind = indentOf(src, p, end);
    if (ind <= 3) {
      const q = skipCols(src, p, end, ind).pos;
      if (src.charCodeAt(q) === f.ch) {
        let r = q;
        while (r < end && src.charCodeAt(r) === f.ch) r++;
        if (r - q >= f.len) {
          let s = r;
          let ok = true;
          while (s < end) { const cc = src.charCodeAt(s); if (cc !== CC.space && cc !== CC.tab) { ok = false; break; } s++; }
          if (ok) { closedEnd = end < len ? end + 1 : end; break; }
        }
      }
    }
    // content line: marked compensates only ``` fences whose line is
    // indented — it strips min(line's leading-whitespace length,
    // fence-line indent length) CHARACTERS from each content line.
    lines.push(src.slice(p, end));
    p = end + 1;
  }
  let rawLines = lines;
  if (f.ch === CC.backtick && f.runStart > pos) {
    const indentLen = f.runStart - pos;
    rawLines = lines.map((line) => {
      const m = /^\s+/.exec(line);
      if (!m) return line;
      return line.slice(Math.min(m[0].length, indentLen));
    });
  }
  // marked's fence text: the raw content with exactly one trailing
  // newline removed — i.e. the content lines joined, no trailing newline.
  const text = rawLines.join('\n');
  const lang = f.info ? f.info.split(/\s+/)[0] : '';
  return { end: closedEnd === -1 ? len : closedEnd, token: { t: 'code', text, lang } };
}

// ATX heading.
function scanAtx(src, pos) {
  const end = lineEnd(src, pos);
  const ind = indentOf(src, pos, end);
  if (ind > 3) return null;
  let p = skipCols(src, pos, end, ind).pos;
  let depth = 0;
  while (p < end && src.charCodeAt(p) === CC.hash) { depth++; p++; }
  if (depth === 0 || depth > 6) return null;
  if (p < end) {
    const c = src.charCodeAt(p);
    if (c !== CC.space && c !== CC.tab) return null;
  }
  return { depth, contentStart: p, lineEndPos: end };
}

function tryHeading(src, pos) {
  const h = scanAtx(src, pos);
  if (!h) return null;
  let e = rtrimLine(src, h.contentStart, h.lineEndPos);
  let s = h.contentStart;
  while (s < e && (src.charCodeAt(s) === CC.space || src.charCodeAt(s) === CC.tab)) s++;
  let text = src.slice(s, e);
  // closing sequence: a run of # at the end, preceded by a space (or alone)
  const m = /(?:^|[ \t])(#+)$/.exec(text);
  if (m) text = text.slice(0, text.length - m[1].length).replace(/[ \t]+$/, '');
  const len = src.length;
  return { end: h.lineEndPos < len ? h.lineEndPos + 1 : h.lineEndPos, token: { t: 'heading', depth: h.depth, text } };
}

// Thematic break.
function isHrLine(src, pos, end) {
  const ind = indentOf(src, pos, end);
  if (ind > 3) return false;
  let p = skipCols(src, pos, end, ind).pos;
  let ch = 0, count = 0;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === CC.space || c === CC.tab) { p++; continue; }
    if (c === CC.star || c === CC.dash || c === CC.under) {
      if (ch === 0) ch = c;
      else if (c !== ch) return false;
      count++; p++; continue;
    }
    return false;
  }
  return count >= 3;
}

function tryHr(src, pos) {
  const end = lineEnd(src, pos);
  if (!isHrLine(src, pos, end)) return null;
  const len = src.length;
  return { end: end < len ? end + 1 : end, token: { t: 'hr' } };
}

// Indented code block.
function tryIndentedCode(src, pos) {
  const len = src.length;
  const lines = [];
  let p = pos, lastEnd = -1;
  while (p < len) {
    const end = lineEnd(src, p);
    if (isBlankLine(src, p, end)) {
      // tentatively part of the block; only kept if more code follows.
      // A blank line with >= 4 columns of indentation keeps the surplus.
      const bind = indentOf(src, p, end);
      let bt = '';
      if (bind >= 4) {
        const sk = skipCols(src, p, end, 4);
        bt = ' '.repeat(sk.extra) + src.slice(sk.pos, end);
      }
      lines.push({ b: bt });
      p = end + 1;
      continue;
    }
    const ind = indentOf(src, p, end);
    if (ind < 4) break;
    const sk = skipCols(src, p, end, 4);
    lines.push(' '.repeat(sk.extra) + src.slice(sk.pos, end));
    lastEnd = end;
    p = end + 1;
  }
  if (lastEnd === -1) return null;
  // drop trailing blank lines (of either kind)
  let n = lines.length;
  while (n > 0 && typeof lines[n - 1] === 'object') n--;
  const kept = lines.slice(0, n).map(l => typeof l === 'object' ? l.b : l);
  return { end: lastEnd < len ? lastEnd + 1 : lastEnd, token: { t: 'code', text: kept.join('\n') + '\n', lang: '' } };
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Scan an HTML block starting at pos; returns {end, text} or null.
// allowType7: type 7 (any other complete tag) — cannot interrupt paragraphs.
// The block's text loses one trailing newline when the block is terminated
// by a blank line (types 6/7) or when a blank line follows the line that
// ends a type 1-5 block; otherwise the text is the raw source slice.
function scanHtmlBlock(src, pos, allowType7) {
  const len = src.length;
  const end0 = lineEnd(src, pos);
  const ind = indentOf(src, pos, end0);
  if (ind > 3) return null;
  const p = skipCols(src, pos, end0, ind).pos;
  if (src.charCodeAt(p) !== CC.lt) return null;
  const rest = src.slice(p, Math.min(end0, p + 12)).toLowerCase();
  let until = null; // substring that ends the block (types 1-5)
  let m;
  if ((m = /^<(pre|script|style|textarea)(?=[ \t>]|$)/.exec(rest))) {
    until = '</' + m[1];
  } else if (rest.startsWith('<!--')) until = '-->';
  else if (rest.startsWith('<?')) until = '?>';
  else if (rest.startsWith('<![cdata[')) until = ']]>';
  else if (src.charCodeAt(p + 1) === CC.bang && src.charCodeAt(p + 2) >= 65 && src.charCodeAt(p + 2) <= 90) until = '>';

  if (until !== null) {
    // consume lines until one contains `until` (case-insensitive for tags)
    let p2 = pos;
    let endPos = len;
    while (p2 < len) {
      const e = lineEnd(src, p2);
      const line = src.slice(p2, e).toLowerCase();
      const done = line.includes(until);
      endPos = e < len ? e + 1 : e;
      if (done) break;
      p2 = e + 1;
    }
    let text = src.slice(pos, endPos);
    // strip the trailing newline only when the next line is a pure-empty
    // line (a whitespace-only line keeps it, per marked's regex + lexer)
    if (endPos < len) {
      const ne = lineEnd(src, endPos);
      if (ne === endPos && text.endsWith('\n')) text = text.slice(0, -1);
    }
    return { end: endPos, text };
  }
  // type 6: a block-level tag name (open or close) followed by whitespace,
  // '>', '/>' or end of line — the tag need not be complete.
  let q = p + 1;
  if (src.charCodeAt(q) === CC.slash) q++;
  if (isAlpha(src.charCodeAt(q))) {
    let r = q + 1;
    while (r < len && (isAlnum(src.charCodeAt(r)) || src.charCodeAt(r) === CC.dash)) r++;
    const name = src.slice(q, r).toLowerCase();
    if (HTML_BLOCK_TAGS.has(name)) {
      const after = src.charCodeAt(r);
      const okAfter = r >= end0 || after === CC.space || after === CC.tab || after === CC.gt ||
        (after === CC.slash && src.charCodeAt(r + 1) === CC.gt);
      if (okAfter) return htmlBlockTail(src, pos);
    }
  }
  // type 7: any other complete tag, with only whitespace after it on the line.
  // The tag must be complete on this line (marked does not let it span lines).
  if (!allowType7) return null;
  const tag = scanTag(src, p, end0);
  if (!tag || !tag.complete) return null;
  let s = tag.end;
  while (s < end0) {
    const c = src.charCodeAt(s);
    if (c !== CC.space && c !== CC.tab) return null;
    s++;
  }
  return htmlBlockTail(src, pos);
}

// Types 6/7 run until a blank line (or EOF). One trailing newline is
// stripped when a blank line terminated the block.
function htmlBlockTail(src, pos) {
  const len = src.length;
  let p2 = pos;
  let lastEnd = lineEnd(src, pos);
  let byBlank = false;
  for (;;) {
    const e = lineEnd(src, p2);
    lastEnd = e;
    if (e >= len) break;
    const ns = e + 1;
    if (ns >= len) break;
    const ne = lineEnd(src, ns);
    if (isBlankLine(src, ns, ne)) { byBlank = true; break; }
    p2 = ns;
  }
  const endPos = lastEnd < len ? lastEnd + 1 : lastEnd;
  let text = src.slice(pos, endPos);
  if (byBlank && text.endsWith('\n')) text = text.slice(0, -1);
  return { end: endPos, text };
}

// Scan a single HTML tag starting at src[i] === '<', bounded by line end e.
// Returns {name, closing, complete, end} — complete means a well-formed tag
// per the CommonMark grammar (attributes included), end just past '>'.
function scanTag(src, i, e) {
  let p = i + 1;
  let closing = false;
  if (src.charCodeAt(p) === CC.slash) { closing = true; p++; }
  if (p >= e || !isAlpha(src.charCodeAt(p))) return null;
  const nameStart = p;
  p++;
  while (p < e) {
    const c = src.charCodeAt(p);
    if (isAlnum(c) || c === CC.dash) p++;
    else break;
  }
  const name = src.slice(nameStart, p).toLowerCase();
  if (closing) {
    while (p < e && (src.charCodeAt(p) === CC.space || src.charCodeAt(p) === CC.tab || src.charCodeAt(p) === CC.lf)) p++;
    if (src.charCodeAt(p) === CC.gt) return { name, closing, complete: true, end: p + 1 };
    return { name, closing, complete: false, end: p };
  }
  // open tag: attributes
  for (;;) {
    let spaces = 0;
    while (p < e && (src.charCodeAt(p) === CC.space || src.charCodeAt(p) === CC.tab || src.charCodeAt(p) === CC.lf)) { p++; spaces++; }
    if (p >= e) return { name, closing, complete: false, end: p };
    const c = src.charCodeAt(p);
    if (c === CC.gt) return { name, closing, complete: true, end: p + 1 };
    if (c === CC.slash && src.charCodeAt(p + 1) === CC.gt) return { name, closing, complete: true, end: p + 2 };
    if (spaces === 0) return { name, closing, complete: false, end: p };
    // attribute name
    if (!(isAlpha(c) || c === CC.under || c === CC.colon)) return { name, closing, complete: false, end: p };
    p++;
    while (p < e) {
      const cc = src.charCodeAt(p);
      if (isAlnum(cc) || cc === CC.under || cc === CC.dot || cc === CC.colon || cc === CC.dash) p++;
      else break;
    }
    // optional value
    let q = p;
    while (q < e && (src.charCodeAt(q) === CC.space || src.charCodeAt(q) === CC.tab || src.charCodeAt(q) === CC.lf)) q++;
    if (src.charCodeAt(q) === CC.eq) {
      q++;
      while (q < e && (src.charCodeAt(q) === CC.space || src.charCodeAt(q) === CC.tab || src.charCodeAt(q) === CC.lf)) q++;
      const v = src.charCodeAt(q);
      if (v === CC.quote || v === CC.apos) {
        q++;
        while (q < e && src.charCodeAt(q) !== v) q++;
        if (q >= e) return { name, closing, complete: false, end: p };
        q++;
      } else {
        if (q >= e || v === CC.quote || v === CC.apos || v === CC.lt || v === CC.gt || v === CC.eq || v === CC.backtick) return { name, closing, complete: false, end: p };
        while (q < e) {
          const cc = src.charCodeAt(q);
          if (cc === CC.space || cc === CC.tab || cc === CC.lf || cc === CC.quote || cc === CC.apos || cc === CC.lt || cc === CC.gt || cc === CC.eq || cc === CC.backtick) break;
          q++;
        }
      }
      p = q;
    }
  }
}

// ---------------------------------------------------------------------------
// Tables (GFM). A table starts when a line containing a pipe is followed by
// a delimiter row with the same number of cells.
// ---------------------------------------------------------------------------

// Split a table row into raw cell strings. Pipes preceded by an odd number
// of backslashes do not delimit; the row's outer pipes are dropped.
function splitCells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) {
    // only drop when not escaped
    let bs = 0, i = s.length - 2;
    while (i >= 0 && s[i] === '\\') { bs++; i--; }
    if (bs % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '', bs = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { bs++; cur += ch; continue; }
    if (ch === '|' && bs % 2 === 0) { cells.push(cur); cur = ''; bs = 0; continue; }
    bs = 0;
    cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

// If the line at pos is a delimiter row, return its alignments, else null.
function scanDelimiterRow(src, pos) {
  const end = lineEnd(src, pos);
  const line = src.slice(pos, end);
  if (!line.includes('-')) return null;
  const cells = splitCells(line);
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

function tryTable(src, pos) {
  const len = src.length;
  const end = lineEnd(src, pos);
  const headerLine = src.slice(pos, end);
  if (!headerLine.includes('|')) return null;
  if (end >= len) return null;
  const aligns = scanDelimiterRow(src, end + 1);
  if (!aligns) return null;
  const header = splitCells(headerLine);
  if (header.length !== aligns.length) return null;
  const rows = [];
  let p = lineEnd(src, end + 1);
  p = p < len ? p + 1 : p;
  while (p < len) {
    const e = lineEnd(src, p);
    if (tableBodyBreak(src, p, e)) break;
    const line = src.slice(p, e);
    const cells = splitCells(line);
    while (cells.length < aligns.length) cells.push('');
    rows.push(cells.slice(0, aligns.length));
    p = e < len ? e + 1 : e;
  }
  return { end: p, token: { t: 'table', header, align: aligns, rows } };
}

// marked's table body regex: each row line must not start (after up to 3
// spaces) with: a spaces-only line end, hr, heading, blockquote, indented
// code (4 spaces, or up to 3 spaces + tab, with content after), a fence, a
// list marker (bullet, or ordered "1", followed by space/tab), or an HTML
// block start (types 1-6 shapes). A row need not contain a pipe; a tab-only
// line is a row, a spaces-only line ends the table.
function tableBodyBreak(src, pos, end) {
  // spaces-only (or empty) line ends the table — tabs do not count
  let allSpaces = true;
  for (let i = pos; i < end; i++) {
    if (src.charCodeAt(i) !== CC.space) { allSpaces = false; break; }
  }
  if (allSpaces) return true;
  const ind = indentOf(src, pos, end);
  if (ind <= 3) {
    const p = skipCols(src, pos, end, ind).pos;
    const c = src.charCodeAt(p);
    if (c === CC.gt) return true;
    if (c === CC.hash && scanAtx(src, pos)) return true;
    if (c === CC.backtick || c === CC.tilde) { if (scanFenceStart(src, pos)) return true; }
    if (isHrLine(src, pos, end)) return true;
    // list: bullet or ordered-1 marker followed by space/tab
    const m = listMarkerAt(src, pos, end);
    if (m && (!m.ordered || m.start === 1)) {
      const after = m.markerEnd < end ? src.charCodeAt(m.markerEnd) : -1;
      if (after === CC.space || after === CC.tab) return true;
    }
    if (c === CC.lt && tableHtmlBreak(src, p, end)) return true;
  }
  // indented code: 4+ columns with content, or a tab with content after it
  if (ind >= 4) {
    const p = skipCols(src, pos, end, 4).pos;
    if (p < end) return true;
  }
  return false;
}

// marked's table-row html lookahead: type 1-6 starts only (no type 7).
function tableHtmlBreak(src, p, end) {
  const rest = src.slice(p, Math.min(end, p + 12)).toLowerCase();
  if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![cdata[')) return true;
  if (src.charCodeAt(p + 1) === CC.bang && src.charCodeAt(p + 2) >= 65 && src.charCodeAt(p + 2) <= 90) return true;
  if (/^<(script|pre|style|textarea)(?=[\s>]|$)/.test(rest)) return true;
  // type 6: </?tagname followed by spaces, '/', '>' or end of line
  let q = p + 1;
  if (src.charCodeAt(q) === CC.slash) q++;
  if (!isAlpha(src.charCodeAt(q))) return false;
  let r = q + 1;
  while (r < end && (isAlnum(src.charCodeAt(r)) || src.charCodeAt(r) === CC.dash)) r++;
  if (!HTML_BLOCK_TAGS.has(src.slice(q, r).toLowerCase())) return false;
  if (r >= end) return true;
  const after = src.charCodeAt(r);
  return after === CC.space || after === CC.gt ||
    (after === CC.slash && src.charCodeAt(r + 1) === CC.gt);
}

// Would the line at (pos,end) start a table together with the next line?
function isTableStart(src, pos, end) {
  const len = src.length;
  if (end >= len) return false;
  const line = src.slice(pos, end);
  if (!line.includes('|')) return false;
  const aligns = scanDelimiterRow(src, end + 1);
  if (!aligns) return false;
  return splitCells(line).length === aligns.length;
}

// ---------------------------------------------------------------------------
// Paragraph interruption: would the line at (pos,end) interrupt a paragraph
// that is in progress? Setext underlines are handled by the paragraph
// scanner itself before this is consulted.
// ---------------------------------------------------------------------------

function listMarkerAt(src, pos, end) {
  const ind = indentOf(src, pos, end);
  if (ind > 3) return null;
  const p = skipCols(src, pos, end, ind).pos;
  const c = src.charCodeAt(p);
  if (c === CC.star || c === CC.plus || c === CC.dash) {
    const after = p + 1;
    if (after >= end) return { ordered: false, bullet: c, start: 0, markerEnd: after, ind };
    const a = src.charCodeAt(after);
    if (a !== CC.space && a !== CC.tab) return null;
    return { ordered: false, bullet: c, start: 0, markerEnd: after, ind };
  }
  if (isDigit(c)) {
    let q = p, num = 0, nd = 0;
    while (q < end && isDigit(src.charCodeAt(q)) && nd < 10) { num = num * 10 + (src.charCodeAt(q) - 48); q++; nd++; }
    if (nd > 9) return null;
    const d = src.charCodeAt(q);
    if (d !== CC.dot && d !== CC.rparen) return null;
    const after = q + 1;
    if (after >= end) return { ordered: true, bullet: d, start: num, markerEnd: after, ind };
    const a = src.charCodeAt(after);
    if (a !== CC.space && a !== CC.tab) return null;
    return { ordered: true, bullet: d, start: num, markerEnd: after, ind };
  }
  return null;
}

// Content of a list item's first line is empty (nothing but spaces after
// the marker and its following whitespace).
function markerLineEmpty(src, m, end) {
  let p = m.markerEnd;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c !== CC.space && c !== CC.tab) return false;
    p++;
  }
  return true;
}

function interruptsParagraph(src, pos, end, anyOrderedStart) {
  const ind = indentOf(src, pos, end);
  if (ind > 3) return false;
  const p = skipCols(src, pos, end, ind).pos;
  const c = src.charCodeAt(p);
  if (c === CC.backtick || c === CC.tilde) return scanFenceStart(src, pos) !== null;
  if (c === CC.hash) return scanAtx(src, pos) !== null;
  if (c === CC.gt) return true;
  if (c === CC.star || c === CC.dash || c === CC.under) {
    if (isHrLine(src, pos, end)) return true;
    if (c === CC.under) return false;
    const m = listMarkerAt(src, pos, end);
    if (m && !markerLineEmpty(src, m, end)) return true;
    return false;
  }
  if (c === CC.plus) {
    const m = listMarkerAt(src, pos, end);
    return !!(m && !markerLineEmpty(src, m, end));
  }
  if (isDigit(c)) {
    const m = listMarkerAt(src, pos, end);
    return !!(m && (anyOrderedStart || m.start === 1) && !markerLineEmpty(src, m, end));
  }
  if (c === CC.lt) return scanHtmlBlock(src, pos, false) !== null;
  if (c === CC.pipe || true) {
    // a table header line interrupts when followed by a delimiter row
    if (isTableStart(src, pos, end)) return true;
  }
  return false;
}

function isSetextUnderline(src, pos, end) {
  const ind = indentOf(src, pos, end);
  if (ind > 3) return 0;
  let p = skipCols(src, pos, end, ind).pos;
  const c = src.charCodeAt(p);
  if (c !== CC.eq && c !== CC.dash) return 0;
  let q = p;
  while (q < end && src.charCodeAt(q) === c) q++;
  if (q === p) return 0;
  // only spaces/tabs may follow
  let s = q;
  while (s < end) { const cc = src.charCodeAt(s); if (cc !== CC.space && cc !== CC.tab) return 0; s++; }
  return c === CC.eq ? 1 : 2;
}

// Scan a paragraph (or setext heading) starting at pos. Always succeeds:
// the caller has established that no other block starts here. `prot`, when
// given, holds offsets of lines that are forced paragraph continuations.
// `top` is marked's lexer state: false inside list items.
function scanParagraph(src, pos, prot, top) {
  const len = src.length;
  const lines = [];
  let p = pos;
  let firstEnd = lineEnd(src, p);
  lines.push(src.slice(p, firstEnd));
  p = firstEnd;
  while (p < len) {
    const ns = p + 1;
    const ne = lineEnd(src, ns);
    // a whitespace-only line ends the paragraph only when it is a complete
    // line; an unterminated whitespace fragment at the end of the text is
    // paragraph content (marked's paragraph regex behaves this way)
    if (isBlankLine(src, ns, ne) && (ne < len || ns === ne)) break;
    if (prot && prot.has(ns)) {
      // a line the block quote capture marked as a forced continuation
      lines.push(src.slice(ns, ne));
      p = ne;
      continue;
    }
    const setext = isSetextUnderline(src, ns, ne);
    if (setext) {
      return { end: ne < len ? ne + 1 : ne, token: { t: 'heading', depth: setext, text: lines.join('\n').trim() } };
    }
    if (top === false ? interruptsParagraphQuote(src, ns, ne) : interruptsParagraph(src, ns, ne)) break;
    let lineText = src.slice(ns, ne);
    if (top === false) {
      // inside list items marked lexes text line-by-line: an indented
      // (>= 4) line is tokenized as indented code and merged into the
      // text token with its dedented content
      const ind = indentOf(src, ns, ne);
      if (ind >= 4) {
        const adv = advanceCols(src, ns, ne, 0, 4);
        lineText = ' '.repeat(adv.extra) + src.slice(adv.pos, ne);
      }
    }
    lines.push(lineText);
    p = ne;
  }
  return { end: p < len ? p + 1 : p, token: { t: 'paragraph', text: lines.join('\n') } };
}

// Advance `cols` columns through whitespace starting at index p (whose
// current column is startCol). Returns {pos, extra}: if a tab straddles the
// target column, pos moves past it and extra counts leftover spaces.
function advanceCols(src, p, end, startCol, cols) {
  let col = startCol;
  const target = startCol + cols;
  while (p < end && col < target) {
    const c = src.charCodeAt(p);
    if (c === CC.space) { col++; p++; }
    else if (c === CC.tab) {
      const w = 4 - (col % 4);
      if (col + w > target) return { pos: p + 1, extra: col + w - target };
      col += w; p++;
    } else break;
  }
  return { pos: p, extra: 0 };
}

// Expand tabs in a whitespace string, counting columns from startCol
// (marked's J helper): each tab advances to the next multiple of 4.
function expandTabs(s, startCol) {
  if (!s.includes('\t')) return s;
  let out = '', col = startCol;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += s[i]; col++; }
  }
  return out;
}

// Expand the leading whitespace run of a line (from column 0), leaving the
// rest of the line untouched.
function expandLeadingWs(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return line;
  let e = 1;
  while (e < line.length && (line.charCodeAt(e) === 32 || line.charCodeAt(e) === 9)) e++;
  const run = line.slice(0, e);
  if (!run.includes('\t')) return line;
  return expandTabs(run, 0) + line.slice(e);
}

// Paragraph interruption as used inside block quote captures (marked's Ke
// variant): a list marker interrupts with any start number, and even an
// empty marker line interrupts.
function interruptsParagraphQuote(src, pos, end) {
  const ind = indentOf(src, pos, end);
  if (ind > 3) return false;
  const p = skipCols(src, pos, end, ind).pos;
  const c = src.charCodeAt(p);
  if (c === CC.star || c === CC.plus || c === CC.dash || isDigit(c)) {
    const m = listMarkerAt(src, pos, end);
    if (m) return true;
  }
  return interruptsParagraph(src, pos, end);
}
// { open, viaList } — viaList tells whether a list intervenes between the
// outermost container and the paragraph. Speculative: defs go to a clone.
function endsWithOpen(text, defs) {
  if (!text) return { open: false, viaList: false };
  const toks = lexBlocks(text, Object.assign(Object.create(null), defs));
  return openOfTokens(toks, false);
}

function openOfTokens(toks, viaList) {
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.t === 'def') continue;
    if (t.t === 'paragraph') return { open: true, viaList };
    if (t.t === 'blockquote') return openOfTokens(t.tokens, viaList);
    if (t.t === 'list' && t.items.length) return openOfTokens(t.items[t.items.length - 1].tokens, true);
    return { open: false, viaList: false };
  }
  return { open: false, viaList: false };
}

// ---------------------------------------------------------------------------
// Block quotes: consecutive marker lines, plus lazy paragraph-continuation
// lines. The stripped content is lexed recursively.
// ---------------------------------------------------------------------------

function tryBlockquote(src, pos, defs) {
  const len = src.length;
  const lines = [];
  const prot = new Set(); // inner-string offsets of protected setext lines
  let protOffset = 0;
  let p = pos;
  let end = pos;
  let lastBlank = true;
  let prevMarker = false;
  while (p < len) {
    const e = lineEnd(src, p);
    const ind = indentOf(src, p, e);
    let stripped = null;
    if (ind <= 3) {
      const q = skipCols(src, p, e, ind).pos;
      if (src.charCodeAt(q) === CC.gt) {
        // strip the marker: '>' plus one whitespace character, where the
        // whitespace run after the marker is first tab-expanded counting
        // from the marker's column (marked's blockquoteMarkerWhitespace)
        const c = q + 1;
        if (c < e && (src.charCodeAt(c) === CC.space || src.charCodeAt(c) === CC.tab)) {
          let r = c;
          while (r < e && (src.charCodeAt(r) === CC.space || src.charCodeAt(r) === CC.tab)) r++;
          stripped = expandTabs(src.slice(c, r), ind + 1).slice(1) + src.slice(r, e);
        } else {
          stripped = src.slice(c, e);
        }
      }
    }
    if (stripped !== null) {
      lines.push(stripped);
      protOffset += stripped.length + 1;
      lastBlank = !/\S/.test(stripped);
      prevMarker = true;
      end = e < len ? e + 1 : e;
      p = end;
      continue;
    }
    // lazy continuation line?
    if (lines.length && !lastBlank && !isBlankLine(src, p, e)) {
      const st = endsWithOpen(lines.join('\n'), defs);
      if (st.open) {
        const setext = isSetextUnderline(src, p, e);
        if (setext !== 0 && !isHrLine(src, p, e)) {
          if (prevMarker) {
            // first line of a new pass: marked lexes it separately and
            // merges it as paragraph text — keep the raw line and protect
            // it from setext conversion in the inner paragraph scan
            prot.add(protOffset);
            lines.push(src.slice(p, e));
          } else {
            // mid-pass: marked indents the underline by 4 so it stays text
            const sk = skipCols(src, p, e, ind);
            lines.push('    ' + ' '.repeat(sk.extra) + src.slice(sk.pos, e));
          }
          protOffset += lines[lines.length - 1].length + 1;
          lastBlank = false;
          prevMarker = false;
          end = e < len ? e + 1 : e;
          p = end;
          continue;
        }
        if (!interruptsParagraphQuote(src, p, e)) {
          let lineText = src.slice(p, e);
          if (prevMarker && ind >= 4 && !st.viaList) {
            // pass-leading indented line: marked lexes it as indented code
            // and merges its dedented text into the open paragraph; the
            // dedented line must not be reinterpreted as a block start
            const adv = advanceCols(src, p, e, 0, 4);
            lineText = ' '.repeat(adv.extra) + src.slice(adv.pos, e);
            prot.add(protOffset);
          }
          lines.push(lineText);
          protOffset += lineText.length + 1;
          lastBlank = false;
          prevMarker = false;
          end = e < len ? e + 1 : e;
          p = end;
          continue;
        }
      }
    }
    break;
  }
  if (!lines.length) return null;
  const inner = lines.join('\n');
  return { end, token: { t: 'blockquote', tokens: lexBlocks(inner, defs, prot, true) } };
}

// ---------------------------------------------------------------------------
// Lists.
// ---------------------------------------------------------------------------

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.bullet === b.bullet; // '.' vs ')'
  return a.bullet === b.bullet;
}

// Analyse the first line of a list item whose marker is m on line
// (lineStart,lineEndPos): where its content begins, in columns and index.
// Also returns the first line's post-marker text with its leading
// whitespace tab-expanded (marked's `m`), which the item-body lazy checks
// consult for the first following line.
function itemFirstLine(src, m, lineStart, lineEndPos) {
  const width = m.ordered ? String(m.start).length + 1 : 1;
  const afterCol = m.ind + width;
  let p = m.markerEnd, col = afterCol;
  while (p < lineEndPos) {
    const c = src.charCodeAt(p);
    if (c === CC.space) { col++; p++; }
    else if (c === CC.tab) { col += 4 - (col % 4); p++; }
    else break;
  }
  const empty = p >= lineEndPos;
  const n = col - afterCol;
  const contentCol = afterCol + (empty || n >= 5 ? 1 : n);
  let contentPos, extra = 0;
  if (empty || n >= 5) {
    const adv = advanceCols(src, m.markerEnd, lineEndPos, afterCol, 1);
    contentPos = adv.pos; extra = adv.extra;
  } else {
    contentPos = p;
  }
  const gExpanded = expandTabs(src.slice(m.markerEnd, p), afterCol) + src.slice(p, lineEndPos);
  let firstText = '';
  if (!empty) {
    let r0 = gExpanded.search(/[^ ]/);
    if (r0 > 4) r0 = 1;
    firstText = gExpanded.slice(r0);
  }
  return { contentCol, contentPos, extra, empty, gExpanded, firstText };
}

// Does the line at (pos,end) start a construct that ends a list item when
// it appears indented less than the item's content column R? Mirrors
// marked's *BeginRegex checks, whose indent allowance is min(3, R-1).
function listBeginBreak(src, pos, end, R) {
  const ind = indentOf(src, pos, end);
  if (ind > Math.min(3, R - 1)) return false;
  const fc = src.charCodeAt(skipCols(src, pos, end, ind).pos);
  if (!(fc === 96 || fc === 126 || fc === 35 || fc === 45 || fc === 42 || fc === 95 || fc === 62 || fc === 43 || fc === 60 || (fc >= 48 && fc <= 57))) return false;
  if (scanFenceStart(src, pos)) return true;
  if (scanAtx(src, pos)) return true;
  if (isHrLine(src, pos, end)) return true;
  const p = skipCols(src, pos, end, ind).pos;
  if (src.charCodeAt(p) === CC.gt) return true;
  if (listMarkerAt(src, pos, end)) return true;
  if (htmlBeginAt(src, pos, end)) return true;
  return false;
}

// marked's htmlBeginRegex: types 1-5 starts, or a block tag name followed
// by spaces, '/>' or end of line.
function htmlBeginAt(src, pos, end) {
  const ind = indentOf(src, pos, end);
  if (ind > 3) return false;
  const p = skipCols(src, pos, end, ind).pos;
  if (src.charCodeAt(p) !== CC.lt) return false;
  const rest = src.slice(p, Math.min(end, p + 12)).toLowerCase();
  if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![cdata[')) return true;
  if (/^<(script|pre|style|textarea)(?=[\s>]|$)/.test(rest)) return true;
  if (src.charCodeAt(p + 1) === CC.bang && isAlpha(src.charCodeAt(p + 2))) return true;
  let q = p + 1;
  if (src.charCodeAt(q) === CC.slash) q++;
  if (isAlpha(src.charCodeAt(q))) {
    let r = q + 1;
    while (r < end && (isAlnum(src.charCodeAt(r)) || src.charCodeAt(r) === CC.dash)) r++;
    const name = src.slice(q, r).toLowerCase();
    if (HTML_BLOCK_TAGS.has(name)) {
      if (r >= end) return true;
      const after = src.charCodeAt(r);
      if (after === CC.space || after === CC.tab) return true;
      if (after === CC.slash && src.charCodeAt(r + 1) === CC.gt) return true;
    }
  }
  return false;
}

// Would this (already dedented) line start a fence/heading/html/hr block?
// Used by the list lazy checks on the previous line's content.
function startsBlockish(lineText) {
  if (!lineText) return false;
  const e = lineText.length;
  if (scanFenceStart(lineText, 0)) return true;
  if (scanAtx(lineText, 0)) return true;
  if (isHrLine(lineText, 0, e)) return true;
  if (htmlBeginAt(lineText, 0, e)) return true;
  return false;
}

function tryList(src, pos, defs) {
  const len = src.length;
  const firstEnd = lineEnd(src, pos);
  const m0 = listMarkerAt(src, pos, firstEnd);
  if (!m0) return null;
  const items = [];
  let loose = false;
  let prevItemEndedBlank = false;
  let p = pos;
  let listEnd = pos;

  while (p < len) {
    const lineEndPos = lineEnd(src, p);
    if (isHrLine(src, p, lineEndPos)) break;
    const m = listMarkerAt(src, p, lineEndPos);
    if (!m || !sameListType(m, m0)) break;
    if (items.length && prevItemEndedBlank) loose = true;
    const info = itemFirstLine(src, m, p, lineEndPos);
    const R = info.contentCol;
    let q = lineEndPos < len ? lineEndPos + 1 : len;
    let lastContentEnd = q;
    let itemEndedBlank = false;
    let contentLines;
    if (info.empty && q < len && isBlankLine(src, q, lineEnd(src, q))) {
      // empty item immediately followed by a blank line: the item is just
      // the marker line; the blank line is consumed with it (marked's rule)
      contentLines = [''];
      q = lineEnd(src, q) < len ? lineEnd(src, q) + 1 : len;
      itemEndedBlank = true;
    } else {
      contentLines = [info.firstText];
      let prevBlank = info.empty;
      let prevContent = info.gExpanded;
      while (q < len) {
        const e = lineEnd(src, q);
        const rawLine = src.slice(q, e);
        const blank = !/\S/.test(rawLine);
        if (!blank && listBeginBreak(src, q, e, R)) break;
        const zLine = expandLeadingWs(rawLine);
        const zInd = zLine.search(/[^ ]/);
        if (blank || zInd >= R) {
          contentLines.push(zLine.slice(R));
          prevBlank = blank;
          prevContent = contentLines[contentLines.length - 1];
          q = e < len ? e + 1 : e;
          if (!blank) lastContentEnd = q;
          continue;
        }
        // lazy continuation candidate
        if (prevBlank) break;
        const mIdx = prevContent.replace(/\t/g, '    ').search(/[^ ]/);
        if (mIdx >= 4) break;
        if (startsBlockish(prevContent)) break;
        if (isSetextUnderline(src, q, e) !== 0 && /\S/.test(prevContent)) {
          const sk = skipCols(src, q, e, indentOf(src, q, e));
          contentLines.push('    ' + ' '.repeat(sk.extra) + src.slice(sk.pos, e));
        } else {
          contentLines.push(rawLine);
        }
        prevBlank = false;
        // marked's next-iteration check reads m = Z.slice(R) of THIS line
        prevContent = zLine.slice(R);
        q = e < len ? e + 1 : e;
        lastContentEnd = q;
      }
      // did the item's span end with blank line(s)?
      itemEndedBlank = contentLines.length > 1 && !/\S/.test(contentLines[contentLines.length - 1]) &&
        contentLines.slice(0, -1).some(l => /\S/.test(l));
      // trailing blank content lines are not part of the item text
      while (contentLines.length > 1 && !/\S/.test(contentLines[contentLines.length - 1])) contentLines.pop();
    }
    prevItemEndedBlank = itemEndedBlank;
    // task list item? the checkbox marker is stripped before lexing, the
    // renderer puts the <input> back
    let task = false, checked = false;
    const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(contentLines[0]);
    if (tm) {
      task = true;
      checked = tm[1] !== ' ';
      contentLines[0] = contentLines[0].slice(tm[0].length);
    }
    const content = contentLines.join('\n');
    const tokens = lexBlocks(content, defs, undefined, false);
    items.push({ tokens, task, checked, content });
    // the list's end rewinds over trailing blank lines of the last item:
    // they belong to the enclosing context (marked leaves them as space)
    listEnd = lastContentEnd;
    p = q;
  }
  if (!items.length) return null;
  // marked trimEnds the last item's text before lexing it
  const lastItem = items[items.length - 1];
  const trimmedContent = lastItem.content.trimEnd();
  if (trimmedContent !== lastItem.content) {
    lastItem.content = trimmedContent;
    lastItem.tokens = lexBlocks(trimmedContent, defs, undefined, false);
  }
  if (!loose) {
    for (const item of items) {
      for (let i = 1; i < item.tokens.length; i++) {
        if (item.tokens[i].blankBefore) { loose = true; break; }
      }
      if (loose) break;
    }
  }
  return { end: listEnd, token: { t: 'list', ordered: m0.ordered, start: m0.start, loose, items } };
}

// ---------------------------------------------------------------------------
// The block lexer proper.
// ---------------------------------------------------------------------------

function lexBlocks(src, defs, prot, top) {
  const tokens = [];
  const len = src.length;
  let pos = 0;
  while (pos < len) {
    // skip blank lines, remembering whether any were skipped
    let blanks = false;
    while (pos < len) {
      const e = lineEnd(src, pos);
      if (isBlankLine(src, pos, e)) { blanks = true; pos = e < len ? e + 1 : e; }
      else break;
    }
    if (pos >= len) break;
    let r = null, tok = null;
    // First-char dispatch: most block starts can only be one or two
    // token kinds; the full chain runs only when the dispatch misses.
    const e0 = lineEnd(src, pos);
    const ind0 = indentOf(src, pos, e0);
    const c0 = ind0 <= 3 ? src.charCodeAt(skipCols(src, pos, e0, ind0).pos) : -1;
    const tableOrPara = () => {
      if (src.slice(pos, e0).includes('|') && (r = tryTable(src, pos))) { tok = r.token; return; }
      r = scanParagraph(src, pos, prot, top); tok = r.token;
    };
    if (ind0 >= 4) {
      if ((r = tryIndentedCode(src, pos))) tok = r.token;
      else tableOrPara();
    } else if (c0 === 96 || c0 === 126) { // ` ~
      if ((r = tryFences(src, pos))) tok = r.token;
      else tableOrPara();
    } else if (c0 === 35) { // #
      if ((r = tryHeading(src, pos))) tok = r.token;
      else tableOrPara();
    } else if (c0 === 62) { // >
      if ((r = tryBlockquote(src, pos, defs))) tok = r.token;
      else tableOrPara();
    } else if (c0 === 60) { // <
      if ((r = scanHtmlBlock(src, pos, true))) { tok = { t: 'html', text: r.text }; }
      else tableOrPara();
    } else if (c0 === 91) { // [
      if ((r = scanDef(src, pos))) {
        const key = normalizeLabel(r.label);
        if (!(key in defs)) defs[key] = { href: cleanLinkText(r.href), title: r.title === null ? null : cleanLinkText(r.title) };
        tok = { t: 'def' };
      }
      else tableOrPara();
    } else if (c0 === 45 || c0 === 43 || c0 === 42 || c0 === 95 || (c0 >= 48 && c0 <= 57)) { // - + * _ digit
      if ((r = tryHr(src, pos))) tok = r.token;
      else if ((r = tryList(src, pos, defs))) tok = r.token;
      else if ((r = tryTable(src, pos))) tok = r.token;
      else { r = scanParagraph(src, pos, prot, top); tok = r.token; }
    } else if (src.slice(pos, e0).includes('|')) {
      if ((r = tryTable(src, pos))) tok = r.token;
      else { r = scanParagraph(src, pos, prot, top); tok = r.token; }
    } else {
      r = scanParagraph(src, pos, prot, top); tok = r.token;
    }
    tok.blankBefore = blanks;
    tokens.push(tok);
    pos = r.end;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline phase.
//
// The scanner walks the block's text once, building a doubly linked list of
// nodes: text runs, finished HTML (code spans, tags, autolinks, <br>),
// delimiter runs for * and _, and bracket openers. Link/image formation
// happens at each ']' (nearest active opener), emphasis afterwards with the
// CommonMark delimiter-stack algorithm over each range. Every HTML node
// also carries its plain-text rendering, which image alt text needs.
// ---------------------------------------------------------------------------

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function cpBefore(text, i) {
  if (i <= 0) return -1;
  const c = text.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const c2 = text.charCodeAt(i - 2);
    if (c2 >= 0xd800 && c2 <= 0xdbff) return 0x10000 + ((c2 - 0xd800) << 10) + (c - 0xdc00);
  }
  return c;
}

function cpAfter(text, i) {
  if (i >= text.length) return -1;
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const c2 = text.charCodeAt(i + 1);
    if (c2 >= 0xdc00 && c2 <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
  }
  return c;
}

// Flanking classification for a delimiter run spanning [start, end).
function flanking(text, start, end) {
  const before = cpBefore(text, start);
  const after = cpAfter(text, end);
  const beforeWs = before === -1 || isUnicodeSpace(before);
  const afterWs = after === -1 || isUnicodeSpace(after);
  const beforeP = before !== -1 && isUnicodePunct(before);
  const afterP = after !== -1 && isUnicodePunct(after);
  return {
    left: !afterWs && (!afterP || beforeWs || beforeP),
    right: !beforeWs && (!beforeP || afterWs || afterP),
  };
}

function isEmailCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45; }
function isEmailChar(ch) { return isEmailCode(ch.charCodeAt(0)); }

// Match marked's email pattern at text[i]: local@domain where the domain
// has at least one dot group and does not end next to a word char or '-'.
// Group labels may end with '-'/'_' only when trimmed back to an alnum.
// When the domain is followed by a '__' run and strongUnd says a '__'
// opener is open in this inline run, the run is the strong's closer (marked
// tokenizes the strong first), so the email ends before it.
// Returns the end index or -1.
function matchEmailAt(text, i, strongUnd) {
  const len = text.length;
  let j = i;
  while (j < len && isEmailCode(text.charCodeAt(j))) j++;
  if (j === i || text[j] !== '@') return -1;
  j++;
  const dStart = j;
  while (j < len) { const c = text.charCodeAt(j); if (isAlnum(c) || c === CC.dash || c === CC.under) j++; else break; }
  if (j === dStart) return -1;
  let groups = 0;
  const groupDots = [];
  for (;;) {
    if (text[j] !== '.') break;
    let k = j + 1;
    while (k < len) { const c = text.charCodeAt(k); if (isAlnum(c) || c === CC.dash || c === CC.under) k++; else break; }
    let trim = k;
    while (trim > j + 1 && (text.charCodeAt(trim - 1) === CC.dash || text.charCodeAt(trim - 1) === CC.under)) trim--;
    if (trim === j + 1 || !isAlnum(text.charCodeAt(trim - 1))) break;
    groups++;
    groupDots.push(j);
    j = trim;
    if (trim !== k) break;
  }
  if (groups === 0) return -1;
  for (;;) {
    const after = j < len ? text.charCodeAt(j) : -1;
    if (after === -1 || !(isAlnum(after) || after === CC.under || after === CC.dash)) return j;
    if (after === CC.under && strongUnd) {
      // A trailing '_' run that closes an emphasis span (an
      // opener-capable '_' run was seen earlier) ends the email:
      // marked consumes the closer via emStrong before matching.
      let run = 0;
      while (text.charCodeAt(j + run) === CC.under) run++;
      const b = j + run < len ? text.charCodeAt(j + run) : -1;
      if (b === -1 || !isAlnum(b)) return j;
    }
    if (groups === 0) return -1;
    j = groupDots.pop();
    groups--;
    if (groups === 0) return -1;
  }
}

// Trim a bare autolink the way marked's backpedal regex does: the
// result is the longest prefix built from units -- plain runs, balanced
// (...) groups, '&' not starting a string-final entity, and
// punctuation runs that do not reach the end of the string.
const URL_PUNCT4 = new Set('?!.,:;*_\'"~)');
function backpedalUrl(u) {
  let i = 0;
  const len = u.length;
  while (i < len) {
    const ch = u[i];
    if (ch === '(') {
      const close = u.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1; continue;
    }
    if (ch === '&') {
      if (/^[a-zA-Z0-9]+;$/.test(u.slice(i + 1))) break;
      i++; continue;
    }
    if (URL_PUNCT4.has(ch)) {
      let j = i;
      while (j < len && URL_PUNCT4.has(u[j])) j++;
      if (j >= len) break;
      i = j; continue;
    }
    let j = i;
    while (j < len && !URL_PUNCT4.has(u[j]) && u[j] !== '(' && u[j] !== '&') j++;
    i = j;
  }
  return u.slice(0, i);
}

// Try a bare autolink (url or email) at text[i]. Returns {end, text, href}.
function scanBareUrl(text, i, strongUnd) {
  const len = text.length;
  // mailto: / xmpp: prefixed email
  for (const proto of ['mailto:', 'xmpp:']) {
    if (text.startsWith(proto, i)) {
      const eEnd = matchEmailAt(text, i + proto.length, strongUnd);
      if (eEnd !== -1) {
        let end = eEnd;
        if (proto === 'xmpp:' && text[end] === '/') {
          let j = end + 1;
          while (j < len && (isAlnum(text.charCodeAt(j)) || text[j] === '@' || text[j] === '.')) j++;
          if (j > end + 1) end = j;
        }
        const t = text.slice(i, end);
        return { end, text: t, href: t };
      }
    }
  }
  // protocol:// or www.
  const head = text.slice(i, i + 8).toLowerCase();
  let kind = null;
  if (head.startsWith('http://') || head.startsWith('https://') || head.startsWith('ftp://')) kind = 'proto';
  else if (text.startsWith('www.', i)) {
    const before = i === 0 ? -1 : text.charCodeAt(i - 1);
    if (before === -1 || before === 32 || before === 9 || before === 10 || before === CC.star || before === CC.under || before === CC.tilde || before === CC.lparen) kind = 'www';
  }
  if (kind) {
    let j = i;
    while (j < len) {
      const c = text.charCodeAt(j);
      if (c <= 32 || c === CC.lt) break;
      j++;
    }
    let t = backpedalUrl(text.slice(i, j));
    if (kind === 'www') {
      // the regex needs at least one domain label char after www.
      if (!/^[a-zA-Z0-9-]+/.test(t.slice(4))) return null;
      return { end: i + t.length, text: t, href: 'http://' + t };
    }
    return { end: i + t.length, text: t, href: t };
  }
  // bare email
  if (isEmailCode(text.charCodeAt(i))) {
    const eEnd = matchEmailAt(text, i, strongUnd);
    if (eEnd !== -1) {
      const t = text.slice(i, eEnd);
      return { end: eEnd, text: t, href: 'mailto:' + t };
    }
  }
  return null;
}

// Code span starting at text[i] === '`'. Returns {end, text} or null.
function scanCodeSpan(text, i, bound) {
  const len = text.length;
  let n = 0;
  while (text.charCodeAt(i + n) === CC.backtick) n++;
  let j = i + n;
  while (j < len) {
    if (bound !== undefined && j >= bound) return null;
    if (text.charCodeAt(j) === CC.backtick) {
      let m = 0;
      while (text.charCodeAt(j + m) === CC.backtick) m++;
      if (m === n) {
        let content = text.slice(i + n, j).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        return { end: j + m, text: content };
      }
      j += m;
    } else j++;
  }
  return null;
}

// Strikethrough, marked's grammar: ~ or ~~ opener, content whose first char
// is not space or ~, ending in a unit that is not space, ~ or a lone
// backslash, then the same opener, not followed by another ~. Same-length
// tilde runs nest (depth-counted); runs of the other length are content.
function scanDel(text, i) {
  const len = text.length;
  for (const open of [2, 1]) {
    if (open === 2 && text.charCodeAt(i + 1) !== CC.tilde) continue;
    if (open === 1 && text.charCodeAt(i + 1) === CC.tilde) continue;
    const start = i + open;
    if (start >= len) continue;
    const f = text.charCodeAt(start);
    if (f === CC.tilde || f === CC.space || f === CC.tab || f === CC.lf) continue;
    let depth = 0;
    let prevEndable = false;
    let k = start;
    while (k < len) {
      const c = text.charCodeAt(k);
      if (c === CC.tilde) {
        let run = 0;
        while (text.charCodeAt(k + run) === CC.tilde) run++;
        if (run !== open) { k += run; prevEndable = false; continue; }
        const after = k + run < len ? text.charCodeAt(k + run) : -1;
        if (prevEndable && after !== CC.tilde) {
          if (depth > 0) { depth--; k += run; prevEndable = false; continue; }
          return { end: k + run, text: text.slice(start, k) };
        }
        if (after !== -1 && after !== CC.tilde && after !== CC.space && after !== CC.tab && after !== CC.lf) {
          depth++; k += run; prevEndable = false; continue;
        }
        k += run; prevEndable = false; continue;
      }
      if (c === CC.backslash && k + 1 < len) { k += 2; prevEndable = true; continue; }
      prevEndable = c !== CC.space && c !== CC.tab && c !== CC.lf;
      k++;
    }
  }
  return null;
}

// An autolink in angle brackets or an inline HTML construct at text[i]==='<'.
// Returns {end, kind:'link', text, href} or {end, kind:'tag', text} or null.
function scanAngle(text, i) {
  const len = text.length;
  // autolink: <scheme:rest> — scheme is 2-32 chars, rest has no spaces or <>
  if (isAlpha(text.charCodeAt(i + 1))) {
    let j = i + 1;
    while (j < len) {
      const c = text.charCodeAt(j);
      if (isAlnum(c) || c === CC.plus || c === CC.dash || c === CC.dot) j++;
      else break;
    }
    const schemeLen = j - (i + 1);
    if (schemeLen >= 2 && schemeLen <= 32 && text.charCodeAt(j) === CC.colon) {
      let k = j + 1;
      while (k < len) {
        const c = text.charCodeAt(k);
        if (c <= 32 || c === CC.lt || c === CC.gt || isUnicodeSpace(c)) break;
        k++;
      }
      if (text.charCodeAt(k) === CC.gt) {
        const t = text.slice(i + 1, k);
        return { end: k + 1, kind: 'link', text: t, href: t };
      }
    }
  }
  const eEnd = matchEmailAt(text, i + 1);
  if (eEnd !== -1 && text[eEnd] === '>') {
    const t = text.slice(i + 1, eEnd);
    return { end: eEnd + 1, kind: 'link', text: t, href: 'mailto:' + t };
  }
  if (text.startsWith('<!--', i)) {
    // marked's comment pattern: <!-- then -?> or lazy content to -->
    const close = text.indexOf('-->', i + 2);
    if (close !== -1) return { end: close + 3, kind: 'tag', text: text.slice(i, close + 3) };
    return null;
  }
  if (text.startsWith('<?', i)) {
    const close = text.indexOf('?>', i + 2);
    if (close !== -1) return { end: close + 2, kind: 'tag', text: text.slice(i, close + 2) };
    return null;
  }
  if (text.startsWith('<![CDATA[', i)) {
    const close = text.indexOf(']]>', i + 9);
    if (close !== -1) return { end: close + 3, kind: 'tag', text: text.slice(i, close + 3) };
    return null;
  }
  if (text.startsWith('<!', i) && isAlpha(text.charCodeAt(i + 2)) && text.charCodeAt(i + 2) === text.charCodeAt(i + 2)) {
    // declaration: <! + uppercase letters ... >
    let j = i + 2;
    let ok = true;
    while (j < len && text.charCodeAt(j) >= 65 && text.charCodeAt(j) <= 90) j++;
    if (j === i + 2) ok = false;
    if (ok) {
      const close = text.indexOf('>', j);
      if (close !== -1) return { end: close + 1, kind: 'tag', text: text.slice(i, close + 1) };
    }
    return null;
  }
  const tag = scanTag(text, i, len);
  if (tag && tag.complete) return { end: tag.end, kind: 'tag', text: text.slice(i, tag.end) };
  return null;
}

// Parse an inline link's destination/title starting at text[i] === '('.
// Returns {href, title, end} or null.
function parseLinkDest(text, i) {
  const len = text.length;
  let j = i + 1;
  const skipWs = () => { while (j < len) { const c = text.charCodeAt(j); if (c === CC.space || c === CC.tab || c === CC.lf) j++; else break; } };
  skipWs();
  let href;
  if (text.charCodeAt(j) === CC.lt) {
    let k = j + 1, ok = false;
    while (k < len) {
      const c = text.charCodeAt(k);
      if (c === CC.backslash) { k += 2; continue; }
      if (c === CC.gt) { ok = true; break; }
      if (c === CC.lt || c === CC.lf) return null;
      k++;
    }
    if (!ok) return null;
    href = text.slice(j + 1, k);
    j = k + 1;
  } else {
    let k = j, depth = 0, bad = false;
    while (k < len) {
      const c = text.charCodeAt(k);
      if (c === CC.backslash && k + 1 < len && isPunct(text.charCodeAt(k + 1))) { k += 2; continue; }
      if (c <= 32) break;
      if (c === CC.lt || c === CC.gt) { bad = true; break; }
      if (c === CC.lparen) depth++;
      else if (c === CC.rparen) { if (depth === 0) break; depth--; }
      k++;
    }
    if (bad || depth !== 0) return null;
    href = text.slice(j, k);
    j = k;
  }
  skipWs();
  let title = null;
  const tc = text.charCodeAt(j);
  if (tc === CC.quote || tc === CC.apos || tc === CC.lparen) {
    const t = parseTitleAt(text, j);
    if (!t) return null;
    title = t.title;
    j = t.end;
    skipWs();
  }
  if (text.charCodeAt(j) !== CC.rparen) return null;
  return { href: cleanLinkText(href), title: title === null ? null : cleanLinkText(title), end: j + 1 };
}

// Scan a reference label starting at text[i] === '['. Returns {label, end}.
function scanRefLabel(text, i) {
  const len = text.length;
  let k = i + 1;
  while (k < len) {
    const c = text.charCodeAt(k);
    if (c === CC.backslash) { k += 2; continue; }
    if (c === CC.lbrack) return null;
    if (c === CC.rbrack) return { label: text.slice(i + 1, k), end: k + 1 };
    k++;
  }
  return null;
}

function nodeHtml(n, inLink) {
  switch (n.k) {
    case 'text': return escapeNoEncode(decodeTextEntities(n.s));
    case 'delim': return n.ch.repeat(n.n);
    case 'bracket': return n.image ? '![' : '[';
    case 'code': return '<code>' + escapeFull(n.text) + '</code>';
    case 'html': return inLink && n.auto ? escapeNoEncode(decodeTextEntities(n.p)) : n.s;
  }
  return '';
}

function nodePlain(n) {
  switch (n.k) {
    case 'text': return decodeTextEntities(n.s);
    case 'delim': return n.ch.repeat(n.n);
    case 'bracket': return n.image ? '![' : '[';
    case 'code': return n.text;
    case 'html': return n.p;
  }
  return '';
}

function rangeHtml(first, last, inLink) {
  let out = '';
  for (let n = first; n; n = n.next) { out += nodeHtml(n, inLink); if (n === last) break; }
  return out;
}

function rangePlain(first, last) {
  let out = '';
  for (let n = first; n; n = n.next) { out += nodePlain(n); if (n === last) break; }
  return out;
}

// The CommonMark delimiter-stack emphasis algorithm over the delim nodes in
// [first, last] (a range of the shared node list).


// ---------------------------------------------------------------------------
// marked's emStrong matcher, run over the node list. The "masked string" of
// marked's inline lexer is modeled by the nodes themselves: text nodes
// contribute their raw characters, delimiter nodes are the runs, and every
// other node (code spans, links, images, raw HTML, autolinks, dels) is
// opaque — only its first/last mask characters matter for classification.
// ---------------------------------------------------------------------------

const PUNCT_U = /[\p{P}\p{S}]/u;
function isPunctU(ch) { return ch !== '' && PUNCT_U.test(ch); }
function isPunctNt(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (PUNCT_U.test(ch) || /\s/.test(ch));
}
function isPunctNoTilde(ch) { return ch !== '' && ch !== '~' && PUNCT_U.test(ch); }
function firstCp(s) {
  if (!s) return '';
  const c = s.charCodeAt(0);
  return c >= 0xd800 && c <= 0xdbff && s.length > 1 ? s.slice(0, 2) : s.charAt(0);
}
function lastCp(s) {
  if (!s) return '';
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xdc00 && c <= 0xdfff && s.length > 1 ? s.slice(-2) : s.charAt(s.length - 1);
}
function maskFirstCh(n) {
  switch (n.k) {
    case 'text': return n.esc ? '\\' : firstCp(n.s);
    case 'delim': return n.ch;
    case 'code': return '`';
    case 'bracket': return n.image ? '!' : '[';
    case 'html': return n.mf !== undefined ? n.mf : '<';
  }
  return '';
}
function maskLastCh(n) {
  switch (n.k) {
    case 'text': return lastCp(n.s);
    case 'delim': return n.ch;
    case 'code': return '`';
    case 'bracket': return '[';
    case 'html': return n.ml !== undefined ? n.ml : '>';
  }
  return '';
}
function charClass(ch, forUnd) {
  if (ch === '') return '';
  if (/\s/.test(ch)) return 'space';
  return (forUnd ? isPunctU(ch) : isPunctNoTilde(ch)) ? 'punct' : 'nps';
}
// Classify a delimiter run by its neighbours, mirroring the alternative
// groups of marked's emStrongRDelim regexes (g1/g2 plain closers, g3/g4
// openers, g5/g6 conditional closers, null = not a candidate).
function classOfRun(prevCh, nextCh, forUnd) {
  const pc = charClass(prevCh, forUnd);
  if (pc === '') return null;
  const nc = charClass(nextCh, forUnd);
  if (pc === 'punct') {
    if (nc === 'space' || nc === '') return 'g1';
    if (nc === 'punct') return 'g5';
    if (nc === 'nps') return 'g3';
  } else if (pc === 'nps') {
    if (nc === 'punct' || nc === 'space' || nc === '') return 'g2';
    if (nc === 'nps' && !forUnd) return 'g6';
  } else {
    if (nc === 'nps') return 'g3';
    if (nc === 'punct') return 'g4';
  }
  return null;
}
// Try to match an em/strong starting at arr[idx] (a delim node), following
// marked's emStrong: LDelim gate, then a classified scan for the closer.
// Returns {closerIdx, use, bEff} or null.
function cpAtStr(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) return s.slice(i, i + 2);
  return s[i];
}
function cpBeforeStr(s, i) {
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const c2 = s.charCodeAt(i - 2);
    if (c2 >= 0xd800 && c2 <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function tryEmStrong(arr, idx, prevCh, ctx) {
  const node = arr[idx];
  const r = node.ch, k = node.n;
  // fe bound: no closer exists past v, and the attempt is void when
  // the bound falls before the opener's end.
  if (ctx && node.pos !== undefined && ctx.v[r] < node.pos - ctx.base + k) return null;
  const nextCh = idx + 1 < arr.length ? maskFirstCh(arr[idx + 1]) : '';
  let d = '', hasGroup = false;
  if (nextCh !== '' && nextCh !== r) {
    if (isPunctNoTilde(nextCh)) { d = nextCh; hasGroup = true; }
    else if (!/\s/.test(nextCh)) hasGroup = true;
  }
  if (!hasGroup) return null;
  let walk = 0, pCh = prevCh;
  if (ctx && node.pos !== undefined) {
    // The gate's walk-back and p come from the MASKED string: masked
    // chunks ([aaa...]) erase delimiter chars and change the char
    // that precedes the opener.
    const mp = node.pos - ctx.base;
    let w2 = 0;
    while (w2 < mp && ctx.mask.charAt(mp - 1 - w2) === r) w2++;
    walk = w2;
    const e = mp - walk;
    if (e > 0) {
      const c = ctx.mask.charCodeAt(e - 1);
      if (c >= 0xdc00 && c <= 0xdfff && e >= 2) {
        const c2 = ctx.mask.charCodeAt(e - 2);
        pCh = c2 >= 0xd800 && c2 <= 0xdbff ? ctx.mask.slice(e - 2, e) : ctx.mask[e - 1];
      } else pCh = ctx.mask[e - 1];
    } else pCh = '';
  } else if (idx > 0) {
    const pn = arr[idx - 1];
    if (pn.k === 'text') {
      const s = pn.s;
      let w = 0;
      while (w < s.length && s.charAt(s.length - 1 - w) === r) w++;
      if (w > 0) {
        walk = w;
        pCh = w < s.length ? lastCp(s.slice(0, s.length - w)) : (idx > 1 ? maskLastCh(arr[idx - 2]) : '');
      }
    }
  }
  const nEff = walk > 0 ? pCh : prevCh;
  if (r === '_' && d === '' && nEff !== '' && /[\p{L}\p{N}]/u.test(nEff)) return null;
  const h = pCh === '*' || pCh === '_' || isPunctNt(pCh);
  const u = walk > 0 ? h : isPunctNt(prevCh);
  if (!(d === '' || nEff === '' || u)) return null;
  const R = pCh !== '' && !/\s/.test(pCh) && (d !== '' || (r === '*' && !h));
  const o = prevCh === r;
  const y = walk + k;
  let m = k, f = 0;
  // The closer scan runs on the MASKED string (marked's RDelim exec):
  // runs inside masked chunks do not exist as candidates, run lengths
  // and flanking chars are read from the mask. Alt-1 (^-anchored, so
  // only at the very start of the scan) covers [text] DD [text] R
  // [text] (?=DD) — DD a run of exactly 2 of the other char, R a run
  // of exactly 1 — and hides that R-run.
  const useMask = ctx && node.pos !== undefined;
  const mbase = useMask ? ctx.base : 0;
  const mask = useMask ? ctx.mask : null;
  let hiddenPos = -1, hiddenIdx = -1;
  if (useMask) {
    const mlen = mask.length;
    let ev = 0, p = node.pos - mbase + k;
    while (p < mlen && ev < 3) {
      const c = mask[p];
      if (c !== '*' && c !== '_') { p++; continue; }
      let q = p + 1;
      while (q < mlen && mask[q] === c) q++;
      const runLen = q - p;
      ev++;
      if (ev === 1) { if (c === r || runLen !== 2) break; }
      else if (ev === 2) { if (c !== r || runLen !== 1) break; hiddenPos = p; }
      else if (ev === 3) { if (c === r || runLen < 2) hiddenPos = -1; }
      p = q;
    }
    if (ev < 3) hiddenPos = -1;
  } else {
    let ev = 0;
    for (let j = idx + 1; j < arr.length && ev < 3; j++) {
      const nd = arr[j];
      if (nd.k !== 'delim' || nd.n === 0) continue;
      ev++;
      if (ev === 1 && (nd.ch === r || nd.n !== 2)) break;
      if (ev === 2) { if (nd.ch !== r || nd.n !== 1) break; hiddenIdx = j; }
      if (ev === 3 && (nd.ch === r || nd.n < 2)) hiddenIdx = -1;
    }
    if (ev < 3) hiddenIdx = -1;
  }
  for (let j = idx + 1; j < arr.length; j++) {
    const nd = arr[j];
    if (nd.k !== 'delim' || nd.n === 0) continue;
    let b, prevC, nextC;
    if (useMask) {
      if (nd.pos === undefined || nd.ch !== r) continue;
      const mpj = nd.pos - mbase;
      if (mask[mpj] !== r) continue;
      if (mpj === hiddenPos) continue;
      if (mpj - 1 > ctx.v[r]) break;
      b = 0; while (mask[mpj + b] === r) b++;
      prevC = mpj > 0 ? cpBeforeStr(mask, mpj) : '';
      nextC = mpj + b < mask.length ? cpAtStr(mask, mpj + b) : '';
    } else {
      if (j === hiddenIdx) continue;
      if (nd.ch !== r) continue;
      prevC = j === idx + 1 ? r : maskLastCh(arr[j - 1]);
      nextC = j + 1 < arr.length ? maskFirstCh(arr[j + 1]) : '';
      b = nd.n;
    }
    const g = classOfRun(prevC, nextC, r === '_');
    if (g === null) continue;
    if (g === 'g3' || g === 'g4') { m += b; continue; }
    if (g === 'g5' || g === 'g6' || R) {
      if (o && (g === 'g5' || g === 'g6')) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) { continue; }
    const bEff = Math.min(b, b + m + f);
    const use = Math.min(k, bEff) % 2 === 1 ? 1 : 2;
    return { closerIdx: j, use, bEff };
  }
  return null;
}
function htmlOfNodes(arr, inLink) {
  let s = '';
  for (const n of arr) s += nodeHtml(n, inLink);
  return s;
}
function plainOfNodes(arr) {
  let s = '';
  for (const n of arr) s += nodePlain(n);
  return s;
}
// Left-to-right emStrong pass over a node array; returns the new array.
function emphasisPass(arr, inLink, ctx) {
  let prevCh = '';
  let i = 0;
  while (i < arr.length) {
    const node = arr[i];
    if (node.k !== 'delim' || node.n === 0) { prevCh = maskLastCh(node); i++; continue; }
    const res = tryEmStrong(arr, i, prevCh, ctx);
    if (!res) {
      if (node.n > 1) {
        node.n--;
        if (node.pos !== undefined) node.pos++;
        arr.splice(i, 0, { k: 'text', s: node.ch });
        prevCh = node.ch;
        i++;
      } else {
        arr[i] = { k: 'text', s: node.ch };
        prevCh = node.ch;
        i++;
      }
      continue;
    }
    const r = node.ch, k = node.n;
    const closerNode = arr[res.closerIdx];
    let segRaw = rawOfNode(node);
    for (let j = i + 1; j < res.closerIdx; j++) segRaw += rawOfNode(arr[j]);
    segRaw += rawOfNode(closerNode);
    const content = [];
    if (k - res.use > 0) content.push({ k: 'delim', ch: r, n: k - res.use, origN: k - res.use, pos: node.pos });
    for (let j = i + 1; j < res.closerIdx; j++) content.push(arr[j]);
    if (res.bEff - res.use > 0) content.push({ k: 'delim', ch: r, n: res.bEff - res.use, origN: res.bEff - res.use, pos: closerNode.pos !== undefined ? closerNode.pos + res.use : undefined });
    // marked re-lexes the wrapped content as a fresh inline text:
    // rebuild its raw string, rebase node positions onto it, and use
    // a fresh mask/fe context for the recursive pass.
    let contentRaw = '';
    for (const cn of content) { cn.pos = contentRaw.length; contentRaw += rawOfNode(cn); }
    const inner = content.some((n) => n.k === 'delim')
      ? emphasisPass(content, inLink, ctx ? maskCtx(contentRaw, ctx.defs, 0) : undefined)
      : content;
    const tag = res.use === 1 ? 'em' : 'strong';
    const wrap = {
      k: 'html',
      s: '<' + tag + '>' + htmlOfNodes(inner, inLink) + '</' + tag + '>',
      p: plainOfNodes(inner), mf: r, ml: r, raw: segRaw,
    };
    const replacement = [wrap];
    const leftover = closerNode.n - res.bEff;
    if (leftover > 0) replacement.push({ k: 'delim', ch: r, n: leftover, origN: leftover, pos: closerNode.pos !== undefined ? closerNode.pos + res.bEff : undefined });
    arr.splice(i, res.closerIdx - i + 1, ...replacement);
    prevCh = r;
    i++;
  }
  return arr;
}
function relinkNodes(arr, before) {
  let prev = before;
  for (const n of arr) { n.prev = prev; if (prev) prev.next = n; prev = n; }
  if (prev) prev.next = null;
  return prev;
}

// marked's link-label grammar (the `re` pattern): the label text must
// tokenize as nested bracket pairs, escapes, complete code spans, a
// trailing `` ``+ `` run, or plain chars (never a bare ']', '[', '\\'
// or backtick). A label that fails this makes the whole link fail.
function labelOk(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 >= n) return false;
      i += 2; continue;
    }
    if (c === '[') {
      // pair: '[' (Le | esc | char)* ']' where Le is a simple pair
      let j = i + 1, ok = false;
      while (j < n) {
        const d = s[j];
        if (d === '\\') { j += 2; continue; }
        if (d === ']') { ok = true; break; }
        if (d === '[') {
          let k = j + 1, ok2 = false;
          while (k < n) {
            const e = s[k];
            if (e === '\\') { k += 2; continue; }
            if (e === ']') { ok2 = true; break; }
            if (e === '[') break;
            k++;
          }
          if (!ok2) return false;
          j = k + 1; continue;
        }
        j++;
      }
      if (!ok) return false;
      i = j + 1; continue;
    }
    if (c === '`') {
      let run = 0; while (s[i + run] === '`') run++;
      let j = i + run;
      while (j < n && s[j] !== '`') j++;
      if (j < n) {
        let run2 = 0; while (s[j + run2] === '`') run2++;
        i = j + run2; continue;
      }
      return run >= 2 && i + run === n;
    }
    if (c === ']') return false;
    i++;
  }
  return true;
}

// ---- emStrong masking (behavior-matched to marked's mask + fe) ----
// Before emphasis scanning, marked masks the inline text: reflink
// chunks, link-shaped chunks, code spans and tags collapse to
// [aaa...] placeholders, escaped punctuation becomes '+', and code
// span interiors lose their backticks. fe() then records, per
// delimiter char, the last index of a run preceded by a non-space:
// emStrong never matches a closer past that bound (and never opens
// when the bound is before the opener's end).
const BT = '\x60';
const MASK_LABEL_SRC = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|' + BT + '+(?!' + BT + ')[^' + BT + ']*?' + BT + '+(?!' + BT + ')|' + BT + BT + '+(?=\\])|[^\\[\\]\\\\' + BT + '])*?';
const MASK_LINK_RE = new RegExp('^!?\\[(' + MASK_LABEL_SRC + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^\\s\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
const MASK_BLOCKSKIP_SRC = '\\[(?:[^\\[\\]' + BT + ']|(' + BT + '+)[^' + BT + ']+\\1(?!' + BT + '))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!' + BT + ')()(' + BT + '+)[^' + BT + ']+\\3(?!' + BT + ')|<(?! )[^<>]*?>';
const MASK_BLOCKSKIP_RE = new RegExp(MASK_BLOCKSKIP_SRC, 'g');
const MASK_REFLINK_SEARCH_SRC = '!?\\[((?:[^\\[\\]\\\\' + BT + ']*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|' + BT + '+(?!' + BT + ')[^' + BT + ']*?' + BT + '+(?!' + BT + ')|' + BT + BT + '+(?=\\]))){0,999}?[^\\[\\]\\\\' + BT + ']*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()';
const MASK_REFLINK_SEARCH_RE = new RegExp(MASK_REFLINK_SEARCH_SRC, 'g');

function linkInTextMask(e, defs) {
  if (!e.includes('[')) return false;
  const bs = new RegExp(MASK_BLOCKSKIP_SRC, 'g');
  for (const n of e.matchAll(bs)) {
    if (MASK_LINK_RE.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  const rs = new RegExp(MASK_REFLINK_SEARCH_SRC, 'g');
  for (const n of e.matchAll(rs)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (s.charAt(0) === '!' || !defs[normalizeLabel(s.slice(r + 1, -1))]) continue;
    if (!(r > 1 && linkInTextMask(s.slice(1, r - 1), defs))) return true;
  }
  return false;
}

function buildMask(text, defs) {
  let t = text;
  if (defs && text.includes('[')) {
    const s = (r) => {
      const o = r.lastIndexOf('[');
      if (!defs[normalizeLabel(r.slice(o + 1, -1))]) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInTextMask(inner, defs)) {
          return '[' + inner.replace(MASK_REFLINK_SEARCH_RE, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(MASK_REFLINK_SEARCH_RE, s);
  }
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu, (n, g1, g2) =>
      g2 ? '+'.repeat(n.length) : g1 ? g1 + n.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : n);
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(MASK_BLOCKSKIP_RE, (n, g1, g2) => {
      const o = g2 ? g2.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

const FE_RUN_RE = /\*+|_+/g;
function feBounds(mask) {
  const v = { '*': -1, '_': -1 };
  FE_RUN_RE.lastIndex = 0;
  let m;
  while ((m = FE_RUN_RE.exec(mask)) !== null) {
    const s = m.index;
    const o = s === 0 ? 32 : mask.charCodeAt(s - 1);
    if (o !== 32 && o !== 9 && o !== 10 && o !== 13 && o !== 12) v[m[0][0]] = s + m[0].length - 1;
  }
  return v;
}

function maskCtx(text, defs, base) {
  if (!text.includes('*') && !text.includes('_')) return undefined;
  const mask = buildMask(text, defs);
  return { v: feBounds(mask), base, mask, defs };
}

// The raw source text a node was scanned from (used to rebuild the
// content string when emphasis wraps recurse, mirroring marked's
// fresh inline lex of the wrapped content).
function rawOfNode(n) {
  switch (n.k) {
    case 'text': return n.esc ? '\\' + n.s : n.s;
    case 'delim': return n.ch.repeat(n.n);
    case 'bracket': return n.image ? '![' : '[';
    case 'code': return n.raw !== undefined ? n.raw : '';
    case 'html': return n.raw !== undefined ? n.raw : n.s;
  }
  return '';
}

// Scan inline text into a node list, resolving links and emphasis.
// Returns the rendered HTML.
// Find the end of the plain-text run starting at i: the first position
// > i where a construct can start (delimiter, bracket, code span, tag,
// autolink, email, hard break), or len. A shared regex scans natively
// for candidate positions; each candidate is verified in JS with the
// same conditions the old per-char loop used. runEnd never recurses,
// so the shared regex's lastIndex is safe.
const RUN_CANDIDATE = /[\\`<>[\]*_~!]|[A-Za-z0-9.+-]+@|(?:https?|ftp):\/\/|www\.|mailto:|xmpp:| {2,}\n/gi;
function runEnd(text, i, len) {
  RUN_CANDIDATE.lastIndex = i + 1;
  let m;
  while ((m = RUN_CANDIDATE.exec(text)) !== null) {
    const p = m.index;
    if (p >= len) break;
    const s = m[0];
    const c0 = s.charCodeAt(0);
    if (c0 === 32) {
      // hard-break candidate: spaces + newline; breaks only when
      // non-whitespace follows later in the text
      let q = p + s.length;
      while (q < len) { const c = text.charCodeAt(q); if (c === 32 || c === 9 || c === 10 || c === 13) q++; else break; }
      return q < len ? p : len;
    }
    if (s.length === 1) {
      if (c0 === 33) { // '!' breaks only before '['
        if (text.charCodeAt(p + 1) === 91) return p;
        continue;
      }
      return p; // a special char always breaks the run
    }
    if (c0 === 119 && s.charCodeAt(1) === 119) { // www.
      const prev = text.charCodeAt(p - 1);
      if (prev === 32 || prev === 9 || prev === 10 || prev === 42 || prev === 95 || prev === 126 || prev === 40) return p;
      continue;
    }
    if ((c0 === 109 || c0 === 120) && (s.startsWith('mailto:') || s.startsWith('xmpp:'))) { // mailto: / xmpp:
      if (!isAlnum(text.charCodeAt(p - 1))) {
        const plen = c0 === 109 ? 7 : 5;
        if (matchEmailAt(text, p + plen) !== -1) return p;
      }
      continue;
    }
    if (s.endsWith('@')) { // email candidate
      if (!isEmailCode(text.charCodeAt(p - 1)) && matchEmailAt(text, p) !== -1) return p;
      continue;
    }
    return p; // protocol autolink candidate
  }
  return len;
}

const INLINE_FAST_RE = /[`\\<>[\]*_~!@]| {2,}\n/;
function renderInline(text, defs, state) {
  // Fast path: no constructs at all (no escapes, code spans, tags,
  // brackets, delimiters, autolinks or hard breaks) — the output is
  // just the entity-decoded, escaped text.
  if (!INLINE_FAST_RE.test(text) && !text.includes('www.') && !text.includes('://')) {
    return escapeNoEncode(decodeTextEntities(text));
  }
  const strongRun = { '_': false };
  const head = { k: 'root', prev: null, next: null };
  let tail = head;
  const brackets = [];
  const push = (node) => { node.prev = tail; node.next = null; tail.next = node; tail = node; return node; };
  const pushText = (s) => {
    if (!s) return;
    if (tail.k === 'text' && !tail.esc) { tail.s += s; return; }
    push({ k: 'text', s });
  };
  const len = text.length;
  let i = 0;

  const formLink = (opener, href, title, endIdx, closeIdx) => {
    // marked's outputLink: the label is lexed with linkEmitted
    // tracking; if a link was emitted anywhere inside a non-image
    // label, the outer link is rejected (the ']' is literal and the
    // opener is discarded). Images absorb inner emissions.
    if (!opener.image && state && state.linkSeq > (opener.linkSeqAtPush || 0)) {
      brackets.splice(brackets.indexOf(opener), 1);
      opener.active = false;
      pushText(']');
      return closeIdx + 1;
    }
    if (state) state.linkSeq = (opener.linkSeqAtPush || 0) + (opener.image ? 0 : 1);
    // emphasis inside the link text is resolved first; processEmphasis
    // splices the node list, so the range is re-read from opener.next
    // afterwards (everything from there to the tail is the link content)
    const rangeArr = [];
    for (let n = opener.next; n; n = n.next) rangeArr.push(n);
    const labelStart = opener.srcIdx + (opener.image ? 2 : 1);
    const passed = rangeArr.some((n) => n.k === 'delim')
      ? emphasisPass(rangeArr, !opener.image, maskCtx(text.slice(labelStart, closeIdx), defs, labelStart))
      : rangeArr;
    relinkNodes(passed, opener);
    tail = passed.length ? passed[passed.length - 1] : opener;
    const first = passed.length ? passed[0] : null;
    let node;
    if (opener.image) {
      const plain = rangePlain(first, null);
      node = { k: 'html', s: buildImageHtml(href, title, plain), p: plain, mf: '!', ml: ')', raw: text.slice(opener.srcIdx, endIdx) };
    } else {
      const inner = rangeHtml(first, null, true);
      node = { k: 'html', s: buildLinkHtml(href, title, inner), p: rangePlain(first, null), mf: '[', ml: ')', raw: text.slice(opener.srcIdx, endIdx) };
    }
    // unlink opener..tail, append node after opener.prev
    node.prev = opener.prev;
    node.next = null;
    opener.prev.next = node;
    tail = node;
    // drop stack entries at or after opener; deactivate earlier link openers
    while (brackets.length && brackets[brackets.length - 1] !== opener) brackets.pop();
    brackets.pop();
    if (!opener.image) for (const b of brackets) if (!b.image) b.active = false;
    return endIdx;
  };

  const handleClose = (idx) => {
    // Only the nearest opener can match; if it was deactivated (e.g. a
    // link formed inside it), this ']' is literal and the opener is
    // discarded — older openers are NOT reconsidered.
    if (!brackets.length) { pushText(']'); return idx + 1; }
    const opener = brackets[brackets.length - 1];
    if (!opener.active) { brackets.pop(); pushText(']'); return idx + 1; }
    const next = text.charCodeAt(idx + 1);
    const textSrc = text.slice(opener.srcIdx + (opener.image ? 2 : 1), idx);
    const lok = labelOk(textSrc);
    if (next === CC.lparen) {
      const d = lok ? parseLinkDest(text, idx + 1) : null;
      if (d) return formLink(opener, d.href, d.title, d.end, idx);
      // fall through to shortcut reference
      const def = defs[normalizeLabel(textSrc)];
      if (def) return formLink(opener, def.href, def.title, idx + 1, idx);
      brackets.splice(brackets.indexOf(opener), 1);
      opener.active = false;
      pushText(']');
      return idx + 1;
    }
    if (next === CC.lbrack) {
      const lab = scanRefLabel(text, idx + 1);
      if (lab && lok) {
        const def = defs[normalizeLabel(lab.label === '' ? textSrc : lab.label)];
        if (def) return formLink(opener, def.href, def.title, lab.end, idx);
        brackets.splice(brackets.indexOf(opener), 1);
        opener.active = false;
        pushText(']');
        return idx + 1;
      }
      // unparseable second bracket: shortcut attempt below
    }
    const def = defs[normalizeLabel(textSrc)];
    if (def) return formLink(opener, def.href, def.title, idx + 1, idx);
    brackets.splice(brackets.indexOf(opener), 1);
    opener.active = false;
    pushText(']');
    return idx + 1;
  };

  const sealCheck = (labelStart) => {
    let depth = 0, e = -1;
    for (let j = labelStart; j < len; j++) {
      const cj = text.charCodeAt(j);
      if (cj === CC.backslash) { j++; continue; }
      if (cj === CC.lbrack) depth++;
      else if (cj === CC.rbrack) { if (depth === 0) { e = j; break; } depth--; }
    }
    if (e < 0) return -1;
    const labelText = text.slice(labelStart, e);
    if (!labelOk(labelText)) return -1;
    const nx = text.charCodeAt(e + 1);
    if (nx === CC.lparen) return parseLinkDest(text, e + 1) ? e : -1;
    if (nx === CC.lbrack) {
      const lab = scanRefLabel(text, e + 1);
      return lab && defs[normalizeLabel(lab.label === '' ? labelText : lab.label)] ? e : -1;
    }
    return defs[normalizeLabel(labelText)] ? e : -1;
  };

  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === CC.backslash) {
      const n = i + 1 < len ? text.charCodeAt(i + 1) : -1;
      if (n !== -1 && isPunct(n)) { push({ k: 'text', s: text[i + 1], esc: true }); i += 2; continue; }
      if (n === CC.lf && /\S/.test(text.slice(i + 2))) {
        push({ k: 'html', s: '<br>', p: '', raw: '\\\n' });
        i += 2;
        while (text.charCodeAt(i) === CC.space || text.charCodeAt(i) === CC.tab) i++;
        continue;
      }
      pushText('\\'); i++; continue;
    }
    if (c === CC.backtick) {
      // With brackets open, marked consumes a label via its link
      // regex before any code span inside it is scanned, so inside a
      // bracket that will form a link ("sealed" at push time), a code
      // span whose closing run lies past the bracket's ']' never
      // forms. In unsealed brackets spans pair freely.
      let bound;
      for (let q = brackets.length - 1; q >= 0; q--) {
        { const b = brackets[q]; if (b.sealed > i && (b.image || !state || state.linkSeq <= (b.linkSeqAtPush || 0))) { bound = b.sealed; break; } }
      }
      const cs = scanCodeSpan(text, i, bound);
      if (cs) { push({ k: 'code', text: cs.text, raw: text.slice(i, cs.end) }); i = cs.end; continue; }
      let n = 0; while (text.charCodeAt(i + n) === CC.backtick) n++;
      pushText('`'.repeat(n)); i += n; continue;
    }
    if (c === CC.lt) {
      const a = scanAngle(text, i);
      if (a) {
        if (a.kind === 'link') push({ k: 'html', s: buildAutolinkHtml(a.text, a.href), p: a.text, raw: a.text });
        else {
          push({ k: 'html', s: a.text, p: a.text });
          if (state) {
            if (/^<a\s/i.test(a.text)) state.inLink = true;
            else if (/^<\/a[\s>]/i.test(a.text)) state.inLink = false;
          }
        }
        i = a.end; continue;
      }
      pushText('<'); i++; continue;
    }
    if (c === CC.bang && text.charCodeAt(i + 1) === CC.lbrack) {
      const node = push({ k: 'bracket', image: true, active: true, srcIdx: i, linkSeqAtPush: state ? state.linkSeq : 0, sealed: sealCheck(i + 2) });
      brackets.push(node); i += 2; continue;
    }
    if (c === CC.lbrack) {
      const node = push({ k: 'bracket', image: false, active: true, srcIdx: i, linkSeqAtPush: state ? state.linkSeq : 0, sealed: sealCheck(i + 1) });
      brackets.push(node); i++; continue;
    }
    if (c === CC.rbrack) { i = handleClose(i); continue; }
    if (c === CC.star || c === CC.under) {
      let n = 0; while (text.charCodeAt(i + n) === c) n++;
      const f = flanking(text, i, i + n);
      let canOpen, canClose;
      if (c === CC.star) { canOpen = f.left; canClose = f.right; }
      else {
        const before = cpBefore(text, i), after = cpAfter(text, i + n);
        const beforeP = before !== -1 && isUnicodePunct(before);
        const afterP = after !== -1 && isUnicodePunct(after);
        canOpen = f.left && (!f.right || beforeP);
        canClose = f.right && (!f.left || afterP);
      }
      if (c === CC.under) strongRun._ = canOpen;
      push({ k: 'delim', ch: text[i], n, origN: n, canOpen, canClose, pos: i });
      i += n; continue;
    }
    if (c === CC.tilde) {
      const d = scanDel(text, i);
      if (d) {
        // Inside a link label, marked lexes with inLink set, which
        // suppresses bare autolinks anywhere in the label — including
        // inside del content (rendered eagerly here).
        let inner;
        let sealedLabel = false;
        for (let q = brackets.length - 1; q >= 0; q--) { const b = brackets[q]; if (b.sealed > i && (b.image || !state || state.linkSeq <= (b.linkSeqAtPush || 0))) { sealedLabel = true; break; } }
        if (sealedLabel && state && !state.inLink) {
          state.inLink = true;
          inner = renderInline(d.text, defs, state);
          state.inLink = false;
        } else inner = renderInline(d.text, defs, state);
        push({ k: 'html', s: '<del>' + inner + '</del>', p: renderPlainText(d.text, defs), mf: '~', ml: '~', raw: text.slice(i, d.end) });
        i = d.end; continue;
      }
      pushText('~'); i++; continue;
    }
    if (c === CC.space) {
      // possible hard break: 2+ spaces then newline, with content after;
      // the following line's leading spaces are consumed by the break
      let k = i; while (text.charCodeAt(k) === CC.space) k++;
      if (k - i >= 2 && text.charCodeAt(k) === CC.lf && /\S/.test(text.slice(k + 1))) {
        push({ k: 'html', s: '<br>', p: '', raw: text.slice(i, k + 1) });
        i = k + 1;
        while (text.charCodeAt(i) === CC.space || text.charCodeAt(i) === CC.tab) i++;
        continue;
      }
    }
    // bare autolink? (suppressed inside a link label that will form:
    // marked lexes labels with inLink set, so no autolink tokens)
    if ((isAlpha(c) || isDigit(c)) && !(state && state.inLink)) {
      let sealedOpen = false;
      for (let q = brackets.length - 1; q >= 0; q--) { const b = brackets[q]; if (b.sealed > i && (b.image || !state || state.linkSeq <= (b.linkSeqAtPush || 0))) { sealedOpen = true; break; } }
      let u = null;
      if (!sealedOpen) {
        // cheap pre-gate: scanBareUrl can only match a mailto:/xmpp:
        // prefix, a protocol, www., or an email shape from here
        if (c === 109 || c === 120 || c === 104 || c === 72 || c === 102 || c === 70 || c === 119) {
          u = scanBareUrl(text, i, strongRun._);
        } else if (isEmailCode(c)) {
          let e2 = i + 1;
          while (e2 < len && isEmailCode(text.charCodeAt(e2))) e2++;
          if (text.charCodeAt(e2) === 64) u = scanBareUrl(text, i, strongRun._);
        }
      }
      if (u) { push({ k: 'html', s: buildAutolinkHtml(u.text, u.href), p: u.text, auto: true, mf: firstCp(u.text), ml: lastCp(u.text), raw: u.text }); i = u.end; continue; }
    }
    // plain text run
    const j = runEnd(text, i, len);
    pushText(text.slice(i, j));
    i = j;
  }

  const allArr = [];
  for (let n = head.next; n; n = n.next) allArr.push(n);
  const passedAll = allArr.some((n) => n.k === 'delim')
    ? emphasisPass(allArr, false, maskCtx(text, defs, 0))
    : allArr;
  let out = '';
  for (const n of passedAll) {
    switch (n.k) {
      case 'text': out += escapeNoEncode(decodeTextEntities(n.s)); break;
      case 'delim': out += n.ch.repeat(n.n); break;
      case 'bracket': out += n.image ? '![' : '['; break;
      case 'code': out += '<code>' + escapeFull(n.text) + '</code>'; break;
      case 'html': out += n.s; break;
    }
  }
  return out;
}

// Plain-text rendering of inline source (for image alt attributes).
function renderPlainText(text, defs) {
  // Reuse the node machinery by rendering with a plain flag would need a
  // second pass; alt text is rare and short, so run a dedicated light scan:
  // simplest correct approach is to render the HTML then strip the tags
  // marked's text renderer keeps. Instead, we approximate marked's text
  // renderer directly here by parsing with the same scanner but asking for
  // plain output — implemented by renderInlinePlain below.
  return renderInlinePlain(text, defs);
}

function renderInlinePlain(text, defs) {
  // A simplified mirror of renderInline that yields plain text: it shares
  // the heavy lifting by rendering HTML for structure and is only used for
  // short alt strings; correctness for alt is handled by the caller using
  // node-level plain values when a full parse happens there. For a direct
  // string call (del contents), fall back to HTML + tag strip.
  const html = renderInline(text, defs);
  return html.replace(/<[^>]*>/g, '');
}

function buildLinkHtml(href, title, innerHtml) {
  const clean = cleanUrl(href);
  if (clean === null) return innerHtml;
  let out = '<a href="' + escapeNoEncode(clean) + '"';
  if (title) out += ' title="' + escapeNoEncode(title) + '"';
  return out + '>' + innerHtml + '</a>';
}

function buildImageHtml(href, title, plain) {
  const clean = cleanUrl(href);
  if (clean === null) return escapeNoEncode(plain);
  let out = '<img src="' + escapeNoEncode(clean) + '" alt="' + escapeNoEncode(plain) + '"';
  if (title) out += ' title="' + escapeNoEncode(title) + '"';
  return out + '>';
}

function buildAutolinkHtml(text, href) {
  const clean = cleanUrl(href);
  if (clean === null) return escapeFull(text);
  return '<a href="' + escapeFull(clean) + '">' + escapeFull(text) + '</a>';
}

// ---------------------------------------------------------------------------
// Block rendering — marked's exact output shapes.
// ---------------------------------------------------------------------------

function renderCodeBlock(tok) {
  let text = tok.text;
  if (text) text = text.replace(/\n$/, '') + '\n';
  const lang = tok.lang ? cleanLinkText(tok.lang) : '';
  if (!lang) return '<pre><code>' + escapeFull(text) + '</code></pre>\n';
  return '<pre><code class="language-' + escapeNoEncode(lang) + '">' + escapeFull(text) + '</code></pre>\n';
}

function renderListItem(item, loose, defs, state) {
  let content = '';
  for (let idx = 0; idx < item.tokens.length; idx++) {
    const t = item.tokens[idx];
    if (t.t === 'paragraph') {
      if (item.task && loose && idx === 0) {
        content += '<p>' + checkboxHtml(item.checked) + renderInline(t.text, defs, state) + '</p>\n';
      } else if (loose) {
        content += '<p>' + renderInline(t.text, defs, state) + '</p>\n';
      } else {
        content += renderInline(t.text, defs, state);
      }
    } else {
      content += renderBlock(t, defs, state);
    }
  }
  if (item.task && !(loose && item.tokens[0] && item.tokens[0].t === 'paragraph')) {
    content = checkboxHtml(item.checked) + content;
  }
  return '<li>' + content + '</li>\n';
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTable(tok, defs, state) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < tok.header.length; c++) {
    const align = tok.align[c];
    out += (align ? '<th align="' + align + '">' : '<th>') + renderInline(tok.header[c], defs, state) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (tok.rows.length) {
    out += '<tbody>';
    for (const row of tok.rows) {
      out += '<tr>\n';
      for (let c = 0; c < tok.header.length; c++) {
        const align = tok.align[c];
        out += (align ? '<td align="' + align + '">' : '<td>') + renderInline(row[c] ?? '', defs, state) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

function renderBlock(tok, defs, state) {
  switch (tok.t) {
    case 'code': return renderCodeBlock(tok);
    case 'heading': return '<h' + tok.depth + '>' + renderInline(tok.text, defs, state) + '</h' + tok.depth + '>\n';
    case 'hr': return '<hr>\n';
    case 'html': return tok.text;
    case 'paragraph': return '<p>' + renderInline(tok.text, defs, state) + '</p>\n';
    case 'blockquote': {
      let inner = '';
      for (const t of tok.tokens) inner += renderBlock(t, defs, state);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      let out = '<' + tag + (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n';
      for (const item of tok.items) out += renderListItem(item, tok.loose, defs, state);
      return out + '</' + tag + '>\n';
    }
    case 'table': return renderTable(tok, defs, state);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const defs = Object.create(null);
  const state = { inLink: false, linkSeq: 0 };
  const tokens = lexBlocks(src, defs);
  let out = '';
  for (const t of tokens) out += renderBlock(t, defs, state);
  return out;
}
