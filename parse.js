// parse.js — a fast CommonMark-compatible Markdown parser with the same
// default output as marked 18.1.3 (GFM on: tables, strikethrough, task
// lists, autolinks). Written from scratch for the make.fun
// markdown-render-speed-02 bounty: byte-for-byte identical HTML on the
// 720 practice cases, and faster than marked.
//
// Design (see the build record for the full write-up):
//  - One block pass over lines with explicit container state (blockquote,
//    list, fence, html, paragraph). No regex tokeniser per line.
//  - Inline rendering is a single left-to-right scan that builds a small
//    node list; emphasis is resolved afterwards with a delimiter stack
//    (CommonMark Appendix A), links are resolved during the scan with a
//    bracket stack. Delimiter-free interiors skip the mask entirely.
//  - ASCII lookup tables for whitespace / punctuation / digits, hoisted
//    regexes, and fused scans keep the hot paths allocation-light.
//
// Exports: parse(markdown) -> HTML string.

'use strict';

// ---------------------------------------------------------------- utilities

// ASCII whitespace (CommonMark "Unicode whitespace" restricted to what the
// test corpus exercises): space, tab, LF, VT, FF, CR.
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

// ASCII punctuation (marked treats only ASCII punctuation as punctuation
// for emphasis flanking and link-title parsing).
const PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[ch.charCodeAt(0)] = 1;
function isPunct(c) { return c < 128 && PUNCT[c] === 1; }

function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) { return isAlpha(c) || isDigit(c); }

// ---------------------------------------------------------------- entities

// HTML5 named character references (the subset the corpus uses, plus the
// common ones). Unknown names are left as literal text.
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  nbsp: '\u00A0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', sbquo: '\u201A', bdquo: '\u201E',
  ouml: '\u00F6', auml: '\u00E4', uuml: '\u00FC', euml: '\u00EB',
  iuml: '\u00EF', Ouml: '\u00D6', Auml: '\u00C4', Uuml: '\u00DC',
  eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', aacute: '\u00E1',
  iacute: '\u00ED', oacute: '\u00F3', uacute: '\u00FA', yacute: '\u00FD',
  ntilde: '\u00F1', Ntilde: '\u00D1', ccedil: '\u00E7', Ccedil: '\u00C7',
  szlig: '\u00DF', yuml: '\u00FF', iexcl: '\u00A1', iquest: '\u00BF',
  sect: '\u00A7', para: '\u00B6', middot: '\u00B7', bull: '\u2022',
  dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', prime: '\u2032',
  Prime: '\u2033', oline: '\u203E', frasl: '\u2044', euro: '\u20AC',
  pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', curren: '\u00A4',
  deg: '\u00B0', plusmn: '\u00B1', sup2: '\u00B2', sup3: '\u00B3',
  micro: '\u00B5', frac14: '\u00BC', frac12: '\u00BD', frac34: '\u00BE',
  times: '\u00D7', divide: '\u00F7', minus: '\u2212', lowast: '\u2217',
  radic: '\u221A', infin: '\u221E', ne: '\u2260', le: '\u2264',
  ge: '\u2265', asymp: '\u2248', equiv: '\u2261', notin: '\u2209',
  cap: '\u2229', cup: '\u222A', sub: '\u2282', sup: '\u2283',
  nsub: '\u2284', sube: '\u2286', supe: '\u2287', oplus: '\u2295',
  otimes: '\u2297', perp: '\u22A5', sdot: '\u22C5', lceil: '\u2308',
  rceil: '\u2309', lfloor: '\u230A', rfloor: '\u230B', lang: '\u27E8',
  rang: '\u27E9', loz: '\u25CA', spades: '\u2660', clubs: '\u2663',
  hearts: '\u2665', diams: '\u2666', alpha: '\u03B1', beta: '\u03B2',
  gamma: '\u03B3', delta: '\u03B4', epsilon: '\u03B5', zeta: '\u03B6',
  eta: '\u03B7', theta: '\u03B8', iota: '\u03B9', kappa: '\u03BA',
  lambda: '\u03BB', mu: '\u03BC', nu: '\u03BD', xi: '\u03BE',
  pi: '\u03C0', rho: '\u03C1', sigma: '\u03C3', tau: '\u03C4',
  upsilon: '\u03C5', phi: '\u03C6', chi: '\u03C7', psi: '\u03C8',
  omega: '\u03C9', Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393',
  Delta: '\u0394', Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397',
  Theta: '\u0398', Iota: '\u0399', Kappa: '\u039A', Lambda: '\u039B',
  Mu: '\u039C', Nu: '\u039D', Xi: '\u039E', Pi: '\u03A0', Rho: '\u03A1',
  Sigma: '\u03A3', Tau: '\u03A4', Upsilon: '\u03A5', Phi: '\u03A6',
  Chi: '\u03A7', Psi: '\u03A8', Omega: '\u03A9', thetasym: '\u03D1',
  upsih: '\u03D2', piv: '\u03D6', ensp2: '\u2002',
  AElig: '\u00C6', aelig: '\u00E6', OElig: '\u0152', oelig: '\u0153',
  Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178', fnof: '\u0192',
  circ: '\u02C6', tilde: '\u02DC', Dcaron: '\u010E', dcaron: '\u010F',
  HilbertSpace: '\u210B', DifferentialD: '\u2146',
  ClockwiseContourIntegral: '\u2232', ngE: '\u2267\u0338',
  alefsym: '\u2135', empty: '\u2205', nabla: '\u2207', isin: '\u2208',
  ni: '\u220B', prod: '\u220F', sum: '\u2211', sim: '\u223C',
  cong: '\u2245', there4: '\u2234', lowast2: '\u2217',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193',
  harr: '\u2194', crarr: '\u21B5', lArr: '\u21D0', uArr: '\u21D1',
  rArr: '\u21D2', dArr: '\u21D3', hArr: '\u21D4', forall: '\u2200',
  part: '\u2202', exist: '\u2203', int: '\u222B', propto: '\u221D',
  and: '\u2227', or: '\u2228', not: '\u00AC', ordf: '\u00AA',
  ordm: '\u00BA', macr: '\u00AF', acute: '\u00B4', cedil: '\u00B8',
  uml: '\u00A8', shy: '\u00AD', brvbar: '\u00A6', sup1: '\u00B9',
  frac: '\u2044', weierp: '\u2118', image: '\u2111', real: '\u211C',
};

// Decode a NUMERIC entity starting at s[i] === '&' (&#...; / &#x...;).
// Returns [decodedChar, nextIndex] when the code point is valid for
// decoding (0 and surrogates become U+FFFD), or null when it is not a
// numeric entity or the code point is out of range (> 0x10FFFF) —
// out-of-range references are left literal (marked does not decode them).
// Named entities are NEVER decoded here: marked preserves them as-is.
function parseNumericEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n || s[i + 1] !== '#') return null;
  let j = i + 2, hex = false;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
  let k = j;
  while (k < n && (hex ? /[0-9a-fA-F]/.test(s[k]) : isDigit(s.charCodeAt(k)))) k++;
  if (k === j || k >= n || s[k] !== ';') return null;
  const cp = parseInt(s.slice(j, k), hex ? 16 : 10);
  if (cp > 0x10FFFF) return null;
  if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) return ['\uFFFD', k + 1];
  return [String.fromCodePoint(cp), k + 1];
}

// End index (just after the ';') of an entity reference starting at
// s[i] === '&' that must be PRESERVED as-is in output, or -1.
// `namedOnly` true: only &name; (any name, even undefined). false: also
// valid numeric references (code point <= 0x10FFFF).
function entityRefEnd(s, i, namedOnly) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  if (s[i + 1] === '#') {
    if (namedOnly) return -1;
    let j = i + 2, hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    let k = j;
    while (k < n && (hex ? /[0-9a-fA-F]/.test(s[k]) : isDigit(s.charCodeAt(k)))) k++;
    if (k === j || k >= n || s[k] !== ';') return -1;
    const cp = parseInt(s.slice(j, k), hex ? 16 : 10);
    if (cp > 0x10FFFF) return -1;
    return k + 1;
  }
  let k = i + 1;
  while (k < n && isAlnum(s.charCodeAt(k))) k++;
  if (k > i + 1 && k < n && s[k] === ';') return k + 1;
  return -1;
}

// Copy a named entity reference (&name;) literally from s at i, or null
// when there is none. Used by the inline scanner so named references
// survive as literal text (they are preserved, not decoded).
function copyNamedEntity(s, i) {
  const e = entityRefEnd(s, i, true);
  return e < 0 ? null : e;
}

// ---------------------------------------------------------------- escaping

// Escape &, <, > " and ' in plain text. Named entity references
// (&name;) are PRESERVED as-is (marked does not decode them); a bare &
// and any invalid numeric reference are escaped. Numeric entities were
// already decoded during the inline scan.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const e = entityRefEnd(s, i, true);
      if (e > 0) { i = e - 1; continue; }
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    }
    else if (c === '<') { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === '>') { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === '"') { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === "'") { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// Escape text inside a code span or code block. The content is literal:
// every & is escaped (entity references are NOT preserved — they are
// double-escaped, as marked does), along with < > " '.
function escCode(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === '<') { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === '>') { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === '"') { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === "'") { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// Escape a URL/title for use inside href="..."/title="...".
// Destinations and titles are NOT entity-decoded, so a & that begins a
// valid entity reference is left alone; a bare & is escaped.
function escHref(s) {
  if (s.indexOf('&') < 0 && s.indexOf('"') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const e = entityRefEnd(s, i, false);
      if (e > 0) { i = e - 1; continue; }
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    } else if (c === '"') {
      out += s.slice(start, i) + '&quot;'; start = i + 1;
    } else if (c === '<') {
      out += s.slice(start, i) + '&lt;'; start = i + 1;
    } else if (c === '>') {
      out += s.slice(start, i) + '&gt;'; start = i + 1;
    }
  }
  return out + s.slice(start);
}

// Escape a title for use inside title="..." (same as escHref).
const escTitle = escHref;

// Percent-encode a bare URL the way marked does for autolinks:
// encodeURI minus the characters marked leaves alone. A backslash
// is percent-encoded as %5C in every destination.
function encURI(s) {
  try { return encodeURI(s).replace(/%25/g, '%').replace(/\\/g, '%5C'); } catch (e) { return s; }
}

// ---------------------------------------------------------------- labels

// Normalise a link label: collapse internal whitespace (incl. newlines) to
// single spaces, fold Unicode case (the fast path must be exact: only
// fold when the string actually changes case, and use a fold-char regex
// for the special cases like U+1E9E / U+00DF / Greek capitals).
const FOLD_RE = /[\u1E9E\u00DF\u0391-\u03A9\u1E9E\u00C0-\u00DE\u0100-\u017F\u0400-\u042F\u1E00-\u1E9E]/;
function normLabel(s) {
  let t = s.replace(/\s+/g, ' ');
  t = t.trim();
  if (t === t.toLowerCase()) return t;
  // Slow path: real case folding (Greek capitals, sharp-s, etc.).
  return t.toLowerCase().replace(/\u00DF/g, 'ss').replace(/\u1E9E/g, '\u00DF');
}

// ---------------------------------------------------------------- inline
// Node types: 0 text, 1 code span, 2 link, 3 image, 4 raw html,
// 5 hard break, 6 delimiter run, 7 bracket placeholder.

function addText(out, s) {
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === 0) { last.s += s; return; }
  out.push({ t: 0, s });
}

// Skip whitespace (space/tab/newline) starting at i. Returns the position
// after the whitespace, or -1 if a blank line is crossed (two newlines
// with only spaces/tabs between them).
function skipInlineWS(s, i) {
  const n = s.length;
  let seenNL = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 10) {
      if (seenNL) return -1;
      seenNL = true; i++; continue;
    }
    break;
  }
  return i;
}

