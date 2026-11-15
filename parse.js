// parse.js — a fast, dependency-free Markdown renderer producing exactly the
// HTML that marked 18.1.3 renders with its default options (gfm on, breaks
// off). Written from scratch for the make.fun markdown-render-speed-02
// competition. It is a two-phase renderer: a line-based block parser builds
// blocks, then a tokenising inline parser renders each leaf block's text.
//
// The implementation follows the CommonMark 0.31.2 / GFM 0.29 structure
// (block containers, leaf blocks, delimiter-stack emphasis) while matching
// marked's observable behaviour wherever it differs from the spec text.

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}
function isAsciiSpace(c) { return c === ' ' || c === '\t'; }
function isDigit(c) { return c >= '0' && c <= '9'; }
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunctChar(c) { return c !== undefined && PUNCT.has(c); }
function isWordChar(c) { return c !== undefined && (isAlnum(c) || c === '_'); }

// Unicode-aware helpers used only for emphasis flanking decisions.
const RE_PUNCT_U = /[\p{P}\p{S}]/u;
const RE_SPACE_U = /\s/u;
function isUnicodePunct(c) { return c !== undefined && c !== '' && RE_PUNCT_U.test(c); }
function isUnicodeSpace(c) { return c !== undefined && c !== '' && RE_SPACE_U.test(c); }

// Escape text content: & < > " '  (marked escapes all five in text and code).
function escapeText(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { out += s.slice(last, i) + rep; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Escape an href / title attribute value. An ampersand is left alone when it
// starts something that looks like a character reference (&word;, &#123; or
// &#xAB; with the digit limits marked honours); every other & becomes &amp;.
function escapeAttr(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (looksLikeRef(s, i)) continue;
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === 62) { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === 34) { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === 39) { out += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Does s starting at i look like &#ddddddd; (<=7 digits), &#xhhhhhh; (<=6
// hex digits) or &word; (word chars only)? Used by escapeAttr.
function looksLikeRef(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const st = j;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || (s[j] >= 'a' && s[j] <= 'f') || (s[j] >= 'A' && s[j] <= 'F'))) j++;
      return j - st >= 1 && j - st <= 6 && s[j] === ';';
    }
    const st = j;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    return j - st >= 1 && j - st <= 7 && s[j] === ';';
  }
  const st = j;
  while (j < s.length && isWordChar(s[j])) j++;
  return j - st >= 1 && s[j] === ';';
}

// Decode one numeric character reference starting at s[i] === '&'.
// Returns [decodedChar, endIndex] or null when it is not a numeric ref.
function numericRef(s, i) {
  if (s[i + 1] !== '#') return null;
  let j = i + 2;
  let code = -1;
  if (s[j] === 'x' || s[j] === 'X') {
    j++;
    const st = j;
    while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || (s[j] >= 'a' && s[j] <= 'f') || (s[j] >= 'A' && s[j] <= 'F'))) j++;
    if (j - st < 1 || j - st > 6 || s[j] !== ';') return null;
    code = parseInt(s.slice(st, j), 16);
    j++;
  } else {
    const st = j;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j - st < 1 || j - st > 7 || s[j] !== ';') return null;
    code = parseInt(s.slice(st, j), 10);
    j++;
  }
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return ['\uFFFD', j];
  return [String.fromCodePoint(code), j];
}

// Percent-encode a link destination the way marked does (encodeURI-like:
// letters, digits and ;,/?:@&=+$-_.!~*'()# stay; everything else, including
// spaces, quotes and non-ASCII, is UTF-8 percent-encoded).
function encodeHref(u) {
  let out = '';
  let last = 0;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 59 || c === 44 || c === 47 || c === 63 || c === 58 || c === 64 || c === 38 ||
      c === 61 || c === 43 || c === 36 || c === 45 || c === 95 || c === 46 || c === 33 ||
      c === 126 || c === 42 || c === 39 || c === 40 || c === 41 || c === 35 || c === 37;
    if (!ok) {
      out += u.slice(last, i) + encodeURIComponent(u[i]);
      last = i + 1;
    }
  }
  return last === 0 ? u : out + u.slice(last);
}

// Clean a link destination: backslash-unescape punctuation, then encode.
function cleanHref(dest) {
  return escapeAttr(encodeHref(unescapePunct(dest)));
}

// Turn backslash-escaped ASCII punctuation into the bare character.
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunctChar(s[i + 1])) {
      out += s.slice(last, i) + s[i + 1];
      i++;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
//
// The scanner walks the source once and builds a flat list of items:
//   - plain strings (already-escaped HTML fragments)
//   - delimiter objects {d, ch, n, o, c} for *, _ and ~ runs
//   - wrapper objects {w, tag, kids} created later by emphasis resolution
// Link, image, code-span and autolink tokens are rendered to strings as
// they are found (their inner text is parsed recursively where needed).
// Emphasis is then resolved over the flat list with the delimiter stack.

function leftFlanking(before, after) {
  // before/after are single chars ('' at the string ends).
  if (after === '' || isUnicodeSpace(after)) return false;
  const ap = isUnicodePunct(after);
  if (!ap) return true;
  return before === '' || isUnicodeSpace(before) || isUnicodePunct(before);
}
function rightFlanking(before, after) {
  if (before === '' || isUnicodeSpace(before)) return false;
  const bp = isUnicodePunct(before);
  if (!bp) return true;
  return after === '' || isUnicodeSpace(after) || isUnicodePunct(after);
}

// Scan for the closing bracket of a link label starting at src[i] === '['.
// Returns the index just past the matching ']' or -1. Brackets nest;
// backslash escapes and code spans do not count.
function scanLabelEnd(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      const run = k - j;
      // A code span inside a label closes with a backtick run of any
      // length, not necessarily the same length as the opener.
      let close = -1;
      let m = k;
      while (m < n) {
        if (src[m] === '`') {
          let e = m;
          while (e < n && src[e] === '`') e++;
          close = e;
          break;
        }
        m++;
      }
      if (close !== -1) { j = close; continue; }
      // A run of two or more backticks right before ']' is allowed
      // on its own.
      if (run >= 2 && src[k] === ']') { j = k; continue; }
      return -1;
    }
    // A '<' starts a tag or autolink: a ']' inside it does not end
    // the label, so skip to the closing '>'.
    if (c === '<') {
      const gt = src.indexOf('>', j + 1);
      if (gt !== -1) { j = gt + 1; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

// Find the end of a code span whose opening run of `run` backticks ends at
// position `from`. Returns the index just past the closing run, or -1.
function findCodeClose(src, from, run) {
  const n = src.length;
  let j = from;
  while (j < n) {
    if (src[j] === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      if (k - j === run) return k;
      j = k;
    } else j++;
  }
  return -1;
}

// Normalise a link label: trim, collapse internal whitespace to one space,
// lowercase with full Unicode case folding (sharp s and ligatures fold to
// their expansions, so [ẞ] matches [SS]).
function normaliseLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Parse the inside of link parens starting at src[i] === '('.
// Returns {dest, title, end} (end = index just past ')') or null.
function parseLinkParens(src, i) {
  const n = src.length;
  let j = i + 1;
  // skip whitespace (spaces, tabs, newlines) after '('
  while (j < n && isSpace(src[j])) j++;
  if (j >= n) return null;
  let dest = '';
  if (src[j] === '<') {
    // <...> destination: no line endings, no unescaped < or >.
    let k = j + 1;
    let raw = '';
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\n' || c === '<') break;
      if (c === '>') { ok = true; break; }
      if (c === '\\' && k + 1 < n && isPunctChar(src[k + 1])) { raw += src[k] + src[k + 1]; k += 2; continue; }
      raw += c;
      k++;
    }
    if (!ok) return null;
    dest = raw;
    j = k + 1;
  } else {
    // Bare destination: balanced parens, backslash escapes, no spaces or
    // control characters.
    let k = j;
    let depth = 0;
    let raw = '';
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c < ' ') break;
      if (c === '\\' && k + 1 < n && isPunctChar(src[k + 1])) { raw += src[k] + src[k + 1]; k += 2; continue; }
      if (c === '(') { depth++; raw += c; k++; continue; }
      if (c === ')') {
        if (depth === 0) { ok = true; break; }
        depth--;
        raw += c;
        k++;
        continue;
      }
      raw += c;
      k++;
    }
    if (!ok) {
      // No closing paren reached without whitespace: this may still be a
      // destination followed by whitespace + title + ')'. Re-scan to the
      // first whitespace, treating that as the destination end.
      let k2 = j;
      let depth2 = 0;
      let raw2 = '';
      let stopped = false;
      while (k2 < n) {
        const c = src[k2];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c < ' ') { stopped = true; break; }
        if (c === '\\' && k2 + 1 < n && isPunctChar(src[k2 + 1])) { raw2 += src[k2] + src[k2 + 1]; k2 += 2; continue; }
        if (c === '(') { depth2++; raw2 += c; k2++; continue; }
        if (c === ')') {
          if (depth2 === 0) { stopped = true; break; }
          depth2--;
          raw2 += c;
          k2++;
          continue;
        }
        raw2 += c;
        k2++;
      }
      if (!stopped || raw2 === '') return null;
      dest = raw2;
      j = k2;
    } else {
      dest = raw;
      j = k;
      // j points at ')' with no title.
      return { dest, title: null, end: j + 1 };
    }
  }
  // Optional title, then ')'.
  let k = j;
  while (k < n && isSpace(src[k])) k++;
  if (k < n && src[k] === ')') return { dest, title: null, end: k + 1 };
  if (k >= n) return null;
  const t = parseTitle(src, k);
  if (t === null) return null;
  k = t.end;
  while (k < n && isSpace(src[k])) k++;
  if (k < n && src[k] === ')') return { dest, title: t.title, end: k + 1 };
  return null;
}

// Parse a link title starting at src[i] ('"' or '\'' or '(').
// Returns {title, end} or null.
function parseTitle(src, i) {
  const n = src.length;
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src[j];
      if (c === '\\' && j + 1 < n && isPunctChar(src[j + 1])) { out += src[j] + src[j + 1]; j += 2; continue; }
      if (c === q) return { title: out, end: j + 1 };
      out += c;
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src[j];
      if (c === '\\' && j + 1 < n && isPunctChar(src[j + 1])) { out += src[j] + src[j + 1]; j += 2; continue; }
      if (c === '(' || c === ')') {
        if (c === ')') return { title: out, end: j + 1 };
        return null;
      }
      out += c;
      j++;
    }
    return null;
  }
  return null;
}

