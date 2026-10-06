// LIFE/OS — Notes: a small, safe markdown renderer. DOM-free (unit-tested in jsc).
//
// Safety model: every piece of user text is HTML-escaped before any markup is
// added, the renderer only ever emits a fixed set of tags, attribute values are
// either escaped text or numbers, and links survive only for http(s)/mailto.
// The returned string is therefore safe to assign to innerHTML.
//
// Supported: # … ###### headings, paragraphs (single newlines become <br>),
// **bold**, *italic*, ***both***, ~~strike~~, `code`, ``` / ~~~ fenced blocks,
// - * + bullet lists, 1. ordered lists, nesting by indentation, task items
// "- [ ]" / "- [x]", > blockquotes (nestable), --- rules, [text](url) links,
// bare https:// autolinks and backslash escapes.

import { escapeHtml } from '../ui.js';

const MAX_QUOTE_DEPTH = 8;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w#+.-]*)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const HEADING_CLOSE = /[ \t]#+$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const TASK_LINE = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\])/;

const CODE_SPAN = /``([^\n]+?)``|`([^`\n]+)`/g;
const BACKSLASH = /\\([\\`*_{}[\]()#+\-.!~>|])/g;
// Labels cannot contain '[' (as in CommonMark), which also keeps this linear.
const LINK = /\[([^\][\n]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)\s*\)/g;
// Runs on escaped text, so stop before the entities escapeHtml produces.
const AUTOLINK = /\bhttps?:\/\/(?:[^\s\u0000&]|&(?!lt;|gt;|quot;|#39;))+/gi;
const SAFE_URL = /^(?:https?:\/\/|mailto:)\S+$/i;
const TOKEN = /\u0000(\d+)\u0000/g;

/**
 * renderMarkdown(src, { tasks = true }) -> HTML string.
 * Task items render as real checkboxes carrying data-line (the 0-based source
 * line) so a click can be written back with toggleTask().
 */
export function renderMarkdown(src, { tasks = true } = {}) {
  // NUL is reserved for the inline placeholder tokens below.
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');
  if (!text.trim()) return '';
  return renderBlocks(text.split('\n'), 0, 0, { tasks });
}

/**
 * toggleTask(src, lineIndex, checked?) -> new source with that task line's box
 * set to `checked` (or flipped when omitted). Returns `src` unchanged when the
 * line is not a task item.
 */
export function toggleTask(src, lineIndex, checked) {
  const text = String(src ?? '');
  // Keep the original line separators so nothing else in the note changes.
  const parts = text.split(/(\r\n|\r|\n)/);
  const at = Number(lineIndex) * 2;
  if (!Number.isInteger(at) || at < 0 || at >= parts.length) return text;
  const m = TASK_LINE.exec(parts[at]);
  if (!m) return text;
  const done = typeof checked === 'boolean' ? checked : m[2] === ' ';
  parts[at] = `${m[1]}${done ? 'x' : ' '}${m[3]}${parts[at].slice(m[0].length)}`;
  return parts.join('');
}

/* ==========================================================================
   Blocks
   ========================================================================== */

function renderBlocks(lines, offset, depth, opts) {
  const out = [];
  const lists = []; // open lists, innermost last: { tag, indent }
  const nextFilled = nextFilledLines(lines);
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((line) => inline(line.trim())).join('<br>')}</p>`);
    para = [];
  };

  // Close every open list deeper than `indent` (all of them by default).
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > indent) {
      out.push(`</li></${lists.pop().tag}>`);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[1][0] === '`' && line.trim().slice(fence[1].length).includes('`'))) {
      flushPara();
      closeLists();
      const marker = fence[1];
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      const code = [];
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) {
        code.push(lines[j]);
        j += 1;
      }
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2].toLowerCase())}"` : '';
      out.push(`<pre class="nt-code"${lang}><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      i = j; // skip the closing fence (or stop at the end of the note)
      continue;
    }

    if (!line.trim()) {
      flushPara();
      // A blank line between two items keeps the same list going.
      const next = lists.length && nextFilled[i] !== -1 ? lines[nextFilled[i]] : '';
      if (!(LIST_ITEM.test(next) && !RULE.test(next))) closeLists();
      continue;
    }

    if (RULE.test(line)) {
      flushPara();
      closeLists();
      out.push('<hr>');
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(headingText(heading[2]))}</h${level}>`);
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara();
      closeLists();
      const start = i;
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      i -= 1;
      const body =
        depth < MAX_QUOTE_DEPTH
          ? renderBlocks(inner, offset + start, depth + 1, opts)
          : `<p>${inner.map((l) => inline(l)).join('<br>')}</p>`;
      out.push(`<blockquote>${body}</blockquote>`);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const indent = indentWidth(item[1]);
      const ordered = /\d/.test(item[2]);
      const tag = ordered ? 'ol' : 'ul';
      closeLists(indent);
      let top = lists[lists.length - 1];
      if (top && indent <= top.indent + 1) {
        // Sibling at the current level
        if (top.tag === tag) {
          out.push('</li>');
        } else {
          out.push(`</li></${top.tag}>`);
          lists.pop();
          top = null;
        }
      } else {
        top = null; // first item, or deeper indentation: nest inside the open <li>
      }
      if (!top) {
        const start = ordered ? parseInt(item[2], 10) : 1;
        out.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`);
        lists.push({ tag, indent });
      }
      out.push(listItem(item[3], offset + i, opts));
      continue;
    }

    // Indented text right under a list item continues that item.
    if (lists.length && /^[ \t]/.test(line)) {
      out.push(`<br>${inline(line.trim())}`);
      continue;
    }

    closeLists();
    para.push(line);
  }

  flushPara();
  closeLists();
  return out.join('');
}

function listItem(content, lineNo, opts) {
  const task = opts.tasks ? TASK.exec(content) : null;
  if (!task) return `<li>${inline(content)}`;
  const done = task[1] !== ' ';
  const text = task[2] ?? '';
  // A bare "- [ ]" still needs an accessible name.
  const name = text.trim() ? '' : ' aria-label="Empty task"';
  return (
    `<li class="nt-task${done ? ' is-done' : ''}">` +
    `<label class="nt-task-label">` +
    `<input type="checkbox" class="nt-task-box" data-line="${lineNo}"${done ? ' checked' : ''}${name}>` +
    `<span class="nt-task-text">${inline(text)}</span>` +
    `</label>`
  );
}

/** "# Title ##" -> "Title" (an optional closing run of #s after a space is dropped). */
function headingText(raw) {
  const text = raw.trimEnd();
  const close = HEADING_CLOSE.exec(text);
  return close ? text.slice(0, close.index).trimEnd() : text;
}

/** For each line, the index of the next non-blank line after it (-1 if none). One pass. */
function nextFilledLines(lines) {
  const next = new Array(lines.length);
  for (let j = lines.length - 1, found = -1; j >= 0; j -= 1) {
    next[j] = found;
    if (lines[j].trim()) found = j;
  }
  return next;
}

function indentWidth(ws) {
  let width = 0;
  for (const ch of ws) width += ch === '\t' ? 4 : 1;
  return width;
}

/* ==========================================================================
   Inline
   ========================================================================== */

// Finished HTML fragments (code, links, escaped characters) are parked in
// `tokens` behind NUL placeholders so later passes can never reach into them.
function inline(text) {
  const tokens = [];
  const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;

  let s = String(text);
  s = s.replace(CODE_SPAN, (_, double, single) => stash(`<code>${escapeHtml(double ?? single)}</code>`));
  s = s.replace(BACKSLASH, (_, ch) => stash(escapeHtml(ch)));
  s = escapeHtml(s);

  s = s.replace(LINK, (_, label, url) => {
    const href = safeHref(url);
    // Unsafe schemes (javascript:, data:, …) lose the link and keep the label.
    return href ? stash(anchor(href, emphasis(label))) : label;
  });

  s = s.replace(AUTOLINK, (match) => {
    let url = match;
    let tail = '';
    // Leave trailing punctuation (and unbalanced closing brackets) outside the link.
    // Bracket counts are kept up to date as characters are peeled off.
    const open = { ')': count(url, '('), ']': count(url, '[') };
    const shut = { ')': count(url, ')'), ']': count(url, ']') };
    for (;;) {
      const last = url[url.length - 1];
      const unbalanced = (last === ')' || last === ']') && open[last] < shut[last];
      if (!/[.,:;!?*_~]/.test(last) && !unbalanced) break;
      if (last in shut) shut[last] -= 1;
      tail = last + tail;
      url = url.slice(0, -1);
    }
    const href = safeHref(url);
    return href ? stash(anchor(href, url)) + tail : match;
  });

  return restore(emphasis(s), tokens);
}

function emphasis(s) {
  return s
    .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>');
}

// `url` is already HTML-escaped, so it is safe inside a quoted attribute as-is.
function safeHref(url) {
  if (!SAFE_URL.test(url) || /[\u0000-\u001f\u007f]/.test(url)) return null;
  return url;
}

function anchor(href, labelHtml) {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

function restore(s, tokens) {
  return s.replace(TOKEN, (_, n) => restore(tokens[Number(n)] ?? '', tokens));
}

function count(str, ch) {
  let n = 0;
  for (const c of str) if (c === ch) n += 1;
  return n;
}