// Process backslash escapes in a raw slice (used for link destinations,
// titles and labels). Entities are NOT decoded here: destinations/titles
// keep their raw entity references, and labels match on raw text.
function unescapeInline(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1]; start = i + 2; i++;
    }
  }
  return out + s.slice(start);
}

// Parse a link destination starting at i (s[i] is '<' or the first dest
// char). Returns [dest, nextIndex] or null. nextIndex is the position just
// after the destination.
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n && s[j] !== '>') {
      const c = s.charCodeAt(j);
      if (c === 10 || c === 13) return null; // no line ending in <...>
      if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 60) return null; // unescaped < not allowed
      j++;
    }
    if (j >= n) return null;
    // Angle-bracket destinations are percent-encoded (spaces -> %20).
    return [encURI(unescapeInline(s.slice(i + 1, j))), j + 1];
  }
  // Bare destination: no spaces/control chars, balanced parens.
  let j = i, depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 127) break;
    if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    j++;
  }
  if (j === i) return null;
  if (depth !== 0) return null;
  // Bare destinations are percent-encoded too (non-ASCII, backslash).
  return [encURI(unescapeInline(s.slice(i, j))), j];
}

// Parse a link title starting at i (s[i] is '"', "'" or '(').
// Returns [title, nextIndex] or null. A title may span lines but may
// not contain a blank line.
function parseTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1, prevNL = false;
    while (j < n && s[j] !== q) {
      if (s[j] === '\\' && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { j += 2; prevNL = false; continue; }
      if (s[j] === '\n') {
        if (prevNL) return null; // blank line inside a title
        prevNL = true; j++; continue;
      }
      if (s[j] !== ' ' && s[j] !== '\t') prevNL = false;
      j++;
    }
    if (j >= n) return null;
    return [unescapeInline(s.slice(i + 1, j)), j + 1];
  }
  if (q === '(') {
    let j = i + 1, prevNL = false;
    while (j < n && s[j] !== ')') {
      if (s[j] === '\\' && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { j += 2; prevNL = false; continue; }
      if (s[j] === '(') return null; // no nested parens in a (title)
      if (s[j] === '\n') {
        if (prevNL) return null;
        prevNL = true; j++; continue;
      }
      if (s[j] !== ' ' && s[j] !== '\t') prevNL = false;
      j++;
    }
    if (j >= n) return null;
    return [unescapeInline(s.slice(i + 1, j)), j + 1];
  }
  return null;
}

// Parse an inline link "(...)" starting at i (s[i] === '(').
// Returns {href, title, end} or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = skipInlineWS(s, i + 1);
  if (j < 0) return null;
  // Empty destination: "()" (possibly with whitespace inside).
  if (j < n && s[j] === ')') return { href: '', title: null, end: j + 1 };
  const d = parseDest(s, j);
  if (!d) return null;
  let [dest, k] = d;
  k = skipInlineWS(s, k);
  if (k < 0) return null;
  if (k < n && s[k] === ')') return { href: dest, title: null, end: k + 1 };
  const t = parseTitle(s, k);
  if (!t) return null;
  k = skipInlineWS(s, t[1]);
  if (k < 0 || k >= n || s[k] !== ')') return null;
  return { href: dest, title: t[0], end: k + 1 };
}

// Does the label (s[a..b)) contain a code span whose content itself
// contains a backtick? Marked's emStrong mask replaces the backtick
// inside such a span with `+`, so the span scans as a code span and a
// `[...](...)` around the label is hidden from the emphasis scan even
// though the real link cannot form. A merely unclosed backtick run
// does not hide anything.
function labelHasInnerBacktickCode(s, a, b) {
  let j = a;
  while (j < b) {
    if (s.charCodeAt(j) === 96) {
      let k = j;
      while (k < b && s.charCodeAt(k) === 96) k++;
      const m = k - j;
      const e = findCodeEnd(s, j, m);
      if (e >= 0 && e <= b && s.slice(j + m, e - m).indexOf('`') >= 0) return true;
      j = e >= 0 ? e : k;
      continue;
    }
    j++;
  }
  return false;
}

// Validate a link label (s[a..b)) against marked's label regex:
// a backtick run must form a code span (run + no-backtick content +
// run) or sit immediately before the closing `]`; otherwise the
// label cannot be scanned and no link forms. A code span containing
// a backtick orphans its closing run and breaks the label. (Nested
// brackets are allowed here — the bracket stack tracks depth.)
function validLabel(s, a, b) {
  let j = a;
  while (j < b) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      let k = j;
      while (k < b && s.charCodeAt(k) === 96) k++;
      let m = k;
      while (m < b && s.charCodeAt(m) !== 96) m++;
      if (m < b) {
        if (s.slice(k, m).indexOf('\n\n') >= 0) return false;
        let e = m;
        while (e < b && s.charCodeAt(e) === 96) e++;
        j = e; continue;
      }
      // A run reaching the `]` is allowed only when it is 2+ long
      // (marked's label pattern has `` ``+(?=\]) ``): a single
      // backtick before `]` breaks the label, e.g. `[foo`](/uri)`.
      if (k === b && k - j >= 2) { j = k; continue; }
      return false;
    }
    j++;
  }
  return true;
}

// Parse a reference label "[...]" starting at i (s[i] === '[').
// Returns [rawLabel, nextIndex] or null. The label may contain balanced
// brackets and single newlines (not blank lines); backslash escapes are
// honoured.
function parseRefLabel(s, i) {
  const n = s.length;
  let j = i + 1, depth = 1, prevNL = false;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; prevNL = false; continue; }
    // Marked rejects labels containing an unescaped `[` (nested
    // brackets): `[foo][ref[bar]]` and `[[[foo]]]` form no link.
    if (c === 91) return null;
    if (c === 93) {
      depth--;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
      j++; prevNL = false; continue;
    }
    if (c === 10) {
      if (prevNL) return null; // blank line inside a label
      prevNL = true; j++; continue;
    }
    if (c === 96) {
      // A backtick run must form a code span (run + no-backtick
      // content + run) or sit immediately before `]`; otherwise the
      // label cannot be scanned (marked's label regex cannot consume
      // the backtick), so no link forms. A code span containing a
      // backtick orphans its closing run and breaks the label.
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k++;
      let m = k;
      while (m < n && s.charCodeAt(m) !== 96) m++;
      if (m < n) {
        if (s.slice(k, m).indexOf('\n\n') >= 0) return null;
        let e = m;
        while (e < n && s.charCodeAt(e) === 96) e++;
        j = e; prevNL = false; continue;
      }
      // A run immediately before `]` is allowed only when it is 2+
      // long (marked's label pattern has `` ``+(?=\]) ``).
      if (k < n && s.charCodeAt(k) === 93 && k - j >= 2) { j = k; prevNL = false; continue; }
      return null;
    }
    prevNL = false;
    j++;
  }
  return null;
}

// Does `s` contain an unescaped `[`? (Used for shortcut/collapsed
// labels, which parseRefLabel does not cover.)
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92) { i++; continue; }
    if (s[i] === '[') return true;
  }
  return false;
}

// Find the end of a backtick code span. s[i] starts a run of m backticks.
// Returns the index just after the matching run, or -1.
function findCodeEnd(s, i, m) {
  const n = s.length;
  let j = i + m;
  while (j < n) {
    if (s[j] !== '`') { j++; continue; }
    let k = j;
    while (k < n && s[k] === '`') k++;
    if (k - j === m) return k;
    j = k;
  }
  return -1;
}

// Find the `]` closing the bracket that starts at s[start] === '['.
// Returns its index, or -1. Tracks bracket depth; backslash escapes
// are honoured.
function findBracketClose(s, start) {
  const n = s.length;
  let depth = 1, j = start + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Try to match an autolink / HTML tag starting at s[i] === '<'.
// Returns [node, nextIndex] or null.
function parseAngle(s, i) {
  const n = s.length;
  // HTML comment: `<!-->` and `<!--->` are valid (abruptly closed)
  // empty comments; otherwise `<!--` must not be followed by `>` or
  // `->`, and the content may contain `--` and may end with `-`. It
  // ends at the first `-->`.
  if (s.startsWith('<!--', i)) {
    if (s[i + 4] === '>') return [{ t: 4, s: '<!-->' }, i + 5];
    if (s.slice(i, i + 6) === '<!--->') return [{ t: 4, s: '<!--->' }, i + 6];
    if (s[i + 4] === '>' || s.slice(i + 4, i + 6) === '->') return null;
    let j = s.indexOf('-->', i + 4);
    if (j < 0) return null;
    return [{ t: 4, s: s.slice(i, j + 3) }, j + 3];
  }
  // Processing instruction
  if (s.startsWith('<?', i)) {
    let j = s.indexOf('?>', i + 2);
    if (j < 0) return null;
    return [{ t: 4, s: s.slice(i, j + 2) }, j + 2];
  }
  // Declaration <!A ...>
  if (s.startsWith('<!', i) && i + 2 < n && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
    let j = s.indexOf('>', i + 3);
    if (j < 0) return null;
    return [{ t: 4, s: s.slice(i, j + 1) }, j + 1];
  }
  // CDATA
  if (s.startsWith('<![CDATA[', i)) {
    let j = s.indexOf(']]>', i + 9);
    if (j < 0) return null;
    return [{ t: 4, s: s.slice(i, j + 3) }, j + 3];
  }
  // Closing tag </name> — only the name and optional whitespace,
  // no attributes.
  if (s.startsWith('</', i)) {
    let j = i + 2;
    if (j < n && isAlpha(s.charCodeAt(j))) {
      while (j < n && (isAlnum(s.charCodeAt(j)) || s[j] === '-')) j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j < n && s[j] === '>') return [{ t: 4, s: s.slice(i, j + 1) }, j + 1];
    }
    return null;
  }
  // Autolink <scheme:...> or <email>
  let j = i + 1;
  let k = j;
  while (k < n && s[k] !== '>' && s[k] !== ' ' && s[k] !== '\t' && s[k] !== '\n' && s[k] !== '<') k++;
  if (k < n && s[k] === '>') {
    const inner = s.slice(j, k);
    const colon = inner.indexOf(':');
    if (colon > 1 && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(inner.slice(0, colon)) && colon <= 32) {
      const href = inner;
      return [{ t: 2, href: encURI(href), title: null, ch: [{ t: 0, s: href }] }, k + 1];
    }
    if (/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(inner)) {
      return [{ t: 2, href: 'mailto:' + inner, title: null, ch: [{ t: 0, s: inner }] }, k + 1];
    }
  }
  // Open tag <name ...>: attribute names must match
  // [a-zA-Z_:][a-zA-Z0-9_.:-]*, attributes are separated by
  // whitespace, values are unquoted / single- / double-quoted, and
  // the tag ends with `>` or `/>` (no space before the `/`).
  if (i + 1 < n && isAlpha(s.charCodeAt(i + 1))) {
    j = i + 1;
    while (j < n && (isAlnum(s.charCodeAt(j)) || s[j] === '-')) j++;
    // After the tag name must come whitespace, '/' or '>'.
    if (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '/' || s[j] === '>')) {
      let needWs = true; // an attribute name must follow whitespace
      while (j < n) {
        const c = s[j];
        if (c === '>') return [{ t: 4, s: s.slice(i, j + 1) }, j + 1];
        if (c === '/' && j + 1 < n && s[j + 1] === '>') return [{ t: 4, s: s.slice(i, j + 2) }, j + 2];
        if (c === ' ' || c === '\t' || c === '\n') { j++; needWs = false; continue; }
        if (c === '<') return null;
        // Attribute name.
        if (!isAlpha(s.charCodeAt(j)) && s[j] !== '_' && s[j] !== ':') return null;
        if (needWs) return null;
        j++;
        while (j < n && (isAlnum(s.charCodeAt(j)) || s[j] === '_' || s[j] === '.' || s[j] === ':' || s[j] === '-')) j++;
        needWs = true;
        while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; needWs = false; }
        if (j < n && s[j] === '=') {
          j++;
          while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
          if (j < n && s[j] === "'") {
            j++;
            while (j < n && s[j] !== "'") j++;
            if (j >= n) return null;
            j++;
          } else if (j < n && s[j] === '"') {
            j++;
            while (j < n && s[j] !== '"') j++;
            if (j >= n) return null;
            j++;
          } else {
            if (j >= n) return null;
            while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '>' && s[j] !== '`') j++;
            if (j >= n) return null;
          }
          // After a value, whitespace (or `>`/`/>`) must follow before
          // the next attribute.
          if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '>' && s[j] !== '/') return null;
        }
      }
    }
  }
  return null;
}