// Try to parse an autolink / email autolink / raw HTML tag starting at
// src[i] === '<'. Returns {html, end} or null.
function parseAngle(src, i, refs, inLink) {
  const n = src.length;
  const rest = src.slice(i + 1);
  // Scheme autolink: <scheme:...>
  let m = rest.match(/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/);
  if (m) {
    const url = m[0].slice(0, -1);
    if (url.indexOf(' ') === -1) {
      const href = escapeText(encodeHref(url));
      return { html: '<a href="' + href + '">' + escapeText(url) + '</a>', end: i + 1 + m[0].length };
    }
  }
  // Email autolink: <local@domain.tld>
  m = rest.match(/^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/);
  if (m) {
    const addr = m[1];
    const href = escapeText(encodeHref('mailto:' + addr));
    return { html: '<a href="' + href + '">' + escapeText(addr) + '</a>', end: i + 1 + m[0].length };
  }
  // Comment <!-- ... --> : '--' may appear inside the body. An abrupt
  // close, <!--> or <!--->, is a complete comment on its own.
  if (rest.startsWith('!--')) {
    if (rest.startsWith('!-->')) return { html: src.slice(i, i + 5), end: i + 5 };
    if (rest.startsWith('!--->')) return { html: src.slice(i, i + 6), end: i + 6 };
    const end = rest.indexOf('-->', 3);
    if (end !== -1) {
      return { html: src.slice(i, i + 1 + end + 3), end: i + 1 + end + 3 };
    }
    return null;
  }
  // Processing instruction <? ... ?>
  if (rest.startsWith('?')) {
    const end = rest.indexOf('?>', 1);
    if (end !== -1) return { html: src.slice(i, i + 1 + end + 2), end: i + 1 + end + 2 };
    return null;
  }
  // Declaration <!A ... >
  if (rest.startsWith('!') && rest.length > 1 && isAlpha(rest[1])) {
    const end = rest.indexOf('>', 1);
    if (end !== -1) return { html: src.slice(i, i + 1 + end + 1), end: i + 1 + end + 1 };
    return null;
  }
  // CDATA <![CDATA[ ... ]]>
  if (rest.startsWith('![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    if (end !== -1) return { html: src.slice(i, i + 1 + end + 3), end: i + 1 + end + 3 };
    return null;
  }
  // Open / close tag.
  const tag = parseHtmlTag(src, i);
  if (tag) return tag;
  return null;
}

// Parse an HTML open or close tag at src[i] === '<'. Returns {html, end}.
// The tag name must end at whitespace, '/' or '>'; attribute names are
// [A-Za-z_:][A-Za-z0-9_.:-]*; whitespace is required between attributes.
function parseHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlpha(src[j])) return null;
  const nameStart = j;
  while (j < n && (isAlnum(src[j]) || src[j] === '-')) j++;
  if (j === nameStart) return null;
  // After the tag name, only whitespace, '/' or '>' may follow.
  if (j < n && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '/' && src[j] !== '>') return null;
  if (closing) {
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (j < n && src[j] === '>') return { html: src.slice(i, j + 1), end: j + 1 };
    return null;
  }
  // Attributes.
  while (j < n) {
    // Skip whitespace.
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
    if (k >= n) return null;
    if (src[k] === '>') return { html: src.slice(i, k + 1), end: k + 1 };
    if (src[k] === '/' && src[k + 1] === '>') return { html: src.slice(i, k + 2), end: k + 2 };
    j = k;
    // Attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    if (!isAlpha(src[j]) && src[j] !== '_' && src[j] !== ':') return null;
    j++;
    while (j < n && (isAlnum(src[j]) || src[j] === '_' || src[j] === '.' || src[j] === ':' || src[j] === '-')) j++;
    // After the name, only whitespace, '=', '/', '>' or end may follow.
    if (j < n && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '=' && src[j] !== '/' && src[j] !== '>') return null;
    // Optional = value.
    let k2 = j;
    while (k2 < n && (src[k2] === ' ' || src[k2] === '\t' || src[k2] === '\n')) k2++;
    if (k2 < n && src[k2] === '=') {
      k2++;
      while (k2 < n && (src[k2] === ' ' || src[k2] === '\t' || src[k2] === '\n')) k2++;
      if (k2 >= n) return null;
      const q = src[k2];
      if (q === '"' || q === "'") {
        k2++;
        while (k2 < n && src[k2] !== q) k2++;
        if (k2 >= n) return null;
        j = k2 + 1;
      } else {
        while (k2 < n && src[k2] !== ' ' && src[k2] !== '\t' && src[k2] !== '\n' && src[k2] !== '"' && src[k2] !== "'" && src[k2] !== '=' && src[k2] !== '<' && src[k2] !== '>' && src[k2] !== '`') k2++;
        j = k2;
      }
      // After a value, only whitespace, '/' or '>' may follow:
      // attributes may not run together without whitespace.
      if (j < n && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '/' && src[j] !== '>') return null;
    }
    // A valueless attribute leaves j just past its name; the loop top
    // skips the whitespace before the next attribute.
  }
  return null;
}

