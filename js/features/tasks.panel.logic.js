// LIFE/OS — Tasks: a task's page (js/features/tasks.panel.js), the pure part (unit-tested in jsc).
//
// The page is the task's notes, in the markdown Notes renders. The toolbar's buttons and a
// pasted picture are edits of that text: each helper here answers with one replacement,
// { from, to, text, select: [start, end] }, which the page types in place of characters
// from..to (so Undo takes it back) before selecting `select`.

const clampAt = (s, n) => Math.max(0, Math.min(s.length, Math.round(Number(n) || 0)));

/** Put `block` on a line of its own at the caret, in place of the selection; the caret goes under it. */
export function insertBlock(value, start, end, block) {
  const s = String(value ?? '');
  const from = clampAt(s, start);
  const to = Math.max(from, clampAt(s, end));
  const before = s.slice(0, from);
  // Text after the caret on the same line moves under the block
  const text = `${before && !before.endsWith('\n') ? '\n' : ''}${block}\n`;
  const caret = from + text.length;
  return { from, to, text, select: [caret, caret] };
}

// What a line can begin with: a heading, a checklist item, a list item (bullet or number)
const MARKER = /^(#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/;
const HAS = {
  '## ': /^#{1,6}[ \t]+/,
  '- [ ] ': /^[-*+][ \t]+\[[ xX]\][ \t]+/,
  '- ': /^[-*+][ \t]+(?!\[[ xX]\][ \t])/,
};

/**
 * Heading / list / checklist on every line the selection touches: when they all have it, it
 * comes off; otherwise each line gets it in place of whatever marker it had.
 */
export function toggleLinePrefix(value, start, end, prefix) {
  const s = String(value ?? '');
  const a = clampAt(s, start);
  let b = Math.max(a, clampAt(s, end));
  // A selection that ends at the start of a line leaves that line alone
  if (b > a && s[b - 1] === '\n') b -= 1;
  const from = s.lastIndexOf('\n', a - 1) + 1;
  const lineEnd = s.indexOf('\n', b);
  const to = lineEnd === -1 ? s.length : lineEnd;
  const lines = s.slice(from, to).split('\n');
  const has = HAS[prefix] ?? new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const filled = lines.filter((l) => l.trim());
  const remove = filled.length > 0 && filled.every((l) => has.test(l));
  const next = lines.map((l) => {
    if (remove) return l.replace(MARKER, '');
    if (!l.trim() && lines.length > 1) return l;
    return prefix + l.replace(MARKER, '');
  });
  const text = next.join('\n');
  // One line: the caret stays with its words. Several: they stay selected
  if (lines.length === 1) {
    const shift = text.length - lines[0].length;
    const caret = Math.max(from, Math.min(from + text.length, b + shift));
    return { from, to, text, select: [caret, caret] };
  }
  return { from, to, text, select: [from, from + text.length] };
}

/** **Bold** around the selection (off again when it is already bold); with none, a word to type over. */
export function wrapSelection(value, start, end, mark = '**', placeholder = 'bold') {
  const s = String(value ?? '');
  const from = clampAt(s, start);
  const to = Math.max(from, clampAt(s, end));
  const inner = s.slice(from, to);
  if (s.slice(from - mark.length, from) === mark && s.slice(to, to + mark.length) === mark) {
    return { from: from - mark.length, to: to + mark.length, text: inner, select: [from - mark.length, to - mark.length] };
  }
  const word = inner || placeholder;
  return { from, to, text: `${mark}${word}${mark}`, select: [from + mark.length, from + mark.length + word.length] };
}

/** [words](https://…) from the selection, with the address selected to paste over. */
export function linkMarkup(value, start, end) {
  const s = String(value ?? '');
  const from = clampAt(s, start);
  const to = Math.max(from, clampAt(s, end));
  const sel = s.slice(from, to).trim();
  // A selected address becomes the link itself, named after its site
  if (/^https?:\/\/\S+$/i.test(sel)) {
    const name = sel.replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0];
    const text = `[${name}](${sel})`;
    return { from, to, text, select: [from + 1, from + 1 + name.length] };
  }
  const label = sel.replace(/[[\]]/g, '') || 'link';
  const text = `[${label}](https://)`;
  const at = from + label.length + 3;
  return { from, to, text, select: [at, at + 'https://'.length] };
}

/** One line of the page as plain words, for the line under the task in the list. */
export function plainLine(line) {
  return String(line ?? '')
    .replace(/!\[([^\]\n]*)\]\(lifeos-img:[A-Za-z0-9_-]{1,64}\)/g, (_, caption) => (caption.trim() ? `Picture: ${caption.trim()}` : 'Picture'))
    .replace(/^ {0,3}(?:>[ \t]?)+/, '')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '$1')
    .trim();
}

/** The page's first line that says something (not a rule or a code fence), as plain words; cut to `max`. */
export function pagePreview(notes, max = 90) {
  for (const raw of String(notes ?? '').split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(raw) || /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(raw)) continue;
    const line = plainLine(raw);
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}