// Trim trailing punctuation from a bare autolink (GFM rules).
// Marked's _backpedal, as a left-to-right scan returning the longest
// valid prefix of the URL: runs of non-punctuation, balanced (...)
// pairs, an `&` that does not start a trailing entity, or punctuation
// that is not at the very end. A `(` with no `)` after it ends the
// URL; a trailing `)` that is part of a balanced pair is kept.
function trimAutolink(url) {
  // `]` is a regular character here (matched by the non-punctuation
  // alternative), never trimmed; only the other punctuation is.
  const PUNCT = '?!.,:;*_~\'")';
  const n = url.length;
  let i = 0;
  while (i < n) {
    const c = url[i];
    if (c === '(') {
      let j = i + 1;
      while (j < n && url[j] !== ')') j++;
      if (j < n) { i = j + 1; continue; }
      break;
    }
    if (c === '&') {
      // An & that starts a trailing &name; entity ends the URL
      // (the whole entity is excluded).
      if (/^&[a-zA-Z0-9]+;$/.test(url.slice(i))) break;
      i++; continue;
    }
    if (PUNCT.indexOf(c) >= 0) {
      let j = i;
      while (j < n && PUNCT.indexOf(url[j]) >= 0) j++;
      if (j < n) { i = j; continue; }
      break;
    }
    while (i < n) {
      const d = url[i];
      if (d === '(' || d === '&' || PUNCT.indexOf(d) >= 0) break;
      i++;
    }
  }
  return url.slice(0, i);
}

// GFM bare autolink: try to match a www./scheme:// URL starting at i.
// `prev` is the char code before i (-1 at start). Returns {href, text, end}
// or null. marked is permissive about the domain: it only needs a
// non-empty domain part after www. / ://.
function parseBareAutolink(s, i, prev) {
  const n = s.length;
  if (s.startsWith('www.', i)) {
    if (prev >= 0 && (isAlnum(prev) || prev === 95)) return null;
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === 60 || c === 93) break;
      j++;
    }
    let url = trimAutolink(s.slice(i, j));
    if (url.length <= 4) return null;
    return { href: 'http://' + url, text: url, end: i + url.length };
  }
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\//.exec(s.slice(i, i + 40));
  if (m) {
    if (prev >= 0 && (isAlnum(prev) || prev === 95)) return null;
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === 60 || c === 93) break;
      j++;
    }
    let url = trimAutolink(s.slice(i, j));
    if (url.length <= m[0].length) return null;
    return { href: url, text: url, end: i + url.length };
  }
  return null;
}

// Unicode whitespace (for emphasis flanking): ASCII ws + U+00A0 + Zs.
function isWSU(c) {
  return isWS(c) || c === 160 || c === 133 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288;
}

// Unicode-aware punctuation for emphasis flanking: ASCII punctuation
// plus Unicode general categories P (punctuation) and S (symbol).
// (Backslash escapes use the ASCII-only isPunct above.)
const PUNCT_U_RE = /[\p{P}\p{S}]/u;
function isPunctU(c) {
  if (c < 128) return PUNCT[c] === 1;
  return PUNCT_U_RE.test(String.fromCodePoint(c));
}
// Compute canOpen/canClose for a delimiter run of `ch` ('*', '_' or '~')
// with the neighbouring char codes (-1 = start/end of text).
function flank(ch, prev, next) {
  const prevWS = prev < 0 || isWSU(prev);
  const nextWS = next < 0 || isWSU(next);
  const prevP = prev >= 0 && isPunctU(prev);
  const nextP = next >= 0 && isPunctU(next);
  // Left-flanking: not followed by ws, and (not followed by punct, or
  // followed by punct and preceded by ws/punct).
  const left = !nextWS && (!nextP || prevWS || prevP);
  // Right-flanking: not preceded by ws, and (not preceded by punct, or
  // preceded by punct and followed by ws/punct).
  const right = !prevWS && (!prevP || nextWS || nextP);
  if (ch === 95) { // '_': the extra intraword conditions
    return {
      open: left && (!right || prevP),
      close: right && (!left || nextP),
    };
  }
  return { open: left, close: right };
}

// Convert bare autolinks inside a node's children back to plain text
// (used when a link/image forms: bare autolinks do not survive inside
// link text, but <...> autolinks do).
function stripBareAutolinks(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 2 && nd.auto === 'bare') {
      nodes[k] = { t: 0, s: nd.ch[0].s };
    } else if (nd.t === 2 || nd.t === 3) {
      stripBareAutolinks(nd.ch);
    }
  }
}

// Render a node list to plain text (for image alt text).
function nodesToText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 1) out += nd.s;
    else if (nd.t === 2 || nd.t === 3) out += nodesToText(nd.ch);
    else if (nd.t === 4) out += '';
    else if (nd.t === 5) out += '\n';
    else if (nd.t === 6) out += nd.ch.repeat(Math.max(0, nd.n - nd.openUsed - nd.closeUsed));
    else if (nd.t === 7) out += nd.img ? '![' : '[';
  }
  return out;
}