// Extended (GFM) autolink: www. / scheme:// / email / scheme:email, at a
// word boundary. src[i] is the first char of the candidate. Returns
// {html, end} or null.
function parseExtendedAutolink(src, i) {
  const n = src.length;
  // Preceding char must be start, whitespace, or one of * _ ~ ( [ " ' <
  if (i > 0) {
    const p = src[i - 1];
    if (!isSpace(p) && p !== '*' && p !== '_' && p !== '~' && p !== '(' && p !== '[' && p !== '"' && p !== "'" && p !== '<') return null;
  }
  const rest = src.slice(i);
  const emailRe = '[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+';
  // Scheme + email: scheme:local@domain. mailto: takes no path; other
  // schemes take a single path segment.
  let m = rest.match(new RegExp('^([A-Za-z][A-Za-z0-9+.-]{1,31}):(' + emailRe + ')'));
  if (m) {
    const scheme = m[1];
    let url = scheme + ':' + m[2];
    // The char after the email must not extend it: '-' / '_' / alnum
    // means the domain label was cut short, so the email is invalid.
    const afterEmail = i + url.length;
    if (afterEmail < n) {
      const nx = src[afterEmail];
      if (nx === '-' || nx === '_' || isAlnum(nx)) return null;
    }
    if (scheme.toLowerCase() !== 'mailto' && afterEmail < n && src[afterEmail] === '/') {
      let k = afterEmail + 1;
      while (k < n && !isSpace(src[k]) && src[k] !== '<' && src[k] !== '>' && src[k] !== '/') k++;
      url = src.slice(i, k);
    }
    url = trimAutolinkEnd(url);
    if (url.length === 0) return null;
    const href = escapeText(encodeHref(url));
    return { html: '<a href="' + href + '">' + escapeText(url) + '</a>', end: i + url.length };
  }
  m = rest.match(/^(?:[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.)[^\s<]*/);
  let isEmail = false;
  if (!m) {
    m = rest.match(new RegExp('^' + emailRe));
    if (!m) return null;
    isEmail = true;
    // Same validity check after a bare email.
    const afterEmail = i + m[0].length;
    if (afterEmail < n) {
      const nx = src[afterEmail];
      if (nx === '-' || nx === '_' || isAlnum(nx)) return null;
    }
  }
  let url = m[0];
  // Trim trailing punctuation and unbalanced closing parens.
  url = trimAutolinkEnd(url);
  if (url.length === 0) return null;
  if (!isEmail && url.indexOf('.') === -1 && !url.startsWith('http')) {
    // www. always has a dot; a bare scheme link needs one too in practice.
  }
  if (isEmail) {
    const href = escapeText(encodeHref('mailto:' + url));
    return { html: '<a href="' + href + '">' + escapeText(url) + '</a>', end: i + url.length };
  }
  const href = escapeText(encodeHref(url.startsWith('www.') ? 'http://' + url : url));
  return { html: '<a href="' + href + '">' + escapeText(url) + '</a>', end: i + url.length };
}

// Length of the longest prefix of `s` matched by the autolink
// backpedal: plain chars, balanced `(...)` groups, a lone `&`, or a
// punctuation run that is followed by more text (a punctuation run
// reaching the end of the string is not consumed). `]` is a plain
// character here, not punctuation.
function backpedalLen(s) {
  const n = s.length;
  const PUNCT = '?!.,:;*_\'"~)';
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const close = s.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === '&') {
      // An `&` that starts an entity reference reaching the end is
      // not consumed.
      const m = /^[A-Za-z0-9]+;/.exec(s.slice(i + 1));
      if (m && i + 1 + m[0].length === n) break;
      i++;
      continue;
    }
    if (PUNCT.indexOf(c) !== -1) {
      let j = i;
      while (j < n && PUNCT.indexOf(s[j]) !== -1) j++;
      if (j === n) break;
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

// Remove trailing punctuation from an extended autolink candidate by
// applying the backpedal until the candidate stops shrinking.
function trimAutolinkEnd(url) {
  let prev;
  do {
    prev = url.length;
    url = url.slice(0, backpedalLen(url));
  } while (url.length !== prev);
  return url;
}

// Does this label text contain a LINK that parses on its own? (Used to
// enforce "a link's label cannot contain a link". An image inside the
// label does not count: it renders to <img>, not <a>.)
function labelContainsLink(label, refs, st) {
  const n = label.length;
  let j = 0;
  while (j < n) {
    const c = label[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && label[k] === '`') k++;
      const close = findCodeClose(label, k, k - j);
      if (close === -1) return false;
      j = close;
      continue;
    }
    // An image is skipped whole (its label may hold a link, which only
    // becomes alt text); a bare '[' is tested as a link.
    if (c === '!' && label[j + 1] === '[') {
      const img = parseLink(label, j, refs, false, st);
      if (img) { j = img.end; continue; }
      j++;
      continue;
    }
    if (c === '[') {
      if (parseLink(label, j, refs, false, st) !== null) return true;
    }
    j++;
  }
  return false;
}

// Try to parse a link or image starting at src[i] (src[i] === '[' or the
// '!' of '!['). Returns {html, end} or null. inLink disables nested links.
function parseLink(src, i, refs, inLink, st) {
  const n = src.length;
  let isImage = false;
  let j = i;
  if (src[j] === '!') { isImage = true; j++; }
  if (src[j] !== '[') return null;
  const labelEnd = scanLabelEnd(src, j);
  if (labelEnd === -1) return null;
  const labelRaw = src.slice(j + 1, labelEnd - 1);
  const after = labelEnd;
  // A LINK's label cannot itself contain a link: if the label text
  // holds a link that parses, the outer link does not form and the
  // inner one parses instead. (An image's label may contain links;
  // they render into its alt text.)
  if (!isImage && labelContainsLink(labelRaw, refs, st)) return null;
  let dest = null;
  let title = null;
  if (after < n && src[after] === '(') {
    const p = parseLinkParens(src, after);
    if (p === null) {
      // An invalid inline destination falls back to the shortcut
      // reference link, leaving the "(...)" as literal text.
      const ref = refs.get(normaliseLabel(labelRaw));
      if (ref === undefined) return null;
      dest = ref.dest;
      title = ref.title;
      var end = after;
    } else {
      dest = p.dest;
      title = p.title;
      var end = p.end;
    }
  } else {
    // Reference link: [label][ref], [label][], or shortcut [label].
    let refLabel = null;
    if (after < n && src[after] === '[') {
      const refEnd = scanLabelEnd(src, after);
      if (refEnd === -1) return null;
      refLabel = src.slice(after + 1, refEnd - 1);
      var end = refEnd;
      if (refLabel === '') refLabel = labelRaw;
    } else {
      refLabel = labelRaw;
      var end = after;
    }
    const ref = refs.get(normaliseLabel(refLabel));
    if (ref === undefined) return null;
    dest = ref.dest;
    title = ref.title;
  }
  if (dest === null) return null;
  // A link's label is parsed with nested links disabled; an image's
  // label is not inside a link, so links inside it may form (they are
  // stripped to their text for the alt attribute). A <a> / </a> inside
  // the label must not change the document-level inLink, so save and
  // restore it around the label parse.
  const savedInLink = st ? st.inLink : false;
  const inner = parseInline(labelRaw, refs, !isImage, st);
  if (st) st.inLink = savedInLink;
  if (isImage) {
    const alt = stripTags(inner);
    let out = '<img src="' + cleanHref(dest) + '" alt="' + escapeAttr(alt) + '"';
    if (title !== null && title !== undefined) out += ' title="' + escapeAttr(unescapePunct(title)) + '"';
    return { html: out + '>', end };
  }
  if (inLink) return null;
  let out = '<a href="' + cleanHref(dest) + '"';
  if (title !== null && title !== undefined) out += ' title="' + escapeAttr(unescapePunct(title)) + '"';
  return { html: out + '>' + inner + '</a>', end };
}

// Strip HTML tags from a rendered string (for image alt text). An
// <img> tag contributes its alt attribute value instead of vanishing.
function stripTags(s) {
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'|\balt\s*=\s*([^\s>]+)/i);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  });
  return s.replace(/<[^>]*>/g, '');
}

// ---------------------------------------------------------------------------
// Opener-driven emphasis / strikethrough resolution (marked's emStrong/del)
// ---------------------------------------------------------------------------
//
// marked does not use a delimiter stack. For every `*`/`_`/`~` run it can
// open, it scans forward over the later runs of the same character:
//   - a run that can only open (groups 3-4) inflates the opener's remaining
//     length instead of closing it;
//   - a run that can both open and close (groups 5-6, and any closer when
//     the R flag holds) is skipped, banking its length, when the rule of
//     three applies (opener length % 3 != 0 and (opener + closer) % 3 == 0);
//   - the first run that covers the remaining length closes the emphasis,
//     consuming min(run, run + remaining + banked) of its characters.
// The interior is then re-parsed from its source text, so nesting resolves
// inside-out. `~` (del) has no rule of three, and its closer must have the
// same length as its opener. A run that can only close is a plain closer;
// a run between two spaces (or at the ends) is never even seen by the scan.

const RE_ALNUM_U = /[\p{L}\p{N}]/u;

// marked's `punctuation` rule: a space or punctuation character, except
// that `*` and `_` never count.
function isNtPunct(c) {
  return c !== '' && c !== '*' && c !== '_' && (isUnicodeSpace(c) || isUnicodePunct(c));
}
// String.prototype.trim() on one character is empty for whitespace (and
// U+FEFF) or the empty string.
function isTrimEmpty(c) {
  return c === '' || isUnicodeSpace(c) || c === '\uFEFF';
}
// The whitespace set marked's closer-index scan treats as "before" a run.
function isFeWS(c) {
  return c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

// Classify one delimiter run as a closer candidate from the characters
// before (B) and after (A) it. 0 = not a candidate, 1-2 = pure closer,
// 3-4 = can only open, 5-6 = can both open and close. `_` has no group 6:
// a `_` run between two word characters is never even seen by the scan.
function closerGroup(ch, B, A) {
  const aEnd = A === '';
  const aWS = A !== '' && isUnicodeSpace(A);
  const aP = A !== '' && isUnicodePunct(A);
  const aN = A !== '' && !isUnicodeSpace(A) && !isUnicodePunct(A);
  const bP = B !== '' && isUnicodePunct(B);
  const bWS = B !== '' && isUnicodeSpace(B);
  const bN = B !== '' && !isUnicodeSpace(B) && !isUnicodePunct(B);
  if (ch === '*') {
    const bPx = bP && B !== '~';
    const bNx = bN || B === '~';
    const bPSx = bWS || bPx;
    const aPx = aP && A !== '~';
    const aNx = aN || A === '~';
    const aPSx = aWS || aPx;
    if (bPx && (aWS || aEnd)) return 1;
    if (bNx && (aPSx || aEnd)) return 2;
    if (bPSx && aNx) return 3;
    if (bWS && aPx) return 4;
    if (bPx && aPx) return 5;
    if (bNx && aNx) return 6;
    return 0;
  }
  if (ch === '_') {
    const bPS = bWS || bP;
    const aPS = aWS || aP;
    if (bP && (aWS || aEnd)) return 1;
    if (bN && (aPS || aEnd)) return 2;
    if (bPS && aN) return 3;
    if (bWS && aP) return 4;
    if (bP && aP) return 5;
    return 0;
  }
  // '~' (del): same shape as `*`, with `~` counting as punctuation.
  const bPx = bP && B !== '~';
  const bPSx = bWS || bPx;
  const aPx = aP && A !== '~';
  const aPSx = aWS || aPx;
  if (bPx && (aWS || aEnd)) return 1;
  if (bN && (aPSx || aEnd)) return 2;
  if (bPSx && aN) return 3;
  if (bWS && aPx) return 4;
  if (bPx && aPx) return 5;
  if (bN && aN) return 6;
  return 0;
}

// First index in the sorted masked-run list with pos > `pos`.
function runAfter(runs, pos) {
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].pos > pos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// marked's closer-scan patterns begin with an alternative that swallows a
// lone `*` between two `__`s (or a lone `_` between two `**`s) right after
// the opener, so that run is never a closer candidate. Find that run: the
// first three `*`/`_` runs after the opener must be `__`, `*`, `__` (or
// `**`, `_`, `**` for a `_` opener), with the middle run exactly one
// character long. `start` is the first masked run after the opener.
function alt1SkippedRun(runs, start, ch) {
  let r1 = null, r2 = null, r3 = null, seen = 0;
  for (let ci = start; ci < runs.length && seen < 3; ci++) {
    const C = runs[ci];
    if (C.ch === '~') continue;
    if (seen === 0) r1 = C;
    else if (seen === 1) r2 = C;
    else r3 = C;
    seen++;
  }
  if (seen < 3) return null;
  if (ch === '*') {
    if (r1.ch === '_' && r1.n === 2 && r2.ch === '*' && r2.n === 1 && r3.ch === '_' && r3.n >= 2) return r2;
  } else if (ch === '_') {
    if (r1.ch === '*' && r1.n === 2 && r2.ch === '_' && r2.n === 1 && r3.ch === '*' && r3.n >= 2) return r2;
  }
  return null;
}

// Scan forward from one opener attempt for a closer. `op` is the run, `j`
// the offset within it where this attempt starts, `k` the opener length
// for the attempt, `runs` the masked-source runs, `v` the scan bound
// (index of the last run of this character preceded by a non-whitespace
// character), `byPos` maps a run's start position to the tokenised
// delimiter there (for its item index and phantom flag). Candidates the
// tokeniser never recorded are skipped. Returns {closer, use} or null.
function scanForCloser(op, j, k, runs, v, byPos) {
  const ch = op.ch;
  const y = op.origLen;
  const start = runAfter(runs, op.pos + op.n);
  const skip = alt1SkippedRun(runs, start, ch);
  if (ch === '~') {
    let rem = k;
    for (let ci = start; ci < runs.length; ci++) {
      const C = runs[ci];
      if (C.ch !== '~') continue;
      if (C.pos > v) break;
      if (C.n !== k) continue;
      const g = closerGroup('~', C.before, C.after);
      if (g === 0) continue;
      if (g === 3 || g === 4) { rem += C.n; continue; }
      rem -= C.n;
      if (rem > 0) continue;
      const d = byPos.get(C.pos);
      if (!d) continue;
      return { closer: d, use: C.n };
    }
    return null;
  }
  const o = j > 0 && ch === '*';
  const p = op.before;
  const h = p === '*' || p === '_' || isNtPunct(p);
  const d = op.after !== '~' && isUnicodePunct(op.after) ? op.after : '';
  const R = !isTrimEmpty(p) && (d !== '' || (ch === '*' && !h));
  let m = k, f = 0;
  for (let ci = start; ci < runs.length; ci++) {
    const C = runs[ci];
    if (C.ch !== ch) continue;
    if (C.pos > v) break;
    if (C === skip) continue;
    const g = closerGroup(ch, C.before, C.after);
    if (g === 0) continue;
    const b = C.n;
    if (g === 3 || g === 4) { m += b; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const d = byPos.get(C.pos);
    if (!d) continue;
    return { closer: d, use: Math.min(b, b + m + f) };
  }
  return null;
}

// Try every opening offset of one delimiter run, opener-driven. `nPrev` is
// the character before the run in the token stream ('' when the previous
// token is not plain text). `runs`/`bounds` come from the masked source;
// `byPos` maps run positions to tokenised delimiters. Returns
// {tag, j, closer, use} or null.
function tryOpen(op, nPrev, runs, bounds, byPos) {
  const ch = op.ch;
  const after = op.after;
  if (after === '' || isUnicodeSpace(after)) return null;
  const v = bounds[ch];
  // `~` runs are only ever tried at their first character: after a failed
  // del() the text token swallows the whole run.
  const attempts = ch === '~' ? 1 : op.n;
  for (let j = 0; j < attempts; j++) {
    const k = op.n - j;
    if (ch === '~' && k > 2) continue;
    const nAt = j > 0 ? op.before : nPrev;
    if (ch === '_') {
      // The character after the run is a non-space, non-underscore
      // character that is not punctuation (other than `~`). With an
      // alphanumeric character before it, this run cannot open.
      const s4 = after !== '_' && !(after !== '~' && isUnicodePunct(after));
      if (s4 && nAt !== '' && RE_ALNUM_U.test(nAt)) continue;
    }
    const d = after !== '~' && isUnicodePunct(after) ? after : '';
    const u = j > 0
      ? (op.before === '*' || op.before === '_' || isNtPunct(op.before))
      : isNtPunct(nAt);
    if (d !== '' && nAt !== '' && !u) continue;
    const hit = scanForCloser(op, j, k, runs, v, byPos);
    if (!hit) continue;
    const tag = ch === '~' ? 'del' : (Math.min(k, hit.use) % 2 === 1 ? 'em' : 'strong');
    // The match takes 1 delimiter per side for em, 2 for strong, and the
    // whole opener run for del; the rest of the two runs stays inside
    // the interior text and is re-parsed with it.
    const take = ch === '~' ? k : (tag === 'em' ? 1 : 2);
    return { tag, j, take, closer: hit.closer, use: hit.use };
  }
  return null;
}

// Resolve emphasis over the flat item list, opener-driven, returning the
// leaf's HTML. `delims` holds every delimiter run (real runs in `items`
// plus phantom runs inside extended autolinks) in document order.
// Find the next backtick run of exactly `len` at or after `from`.
// Returns the run's start index, or -1.
function nextBacktickRun(src, from, len) {
  const n = src.length;
  let j = from;
  while (j < n) {
    if (src[j] === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      if (k - j === len) return j;
      j = k;
    } else j++;
  }
  return -1;
}

// Try to match an inline link starting at s[i] ('[' or '![') using the
// masking pass's label rule: code spans in the label need equal-length
// runs, and the label has no nested brackets. Returns the index just
// past the closing ')' or -1.
function matchMaskedLink(s, i) {
  const n = s.length;
  let j = i;
  if (s[j] === '!') j++;
  if (j >= n || s[j] !== '[') return -1;
  j++;
  while (j < n) {
    const c = s[j];
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const len = k - j;
      const close = nextBacktickRun(s, k, len);
      if (close === -1) return -1;
      j = close + len;
      continue;
    }
    j++;
  }
  if (j >= n || s[j] !== ']') return -1;
  let k = j + 1;
  if (k >= n || s[k] !== '(') return -1;
  k++;
  let depth = 0;
  while (k < n) {
    const c = s[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '(') {
      if (depth === 1) return -1;
      depth = 1;
      k++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return k + 1;
      depth = 0;
      k++;
      continue;
    }
    k++;
  }
  return -1;
}

// The masked copy of the source: code-span contents, link spans and
// HTML tags are replaced by filler, so delimiter runs inside them are
// invisible to the emphasis scan. The masking is a single left-to-right
// pass: a backtick run pairs with the next run of the same length (even
// across a link label, so a mismatched code span in a label leaves the
// link unmasked and its backticks free to swallow a later run), a link
// is only masked when its label's code spans have equal runs, and an
// escaped punctuation mark is masked too.
function maskedSrc(src) {
  const n = src.length;
  const m = src.split('');
  const fill = (a, b) => { for (let k = a; k < b; k++) m[k] = 'a'; };
  let j = 0;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isUnicodePunct(src[j + 1])) { fill(j, j + 2); j += 2; continue; }
    if (c === '[' || (c === '!' && src[j + 1] === '[')) {
      const end = matchMaskedLink(src, j);
      if (end !== -1) { fill(j, end); j = end; continue; }
      j++;
      continue;
    }
    if (c === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      const len = k - j;
      const close = nextBacktickRun(src, k, len);
      if (close !== -1) { fill(k, close); j = close + len; continue; }
      j = k;
      continue;
    }
    if (c === '<' && src[j + 1] !== ' ') {
      let k = j + 1;
      while (k < n && src[k] !== '>' && src[k] !== '<') k++;
      if (k < n && src[k] === '>') { fill(j, k + 1); j = k + 1; continue; }
      j++;
      continue;
    }
    j++;
  }
  return m.join('');
}

// Delimiter runs of a masked source, plus the closer bound per char
// (the last run start whose before-char is not whitespace). Runs of
// three or more tildes are not candidates (a failed del swallows the
// whole run as text) but still count for the `~` bound.
function maskedRuns(masked) {
  const n = masked.length;
  const bounds = { '*': -1, '_': -1, '~': -1 };
  const runs = [];
  let p = 0;
  while (p < n) {
    const c = masked[p];
    if (c === '*' || c === '_' || c === '~') {
      let k = p;
      while (k < n && masked[k] === c) k++;
      if (p > 0 && !isFeWS(masked[p - 1])) bounds[c] = p;
      if (!(c === '~' && k - p >= 3)) {
        runs.push({ ch: c, n: k - p, pos: p, before: p > 0 ? masked[p - 1] : '', after: k < n ? masked[k] : '' });
      }
      p = k;
    } else p++;
  }
  return { bounds, runs };
}

function resolveEmphasis(items, delims, src, refs, inLink, st) {
  // Closer candidates and bounds come from the masked source; the
  // tokenised delimiters supply item indexes and phantom flags.
  const { bounds, runs } = maskedRuns(maskedSrc(src));
  const byPos = new Map();
  for (const d of delims) if (!byPos.has(d.pos)) byPos.set(d.pos, d);
  let out = '';
  let i = 0;
  let pending = null;
  let prevKind = 'start'; // 'start' | 'text' | 'token': kind of previous token
  while (i < items.length || pending) {
    let op;
    if (pending) { op = pending; pending = null; }
    else {
      const it = items[i];
      if (typeof it === 'string') {
        out += it;
        prevKind = it[0] === '<' ? 'token' : 'text';
        i++;
        continue;
      }
      if (it.w) { out += '<' + it.w + '>' + renderItems(it.kids) + '</' + it.w + '>'; prevKind = 'token'; i++; continue; }
      op = it;
      i++;
    }
    const nPrev = prevKind === 'text' ? op.before : '';
    const hit = tryOpen(op, nPrev, runs, bounds, byPos);
    if (!hit) {
      out += op.ch.repeat(op.n);
      prevKind = 'text';
      continue;
    }
    if (hit.j > 0) out += op.ch.repeat(hit.j);
    const inner = parseInline(src.slice(op.pos + hit.j + hit.take, hit.closer.pos + hit.use - hit.take), refs, inLink, st);
    out += '<' + hit.tag + '>' + inner + '</' + hit.tag + '>';
    prevKind = 'token';
    if (hit.closer.phantom) {
      // The closer is a phantom run inside an extended autolink: the
      // match cuts that link short, so the rest of the leaf is
      // tokenised afresh from just past the closer.
      return out + parseInline(src.slice(hit.closer.pos + hit.use), refs, inLink, st);
    }
    i = hit.closer.ix + 1;
    if (hit.use < hit.closer.n) {
      pending = {
        d: 1, ch: hit.closer.ch, n: hit.closer.n - hit.use,
        pos: hit.closer.pos + hit.use, origLen: hit.closer.n,
        before: hit.closer.before, after: hit.closer.after,
        di: hit.closer.di, ix: -1, phantom: false,
      };
    }
  }
  return out;
}

// Render the flat item list to an HTML string.
function renderItems(items) {
  let out = '';
  for (const it of items) {
    if (typeof it === 'string') out += it;
    else if (it.w) out += '<' + it.w + '>' + renderItems(it.kids) + '</' + it.w + '>';
    else if (it.d) out += it.ch.repeat(it.n);
  }
  return out;
}

// Record the delimiter runs inside an extended autolink as phantom
// delimiters: they are visible to an earlier opener's closer scan (the
// link text is not masked), but they are never opening positions
// themselves, and they never appear in the item list.
function recordPhantomRuns(src, from, to, delims) {
  let j = from;
  while (j < to) {
    const c = src[j];
    if (c === '*' || c === '_' || c === '~') {
      let k = j;
      while (k < to && src[k] === c) k++;
      const run = k - j;
      if (!(c === '~' && run >= 3)) {
        delims.push({ d: 1, ch: c, n: run, pos: j, origLen: run, before: j > 0 ? src[j - 1] : '', after: k < src.length ? src[k] : '', di: delims.length, ix: -1, phantom: true });
      }
      j = k;
    } else j++;
  }
}

// The main inline parser: src is one leaf block's text (paragraph lines
// joined by \n, heading text, table cell text, ...).
function parseInline(src, refs, inLink, st) {
  const n = src.length;
  const items = [];
  const delims = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf !== '') { items.push(buf); buf = ''; } };
  while (i < n) {
    const c = src[i];
    // Backslash escapes and hard breaks.
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        flush();
        items.push('<br>');
        i += 2;
        // A hard break strips all leading whitespace of the next line.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (d !== undefined && isPunctChar(d)) { buf += escapeText(d); i += 2; continue; }
      buf += '\\';
      i++;
      continue;
    }
    // Code span.
    if (c === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const run = k - i;
      const close = findCodeClose(src, k, run);
      if (close !== -1) {
        let content = src.slice(k, close - run);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flush();
        items.push('<code>' + escapeText(content) + '</code>');
        i = close;
        continue;
      }
      // No closing run of the same length: the whole run is literal.
      buf += escapeText(src.slice(i, k));
      i = k;
      continue;
    }
    // Emphasis / strikethrough delimiter runs. Every run is recorded:
    // a run that cannot open can still close an earlier opener, and a
    // run that cannot close can still open. Runs of 3+ tildes are never
    // delimiters (a failed del() swallows the whole run as text).
    if (c === '*' || c === '_' || c === '~') {
      let k = i;
      while (k < n && src[k] === c) k++;
      const run = k - i;
      if (c === '~' && run >= 3) { buf += escapeText(src.slice(i, k)); i = k; continue; }
      const before = i > 0 ? src[i - 1] : '';
      const after = k < n ? src[k] : '';
      flush();
      const d = { d: 1, ch: c, n: run, pos: i, origLen: run, before, after, di: delims.length, ix: items.length, phantom: false };
      items.push(d);
      delims.push(d);
      i = k;
      continue;
    }
    // Links and images.
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const lk = parseLink(src, i, refs, !!inLink, st);
      if (lk) {
        flush();
        items.push(lk.html);
        i = lk.end;
        continue;
      }
      if (c === '!') { buf += '!'; i++; continue; }
      buf += '[';
      i++;
      continue;
    }
    // Autolinks, email autolinks and raw HTML.
    if (c === '<') {
      const a = parseAngle(src, i, refs, inLink);
      if (a) {
        // An <a> opening tag in the SOURCE sets the document-level
        // inLink (which disables extended autolinks until a </a>
        // closes it); a self-closing <a .../> does not. Only a raw
        // tag counts here, never a generated autolink <a href>.
        if (st) {
          if (/^<a(?=[\s>])/i.test(src.slice(i, i + 10)) && !/\/>$/.test(a.html)) st.inLink = true;
          else if (/^<\/a(?=[\s>])/i.test(src.slice(i, i + 10))) st.inLink = false;
        }
        flush();
        items.push(a.html);
        i = a.end;
        continue;
      }
      buf += '&lt;';
      i++;
      continue;
    }
    // Extended autolinks: www. / http(s):// / ftp:// / email. Disabled
    // inside a link label and while the document-level inLink (from an
    // unclosed <a> tag) is set. The scheme is case-insensitive
    // (Https://, FTP://); www. is not.
    const noExtAuto = inLink || (st && st.inLink);
    if (!noExtAuto && c === 'w' && src.startsWith('www.', i)) {
      const a = parseExtendedAutolink(src, i);
      if (a) { flush(); items.push(a.html); recordPhantomRuns(src, i, a.end, delims); i = a.end; continue; }
    }
    if (!noExtAuto && ((c === 'h' || c === 'H') && (src.slice(i, i + 7).toLowerCase() === 'http://' || src.slice(i, i + 8).toLowerCase() === 'https://') ||
        (c === 'f' || c === 'F') && src.slice(i, i + 6).toLowerCase() === 'ftp://')) {
      const a = parseExtendedAutolink(src, i);
      if (a) { flush(); items.push(a.html); recordPhantomRuns(src, i, a.end, delims); i = a.end; continue; }
    }
    // Bare email / scheme:email autolink: a word char at a word
    // boundary, in a word that contains '@'.
    if (!noExtAuto && isAlnum(c) && (i === 0 || isSpace(src[i - 1]) || '*_~(["\''.indexOf(src[i - 1]) !== -1)) {
      let k = i;
      let hasAt = false;
      while (k < n && !isSpace(src[k]) && src[k] !== '<' && src[k] !== '>') {
        if (src[k] === '@') { hasAt = true; break; }
        k++;
      }
      if (hasAt) {
        const a = parseExtendedAutolink(src, i);
        if (a) { flush(); items.push(a.html); recordPhantomRuns(src, i, a.end, delims); i = a.end; continue; }
      }
    }
    if (c === '&') {
      const nr = numericRef(src, i);
      if (nr) { buf += escapeText(nr[0]); i = nr[1]; continue; }
      let j = i + 1;
      while (j < n && isWordChar(src[j])) j++;
      if (j > i + 1 && src[j] === ';') { buf += src.slice(i, j + 1); i = j + 1; continue; }
      buf += '&amp;';
      i++;
      continue;
    }
    if (c === '\n') {
      // Soft break: a newline in the source is a newline in the output,
      // unless the line ends with two or more spaces (hard break, which
      // emits <br> and no newline, and strips the next line's leading
      // whitespace).
      let k = buf.length - 1;
      let spaces = 0;
      while (k >= 0 && buf[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush();
        items.push('<br>');
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        flush();
        items.push('\n');
        i++;
      }
      continue;
    }
    buf += escapeText(c);
    i++;
  }
  flush();
  return resolveEmphasis(items, delims, src, refs, inLink, st);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