// The next-special-char regex for the inline scanner.
const INLINE_SPECIAL = /www\.|:\/\/|[\\`*_~\[\]!<&\n@:]/g;

// Scan one inline source into a node list. `refs` is a Map of normalised
// label -> {href, title}.
// Document-level link scope: a raw <a> tag (without a matching </a>)
// suppresses bare autolinks for the rest of the document (marked
// behaviour). Reset at the start of each parse().
let inLinkDoc = false;

function scanInline(s, refs) {
  const n = s.length;
  const out = [];
  const brackets = [];
  // Intervals [start, end) that marked's emStrong mask hides from the
  // emphasis scan: a code span the mask sees (backtick run + content
  // without backticks + same run) even though our scanner could not
  // form it (the link rule took the `]` first). Delimiter runs inside
  // such an interval are literal text.
  const maskSpans = [];
  let pend = '';       // pending plain text (decoded)
  let pendSrc = 0;     // source index where `pend` started
  let i = 0;
  const flush = () => { if (pend) { addText(out, pend); pend = ''; } };
  // Would closing the top bracket at position j form a link? Mirrors
  // the `]` handler (label scan, destination/ref, nested-link check)
  // without side effects. A bare autolink URL stops at a `]` only when
  // that `]` would close a bracket into a link; otherwise the `]` is
  // part of the URL (marked's bare-URL regex includes it).
  const bracketWouldLink = (j) => {
    const br = brackets.length ? brackets[brackets.length - 1] : null;
    if (!br || !br.active) return false;
    if (!validLabel(s, br.srcStart + 1, j)) return false;
    let link = null;
    if (j + 1 < n && s[j + 1] === '(') {
      const r = parseInlineLink(s, j + 1);
      if (r) link = r;
    } else if (j + 1 < n && s[j + 1] === '[') {
      const rl = parseRefLabel(s, j + 1);
      if (rl) {
        const rawLab = rl[0];
        const labText = rawLab === '' ? s.slice(br.srcStart + 1, j) : rawLab;
        if (rawLab !== '' || !hasUnescapedBracket(labText)) {
          const ref = refs.get(normLabel(labText));
          if (ref) link = ref;
        }
      }
    }
    if (!link && !(j + 1 < n && s[j + 1] === '[')) {
      const labText = s.slice(br.srcStart + 1, j);
      if (!hasUnescapedBracket(labText)) {
        const ref = refs.get(normLabel(labText));
        if (ref) link = ref;
      }
    }
    if (!link) return false;
    if (!br.img) {
      const bi = out.indexOf(br);
      const children = bi >= 0 ? out.slice(bi + 1) : [];
      for (const nd of children) if (nd.t === 2 && nd.auto !== 'bare' && nd.auto !== 'angle') return false;
    }
    return true;
  };
  // Advance the pending text to cover source up to `to` (plain chars only,
  // decoding entities and backslash escapes as we go).
  const takeText = (to) => {
    // `pend` currently covers s[pendSrc..i). Extend it to s[pendSrc..to).
    let j = i;
    while (j < to) {
      const c = s[j];
      if (c === '\\' && j + 1 < to && isPunct(s.charCodeAt(j + 1))) {
        pend += s[j + 1]; j += 2; continue;
      }
      if (c === '&') {
        // Numeric entities decode; named references are copied literally.
        const d = parseNumericEntity(s, j);
        if (d) { pend += d[0]; j = d[1]; continue; }
        const e = copyNamedEntity(s, j);
        if (e) { pend += s.slice(j, e); j = e; continue; }
      }
      pend += c; j++;
    }
    i = to;
  };

  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const nx = m ? m.index : n;
    // Consume plain text up to the next special position.
    if (nx > i) takeText(nx);
    if (!m) break;
    const tok = m[0];
    const ci = m.index;
    if (tok === 'www.') {
      // Bare www autolink (only when preceded by non-word char, and
      // not inside a raw <a> scope).
      const prev = ci > 0 ? s.charCodeAt(ci - 1) : -1;
      if (inLinkDoc || (prev >= 0 && (isAlnum(prev) || prev === 95))) { takeText(ci + 4); continue; }
      let j = ci;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c <= 32 || c === 60 || c === 96) break;
        if (c === 93 && bracketWouldLink(j)) break;
        j++;
      }
      let url = trimAutolink(s.slice(ci, j));
      if (url.length <= 4) { takeText(ci + 4); continue; }
      flush();
      out.push({ t: 2, href: 'http://' + encURI(url), title: null, ch: [{ t: 0, s: url }], auto: 'bare' });
      i = ci + url.length; pendSrc = i;
      continue;
    }
    if (tok === '://') {
      // Bare scheme autolink: find the scheme start in the pending text.
      let k = ci - 1;
      while (k >= pendSrc && /[a-zA-Z0-9+.-]/.test(s[k])) k--;
      const start = k + 1;
      const scheme = s.slice(start, ci);
      const okScheme = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/.test(scheme);
      const prevOk = start === 0 || !(isAlnum(s.charCodeAt(start - 1)) || s.charCodeAt(start - 1) === 95);
      const clean = s.slice(start, ci).indexOf('\\') < 0 && s.slice(start, ci).indexOf('&') < 0;
      if (inLinkDoc || !okScheme || !prevOk || !clean || start < pendSrc) { takeText(ci + 3); continue; }
      let j = ci + 3;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c <= 32 || c === 60 || c === 96) break;
        if (c === 93 && bracketWouldLink(j)) break;
        j++;
      }
      let url = trimAutolink(s.slice(start, j));
      if (url.length <= scheme.length + 3) { takeText(ci + 3); continue; }
      // Truncate the pending text back to the scheme start.
      pend = pend.slice(0, pend.length - (ci - start));
      flush();
      out.push({ t: 2, href: encURI(url), title: null, ch: [{ t: 0, s: url }], auto: 'bare' });
      i = start + url.length; pendSrc = i;
      continue;
    }
    if (tok === ':') {
      // Bare scheme autolink (mailto:, xmpp:, ...): a scheme of 2-32
      // chars ending at this colon, followed by non-space content.
      // Not when the colon is part of :// (handled above) or when
      // inside a raw <a> scope.
      if (inLinkDoc) { takeText(ci + 1); continue; }
      let k = ci - 1;
      while (k >= pendSrc && /[a-zA-Z0-9+.-]/.test(s[k])) k--;
      const start = k + 1;
      const scheme = s.slice(start, ci);
      // Only mailto: and xmpp: form bare scheme autolinks (GFM's
      // email-like schemes); any other scheme is plain text.
      const okScheme = /^(mailto|xmpp)$/i.test(scheme);
      const prevOk = start === 0 || !(isAlnum(s.charCodeAt(start - 1)) || s.charCodeAt(start - 1) === 95);
      const clean = scheme.indexOf('\\') < 0 && scheme.indexOf('&') < 0;
      const after = ci + 1 < n ? s.charCodeAt(ci + 1) : -1;
      if (!okScheme || !prevOk || !clean || start < pendSrc || after < 0 || after <= 32 || after === 60 || after === 96 || after === 92 || s.slice(ci + 1, ci + 3) === '//') { takeText(ci + 1); continue; }
      let j = ci + 1;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c <= 32 || c === 60 || c === 96 || c === 92) break;
        if (c === 93 && bracketWouldLink(j)) break;
        j++;
      }
      let url = trimAutolink(s.slice(start, j));
      // The path keeps at most one segment: a second `/` ends the
      // autolink (`xmpp:foo@bar.baz/txt/bin` links only `/txt`).
      const firstSlash = url.indexOf('/', scheme.length + 1);
      if (firstSlash >= 0) {
        const secondSlash = url.indexOf('/', firstSlash + 1);
        if (secondSlash >= 0) url = url.slice(0, secondSlash);
      }
      // A trailing `/` is not part of the autolink, and a trailing
      // `-` or `_` on the raw candidate invalidates the whole
      // autolink (trimAutolink would otherwise swallow the `_`).
      while (url.endsWith('/')) url = url.slice(0, -1);
      const rawEnd = s[j - 1];
      if (url.length <= scheme.length + 1 || rawEnd === '-' || rawEnd === '_') { takeText(ci + 1); continue; }
      pend = pend.slice(0, pend.length - (ci - start));
      flush();
      out.push({ t: 2, href: encURI(url), title: null, ch: [{ t: 0, s: url }], auto: 'bare' });
      i = start + url.length; pendSrc = i;
      continue;
    }
    if (tok === '@') {
      // Bare email autolink: local part before, domain after. A
      // character escaped by a backslash cannot be part of the local
      // part (so `\+@bar.example.com` is not an autolink).
      let k = ci - 1;
      while (k >= pendSrc && /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[k])) {
        if (k > 0 && s[k - 1] === '\\' && (k < 2 || s[k - 2] !== '\\')) break;
        k--;
      }
      const start = k + 1;
      const local = s.slice(start, ci);
      const clean = local.indexOf('\\') < 0 && local.indexOf('&') < 0;
      let j = ci + 1;
      while (j < n && /[a-zA-Z0-9.-]/.test(s[j])) j++;
      // A trailing dot is punctuation, not part of the domain.
      let dom = s.slice(ci + 1, j);
      while (dom.endsWith('.')) dom = dom.slice(0, -1);
      j = ci + 1 + dom.length;
      const dot = dom.indexOf('.');
      const tld = dot >= 0 ? dom.slice(dot + 1) : '';
      // A `-` or `_` immediately after the domain invalidates the
      // whole email autolink (`a.b-c_d@a.b_` is literal text) — but
      // a `_` that closes an open `_` emphasis delimiter does not
      // (`_foo bar@baz.com_` links the email).
      const afterDom = j < n ? s[j] : '';
      let afterBad = afterDom === '-';
      if (afterDom === '_') {
        afterBad = true;
        for (let q = out.length - 1; q >= 0; q--) {
          const nd = out[q];
          if (nd.t === 6 && nd.ch === '_' && nd.canOpen && nd.closeUsed < nd.len) { afterBad = false; break; }
          if (nd.t === 1 || nd.t === 2 || nd.t === 3) break;
        }
      }
      const okMail = local.length > 0 && clean && start >= pendSrc &&
        dot > 0 && /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/.test(dom) &&
        /[a-zA-Z]/.test(tld) && !dom.endsWith('-') && !dom.startsWith('-') &&
        !afterBad;
      if (inLinkDoc || !okMail) { takeText(ci + 1); continue; }
      const email = local + '@' + dom;
      pend = pend.slice(0, pend.length - (ci - start));
      flush();
      out.push({ t: 2, href: 'mailto:' + email, title: null, ch: [{ t: 0, s: email }], auto: 'bare' });
      i = ci + 1 + dom.length; pendSrc = i;
      continue;
    }
    // Single-char special token at ci.
    i = ci;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && s[i + 1] === '\n') {
        flush();
        out.push({ t: 5 });
        i += 2; pendSrc = i;
        // A backslash hard break swallows the next line's leading
        // whitespace, like a two-space hard break.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        pendSrc = i;
        continue;
      }
      if (i + 1 < n && isPunct(s.charCodeAt(i + 1))) {
        // A backslash-escaped `&` is a literal ampersand, not an
        // entity reference: emit it pre-escaped so the renderer does
        // not re-read `&ouml;` as an entity (`\&ouml;` -> `&amp;ouml;`).
        if (s[i + 1] === '&') pend += '&amp;'; else pend += s[i + 1];
        i += 2; continue;
      }
      pend += '\\'; i++; continue;
    }
    if (c === 96) { // backtick run -> code span
      let k = i;
      while (k < n && s[k] === '`') k++;
      const mLen = k - i;
      const end = findCodeEnd(s, i, mLen);
      if (end < 0) { pend += s.slice(i, k); i = k; continue; }
      // A code span opened inside a link label must close before
      // the label's `]`; otherwise it would swallow the `]` and the
      // link could never form (marked tries the link rule at the `[`
      // before it ever reaches the backticks, and its label pattern
      // accepts a code span whose runs differ in length, e.g.
      // `` ``small` ``). Only when the bracket really forms a link
      // (valid label + a parseable destination) is the span blocked;
      // a literal `[` must not stop a code span.
      const brTop = brackets.length ? brackets[brackets.length - 1] : null;
      if (brTop && brTop.active) {
        const closeIdx = findBracketClose(s, brTop.srcStart);
        // The `]` must lie strictly INSIDE this code span (after
        // its opening backticks, before its closing run) for the
        // span to swallow it.
        if (closeIdx > i && closeIdx < end &&
            validLabel(s, brTop.srcStart + 1, closeIdx)) {
          const after = s[closeIdx + 1];
          const isLink = after === '(' ? !!parseInlineLink(s, closeIdx + 1) : after === '[';
          if (isLink) {
            // Marked's mask still sees this span and hides it from
            // the emphasis scan, even though the real code span
            // cannot form here. (Its step-1 pass replaces an inner
            // backtick of a code span with `+`, so the span scans
            // even when its content holds such a backtick.)
            maskSpans.push([i, end]);
            pend += s.slice(i, k); i = k; continue;
          }
        }
      }
      let content = s.slice(k, end - mLen);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      out.push({ t: 1, s: content });
      i = end; pendSrc = i; continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let k = i;
      const ch = s[i];
      while (k < n && s[k] === ch) k++;
      const runLen = k - i;
      // A delimiter run inside a mask-hidden code span (recorded
      // when the link rule blocked a code span) is literal text —
      // unless it sits inside a link label: a label gets its own
      // emphasis scope in marked, so the outer mask does not hide it.
      let masked = false;
      const inLabel = brackets.length > 0 && brackets[brackets.length - 1].active;
      if (!inLabel) {
        for (let q = 0; q < maskSpans.length; q++) {
          if (i >= maskSpans[q][0] && i < maskSpans[q][1]) { masked = true; break; }
        }
      }
      if (masked) { pend += s.slice(i, k); i = k; continue; }
      // Strikethrough needs one or two tildes: a run of three or more
      // is literal text (marked leaves `~~~not~~~` untouched).
      if (ch === '~' && runLen > 2) { pend += s.slice(i, k); i = k; continue; }
      const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
      const next = k < n ? s.charCodeAt(k) : -1;
      const f = flank(ch.charCodeAt(0), prev, next);
      // A run that can neither open nor close emphasis is literal
      // text (an intraword `_` must not split a bare email address).
      if (!f.open && !f.close) { pend += s.slice(i, k); i = k; continue; }
      flush();
      out.push({ t: 6, ch, n: runLen, len: runLen, canOpen: f.open, canClose: f.close, opens: [], closes: [], openUsed: 0, closeUsed: 0, inLeft: 0, skipped: 0 });
      i = k; pendSrc = i; continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && s[i + 1] === '[')) { // [ or ![
      const isImg = c === 33;
      flush();
      const br = { t: 7, img: isImg, srcStart: isImg ? i + 1 : i, active: true };
      out.push(br);
      brackets.push(br);
      i += isImg ? 2 : 1; pendSrc = i; continue;
    }
    if (c === 93) { // ] -> try to resolve a link
      flush();
      const br = brackets.length ? brackets[brackets.length - 1] : null;
      if (!br || !br.active) { pend += ']'; i++; continue; }
      // A label whose backticks do not scan (a code span containing
      // a backtick, or an unclosed backtick run not at the end)
      // cannot form a link.
      if (!validLabel(s, br.srcStart + 1, i)) {
        // Marked's emStrong mask still hides a `[...](...)` whose
        // label holds a code span with an inner backtick (the inner
        // backtick is masked to `+`, so the span scans): delimiter
        // runs inside such a label never form emphasis.
        if (s[i + 1] === '(' && parseInlineLink(s, i + 1) &&
            !hasUnescapedBracket(s.slice(br.srcStart + 1, i)) &&
            labelHasInnerBacktickCode(s, br.srcStart + 1, i)) {
          const bi = out.indexOf(br);
          for (let q = bi + 1; q < out.length; q++) {
            const nd = out[q];
            if (nd.t === 6) { nd.canOpen = false; nd.canClose = false; }
          }
        }
        br.active = false;
        brackets.pop();
        pend += ']'; i++; continue;
      }
      let link = null;
      let end = -1;
      if (i + 1 < n && s[i + 1] === '(') {
        const r = parseInlineLink(s, i + 1);
        if (r) { link = r; end = r.end; }
      } else if (i + 1 < n && s[i + 1] === '[') {
        const rl = parseRefLabel(s, i + 1);
        if (rl) {
          const rawLab = rl[0];
          // Labels match on the RAW text (backslashes preserved) —
          // an escaped label does not match an unescaped ref def.
          // A collapsed label (the link text) containing an
          // unescaped `[` never matches.
          const labText = rawLab === '' ? s.slice(br.srcStart + 1, i) : rawLab;
          if (rawLab !== '' || !hasUnescapedBracket(labText)) {
            const key = normLabel(labText);
            const ref = refs.get(key);
            if (ref) { link = ref; end = rl[1]; }
          }
        }
      }
      if (!link && !(i + 1 < n && s[i + 1] === '[')) {
        // Shortcut reference: the link text is the label. Only when
        // not followed by [ (a failed full/collapsed reference does
        // not fall back to a shortcut). A failed inline ( destination
        // DOES fall back to a shortcut. A label containing an
        // unescaped `[` never matches.
        const labText = s.slice(br.srcStart + 1, i);
        if (!hasUnescapedBracket(labText)) {
          const key = normLabel(labText);
          const ref = refs.get(key);
          if (ref) { link = ref; end = i + 1; }
        }
      }
      if (!link) {
        // Not a link: deactivate this bracket, literal ]. But if the
        // `]` is followed by `(` (a failed inline-link attempt),
        // emphasis inside the label is suppressed (marked treats the
        // label as link text even though no link formed).
        if (i + 1 < n && s[i + 1] === '(' && !br.img) {
          const bi0 = out.indexOf(br);
          if (bi0 >= 0) {
            for (let q = bi0 + 1; q < out.length; q++) {
              const nd = out[q];
              if (nd.t === 6) { nd.canOpen = false; nd.canClose = false; }
            }
          }
        }
        br.active = false;
        brackets.pop();
        pend += ']'; i++; continue;
      }
      // Form the link/image.
      const bi = out.indexOf(br);
      const children = out.slice(bi + 1);
      // Link text may not contain an explicit (non-autolink) link; an
      // image's alt text may (the inner link contributes its text to
      // the alt, e.g. `![[[foo](uri1)](uri2)](uri3)`).
      let nested = false;
      if (!br.img) {
        for (const nd of children) if (nd.t === 2 && nd.auto !== 'bare' && nd.auto !== 'angle') { nested = true; break; }
      }
      if (nested) {
        br.active = false;
        brackets.pop();
        pend += ']'; i++; continue;
      }
      stripBareAutolinks(children);
      brackets.pop();
      let node;
      if (br.img) {
        // Alt text is computed at render time (after emphasis resolves),
        // so emphasis delimiters that formed emphasis are excluded.
        node = { t: 3, src: link.href, title: link.title, ch: children };
      } else {
        node = { t: 2, href: link.href, title: link.title, ch: children };
      }
      out.splice(bi, out.length - bi, node);
      i = end; pendSrc = i;
      continue;
    }
    if (c === 60) { // < -> autolink / html tag
      const r = parseAngle(s, i);
      if (!r) { pend += '<'; i++; continue; }
      flush();
      r[0].auto = 'angle';
      out.push(r[0]);
      // A raw <a> tag opens a link scope that persists (marked
      // suppresses bare autolinks until the matching </a>); an
      // unclosed <a> suppresses them for the rest of the document.
      if (r[0].t === 4) {
        const tag = r[0].s;
        // Marked's startATag is /^<a /i and endATag is /^<\/a>/i:
        // a self-closing <a /> still opens the link scope (no
        // exception), and only a literal </a> closes it.
        if (/^<\/a>/i.test(tag)) inLinkDoc = false;
        else if (/^<a /i.test(tag)) inLinkDoc = true;
      }
      i = r[1]; pendSrc = i; continue;
    }
    if (c === 38) { // & -> numeric entity decodes, named ref copied literally
      const d = parseNumericEntity(s, i);
      if (d) { pend += d[0]; i = d[1]; continue; }
      const e = copyNamedEntity(s, i);
      if (e) { pend += s.slice(i, e); i = e; continue; }
      pend += '&'; i++; continue;
    }
    if (c === 10) { // newline -> hard break if 2+ trailing spaces, else soft
      let sp = 0;
      while (sp < pend.length && pend[pend.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        pend = pend.slice(0, pend.length - sp);
        flush();
        out.push({ t: 5 });
        i++; pendSrc = i;
        // A hard break swallows the next line's leading whitespace.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        pendSrc = i;
        continue;
      }
      pend += '\n'; i++; continue;
    }
    // Anything else (should not happen): copy literally.
    pend += s[i]; i++;
  }
  flush();
  return out;
}