function indentCols(line) {
  let col = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}
function firstNonWs(line) {
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return k;
}
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
// Remove `count` columns of indentation from the start of a line, where
// the line's first character sits at column `startCol`. A tab that
// straddles the cut becomes spaces for its remainder.
function stripCols(line, count, startCol) {
  const target = (startCol || 0) + count;
  let col = startCol || 0;
  let k = 0;
  let out = '';
  while (k < line.length && col < target) {
    const c = line[k];
    if (c === ' ') { col++; k++; }
    else if (c === '\t') {
      const nc = col + (4 - (col % 4));
      if (nc <= target) { col = nc; k++; }
      else { out = ' '.repeat(nc - target); col = target; k++; break; }
    } else break;
  }
  return out + line.slice(k);
}

// Expand the tabs in a line's leading whitespace to spaces, with each
// tab's width taken from its column in the original line (the line's first
// character sits at column `startCol`). Tabs after the first non-space
// character are left alone.
function expandLeadingTabs(line, startCol) {
  let col = startCol || 0;
  let k = 0;
  let out = '';
  while (k < line.length) {
    const c = line[k];
    if (c === ' ') { out += ' '; col++; k++; }
    else if (c === '\t') { const nc = col + (4 - (col % 4)); out += ' '.repeat(nc - col); col = nc; k++; }
    else break;
  }
  return out + line.slice(k);
}

// Thematic break: 3+ of the same -, * or _ char, spaces allowed between.
function isThematicBreak(s) {
  let ch = '';
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '-' && c !== '*' && c !== '_') return false;
    if (ch === '') ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}

// ATX heading: returns {level, text} or null. s has no leading indent.
function matchAtx(s) {
  if (s[0] !== '#') return null;
  let i = 0;
  while (i < s.length && s[i] === '#') i++;
  if (i > 6) return null;
  if (i < s.length && s[i] !== ' ' && s[i] !== '\t') return null;
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  let text = s.slice(j);
  // Trim trailing whitespace.
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  text = text.slice(0, end);
  // Closing sequence of #'s preceded by a space (or the whole content).
  let k = text.length;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k < text.length && (k === 0 || text[k - 1] === ' ' || text[k - 1] === '\t')) {
    text = text.slice(0, k);
    end = text.length;
    while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
    text = text.slice(0, end);
  }
  return { level: i, text };
}

// Fence opener: returns {ch, len, info} or null. s has no leading indent.
function matchFence(s) {
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let i = 0;
  while (i < s.length && s[i] === ch) i++;
  if (i < 3) return null;
  const info = s.slice(i).trim();
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  // A tilde fence's info string may contain '~' (marked's behaviour);
  // only a backtick fence rejects its own fence character.
  return { ch, len: i, info };
}
function isFenceClose(s, ch, len) {
  if (s[0] !== ch) return false;
  let i = 0;
  while (i < s.length && s[i] === ch) i++;
  if (i < len) return false;
  for (let j = i; j < s.length; j++) {
    if (s[j] !== ' ' && s[j] !== '\t') return false;
  }
  return true;
}

// Setext underline: returns 1 for ===, 2 for ---, else 0. s: line content
// after up-to-3 indent. Leading/trailing whitespace is ignored, but the
// run itself must be a single run of = or - (no internal spaces).
function matchSetext(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  if (a >= b) return 0;
  const ch = s[a];
  if (ch !== '=' && ch !== '-') return 0;
  for (let i = a + 1; i < b; i++) {
    if (s[i] !== ch) return 0;
  }
  return ch === '=' ? 1 : 2;
}

// HTML block start: returns type 1..7 or 0. s has no leading indent.
// Types 1-6 can interrupt a paragraph; type 7 cannot (marked's behaviour).
function htmlBlockStart(s) {
  if (s[0] !== '<') return 0;
  const low = s.toLowerCase();
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<![cdata[')) return 5;
  if (s.startsWith('<!') && s.length > 2 && isAlpha(s[2])) return 4;
  const m = s.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/);
  if (!m) return 0;
  const name = m[1].toLowerCase();
  // Type 1 is an OPENING tag only; a closing tag cannot start one.
  if (s[1] !== '/' && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) return 1;
  // The tag name must end at a boundary (space, tab, '>', '/', end).
  const after = s[m[0].length];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '>' && after !== '/') return 0;
  if (BLOCK_TAGS.has(name)) return 6;
  // Type 7: the tag must be alone on the line (only whitespace after it).
  const rest = s.slice(m[0].length);
  let j = 0;
  // Scan a complete tag; if it ends the line, it is type 7.
  const tag = parseHtmlTag(s, 0);
  if (tag && tag.end === s.length) return 7;
  void rest; void j;
  return 0;
}

// Does this line start a block that can interrupt a paragraph?
// (ATX, fence, HTML types 1-6, blockquote, list that can interrupt,
// thematic break, indented code is NOT interrupting.) Inside a list
// item, an ordered list may interrupt a paragraph whatever its start
// number; elsewhere only a list starting at 1 may.
function interruptsParagraph(line, ind, inList) {
  if (ind === undefined) ind = indentCols(line);
  if (ind >= 4) return false;
  const s = line.slice(firstNonWs(line));
  if (s === '') return false;
  if (matchFence(s)) return true;
  if (matchAtx(s)) return true;
  const ht = htmlBlockStart(s);
  if (ht >= 1 && ht <= 6) return true;
  if (s[0] === '>') return true;
  if (isThematicBreak(s)) return true;
  const lm = matchListMarker(s);
  if (lm) {
    // An empty list item cannot interrupt a paragraph.
    if (s.slice(lm.markerLen).trim() === '') return false;
    if (lm.bullet) return true;
    if (lm.start === 1 || inList) return true;
  }
  return false;
}

// List marker: returns {bullet, delim, start, markerLen} or null.
// s has no leading indent; markerLen is the marker's char length.
function matchListMarker(s) {
  const c = s[0];
  if (c === '-' || c === '+' || c === '*') {
    if (s.length === 1 || s[1] === ' ' || s[1] === '\t') return { bullet: c, delim: null, start: 0, markerLen: 1 };
    return null;
  }
  if (isDigit(c)) {
    let i = 0;
    while (i < s.length && isDigit(s[i])) i++;
    if (i > 9) return null;
    if (i < s.length && (s[i] === '.' || s[i] === ')')) {
      if (i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t') {
        return { bullet: null, delim: s[i], start: parseInt(s.slice(0, i), 10), markerLen: i + 1 };
      }
    }
    return null;
  }
  return null;
}

// Content indent for a list item: given the line, its indent columns and
// the marker, return {contentIndent, content} where content is the line
// with the marker + separator removed (tab-aware). The content's leading
// tabs are expanded to spaces on the original columns.
function listItemContent(line, ind, marker) {
  const start = firstNonWs(line);
  const markerEndCol = ind + marker.markerLen;
  const rest = line.slice(start + marker.markerLen);
  // Measure the whitespace after the marker (tab-aware, from markerEndCol).
  let col = markerEndCol;
  let k = 0;
  let ws = 0;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    if (rest[k] === ' ') { col++; ws++; k++; }
    else {
      const nc = col + (4 - (col % 4));
      ws += nc - col;
      col = nc;
      k++;
    }
  }
  const empty = k >= rest.length;
  if (empty) return { contentIndent: markerEndCol + 1, content: '' };
  if (ws === 0) return null; // not a list item after all
  let contentIndent;
  let content;
  if (ws >= 5) {
    contentIndent = markerEndCol + 1;
    content = stripCols(rest, 1, markerEndCol);
  } else {
    contentIndent = markerEndCol + ws;
    content = rest.slice(k);
  }
  return { contentIndent, content: expandLeadingTabs(content, contentIndent) };
}

// Is this line a paragraph line (not starting any other block)?
function startsNonParaBlock(s) {
  if (s === '') return false;
  if (matchFence(s)) return true;
  if (matchAtx(s)) return true;
  const ht = htmlBlockStart(s);
  if (ht >= 1 && ht <= 6) return true;
  if (s[0] === '>') return true;
  if (isThematicBreak(s)) return true;
  if (matchListMarker(s)) return true;
  if (matchSetext(s)) return true;
  return false;
}