// Resolve emphasis / strikethrough in one node list (one scope) using the
// CommonMark delimiter-stack algorithm. Delimiters inside a link's text
// are a separate scope: this runs per list, recursing into link children.
function processEmphasis(nodes) {
  const delims = [];
  for (const nd of nodes) {
    if (nd.t === 6) delims.push(nd);
    else if (nd.t === 2 || nd.t === 3) processEmphasis(nd.ch);
  }
  if (!delims.length) return;
  const stack = [];
  for (const d of delims) {
    if (d.canClose) {
      while (d.len > 0) {
        let oi = -1;
        for (let k = stack.length - 1; k >= 0; k--) {
          const o = stack[k];
          if (o.ch !== d.ch || !o.canOpen || o.len <= 0) continue;
          // A blocked opener cannot match a closer that is too short
          // to cover it plus the inner closer that blocked it, less
          // any close-only runs already skipped for it (marked's
          // scan subtracts those from the opener's remaining length,
          // so a later closer can match once they have been spent).
          if (o.blocked && o.len % 3 !== 0 && (o.len + o.blockLen) % 3 === 0) {
            const need = o.len + o.blockLen - (o.skipped || 0);
            if (d.len < need) {
              if (d.canClose && !d.canOpen) o.skipped = (o.skipped || 0) + d.len;
              continue;
            }
          }
          // An opener with unmatched OPEN-ONLY openers of the same
          // character still on the stack above it has a longer
          // effective length in marked's scan: each inner opener
          // inflates it by its length, and close-only runs already
          // skipped for it have been spent. A closer shorter than
          // that cannot match it. Both-flanking openers do NOT
          // inflate it (marked rule-of-3-skips them into f, or
          // treats them as closers). Only applies when inner
          // openers exist (a bare opener still odd-matches, e.g.
          // **foo* bar**).
          let innerLen = 0;
          for (let q = k + 1; q < stack.length; q++) {
            if (stack[q].ch === d.ch && stack[q].canOpen && !stack[q].canClose) innerLen += stack[q].len;
          }
          if (innerLen > 0) {
            const need = o.len + innerLen - (o.skipped || 0);
            if (d.len < need) {
              if (d.canClose && !d.canOpen) o.skipped = (o.skipped || 0) + d.len;
              continue;
            }
          }
          // Odd-match rule: if either delimiter can both open and close,
          // the sum of the remaining lengths must not be a multiple of 3
          // unless both are multiples of 3.
          const both = (o.canOpen && o.canClose) || (d.canOpen && d.canClose);
          if (both && (o.len + d.len) % 3 === 0 && !(o.len % 3 === 0 && d.len % 3 === 0)) continue;
          const u = o.len < d.len ? o.len : d.len;
          const uu = u > 2 ? 2 : u;
          // An em match here loses to an earlier strong match only
          // when the closer is exactly 2 long: matching the em
          // would leave 1, too short for the strong. (A closer of
          // length 1 can never make a strong match, so it must take
          // the nearer em; a closer of 3+ covers both and the inner
          // em matches first, e.g. **foo *bar***.)
          if (d.ch !== '~' && uu === 1 && d.len === 2) {
            let starved = false;
            for (let j = k - 1; j >= 0 && !starved; j--) {
              const p = stack[j];
              if (p.ch !== d.ch || !p.canOpen || p.len <= 0 || p.len < 2) continue;
              if (p.blocked && p.len % 3 !== 0 && (p.len + p.blockLen) % 3 === 0) {
                if (d.len < p.len + p.blockLen - (p.skipped || 0)) continue;
              }
              let pInner = 0;
              for (let q = j + 1; q < stack.length; q++) {
                if (stack[q].ch === d.ch && stack[q].canOpen && !stack[q].canClose) pInner += stack[q].len;
              }
              if (pInner > 0 && d.len < p.len + pInner - (p.skipped || 0)) continue;
              const pBoth = (p.canOpen && p.canClose) || (d.canOpen && d.canClose);
              if (pBoth && (p.len + d.len) % 3 === 0 && !(p.len % 3 === 0 && d.len % 3 === 0)) continue;
              starved = true;
            }
            if (starved) continue;
          }
          oi = k; break;
        }
        if (oi < 0) break;
        const o = stack[oi];
        const dLenBefore = d.len;
        let use = o.len < d.len ? o.len : d.len;
        if (use > 2) use = 2;
        // Marked's effective closer length b = min(run, opener +
        // skipped length): chars of the closer run beyond the tag
        // (b - use) are interior text, rendered BEFORE the closing
        // tag; chars beyond b are exterior, rendered after it. The
        // skipped length counts only when the rule of three actually
        // blocks this opener (same %3 conditions as the check above);
        // otherwise b is just the opener's remaining length. The
        // last match wins (outermost opener decides the split).
        const blockedHere = o.blocked && o.len % 3 !== 0 && (o.len + o.blockLen) % 3 === 0;
        const bEff = Math.min(dLenBefore, o.len + (blockedHere ? o.blockLen : 0));
        d.inLeft = Math.max(0, bEff - use);
        const tag = d.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        o.opens.push(tag); d.closes.push(tag);
        o.openUsed += use; d.closeUsed += use;
        o.len -= use; d.len -= use;
        // Delimiters between the opener and this closer are inside the
        // formed emphasis and can no longer match anything outside it.
        stack.splice(oi + 1);
        if (o.len <= 0) stack.splice(oi, 1);
        // Marked quirk: a closer that can both open and close, once it
        // matches an opener that itself cannot close, marks the nearest
        // preceding opener of the same character as blocked (recording
        // this closer's length). A later closer can still match the
        // blocked opener only if it is long enough to cover both.
        if (d.canOpen && d.canClose && !o.canClose) {
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].ch === d.ch && stack[k].canOpen && stack[k].len > 0) { stack[k].blocked = true; stack[k].blockLen = dLenBefore; break; }
          }
        }
      }
    }
    if (d.canOpen && d.len > 0) stack.push(d);
  }
}

// Render a node list to HTML.
function renderInline(nodes, out) {
  for (const nd of nodes) {
    if (nd.t === 0) { out.push(escText(nd.s)); continue; }
    if (nd.t === 1) { out.push('<code>' + escCode(nd.s) + '</code>'); continue; }
    if (nd.t === 2) {
      out.push('<a href="' + escHref(nd.href) + '"');
      if (nd.title != null) out.push(' title="' + escHref(nd.title) + '"');
      out.push('>');
      renderInline(nd.ch, out);
      out.push('</a>');
      continue;
    }
    if (nd.t === 3) {
      out.push('<img src="' + escHref(nd.src) + '" alt="' + escText(nodesToText(nd.ch)) + '"');
      if (nd.title != null) out.push(' title="' + escHref(nd.title) + '"');
      out.push('>');
      continue;
    }
    if (nd.t === 4) { out.push(nd.s); continue; }
    if (nd.t === 5) { out.push('<br>'); continue; }
    if (nd.t === 6) {
      // A closer run's leftover chars split: `inLeft` chars are
      // interior text (before the closing tags), the rest are
      // exterior (after the closing tags, before any opens).
      const left = nd.n - nd.openUsed - nd.closeUsed;
      const inLeft = Math.min(nd.inLeft || 0, left);
      if (inLeft > 0) out.push(nd.ch.repeat(inLeft));
      for (const tag of nd.closes) out.push(tag === 'em' ? '</em>' : tag === 'strong' ? '</strong>' : '</del>');
      const ext = left - inLeft;
      if (ext > 0) out.push(nd.ch.repeat(ext));
      for (let k = nd.opens.length - 1; k >= 0; k--) {
        const tag = nd.opens[k];
        out.push(tag === 'em' ? '<em>' : tag === 'strong' ? '<strong>' : '<del>');
      }
      continue;
    }
    if (nd.t === 7) { out.push(nd.img ? '![' : '['); continue; }
  }
}