// Is this line (raw) a paragraph line for lazy continuation purposes?
// Setext underlines count as paragraph lines (they close the paragraph
// into a heading); every other block start does not.
function isParaLine(line) {
  if (isBlank(line)) return false;
  const ind = indentCols(line);
  if (ind >= 4) return false;
  const s = line.slice(firstNonWs(line));
  if (matchFence(s)) return false;
  if (matchAtx(s)) return false;
  const ht = htmlBlockStart(s);
  if (ht >= 1 && ht <= 6) return false;
  if (s[0] === '>') return false;
  if (isThematicBreak(s)) return false;
  if (matchListMarker(s)) return false;
  return true;
}

// After a content line, is the current block still an open paragraph?
function stillPara(content) {
  if (isBlank(content)) return false;
  const ind = indentCols(content);
  if (ind >= 4) return false;
  const s = content.slice(firstNonWs(content));
  if (matchSetext(s)) return false;
  if (matchFence(s)) return false;
  if (matchAtx(s)) return false;
  const ht = htmlBlockStart(s);
  if (ht >= 1 && ht <= 6) return false;
  if (s[0] === '>') return false;
  if (isThematicBreak(s)) return false;
  if (matchListMarker(s)) return false;
  return true;
}

function parseBlocks(lines, lo, hi, refs, lastNL, paraBreaks, forcePara, inList) {
  const blocks = [];
  let loose = false;
  let pendingBlank = false;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) { pendingBlank = true; i++; continue; }
    if (pendingBlank && blocks.length > 0) loose = true;
    pendingBlank = false;
    // A line forced to be paragraph text skips every block check.
    if (forcePara && forcePara.has(i)) {
      const para = parseParagraph(lines, i, hi, refs, paraBreaks, forcePara, inList);
      if (para.node) blocks.push(para.node);
      i = para.next;
      continue;
    }
    const ind = indentCols(line);
    const start = firstNonWs(line);
    if (ind >= 4) {
      // Indented code block.
      const codeLines = [];
      let j = i;
      while (j < hi) {
        const l = lines[j];
        if (isBlank(l)) {
          let k = j + 1;
          while (k < hi && isBlank(lines[k])) k++;
          if (k < hi && indentCols(lines[k]) >= 4) {
            // Interior blank lines keep their content after the
            // four-column strip.
            while (j < k) { codeLines.push(stripCols(lines[j], 4, 0)); j++; }
            continue;
          }
          break;
        }
        if (indentCols(l) >= 4) { codeLines.push(stripCols(l, 4, 0)); j++; continue; }
        break;
      }
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      blocks.push({ k: 'code', lang: null, text: codeLines.length ? codeLines.join('\n') + '\n' : '' });
      i = j;
      continue;
    }
    const s = line.slice(start);
    // Fenced code.
    const fence = matchFence(s);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < hi) {
        const l = lines[j];
        if (indentCols(l) <= 3 && isFenceClose(l.slice(firstNonWs(l)), fence.ch, fence.len)) { j++; break; }
        // Content lines lose the opening fence's indent columns, but
        // only for backtick fences: a tilde fence never dedents.
        content.push(fence.ch === '`' ? stripCols(l, ind, 0) : l);
        j++;
      }
      // One trailing EMPTY line is dropped from the content; a line
      // that is only whitespace is kept.
      if (content.length && content[content.length - 1].length === 0) content.pop();
      const lang = fence.info === '' ? null : unescapePunct(fence.info.split(/\s+/)[0]);
      blocks.push({ k: 'code', lang, text: content.length ? content.join('\n') + '\n' : '' });
      i = j;
      continue;
    }
    // ATX heading.
    const atx = matchAtx(s);
    if (atx) { blocks.push({ k: 'h', level: atx.level, lines: [atx.text] }); i++; continue; }
    // HTML block.
    const ht = htmlBlockStart(s);
    if (ht) {
      // The block keeps the first line's raw leading spaces.
      const htmlLines = [line];
      let j = i + 1;
      let endTag = null;
      if (ht === 1) {
        const m = s.match(/<\/?(script|pre|style|textarea)/i);
        endTag = '</' + (m ? m[1].toLowerCase() : 'script');
        if (s.toLowerCase().indexOf(endTag) === -1) {
          while (j < hi) {
            htmlLines.push(lines[j]);
            if (lines[j].toLowerCase().indexOf(endTag) !== -1) { j++; break; }
            j++;
          }
        }
      } else if (ht === 2) {
        if (s.indexOf('-->', 4) === -1) {
          while (j < hi) {
            htmlLines.push(lines[j]);
            if (lines[j].indexOf('-->') !== -1) { j++; break; }
            j++;
          }
        }
      } else if (ht === 3) {
        if (s.indexOf('?>', 2) === -1) {
          while (j < hi) {
            htmlLines.push(lines[j]);
            if (lines[j].indexOf('?>') !== -1) { j++; break; }
            j++;
          }
        }
      } else if (ht === 4) {
        if (s.indexOf('>', 2) === -1) {
          while (j < hi) {
            htmlLines.push(lines[j]);
            if (lines[j].indexOf('>') !== -1) { j++; break; }
            j++;
          }
        }
      } else if (ht === 5) {
        if (s.indexOf(']]>', 9) === -1) {
          while (j < hi) {
            htmlLines.push(lines[j]);
            if (lines[j].indexOf(']]>') !== -1) { j++; break; }
            j++;
          }
        }
      } else {
        // Types 6 and 7: run to the next blank line.
        while (j < hi && !isBlank(lines[j])) { htmlLines.push(lines[j]); j++; }
      }
      let text = htmlLines.join('\n');
      // The block keeps the newline ending its last line. For types 1-5
      // it is only dropped when the next line is exactly empty; for
      // types 6-7 any blank next line swallows it. At the end of the
      // input it is kept exactly when the source ends with a newline.
      const nextBlank = j < hi && isBlank(lines[j]);
      const nextEmpty = j < hi && lines[j] === '';
      if (ht <= 5) {
        if ((j < hi && !nextEmpty) || (j >= hi && lastNL)) text += '\n';
      } else if ((j < hi && !nextBlank) || (j >= hi && lastNL)) text += '\n';
      blocks.push({ k: 'html', text });
      i = j;
      continue;
    }
    // Thematic break.
    if (isThematicBreak(s)) { blocks.push({ k: 'hr' }); i++; continue; }
    // Blockquote.
    if (s[0] === '>') {
      const sub = [];
      const paraBreaks = new Set();
      const forcePara = new Set();
      let j = i;
      let inPara = false;
      let codeClosed = false;
      let prevLazy = false;
      // A fenced code block open in the quote's sub-lines: lazy lines
      // cannot continue it, and its content lines are not paragraphs.
      let fence = null;
      const noteParaLine = () => {
        if (codeClosed) { paraBreaks.add(sub.length); codeClosed = false; }
      };
      while (j < hi) {
        const l = lines[j];
        const li = indentCols(l);
        if (!isBlank(l) && li <= 3 && l[firstNonWs(l)] === '>') {
          const gtPos = firstNonWs(l);
          const afterGt = l.slice(gtPos + 1);
          let content;
          let contentCol;
          if (afterGt === '') { content = ''; contentCol = gtPos + 1; }
          else if (afterGt[0] === ' ' || afterGt[0] === '\t') {
            content = stripCols(afterGt, 1, gtPos + 1);
            contentCol = gtPos + 2;
          } else { content = afterGt; contentCol = gtPos + 1; }
          content = expandLeadingTabs(content, contentCol);
          // Track fenced code blocks: while one is open, lines are code
          // content (never a paragraph) and lazy lines are refused.
          const cInd = indentCols(content);
          const cStripped = cInd <= 3 ? content.slice(firstNonWs(content)) : content;
          if (fence) {
            if (cInd <= 3 && isFenceClose(cStripped, fence.ch, fence.len)) fence = null;
            inPara = false;
            codeClosed = false;
          } else if (cInd <= 3 && matchFence(cStripped)) {
            fence = matchFence(cStripped);
            inPara = false;
            codeClosed = false;
          } else {
            // A paragraph line after a code line starts a new group.
            // Content with 4+ columns of indent is a paragraph line
            // while a paragraph is open (a code block otherwise).
            const isParaContent = stillPara(content) || (inPara && indentCols(content) >= 4);
            if (isParaContent) noteParaLine();
            else codeClosed = false;
            // Indented content leaves the paragraph state unchanged
            // (continuation if open, code block if not); anything else
            // follows stillPara.
            if (indentCols(content) < 4) inPara = stillPara(content);
          }
          sub.push(content);
          prevLazy = false;
          j++;
          continue;
        }
        // A truly blank line (no '>') ends the blockquote; a new
        // quote starts on the next '>' line.
        if (isBlank(l)) break;
        // A lazy line cannot continue a fenced code block.
        if (fence) break;
        // Lazy line: a paragraph line, or a line with 4+ columns of
        // indent (a code line, stripped by four).
        if (inPara && (isParaLine(l) || li >= 4)) {
          // A lazy setext underline is paragraph text, never a heading.
          // Its indent is normalised to four columns when the previous
          // line was lazy too; otherwise it is kept as-is (and the
          // sub-parse must not treat it as a setext underline).
          const se = matchSetext(l.slice(firstNonWs(l)));
          if (se === 1) {
            if (prevLazy) {
              if (l[0] === '\t') sub.push(l);
              else sub.push('    ' + l.replace(/^[ ]+/, ''));
            } else {
              forcePara.add(sub.length);
              sub.push(l);
            }
            inPara = true;
            prevLazy = true;
            j++;
            continue;
          }
          if (li >= 4) {
            forcePara.add(sub.length);
            sub.push(stripCols(l, 4, 0));
            inPara = false;
            codeClosed = true;
          } else {
            noteParaLine();
            sub.push(l);
            inPara = stillPara(l);
          }
          prevLazy = true;
          j++;
          continue;
        }
        // Lazy continuation into a nested container: the quote's last
        // sub-line, followed through quote/list markers, ends in an
        // open paragraph, so this paragraph line belongs inside it.
        if (isParaLine(l) && deepParaOpen(sub)) {
          noteParaLine();
          sub.push(l);
          prevLazy = true;
          j++;
          continue;
        }
        break;
      }
      const inner = parseBlocks(sub, 0, sub.length, refs, false, paraBreaks, forcePara, false);
      blocks.push({ k: 'quote', blocks: inner.blocks });
      i = j;
      continue;
    }
    // List.
    const lm = matchListMarker(s);
    if (lm) {
      const res = parseList(lines, i, hi, refs, lastNL, paraBreaks, forcePara, inList);
      blocks.push(res.node);
      // A trailing blank line inside the list's last item still counts
      // as a blank line in this level if another block follows it.
      if (res.trailingBlank) pendingBlank = true;
      i = res.next;
      continue;
    }
    // Paragraph (or setext heading, or table).
    const para = parseParagraph(lines, i, hi, refs, paraBreaks, forcePara, inList);
    if (para.node) blocks.push(para.node);
    i = para.next;
  }
  return { blocks, loose };
}

// Parse one list starting at lines[i]. Returns {node, next, trailingBlank}.
function parseList(lines, i, hi, refs, lastNL, paraBreaks, forcePara, inList) {
  const firstLine = lines[i];
  const lm0 = matchListMarker(firstLine.slice(firstNonWs(firstLine)));
  const ordered = lm0.bullet === null;
  const items = [];
  let loose = false;
  let j = i;
  let trailingBlank = false;
  while (j < hi) {
    const item = parseListItem(lines, j, hi, lm0, refs, lastNL, paraBreaks, forcePara, inList);
    items.push(item);
    const nextJ = item.next;
    trailingBlank = item.blankAfter;
    // Does another item of the same list follow? A thematic-break line
    // is not a list marker: it ends the list instead.
    let more = false;
    if (nextJ < hi) {
      const l = lines[nextJ];
      if (indentCols(l) <= 3 && !isThematicBreak(l.slice(firstNonWs(l)))) {
        const m = matchListMarker(l.slice(firstNonWs(l)));
        if (m && (ordered === (m.bullet === null)) &&
            (ordered ? m.delim === lm0.delim : m.bullet === lm0.bullet)) more = true;
      }
    }
    if (more && item.blankAfter) loose = true;
    if (item.loose) loose = true;
    j = nextJ;
    if (!more) break;
  }
  return {
    node: { k: 'list', ordered, start: lm0.start, items: items.map((x) => x.blocks), loose },
    next: j,
    trailingBlank,
  };
}

// Parse one list item starting at lines[i]. Returns
// {blocks, loose, next, blankAfter}.
function parseListItem(lines, i, hi, listMarker, refs, lastNL, paraBreaks, forcePara, inList) {
  const line = lines[i];
  const ind = indentCols(line);
  const lm = matchListMarker(line.slice(firstNonWs(line)));
  const ic = listItemContent(line, ind, lm);
  const contentIndent = ic.contentIndent;
  const sub = [];
  const pb = new Set();
  const fp = new Set();
  let inPara;
  let codeClosed = false;
  let sawBlank = false;
  const emptyContent = ic.content === '';
  // A fenced code block open in the item's sub-lines: its content
  // lines are never code lines (no extra four-column strip), and a
  // lazy line inside it is fence content.
  let fence = null;
  const checkFenceOpen = (stripped) => {
    if (fence) return;
    const sInd = indentCols(stripped);
    if (sInd <= 3) {
      const fm = matchFence(stripped.slice(firstNonWs(stripped)));
      if (fm) fence = fm;
    }
  };
  const checkFenceClose = (stripped) => {
    if (!fence) return;
    const sInd = indentCols(stripped);
    if (sInd <= 3 && isFenceClose(stripped.slice(firstNonWs(stripped)), fence.ch, fence.len)) fence = null;
  };
  if (emptyContent) { sub.push(''); inPara = false; }
  else { sub.push(ic.content); inPara = stillPara(ic.content); checkFenceOpen(ic.content); }
  // Record a paragraph-group break before a paragraph line that follows
  // a code line (a line whose indent, after the item strip, was >= 4).
  const noteParaLine = () => {
    if (codeClosed) { pb.add(sub.length); codeClosed = false; }
  };
  let j = i + 1;
  while (j < hi) {
    const l = lines[j];
    if (isBlank(l)) { sub.push(''); inPara = false; codeClosed = false; sawBlank = true; j++; continue; }
    const li = indentCols(l);
    // An empty item followed by a blank line claims no further lines.
    if (emptyContent && sawBlank && sub.every((x) => x === '')) break;
    if (li >= contentIndent) {
      // Expand leading tabs to spaces first: the item strip and a
      // later four-column strip must compose on the same columns, and
      // a tab straddling a cut would otherwise lose its remainder.
      const le = expandLeadingTabs(l, 0);
      if (fence) {
        // Fence content: strip only the item indent, never the extra
        // four columns, and never treat it as a paragraph line.
        const stripped = stripCols(le, contentIndent, 0);
        checkFenceClose(stripped);
        sub.push(stripped);
        inPara = false;
        codeClosed = false;
      } else if (inPara && li >= contentIndent + 4) {
        // Code line: strip the item indent plus four more columns in
        // a single operation on the original line (so a tab straddling
        // the cut keeps its remainder as spaces). It is paragraph
        // text, never a block start, and it closes the paragraph for
        // the next line.
        fp.add(sub.length);
        sub.push(stripCols(le, contentIndent + 4, 0));
        inPara = false;
        codeClosed = true;
      } else {
        const stripped = stripCols(le, contentIndent, 0);
        checkFenceOpen(stripped);
        if (stillPara(stripped)) noteParaLine();
        else codeClosed = false;
        sub.push(stripped);
        inPara = stillPara(stripped);
      }
      j++;
      continue;
    }
    if (li <= 3) {
      const m = matchListMarker(l.slice(firstNonWs(l)));
      if (m) break; // any list marker ends this item
    }
    // A lazy line inside a fenced code block is fence content.
    if (fence) {
      checkFenceClose(l);
      sub.push(l);
      inPara = false;
      codeClosed = false;
      j++;
      continue;
    }
    // Lazy line: a paragraph line, or a line with 4+ columns of indent
    // (a code line, stripped by four).
    if (inPara && (isParaLine(l) || li >= 4)) {
      if (li >= 4) {
        fp.add(sub.length);
        sub.push(stripCols(l, 4, 0));
        inPara = false;
        codeClosed = true;
      } else {
        noteParaLine();
        sub.push(l);
        inPara = stillPara(l);
      }
      j++;
      continue;
    }
    // Lazy continuation into a nested container: the item's last
    // sub-line, followed through quote/list markers, ends in an open
    // paragraph, so this paragraph line belongs inside it.
    if (isParaLine(l) && deepParaOpen(sub)) {
      noteParaLine();
      sub.push(l);
      j++;
      continue;
    }
    break;
  }
  let trailingBlanks = 0;
  while (sub.length > (emptyContent ? 1 : 0) && sub[sub.length - 1] === '') { sub.pop(); trailingBlanks++; }
  const inner = parseBlocks(sub, 0, sub.length, refs, false, pb, fp, true);
  return { blocks: inner.blocks, loose: inner.loose, next: j, blankAfter: trailingBlanks > 0 };
}

// Follow the last sub-line through quote markers and list markers to
// its innermost content; true when that content is an open paragraph
// line (so a lazy paragraph line can continue inside it).
function deepParaOpen(sub) {
  for (let k = sub.length - 1; k >= 0; k--) {
    const l = sub[k];
    if (l === '') return false;
    let cur = l;
    while (true) {
      const ind = indentCols(cur);
      if (ind > 3) return false;
      const s = cur.slice(firstNonWs(cur));
      if (s[0] === '>') {
        let after = s.slice(1);
        if (after !== '' && (after[0] === ' ' || after[0] === '\t')) after = stripCols(after, 1, 1);
        cur = expandLeadingTabs(after, 1);
        if (cur === '') return false;
        continue;
      }
      const m = matchListMarker(s);
      if (m) {
        const ic = listItemContent(cur, ind, m);
        if (!ic) return false;
        cur = ic.content;
        if (cur === '') return false;
        continue;
      }
      return stillPara(cur);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Parse a link destination starting at text[j] (whitespace skipped first).
// Returns {dest, end} or null.
function parseDestInText(text, j) {
  const n = text.length;
  while (j < n && isSpace(text[j])) j++;
  if (j >= n) return null;
  if (text[j] === '<') {
    let k = j + 1;
    let raw = '';
    while (k < n) {
      const c = text[k];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: raw, end: k + 1 };
      if (c === '\\' && k + 1 < n && isPunctChar(text[k + 1])) { raw += text[k] + text[k + 1]; k += 2; continue; }
      raw += c;
      k++;
    }
    return null;
  }
  let k = j;
  let depth = 0;
  let raw = '';
  while (k < n) {
    const c = text[k];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c < ' ') break;
    if (c === '\\' && k + 1 < n && isPunctChar(text[k + 1])) { raw += text[k] + text[k + 1]; k += 2; continue; }
    if (c === '(') { depth++; raw += c; k++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--;
      raw += c;
      k++;
      continue;
    }
    raw += c;
    k++;
  }
  if (raw === '' || depth > 0) return null;
  return { dest: raw, end: k };
}

// Try to parse one link reference definition starting at text[i] === '['.
// Returns {end, key, dest, title} (end = index of the line ending) or null.
function tryParseDef(text, i) {
  const n = text.length;
  let j = i + 1;
  let label = '';
  if (j < n && text[j] === ']') return null;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isPunctChar(text[j + 1])) { label += text[j] + text[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') break;
    if (c === '\n') {
      if (j + 1 >= n || text[j + 1] === '\n') return null;
      label += c;
      j++;
      continue;
    }
    label += c;
    j++;
  }
  if (j >= n || text[j] !== ']' || label.length === 0 || label.length > 999) return null;
  j++;
  if (text[j] !== ':') return null;
  j++;
  const dest = parseDestInText(text, j);
  if (!dest) return null;
  const key = normaliseLabel(label);
  if (key === '') return null;
  let k = dest.end;
  // Skip spaces/tabs on the same line (never a newline: the definition
  // must end on its own line unless a title follows on the next line).
  let hadSpace = false;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) { k++; hadSpace = true; }
  if (k >= n) return { end: k, key, dest: dest.dest, title: null };
  if (text[k] === '\n') {
    // The definition may carry its title on the next line. If that title
    // is not clean (followed by junk), the definition still stands
    // without a title and the next line stays paragraph text.
    let k2 = k + 1;
    while (k2 < n && (text[k2] === ' ' || text[k2] === '\t')) k2++;
    if (k2 < n && (text[k2] === '"' || text[k2] === "'" || text[k2] === '(')) {
      const t = parseTitle(text, k2);
      if (t !== null) {
        let e = t.end;
        while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= n || text[e] === '\n') return { end: e, key, dest: dest.dest, title: t.title };
      }
    }
    return { end: k, key, dest: dest.dest, title: null };
  }
  // A same-line title needs whitespace before it; junk after the title
  // (or after the destination) invalidates the whole definition.
  if (text[k] === '"' || text[k] === "'" || text[k] === '(') {
    if (!hadSpace) return null;
    const t = parseTitle(text, k);
    if (t === null) return null;
    let e = t.end;
    while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
    if (e >= n || text[e] === '\n') return { end: e, key, dest: dest.dest, title: t.title };
    return null;
  }
  return null;
}