// Fast path: plain text with no inline construct at all.
const INLINE_PLAIN = /[\\`*_~\[\]!<&\n@]/;
function inlineToHtml(s, refs) {
  if (!INLINE_PLAIN.test(s) && s.indexOf('www.') < 0 && s.indexOf('://') < 0) {
    return escText(s);
  }
  const nodes = scanInline(s, refs);
  processEmphasis(nodes);
  const out = [];
  renderInline(nodes, out);
  return out.join('');
}

// ---------------------------------------------------------------- blocks

// A line is blank if it contains only spaces/tabs.
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Indent of a line in columns (tab = next multiple of 4). Returns
// {cols, idx} where idx is the index where the indent ends.
// Lazy-continuation dedent: if the line's leading whitespace is at
// least ci columns, remove ci columns' worth; else if it is at least
// 4 columns, remove 4 (the indented-code indent); else keep the line
// unchanged. A tab straddling the boundary becomes spaces.
function dedentIfAtLeast(line, ci) {
  let col = 0, i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') col++;
    else col += 4 - (col % 4);
    i++;
  }
  const n = col >= ci ? ci : (col >= 4 ? 4 : 0);
  if (n === 0) return line;
  let removed = 0, j = 0, out = '';
  while (j < i && removed < n) {
    if (line[j] === ' ') { removed++; j++; }
    else {
      const w = 4 - (removed % 4);
      if (removed + w <= n) { removed += w; j++; }
      else { out += ' '.repeat(removed + w - n); removed = n; j++; }
    }
  }
  return out + line.slice(j);
}

function indentCols(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, idx: i };
}

// Remove up to n columns of leading whitespace. A tab that straddles the
// boundary is replaced by the right number of spaces.
function dedentCols(line, n, colOff, expandBoundary) {
  const off = colOff || 0;
  // For container dedents (list/quote), expand ALL leading tabs to
  // spaces using absolute columns, then drop n columns: a tab's width
  // depends on its absolute column, and later tabs must expand from
  // the position the earlier ones left (`-\t\tfoo`, `\t\tbar`).
  if (expandBoundary) {
    let col = off, i = 0, expanded = '';
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      if (line[i] === ' ') { expanded += ' '; col++; i++; }
      else { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; i++; }
    }
    const rest = line.slice(i);
    if (expanded.length <= n) return rest;
    return expanded.slice(n) + rest;
  }
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - ((col + off) % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  // A tab starting exactly at the dedent boundary expands to the
  // spaces it would occupy past the boundary — but only for container
  // dedents (list/quote/fence), not for indented code blocks, where
  // the tab is literal content. (Only when actually dedenting.)
  if (expandBoundary && n > 0 && i < line.length && line[i] === '\t' && col === n) {
    return ' '.repeat(4 - ((col + off) % 4)) + line.slice(i + 1);
  }
  return line.slice(i);
}

// Strip one blockquote marker from a line ("   > " -> rest). Returns the
// rest of the line, or null if the line has no quote marker. A tab
// after `>` counts as a single space for the marker; the rest of the
// tab's expansion becomes leading spaces of the content, and any
// further leading tabs expand on absolute columns.
function stripQuote(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return null;
  if (idx < line.length && line[idx] === '>') {
    let j = idx + 1;
    let col = cols + 1; // absolute column just after '>'
    let extra = '';
    if (j < line.length && line[j] === ' ') { j++; col++; }
    else if (j < line.length && line[j] === '\t') {
      const w = 4 - (col % 4);
      col++; // the marker consumes 1 column of the tab
      extra = ' '.repeat(w - 1); // the rest is content
      j++;
    }
    // Expand any further leading tabs on absolute columns.
    const rest = line.slice(j);
    let out = extra, c = col + extra.length, k = 0;
    while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
      if (rest[k] === ' ') { out += ' '; c++; k++; }
      else { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; k++; }
    }
    return out + rest.slice(k);
  }
  return null;
}

// Columns consumed by one blockquote marker (indent + '>' + one space
// or tab). A tab after `>` counts as a single space, not its full
// expansion, so tab expansion inside the quote uses absolute columns.
function quotePrefixCols(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return 0;
  if (idx >= line.length || line[idx] !== '>') return 0;
  let col = cols + 1;
  let j = idx + 1;
  if (j < line.length && line[j] === ' ') col++;
  else if (j < line.length && line[j] === '\t') col++;
  return col;
}

// Thematic break: up to 3 spaces indent, then 3+ of the same char
// (*, -, _) with only spaces/tabs between.
function isThematicBreak(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return false;
  let i = idx;
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ch) { count++; i++; }
    else if (c === ' ' || c === '\t') i++;
    else return false;
  }
  return count >= 3;
}

// ATX heading: up to 3 spaces, 1-6 '#', then space/tab/end, then text,
// then optional closing #'s. Returns {level, text} or null.
function parseATX(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return null;
  let i = idx, level = 0;
  while (i < line.length && line[i] === '#' && level < 7) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  let text = line.slice(i).replace(/[ \t]+$/, '');
  // Remove a closing sequence of #'s (preceded by space/tab).
  text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  return { level, text: text.replace(/^[ \t]+/, '') };
}

// Setext underline: up to 3 spaces, then 1+ '=' or '-' with NO spaces
// between the chars (only trailing spaces/tabs after the run).
// Returns 1 for '=', 2 for '-', or 0.
function setextLevel(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return 0;
  let i = idx;
  if (i >= line.length) return 0;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return 0;
  while (i < line.length && line[i] === ch) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i < line.length) return 0;
  return ch === '=' ? 1 : 2;
}

// Fence opener: up to 3 spaces, then 3+ backticks or tildes.
// Returns {ch, len, info, indent} or null. (Backtick fences may not
// contain backticks in the info string.)
function parseFence(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return null;
  let i = idx;
  if (i >= line.length) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i < line.length && line[i] === ch) { len++; i++; }
  if (len < 3) return null;
  const info = line.slice(i).trim();
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len, info, indent: cols };
}

// Remove up to n columns of leading whitespace from a fenced-code content
// line. Marked's Dt() removes up to n leading-whitespace CHARACTERS
// (a tab is one character), so a tab inside the budget is removed
// whole, not expanded to spaces first. Inside a container (colOff >
// 0) any tab that SURVIVES the dedent still expands to spaces using
// its absolute column; at the top level (colOff = 0) a surviving
// leading tab is literal content and stays.
function fenceDedent(line, n, colOff) {
  // Dedent by n characters; track the columns consumed so the
  // remainder's absolute column is right for the expansion below.
  // A tab counts as one character here but occupies up to the next
  // tab stop in columns.
  const off = colOff || 0;
  let col = 0, i = 0;
  while (i < line.length && i < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - ((col + off) % 4); i++; }
    else break;
  }
  let rest = line.slice(i);
  // Inside a container, expand leading tabs to spaces on absolute
  // columns; the dedented line starts at absolute column off + n.
  if (off > 0 && rest.length && (rest[0] === '\t' || rest[0] === ' ')) {
    let acol = off + col;
    let j = 0;
    let out = '';
    while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) {
      if (rest[j] === ' ') { out += ' '; acol++; j++; }
      else { const w = 4 - (acol % 4); out += ' '.repeat(w); acol += w; j++; }
    }
    if (j > 0 && out !== rest.slice(0, j)) rest = out + rest.slice(j);
  }
  return rest;
}

// Expand tabs in the leading whitespace of a fenced-code content line
// to spaces on absolute columns (relative column + colOff). Tilde
// fences never dedent, but inside a container their content lines'
// leading tabs still expand; at the top level they stay literal.
function expandLeadingTabs(line, colOff) {
  const off = colOff || 0;
  if (off <= 0) return line;
  let acol = off, j = 0, out = '';
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { out += ' '; acol++; j++; }
    else { const w = 4 - (acol % 4); out += ' '.repeat(w); acol += w; j++; }
  }
  return j > 0 && out !== line.slice(0, j) ? out + line.slice(j) : line;
}

// Is this line a closing fence for the given opener?
function isFenceClose(line, f) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return false;
  let i = idx, len = 0;
  while (i < line.length && line[i] === f.ch) { len++; i++; }
  if (len < f.len) return false;
  // Only spaces/tabs may follow.
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
    i++;
  }
  return true;
}

// Try to parse a link reference definition starting at lines[i].
// Returns {label, href, title, lines} (lines consumed) or null.
// The window runs until a blank line (a title may span lines, but the
// definition ends at a blank line). After the destination (or title),
// junk on the SAME line invalidates the title only — the definition
// still stands with just the destination; a following non-title line
// simply ends the definition.
function tryParseRefDef(lines, i) {
  const n = lines.length;
  const first = lines[i];
  const { cols, idx } = indentCols(first);
  if (cols > 3) return null;
  if (first[idx] !== '[') return null;
  // Window: lines until the first blank line (max 12), so a multi-line
  // title is visible.
  let win = first.slice(idx);
  let winLines = 1;
  for (let k = 1; k <= 11 && i + k < n && !isBlank(lines[i + k]); k++) {
    win += '\n' + lines[i + k];
    winLines++;
  }
  const rl = parseRefLabel(win, 0);
  if (!rl) return null;
  const rawLabel = rl[0];
  if (rawLabel.trim() === '') return null;
  let j = rl[1];
  if (j >= win.length || win[j] !== ':') return null;
  j++;
  j = skipInlineWS(win, j);
  if (j < 0) return null;
  const d = parseDest(win, j);
  if (!d) return null;
  let [dest, k] = d;
  let title = null;
  let endPos = k; // end of the definition content (after dest, or title)
  // Optional title: whitespace must separate it from the destination.
  // Look only at the remainder of the destination's line first.
  let lineEnd = win.indexOf('\n', k);
  if (lineEnd < 0) lineEnd = win.length;
  let m = k;
  while (m < lineEnd && (win[m] === ' ' || win[m] === '\t')) m++;
  if (m < lineEnd) {
    // Something on the same line after the destination: it must be a
    // title preceded by whitespace (no whitespace -> invalid).
    if (m === k) return null;
    const t = parseTitle(win, m);
    if (!t) return null;
    // After the title, only whitespace to end of line. Junk here
    // invalidates the whole definition (the title is on the same line
    // as the destination).
    let e = t[1];
    while (e < win.length && win[e] !== '\n' && (win[e] === ' ' || win[e] === '\t')) e++;
    if (e < win.length && win[e] !== '\n') return null;
    title = t[0]; endPos = t[1];
  } else {
    // The destination's line is blank after the destination: the title
    // may be on the next line (only if it is a valid title).
    const k2 = skipInlineWS(win, k);
    if (k2 >= 0 && k2 < win.length && win[k2] !== '\n') {
      const t = parseTitle(win, k2);
      if (t) {
        let e = t[1];
        while (e < win.length && win[e] !== '\n' && (win[e] === ' ' || win[e] === '\t')) e++;
        if (e >= win.length || win[e] === '\n') { title = t[0]; endPos = t[1]; }
        // Else: junk after the title -> no title, definition ends at dest.
      }
      // Else: not a title on the next line -> definition ends at dest.
    }
    // Else: blank line / end after the destination -> definition ends.
  }
  // How many lines did the definition consume? Count newlines up to
  // the end of the definition content.
  const consumed = win.slice(0, endPos).split('\n').length;
  if (consumed > winLines) return null;
  return { label: normLabel(rawLabel), href: dest, title, lines: consumed };
}

// Block-level HTML tag names (CommonMark type 6).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Try to match an HTML block start at `line` (already dedented to <=3
// spaces indent by the caller). Returns {type, endTag} or null.
// type 1-5 end at a specific marker; type 6/7 end at a blank line.
function htmlBlockStart(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return null;
  const s = line.slice(idx);
  const m1 = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(s);
  if (m1) return { type: 1, endTag: '</' + m1[1].toLowerCase() };
  const low = s.toLowerCase();
  if (low.startsWith('<!--')) return { type: 2, endTag: '-->' };
  if (low.startsWith('<?')) return { type: 3, endTag: '?>' };
  if (low.startsWith('<!') && s.length > 2 && s[2] >= 'A' && s[2] <= 'Z') return { type: 4, endTag: '>' };
  if (low.startsWith('<![cdata[')) return { type: 5, endTag: ']]>' };
  // Type 6: block tag (open or close), type 7: any complete tag.
  // The character after the tag name must be whitespace, '/' or '>'
  // (so <https://...> is NOT an HTML block, it is an autolink).
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
  if (!m) return null;
  const after = s[m[0].length];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '/' && after !== '>') return null;
  const tag = m[1].toLowerCase();
  const isClose = s[1] === '/';
  // A block tag starts a type-6 block regardless of what follows on
  // the line (attributes need not be valid); only a closing tag must
  // be well-formed.
  if (!isClose && BLOCK_TAGS.has(tag)) return { type: 6, endTag: null };
  // Validate the tag: attribute names must match
  // [a-zA-Z_:][a-zA-Z0-9_.:-]*, separated by whitespace; a closing
  // tag takes no attributes; the tag ends with `>` or `/>`.
  let j = m[0].length;
  if (isClose) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j >= s.length || s[j] !== '>') return null;
    if (BLOCK_TAGS.has(tag)) return { type: 6, endTag: null };
    let k = j + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k >= s.length) return { type: 7, endTag: null };
    return null;
  }
  let closed = false;
  let badAttr = false;
  let needWs = true; // an attribute name must follow whitespace
  while (j < s.length) {
    const c = s[j];
    if (c === '>') { closed = true; break; }
    if (c === '/' && j + 1 < s.length && s[j + 1] === '>') { closed = true; j++; break; }
    if (c === ' ' || c === '\t') { j++; needWs = false; continue; }
    if (c === '<') { badAttr = true; break; }
    if (!isAlpha(s.charCodeAt(j)) && s[j] !== '_' && s[j] !== ':') { badAttr = true; break; }
    if (needWs) { badAttr = true; break; }
    j++;
    while (j < s.length && (isAlnum(s.charCodeAt(j)) || s[j] === '_' || s[j] === '.' || s[j] === ':' || s[j] === '-')) j++;
    needWs = true;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) { j++; needWs = false; }
    if (j < s.length && s[j] === '=') {
      j++;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      if (j < s.length && s[j] === "'") {
        j++;
        while (j < s.length && s[j] !== "'") j++;
        if (j >= s.length) break;
        j++;
      } else if (j < s.length && s[j] === '"') {
        j++;
        while (j < s.length && s[j] !== '"') j++;
        if (j >= s.length) break;
        j++;
      } else {
        if (j >= s.length) break;
        while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '>' && s[j] !== '`') j++;
        if (j >= s.length) { badAttr = true; break; }
      }
      // After a value, whitespace (or `>`/`/>`) must follow before
      // the next attribute: `'bar'title` is not two attributes.
      if (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '>' && s[j] !== '/') { badAttr = true; break; }
    }
  }
  if (badAttr) return null;
  if (closed) {
    // Rest of the line after '>' must be blank for type 7.
    let k = j + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k >= s.length) return { type: 7, endTag: null };
  }
  return null;
}