// Strip leading link reference definitions from a paragraph's lines,
// registering them in refs. Returns the remaining lines.
function extractDefs(paraLines, refs) {
  const text = paraLines.join('\n');
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let p = pos;
    let sp = 0;
    while (p < n && text[p] === ' ' && sp < 3) { p++; sp++; }
    if (text[p] !== '[') break;
    const d = tryParseDef(text, p);
    if (!d) break;
    if (!refs.has(d.key)) refs.set(d.key, { dest: d.dest, title: d.title });
    pos = d.end;
    if (pos < n && text[pos] === '\n') pos++;
    else if (pos < n) break;
  }
  if (pos === 0) return { lines: paraLines };
  const rest = text.slice(pos);
  return { lines: rest === '' ? [] : rest.split('\n') };
}

// How many lines remain after stripping leading definitions (pure: does
// not register anything).
function peekDefLines(paraLines) {
  const text = paraLines.join('\n');
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let p = pos;
    let sp = 0;
    while (p < n && text[p] === ' ' && sp < 3) { p++; sp++; }
    if (text[p] !== '[') break;
    const d = tryParseDef(text, p);
    if (!d) break;
    pos = d.end;
    if (pos < n && text[pos] === '\n') pos++;
    else if (pos < n) break;
  }
  if (pos === 0) return paraLines.length;
  const rest = text.slice(pos);
  return rest === '' ? 0 : rest.split('\n').length;
}

// ---------------------------------------------------------------------------
// Tables (GFM)
// ---------------------------------------------------------------------------

// Split a table row line into cells, honouring code spans and \| escapes.
function splitTableCells(s) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) {
      const nx = s[i + 1];
      // \| is an escaped pipe: it does not split, and the table layer
      // unescapes it to a plain |. \\ is an escaped backslash, so a
      // following | is a real separator. Other escapes are kept for
      // the inline parser.
      if (nx === '|') { cur += '|'; i += 2; continue; }
      cur += c + nx;
      i += 2;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (k < n && s[k] === '`') k++;
      const run = k - i;
      const close = findCodeClose(s, k, run);
      if (close !== -1) { cur += s.slice(i, close).replace(/\\\|/g, '|'); i = close; continue; }
      cur += c;
      i++;
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  // Drop the empty cells created by a leading / trailing pipe.
  let start = 0;
  let end = cells.length;
  if (s.trimStart().startsWith('|')) start = 1;
  if (s.trimEnd().endsWith('|')) end--;
  const out = [];
  for (let k = start; k < end; k++) out.push(cells[k].trim());
  return out;
}

// Is this line a table delimiter row? Returns the alignment array
// ('left' | 'center' | 'right' | null per cell) or null.
function matchTableDelim(s) {
  const raw = s.split('|');
  // A delimiter row's cells are simple: optional colon, hyphens, colon.
  const cells = [];
  for (let cell of raw) {
    cell = cell.trim();
    if (cell === '') continue;
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':') && cell.length >= 2) cells.push('center');
    else if (cell.startsWith(':')) cells.push('left');
    else if (cell.endsWith(':')) cells.push('right');
    else cells.push(null);
  }
  if (cells.length === 0) return null;
  // A delimiter row must contain a colon or a pipe (a bare run of
  // hyphens is a setext underline, not a table delimiter).
  if (!/[:|]/.test(s)) return null;
  // The row must be made only of cells, pipes and whitespace.
  if (!/^[\s:|\-]+$/.test(s)) return null;
  return cells;
}

// ---------------------------------------------------------------------------
// Paragraphs (with setext headings and tables)
// ---------------------------------------------------------------------------

function parseParagraph(lines, i, hi, refs, paraBreaks, forcePara, inList) {
  const paraLines = [lines[i]];
  let j = i + 1;
  let isTable = false;
  let aligns = null;
  while (j < hi) {
    const l = lines[j];
    if (isBlank(l)) {
      // A table row line is only ended by a spaces-only line; a line
      // containing a tab is still a table row (its row pattern
      // excludes ` *\n` but not a tab).
      if (!isTable || /^ *$/.test(l)) break;
    }
    // A line forced to be paragraph text never starts a block.
    if (forcePara && forcePara.has(j)) {
      if (paraBreaks && paraBreaks.has(j)) paraLines.push('');
      paraLines.push(l);
      j++;
      continue;
    }
    const ind = indentCols(l);
    if (ind <= 3) {
      const s = l.slice(firstNonWs(l));
      // Once a table has started, its rows are never setext text.
      if (!isTable) {
        const se = matchSetext(s);
        if (se) {
          const content = extractDefs(paraLines, refs);
          if (content.lines.length === 0) return { node: null, next: j };
          // A setext heading's text drops the first line's leading
          // spaces and the last line's trailing whitespace.
          const hlines = content.lines;
          hlines[0] = hlines[0].replace(/^[ \t]+/, '');
          hlines[hlines.length - 1] = hlines[hlines.length - 1].replace(/[ \t]+$/, '');
          return { node: { k: 'h', level: se, lines: hlines }, next: j + 1 };
        }
        const delim = matchTableDelim(s);
        if (delim && peekDefLines(paraLines) === 1) {
          isTable = true;
          aligns = delim;
          paraLines.push(l);
          j++;
          continue;
        }
      }
    }
    if (isTable) {
      if (interruptsParagraph(l, undefined, inList)) break;
      paraLines.push(l);
      j++;
      continue;
    }
    if (interruptsParagraph(l, undefined, inList)) break;
    // A paragraph-group break joins with a blank line instead.
    if (paraBreaks && paraBreaks.has(j)) paraLines.push('');
    paraLines.push(l);
    j++;
  }
  const content = extractDefs(paraLines, refs);
  if (isTable) {
    const headerCells = splitTableCells(content.lines[0]);
    if (headerCells.length !== aligns.length) {
      // Cell count mismatch: not a table after all.
      if (content.lines.length === 0) return { node: null, next: j };
      return { node: { k: 'para', lines: content.lines }, next: j };
    }
    const rows = [];
    for (let r = 2; r < content.lines.length; r++) {
      const cells = splitTableCells(content.lines[r]);
      while (cells.length < headerCells.length) cells.push('');
      rows.push(cells.slice(0, headerCells.length));
    }
    return { node: { k: 'table', aligns, header: headerCells, rows }, next: j };
  }
  if (content.lines.length === 0) return { node: null, next: j };
  return { node: { k: 'para', lines: content.lines }, next: j };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, refs, st) {
  let out = '';
  for (const b of blocks) {
    if (b.k === 'para') {
      out += '<p>' + parseInline(b.lines.join('\n'), refs, false, st) + '</p>\n';
    } else if (b.k === 'h') {
      out += '<h' + b.level + '>' + parseInline(b.lines.join('\n'), refs, false, st) + '</h' + b.level + '>\n';
    } else if (b.k === 'code') {
      out += '<pre><code' + (b.lang !== null ? ' class="language-' + escapeAttr(b.lang) + '"' : '') + '>' + escapeText(b.text) + '</code></pre>\n';
    } else if (b.k === 'html') {
      out += b.text;
    } else if (b.k === 'hr') {
      out += '<hr>\n';
    } else if (b.k === 'quote') {
      out += '<blockquote>\n' + renderBlocks(b.blocks, refs, st) + '</blockquote>\n';
    } else if (b.k === 'list') {
      out += renderList(b, refs, st);
    } else if (b.k === 'table') {
      out += renderTable(b, refs, st);
    }
  }
  return out;
}

// Render a list item's blocks in "tight" mode: paragraphs without <p>.
function renderTight(blocks, refs, st) {
  let out = '';
  for (const b of blocks) {
    if (b.k === 'para') out += parseInline(b.lines.join('\n'), refs, false, st);
    else out += renderBlocks([b], refs, st);
  }
  return out;
}

function renderList(list, refs, st) {
  const tag = list.ordered ? 'ol' : 'ul';
  let out = '<' + tag + (list.ordered && list.start !== 1 ? ' start="' + list.start + '"' : '') + '>\n';
  for (const itemBlocks of list.items) {
    out += '<li>';
    // Task list item: first block a paragraph starting with [ ] / [x].
    let task = null;
    let first = itemBlocks[0];
    if (first && first.k === 'para' && first.lines.length > 0) {
      const m = first.lines[0].match(/^\[([ xX])\](?:[ \t]+(.*))?$/);
      if (m && (first.lines.length > 1 || m[2] !== undefined || first.lines[0].length === 3)) {
        // Only when the marker is followed by space/tab or is the whole line.
        if (first.lines[0].length === 3 || m[2] !== undefined) {
          task = m[1] === ' ' ? 'unchecked' : 'checked';
          if (first.lines[0].length === 3) first = { k: 'para', lines: [''] };
          else first = { k: 'para', lines: [m[2]].concat(first.lines.slice(1)) };
        }
      }
    }
    const blocks = [first].concat(itemBlocks.slice(1));
    if (task) {
      const checkbox = task === 'checked'
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      if (list.loose) {
        // In a loose list the checkbox lives inside the first
        // paragraph's <p>; in a tight list it sits directly in <li>.
        if (first.k === 'para') {
          out += '<p>' + checkbox + parseInline(first.lines.join('\n'), refs, false, st) + '</p>\n';
          out += renderBlocks(blocks.slice(1), refs, st);
        } else {
          out += checkbox + renderBlocks(blocks, refs, st);
        }
      } else {
        out += checkbox + renderTight(blocks, refs, st);
      }
    } else if (list.loose) out += renderBlocks(itemBlocks, refs, st);
    else out += renderTight(itemBlocks, refs, st);
    out += '</li>\n';
  }
  out += '</' + tag + '>\n';
  return out;
}

function renderTable(t, refs, st) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < t.header.length; c++) {
    out += t.aligns[c] ? '<th align="' + t.aligns[c] + '">' : '<th>';
    out += parseInline(t.header[c], refs, false, st) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (t.rows.length > 0) {
    out += '<tbody>';
    for (const row of t.rows) {
      out += '<tr>\n';
      for (let c = 0; c < row.length; c++) {
        out += t.aligns[c] ? '<td align="' + t.aligns[c] + '">' : '<td>';
        out += parseInline(row[c], refs, false, st) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  const text = src.replace(/\r\n?/g, '\n');
  if (text === '') return '';
  const lines = text.split('\n');
  const lastNL = lines[lines.length - 1] === '';
  if (lastNL) lines.pop();
  const refs = new Map();
  const { blocks } = parseBlocks(lines, 0, lines.length, refs, lastNL);
  // Document-level inline state: an unclosed <a> tag seen while
  // rendering sets inLink, which disables extended autolinks for the
  // rest of the document (marked's behaviour). Reset per parse call.
  const st = { inLink: false };
  return renderBlocks(blocks, refs, st);
}