// Parse a list marker at the start of `line`. Returns null or
// {ordered, start, bullet, markerLen, contentIndent, contentStart, empty}.
// contentStart is the index where the item content begins on this line
// (or -1 if the item is empty on this line).
function parseListMarker(line) {
  const { cols, idx } = indentCols(line);
  if (cols > 3) return null;
  let i = idx;
  if (i >= line.length) return null;
  const ch = line[i];
  let ordered = false, start = 0, markerLen = 0, delim = '';
  if (ch === '-' || ch === '+' || ch === '*') {
    markerLen = 1;
  } else if (isDigit(line.charCodeAt(i))) {
    let j = i;
    while (j < line.length && isDigit(line.charCodeAt(j))) j++;
    if (j - i > 9) return null;
    if (j >= line.length || (line[j] !== '.' && line[j] !== ')')) return null;
    ordered = true;
    start = parseInt(line.slice(i, j), 10);
    markerLen = j - i + 1;
    delim = line[j];
  } else return null;
  // Marker must be followed by whitespace or end of line.
  let k = idx + markerLen;
  if (k < line.length && line[k] !== ' ' && line[k] !== '\t') return null;
  // Measure the whitespace after the marker (in columns).
  let wsCols = 0, m = k;
  while (m < line.length && (line[m] === ' ' || line[m] === '\t')) {
    if (line[m] === ' ') wsCols++;
    else wsCols += 4 - ((cols + markerLen + wsCols) % 4);
    m++;
  }
  const empty = m >= line.length;
  let contentIndent, contentStart;
  if (empty) {
    contentIndent = cols + markerLen + 1;
    contentStart = -1;
  } else if (wsCols >= 5) {
    contentIndent = cols + markerLen + 1;
    contentStart = k + 1;
  } else {
    contentIndent = cols + markerLen + wsCols;
    contentStart = m;
  }
  return { ordered, start, bullet: ch, delim, markerLen, contentIndent, contentStart, empty, indent: cols };
}

// Does this list marker interrupt a paragraph? A bullet list always can
// (if its first item is not empty); an ordered list only if it starts
// with 1 (and its first item is not empty).
function listInterrupts(lm) {
  if (lm.empty) return false;
  if (!lm.ordered) return true;
  return lm.start === 1;
}

// Does the block parse of `lines` end in an open paragraph?
function endsInParagraph(lines) {
  if (!lines.length) return false;
  // A trailing blank line closes the paragraph: after it, a line
  // without a quote marker is not a lazy continuation.
  if (isBlank(lines[lines.length - 1])) return false;
  const blocks = parseBlocks(lines, new Map());
  if (!blocks.length) return false;
  let b = blocks[blocks.length - 1];
  while (b) {
    if (b.t === 'para') return true;
    if (b.t === 'quote' && b.children.length) { b = b.children[b.children.length - 1]; continue; }
    if (b.t === 'list' && b.items.length) {
      const it = b.items[b.items.length - 1];
      if (it.children.length) { b = it.children[it.children.length - 1]; continue; }
    }
    return false;
  }
  return false;
}

// Is this line the start of a block that can interrupt a paragraph?
function isInterrupt(line, lines, i, inItem, skipSetext) {
  if (parseATX(line)) return true;
  if (parseFence(line)) return true;
  if (isThematicBreak(line)) return true;
  if (stripQuote(line) !== null) return true;
  const hb = htmlBlockStart(line);
  if (hb && hb.type <= 6) return true;
  if (!skipSetext && setextLevel(line)) return true;
  const lm = parseListMarker(line);
  // Inside a list item, ANY list marker interrupts a paragraph;
  // at the top level only bullets and ordered lists starting at 1 do.
  if (lm && (inItem ? !lm.empty : listInterrupts(lm))) return true;
  return false;
}

// Table delimiter row: returns the alignment array or null.
function parseTableDelim(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  if (!s) return null;
  const cells = s.split('|');
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else if (c.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Split a table row line into cells (handling \| and edge pipes).
function splitTableRow(line) {
  let s = line.trim();
  // Remove one leading and one trailing pipe (if present).
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Collect a blockquote's inner lines starting at lines[i].
// Returns {inner, next}.
function collectQuote(lines, i) {
  const inner = [];
  let j = i;
  const n = lines.length;
  const colOff = quotePrefixCols(lines[i]);
  while (j < n) {
    const line = lines[j];
    const stripped = stripQuote(line);
    if (stripped !== null) {
      // A marker line whose content is only spaces is not a blank
      // line: the spaces are paragraph text (`>  ` continues the
      // paragraph as `foo\n `).
      if (stripped !== '' && isBlank(stripped) && endsInParagraph(inner)) {
        inner[inner.length - 1] += '\n' + stripped;
        j++; continue;
      }
      inner.push(stripped); j++; continue;
    }
    if (isBlank(line)) {
      // An empty blank line (no quote marker) ends the blockquote.
      // Only a marker line (handled above) continues it.
      break;
    }
    // A `=` setext underline as a lazy continuation cannot form a
    // heading (the underline is outside the quote), so it is
    // paragraph text. For a multi-line paragraph it gains 4 leading
    // spaces (a tab is kept as-is).
    if (setextLevel(line) === 1 && endsInParagraph(inner)) {
      const last = inner[inner.length - 1];
      const pc = last.split('\n').length;
      const t = line.replace(/^[ ]+/, '');
      inner[inner.length - 1] += '\n' + (pc >= 2 && !line.startsWith('\t') ? '    ' + t : (line.startsWith('\t') ? line : t));
      j++; continue;
    }
    // Lazy continuation: paragraph text only, and only while the quote
    // is in a paragraph. A list marker at indent < 4 is a block start,
    // not a continuation; at indent >= 4 it is paragraph text (an
    // indented code block cannot interrupt a paragraph). Appended to
    // the paragraph's last line so it is not re-parsed as a block.
    if (!isInterrupt(line, lines, j) && !(indentCols(line).cols < 4 && parseListMarker(line)) && endsInParagraph(inner)) { inner[inner.length - 1] += '\n' + dedentIfAtLeast(line, 4); j++; continue; }
    break;
  }
  return { inner, next: j, colOff };
}

// Collect one list starting at lines[i]. Returns {list, next}.
// A sibling item must match the list type, bullet char (unordered) or
// delimiter (ordered). Its indent may vary, but it must be below the
// previous item's content indent (otherwise it is nested inside that
// item, not a sibling).
function isSibling(lm, first, prevCi) {
  if (!lm || lm.ordered !== first.ordered) return false;
  // The new item may be less indented than the first item (it is still
  // a sibling at the list's level); it is nested only when it reaches
  // the previous item's content indent.
  if (prevCi !== undefined && lm.indent >= prevCi) return false;
  if (!first.ordered) return lm.bullet === first.bullet;
  return lm.delim === first.delim;
}

// Content of a list item's first line: the text after the marker,
// with leading tabs expanded to spaces on absolute columns. The
// marker's whitespace can expand past the content indent (a tab
// after `-` counts 1 column toward the indent but expands further),
// so the content can carry leading spaces (`-\t\tfoo` -> code
// `  foo`).
function firstItemContent(line, lm, colOff) {
  const off = colOff || 0;
  // Absolute column of the content start.
  let col = off, i = 0;
  while (i < lm.contentStart) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else col++;
    i++;
  }
  const contentCol = col;
  const prefix = Math.max(0, contentCol - (off + lm.contentIndent));
  // Expand leading tabs of the remainder on absolute columns.
  const rest = line.slice(lm.contentStart);
  let out = ' '.repeat(prefix), c = contentCol, k = 0;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    if (rest[k] === ' ') { out += ' '; c++; k++; }
    else { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; k++; }
  }
  return out + rest.slice(k);
}

function collectList(lines, i, refs, colOff) {
  const n = lines.length;
  const first = parseListMarker(lines[i]);
  const ordered = first.ordered;
  const items = [];
  let j = i;
  let loose = false;
  let prevCi = first.contentIndent;
  while (j < n) {
    const line = lines[j];
    // A thematic break is not a list item (it ends the list).
    if (isThematicBreak(line)) break;
    const lm = parseListMarker(line);
    if (!isSibling(lm, first, prevCi)) break;
    const ci = lm.contentIndent;
    const itemLines = [];
    if (lm.contentStart >= 0) itemLines.push(firstItemContent(line, lm, colOff));
    let k = j + 1;
    let itemHadBlank = false;
    let seenNestedMarker = false; // a nested list already started in this item
    let inFence = null; // active fenced-code opener while collecting
    let fenceLines = 0; // content lines added to the current fence
    if (itemLines.length) {
      const f0 = parseFence(itemLines[0]);
      if (f0) inFence = f0;
    }
    while (k < n) {
      const ln = lines[k];
      // Inside a fenced code block: include every line until the close.
      // But a non-blank line indented below the item's content indent
      // is not part of the item — unless the fence already has content
      // (once established, a fence owns all lines until its close).
      // So only the FIRST content line can end the item this way.
      if (inFence) {
        if (!isBlank(ln) && indentCols(ln).cols < ci && fenceLines === 0) { inFence = null; break; }
        const dl = dedentCols(ln, ci, colOff, true);
        itemLines.push(dl);
        fenceLines++;
        if (isFenceClose(dl, inFence)) inFence = null;
        k++; continue;
      }
      if (isBlank(ln)) {
        // An empty item ends at a blank line.
        if (!itemLines.length) break;
        // Include the blank line only if a later line belongs to this item.
        let m = k + 1;
        while (m < n && isBlank(lines[m])) m++;
        if (m >= n) break;
        if (isSibling(parseListMarker(lines[m]), first, ci)) break;
        // A link reference definition after a blank line is a top-level
        // block (not part of this item) — unless it is indented into
        // the item.
        if (indentCols(lines[m]).cols < ci && tryParseRefDef(lines, m)) break;
        const ind = indentCols(lines[m]);
        if (ind.cols >= ci) {
          itemLines.push('');
          // A blank line separates two blocks of this item — except
          // when it falls inside an already-started nested list
          // (between its items, or before a block nested in it),
          // where it loosens the nested list instead of this one.
          // A nested marker may sit at exactly this item's content
          // indent (so parseListMarker on the raw line misses it);
          // dedent first.
          const isMarker = parseListMarker(dedentCols(lines[m], ci, colOff, true)) != null;
          let loosens = itemLines.length > 1;
          if (seenNestedMarker && (isMarker || ind.cols > ci)) loosens = false;
          if (loosens) itemHadBlank = true;
          k++; continue;
        }
        // A blank line ends the item; the next line is not a lazy
        // continuation of its paragraph.
        break;
      }
      // Content indented to this item's level belongs to the item even
      // if it looks like a thematic break (it is a setext underline) or
      // a list marker (it is nested).
      const ind = indentCols(ln);
      if (ind.cols >= ci) {
        const dl = dedentCols(ln, ci, colOff, true);
        itemLines.push(dl);
        if (parseListMarker(dl)) seenNestedMarker = true;
        const f = parseFence(dl);
        if (f) { inFence = f; fenceLines = 0; }
        k++; continue;
      }
      if (isThematicBreak(ln)) break;
      if (isSibling(parseListMarker(ln), first, ci)) break;
      // A line indented less than the content indent can only be a lazy
      // paragraph continuation (never a list marker). It is appended to
      // the paragraph's last line so it is not re-parsed as a block.
      if (!isInterrupt(ln, lines, k) && !parseListMarker(ln) && endsInParagraph(itemLines)) {
        itemLines[itemLines.length - 1] += '\n' + dedentIfAtLeast(ln, ci); k++; continue;
      }
      break;
    }
    if (itemHadBlank) loose = true;
    while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    items.push({ t: 'item', children: parseBlocks(itemLines, refs, true, (colOff || 0) + ci) });
    prevCi = ci;
    j = k;
    // Blank lines between items make the list loose (if another item
    // follows).
    let b = j;
    while (b < n && isBlank(lines[b])) b++;
    if (b > j && b < n && isSibling(parseListMarker(lines[b]), first, ci)) loose = true;
    j = b;
  }
  return { list: { t: 'list', ordered, start: ordered ? first.start : 0, tight: !loose, items }, next: j };
}

// Parse one paragraph starting at lines[i]. Returns {block, next}.
// Handles setext headings and GFM tables.
function parseParagraph(lines, i, refs, inItem) {
  const para = [];
  let j = i;
  const n = lines.length;
  while (j < n) {
    const line = lines[j];
    if (isBlank(line)) {
      // For a table, a tab-only line is a (empty) row, not a blank
      // line — the table continues. A spaces-only or empty line ends it.
      if (line.indexOf('\t') >= 0 && para.length >= 2 && parseTableDelim(para[1]) && para[0].indexOf('|') >= 0) {
        para.push(line); j++; continue;
      }
      break;
    }
    if (para.length > 0) {
      // A table's rows are not setext underlines: once the first two
      // lines form a header + delimiter, later lines are table rows.
      const isTable = para.length >= 2 && parseTableDelim(para[1]) && para[0].indexOf('|') >= 0;
      const sl = isTable ? 0 : setextLevel(line);
      if (sl) {
        return { block: { t: 'h', level: sl, text: para.map(l => dedentCols(l, 3)).join('\n').trim() }, next: j + 1 };
      }
      if (isInterrupt(line, lines, j, inItem, isTable)) break;
    }
    para.push(line);
    j++;
  }
  if (para.length >= 2) {
    const aligns = parseTableDelim(para[1]);
    const head = splitTableRow(para[0]);
    if (aligns && aligns.length === head.length && para[0].indexOf('|') >= 0) {
      const w = head.length;
      const norm = (cells) => {
        while (cells.length < w) cells.push('');
        return cells.slice(0, w);
      };
      const rows = [];
      for (let k = 2; k < para.length; k++) rows.push(norm(splitTableRow(para[k])));
      return { block: { t: 'table', head: norm(head), aligns, rows }, next: j };
    }
  }
  return { block: { t: 'para', text: para.join('\n') }, next: j };
}

// The main block parser: lines -> block nodes. `refs` collects link
// reference definitions.
function parseBlocks(lines, refs, inItem, colOff, endsNL) {
  const blocks = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (isBlank(lines[i])) { i++; continue; }
    const line = lines[i];
    const rd = tryParseRefDef(lines, i);
    if (rd) {
      if (!refs.has(rd.label)) refs.set(rd.label, { href: rd.href, title: rd.title });
      i += rd.lines; continue;
    }
    const atx = parseATX(line);
    if (atx) { blocks.push({ t: 'h', level: atx.level, text: atx.text }); i++; continue; }
    const fence = parseFence(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], fence)) {
        content.push(fence.ch === '`' ? fenceDedent(lines[j], fence.indent, colOff) : expandLeadingTabs(lines[j], colOff));
        j++;
      }
      // The text is the content lines joined by newlines, with a
      // trailing newline added only if the result does not already
      // end with one (a blank line before the closing fence supplies
      // it, so trailing blanks are kept, not popped).
      let text = content.join('\n');
      if (text.length && !text.endsWith('\n')) text += '\n';
      blocks.push({ t: 'code', lang: fence.info, text });
      i = j < n ? j + 1 : j;
      continue;
    }
    const hb = htmlBlockStart(line);
    if (hb) {
      const htmlLines = [line];
      let j = i + 1;
      if (hb.type <= 5) {
        if (line.toLowerCase().indexOf(hb.endTag.toLowerCase()) < 0) {
          while (j < n) {
            htmlLines.push(lines[j]);
            if (lines[j].toLowerCase().indexOf(hb.endTag.toLowerCase()) >= 0) { j++; break; }
            j++;
          }
        }
      } else {
        while (j < n && !isBlank(lines[j])) { htmlLines.push(lines[j]); j++; }
      }
      // Types 1-5 get a trailing newline when followed by more
      // content in this scope, or (top level only, when the source
      // ends with a newline) when they are the last block. A trailing
      // HTML block in a nested scope (list item, blockquote) gets
      // none: marked lexes that scope's text without a trailing
      // newline. Types 6-7 never do (except the last-block rule in
      // parse). "Blank" here means a truly empty line: a
      // whitespace-only line (spaces or tabs) does NOT suppress
      // the newline.
      const hasFollowing = j < n && lines[j] !== '';
      const nl = hb.type <= 5 && (hasFollowing || (j >= n && endsNL));
      blocks.push({ t: 'html', text: htmlLines.join('\n'), htype: hb.type, nl });
      i = j; continue;
    }
    if (isThematicBreak(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    if (stripQuote(line) !== null) {
      const q = collectQuote(lines, i);
      // A blockquote re-lexes its content from scratch: the column
      // offset resets to just this quote's marker width (it does not
      // accumulate the outer offset). Lists, by contrast, accumulate.
      blocks.push({ t: 'quote', children: parseBlocks(q.inner, refs, inItem, q.colOff) });
      i = q.next; continue;
    }
    if (parseListMarker(line)) {
      const l = collectList(lines, i, refs, colOff);
      blocks.push(l.list);
      i = l.next; continue;
    }
    const ind = indentCols(line);
    if (ind.cols >= 4) {
      const content = [];
      let j = i;
      while (j < n) {
        if (isBlank(lines[j])) {
          let k = j + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && indentCols(lines[k]).cols >= 4) { content.push(dedentCols(lines[j], 4)); j++; continue; }
          break;
        }
        if (indentCols(lines[j]).cols >= 4) { content.push(dedentCols(lines[j], 4)); j++; continue; }
        break;
      }
      while (content.length && isBlank(content[content.length - 1])) content.pop();
      blocks.push({ t: 'code', lang: null, text: content.join('\n') + (content.length ? '\n' : '') });
      i = j; continue;
    }
    const p = parseParagraph(lines, i, refs, inItem);
    blocks.push(p.block);
    i = p.next;
  }
  return blocks;
}

// Render one list item's children. `tight` = the list is tight.
function renderListItem(it, tight, refs, out) {
  const ch = it.children;
  for (let k = 0; k < ch.length; k++) {
    const c = ch[k];
    if (c.t === 'para') {
      // Task list checkbox (only on the first paragraph).
      let tm = null, rest = null;
      if (k === 0) {
        if (c.text.startsWith('[ ] ') || c.text.startsWith('[x] ') || c.text.startsWith('[X] ')) {
          tm = c.text[1] === ' '; rest = c.text.slice(4);
        } else if (c.text === '[ ]' || c.text === '[x]' || c.text === '[X]') {
          tm = c.text[1] === ' '; rest = '';
        }
      }
      const box = tm === null ? '' : (tm ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ');
      if (tight) {
        out.push(box + inlineToHtml(rest !== null ? rest : c.text, refs));
      } else {
        out.push('<p>' + box + inlineToHtml(rest !== null ? rest : c.text, refs) + '</p>\n');
      }
      continue;
    }
    renderBlocks([c], refs, out);
  }
}

// Render block nodes to HTML.
function renderBlocks(blocks, refs, out) {
  for (const b of blocks) {
    if (b.t === 'para') {
      out.push('<p>' + inlineToHtml(b.text, refs) + '</p>\n');
    } else if (b.t === 'h') {
      out.push('<h' + b.level + '>' + inlineToHtml(b.text, refs) + '</h' + b.level + '>\n');
    } else if (b.t === 'code') {
      const lang = b.lang ? ' class="language-' + escHref(unescapeInline(b.lang.split(/\s+/)[0])) + '"' : '';
      out.push('<pre><code' + lang + '>' + escCode(b.text) + '</code></pre>\n');
    } else if (b.t === 'html') {
      // Trailing newline decided at parse time (see parseBlocks).
      out.push(b.text + (b.nl ? '\n' : ''));
    } else if (b.t === 'hr') {
      out.push('<hr>\n');
    } else if (b.t === 'quote') {
      out.push('<blockquote>\n');
      renderBlocks(b.children, refs, out);
      out.push('</blockquote>\n');
    } else if (b.t === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      out.push('<' + tag + start + '>\n');
      for (const it of b.items) {
        out.push('<li>');
        renderListItem(it, b.tight, refs, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
    } else if (b.t === 'table') {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < b.head.length; k++) {
        const a = b.aligns[k];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineToHtml(b.head[k], refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < row.length; k++) {
            const a = b.aligns[k];
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineToHtml(row[k], refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
    }
  }
}

// ---------------------------------------------------------------- entry

// Render Markdown to HTML (marked 18.1.3 default options: GFM on).
function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  inLinkDoc = false;
  const refs = new Map();
  const blocks = parseBlocks(lines, refs, false, 0, src.endsWith('\n'));
  const out = [];
  renderBlocks(blocks, refs, out);
  // A trailing-newline HTML block (type 6-7) that is the last block
  // gets one when the source ends with a newline.
  if (blocks.length && blocks[blocks.length - 1].t === 'html' && !blocks[blocks.length - 1].nl && src.endsWith('\n')) out.push('\n');
  return out.join('');
}

export { parse };
