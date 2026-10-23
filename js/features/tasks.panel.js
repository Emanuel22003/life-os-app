// LIFE/OS — Tasks: a task's page, the panel that slides in from the right when a task is clicked
// (anywhere but its checkbox). The title on top, its date / priority / section as chips (they
// open the Details dialog), and under them a page for whatever the task needs: paragraphs,
// links, checklists, pictures. The page is the task's notes, in the markdown Notes renders, so it
// syncs and the Details dialog shows the same text. Pictures stay on this device (js/files.js).
//
// Not a modal: the list stays usable beside it (wide screens make room for it, smaller ones
// put it over the list with a scrim that closes it). Esc or × closes it; another task's click
// shows that task instead.

import { h, icon, registerIcon, toast, checkButton, setChecked, isTyping, modalOpen, menuOpen } from '../ui.js';
import { renderMarkdown, toggleTask as toggleLine } from './notes.markdown.js';
import { continueList } from './notes.logic.js';
import { saveImage, imageUrl } from '../files.js';
import { imageMarkup, isImageType, IMAGE_TYPES } from '../files.logic.js';
import { insertBlock, toggleLinePrefix, wrapSelection, linkMarkup } from './tasks.panel.logic.js';

const SAVE_MS = 400;
const LEAVE_MS = 260; // the slide out, then the panel is hidden for good
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? '');
// A key with the modifier, as a tooltip writes it: '⌘B' on a Mac, 'Ctrl+B' elsewhere
const chord = (k) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
// ⌘ on a Mac (Ctrl + B and Ctrl + K move and delete there, in every text field), Ctrl elsewhere:
// the same chord as Search's ⌘K (js/command.js); a non-Latin layout's key counts by its place
const isModKey = (e, k) =>
  (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
  !e.altKey &&
  !e.shiftKey &&
  (e.key?.toLowerCase() === k || (e.code === `Key${k.toUpperCase()}` && !/^[a-z]$/i.test(e.key ?? '')));

registerIcon('tk-image', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>');
registerIcon('tk-heading', '<path d="M6 4v16M18 4v16M6 12h12"/>');
registerIcon('tk-bold', '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7Z"/><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7Z"/>');

/**
 * createTaskPanel({ getTask, chipsFor, onTitle, onNotes, onDone, onDetails, onDelete, onChange })
 *   getTask(id)        the task, or null once it is gone
 *   chipsFor(task)     the row's chips (due, priority, section) to show under the title
 *   onTitle / onNotes  save a new title / page text; onDone(id, done); onDetails(id); onDelete(id)
 *   onChange(id, was)  the task shown changed (null: closed; `was` had focus inside when closed)
 * -> { open(id), close(), refresh(), flush(), destroy(), get id() }
 */
export function createTaskPanel({ getTask, chipsFor, onTitle, onNotes, onDone, onDetails, onDelete, onChange }) {
  let id = null;
  let editing = false;
  let rendered = null; // the text the page view was drawn from
  let titleTimer = 0;
  let notesTimer = 0;
  let leaveTimer = 0;
  let busy = 0; // pictures being saved
  let switching = false; // setEditing() is swapping the page and its text box
  const wide = globalThis.matchMedia?.('(min-width: 1100px)') ?? null;

  const iconBtn = (name, label, onClick, extra = {}) =>
    h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', title: label, 'aria-label': label, onClick, ...extra }, icon(name, { size: 16 }));

  const done = checkButton({ label: 'Mark done', onToggle: (checked) => id && onDone(id, checked) });
  done.classList.add('tk-page-check');
  const detailsBtn = h(
    'button',
    // (E opens them from the task's row; here the page has the keyboard, so no key is promised)
    { type: 'button', class: 'btn btn--ghost btn--sm', title: 'Date, priority, section, color', onClick: () => id && onDetails(id) },
    icon('sliders', { size: 14 }),
    h('span', null, 'Details'),
  );
  const deleteBtn = iconBtn('trash', 'Delete task', () => id && onDelete(id));
  const closeBtn = iconBtn('x', 'Close (Esc)', () => close());

  const titleIn = h('textarea', { class: 'tk-page-title', rows: '1', maxlength: '500', 'aria-label': 'Title', placeholder: 'Task title', spellcheck: 'true' });
  const chips = h('button', { type: 'button', class: 'tk-page-meta', title: 'Change the date, priority or section', onClick: () => id && onDetails(id) });

  const fileIn = h('input', { type: 'file', accept: IMAGE_TYPES.join(','), multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const tool = (name, label, run) =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--icon btn--sm tk-page-tool',
        title: label,
        'aria-label': label,
        // The text box keeps its caret and selection while a tool is clicked
        onPointerdown: (e) => e.preventDefault(),
        onClick: run,
      },
      icon(name, { size: 15 }),
    );
  const tools = h(
    'div',
    { class: 'tk-page-tools', role: 'toolbar', 'aria-label': 'Format the page' },
    tool('tk-image', 'Add pictures', () => fileIn.click()),
    tool('tk-heading', 'Heading', () => edit((v, a, b) => toggleLinePrefix(v, a, b, '## '))),
    tool('list', 'List', () => edit((v, a, b) => toggleLinePrefix(v, a, b, '- '))),
    tool('check-square', 'Checklist', () => edit((v, a, b) => toggleLinePrefix(v, a, b, '- [ ] '))),
    tool('tk-bold', `Bold (${chord('B')})`, () => edit((v, a, b) => wrapSelection(v, a, b))),
    tool('tk-link', `Link (${chord('K')})`, () => edit(linkMarkup)),
  );
  const view = h('div', { class: 'tk-page-view nt-prose', tabindex: '0', role: 'region', 'aria-label': 'Page (click or press Enter to edit)' });
  const text = h('textarea', {
    class: 'tk-page-text',
    'aria-label': 'Page',
    'aria-keyshortcuts': IS_MAC ? 'Meta+B Meta+K' : 'Control+B Control+K',
    placeholder: 'Write anything this task needs: steps, links, long notes, a checklist… Paste or drop pictures here.',
    spellcheck: 'true',
    // ⌘K in here makes a link (a text field that owns ⌘K: js/command.js leaves it to it);
    // anywhere else, the title above included, ⌘K is Search
    'data-mod-k': 'own',
  });
  const status = h('span', { class: 'tk-page-status', role: 'status' });
  const foot = h('p', { class: 'tk-page-foot label' }, icon('tk-image', { size: 13 }), h('span', null, 'Pictures stay on this device. Text and links sync.'), status);
  const bodyWrap = h('div', { class: 'tk-page-body' }, tools, view, text);

  const el = h(
    'aside',
    { class: 'tk-page hud', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Task page', tabindex: '-1', hidden: true },
    h('div', { class: 'tk-page-head' }, done, h('span', { class: 'spacer' }), detailsBtn, deleteBtn, closeBtn),
    h('div', { class: 'tk-page-scroll' }, titleIn, chips, bodyWrap, foot),
    fileIn,
  );
  const scrim = h('div', {
    class: 'tk-page-scrim',
    hidden: true,
    // The focus stays in the page until it closes, so it goes back to the task's row
    onPointerdown: (e) => e.preventDefault(),
    onClick: () => close(),
  });
  document.body.append(scrim, el);

  /* ---- filling and drawing ---- */

  function fit(area) {
    if (CSS.supports?.('field-sizing', 'content')) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  function fill(task, { force = false } = {}) {
    setChecked(done, task.done);
    done.setAttribute('aria-label', task.done ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`);
    el.classList.toggle('is-done', task.done);
    el.setAttribute('aria-label', `Task: ${task.title}`);
    if ((force || document.activeElement !== titleIn) && !titleTimer && titleIn.value !== task.title) {
      titleIn.value = task.title;
      fit(titleIn);
    }
    const parts = chipsFor(task);
    chips.replaceChildren(...(parts.length ? parts : [h('span', { class: 'tk-page-meta-empty' }, icon('calendar', { size: 13 }), 'No date. Add one, a priority or a section…')]));
    if ((force || document.activeElement !== text) && !notesTimer && text.value !== task.notes) {
      text.value = task.notes;
      fit(text);
    }
    if (!editing) paintView();
  }

  function paintView() {
    if (rendered === text.value) return;
    rendered = text.value;
    view.innerHTML = renderMarkdown(text.value, { tasks: true, images: true });
    for (const fig of view.querySelectorAll('figure[data-img]')) {
      const caption = fig.dataset.caption ?? '';
      imageUrl(fig.dataset.img).then((url) => {
        if (!fig.isConnected) return;
        if (url) {
          fig.replaceChildren(h('img', { src: url, alt: caption || 'Picture', loading: 'lazy', decoding: 'async' }), caption ? h('figcaption', null, caption) : null);
        } else {
          fig.classList.add('is-missing');
          fig.replaceChildren(icon('tk-image', { size: 16 }), h('span', null, `${caption || 'Picture'}: added on another device, so it shows there`));
        }
      });
    }
  }

  /** The text box, or the drawn page. An empty page is always the text box, ready to type in. */
  function setEditing(on, { focus = false, caret = null } = {}) {
    editing = on || !text.value.trim();
    // The text box takes the focus before the drawn page hides: hiding the page while it has
    // the focus blurs it to <body> at once, and that blur (focusout below) would end the editing
    // it was starting (a click on the page, or Enter on it, did nothing)
    switching = true;
    try {
      text.hidden = !editing;
      el.classList.toggle('is-editing', editing);
      if (editing) fit(text);
      if (focus && editing) {
        text.focus({ preventScroll: true });
        const at = caret ?? text.value.length;
        text.setSelectionRange(at, at);
      }
      view.hidden = editing;
      if (!editing) paintView();
    } finally {
      switching = false;
    }
  }

  /* ---- saving ---- */

  function saveTitle() {
    clearTimeout(titleTimer);
    titleTimer = 0;
    const title = titleIn.value.replace(/\s+/g, ' ').trim();
    if (id && title) onTitle(id, title);
  }

  function saveNotes() {
    clearTimeout(notesTimer);
    notesTimer = 0;
    if (id) onNotes(id, text.value.replace(/\s+$/, ''));
  }

  function flush() {
    if (titleTimer) saveTitle();
    if (notesTimer) saveNotes();
  }

  titleIn.addEventListener('input', () => {
    fit(titleIn);
    clearTimeout(titleTimer);
    titleTimer = setTimeout(saveTitle, SAVE_MS);
  });
  titleIn.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      // A title is one line: Enter goes on to the page
      e.preventDefault();
      saveTitle();
      setEditing(true, { focus: true, caret: 0 });
    }
  });
  titleIn.addEventListener('blur', () => {
    if (titleTimer) saveTitle();
    // Emptied and left: the title it had comes back
    const task = id ? getTask(id) : null;
    if (task && !titleIn.value.trim()) {
      titleIn.value = task.title;
      fit(titleIn);
    }
  });

  text.addEventListener('input', () => {
    fit(text);
    clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotes, SAVE_MS);
  });

  /* ---- editing the page ---- */

  // Type `text` in place of the selection, so the browser's Undo takes it back
  function typeText(value) {
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, value);
    } catch {
      ok = false;
    }
    if (!ok) {
      text.setRangeText(value, text.selectionStart, text.selectionEnd, 'end');
      text.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /** Apply a helper's { from, to, text, select } at the current selection. */
  function edit(helper) {
    if (!id) return;
    if (!editing || document.activeElement !== text) setEditing(true, { focus: true, caret: editing ? null : text.value.length });
    const change = helper(text.value, text.selectionStart, text.selectionEnd);
    text.setSelectionRange(change.from, change.to);
    typeText(change.text);
    text.setSelectionRange(change.select[0], change.select[1]);
  }

  text.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (notesTimer) saveNotes();
      setEditing(false);
      (editing ? text : view).focus({ preventScroll: true });
      return;
    }
    // (a held key does it once: a held ⌘K nested link in link, as Search ignores a held ⌘K)
    if (isModKey(e, 'b')) {
      e.preventDefault();
      if (!e.repeat) edit((v, a, b) => wrapSelection(v, a, b));
      return;
    }
    // (Search's ⌘K steps aside for this field: data-mod-k)
    if (isModKey(e, 'k')) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) edit(linkMarkup);
      return;
    }
    // Enter in a list or checklist starts the next item (or ends the list on an empty one)
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const { selectionStart: start, selectionEnd: end, value } = text;
    if (start !== end) return;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', start);
    const action = continueList(value.slice(lineStart, start), value.slice(start, lineEnd === -1 ? value.length : lineEnd));
    if (!action) return;
    e.preventDefault();
    if (action.clear) {
      text.setSelectionRange(start - action.clear, start);
      typeText('');
    } else {
      typeText(action.insert);
    }
  });

  // Leaving the page (not for one of its tools): it is saved and drawn again
  bodyWrap.addEventListener('focusout', (e) => {
    if (switching || (e.relatedTarget && bodyWrap.contains(e.relatedTarget))) return;
    if (notesTimer) saveNotes();
    // Search or a dialog takes the keyboard for a while and gives it back to the text box: it
    // stays open for that (hidden, the focus it gave back fell to <body>, and Esc then closed the
    // page instead of ending the writing)
    if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.modal-root, .ctx-menu')) return;
    if (editing && document.activeElement !== text) setEditing(false);
  });

  view.addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (img) {
      window.open(img.src, '_blank', 'noopener');
      return;
    }
    // A link opens, a checklist box ticks; anywhere else starts editing
    if (e.target.closest('a, input, label, button')) return;
    if (globalThis.getSelection?.()?.toString()) return;
    setEditing(true, { focus: true });
  });
  view.addEventListener('keydown', (e) => {
    if (e.target !== view || e.key !== 'Enter') return;
    e.preventDefault();
    setEditing(true, { focus: true });
  });
  // A ticked checklist box is written back into the text
  view.addEventListener('change', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.classList.contains('nt-task-box') || !id) return;
    const next = toggleLine(text.value, Number(box.dataset.line), box.checked);
    if (next === text.value) {
      rendered = null;
      paintView();
      return;
    }
    text.value = next;
    rendered = next; // the box already shows it
    box.closest('.nt-task')?.classList.toggle('is-done', box.checked);
    saveNotes();
  });

  /* ---- pictures ---- */

  async function addPictures(files) {
    const list = [...files].filter((f) => f && f.type?.startsWith('image/'));
    if (!list.length || !id) return;
    const forId = id;
    if (!editing || document.activeElement !== text) setEditing(true, { focus: true, caret: text.value.length });
    busy += list.length;
    status.textContent = list.length > 1 ? `Adding ${list.length} pictures…` : 'Adding the picture…';
    for (const file of list) {
      try {
        if (!isImageType(file.type)) throw new Error('Only pictures can go in here (PNG, JPEG, WebP, GIF).');
        const saved = await saveImage(file);
        const markup = imageMarkup(saved.id, file.name);
        if (id === forId) {
          edit((v, a, b) => insertBlock(v, a, b, markup));
          saveNotes();
        } else {
          // The panel moved on to another task meanwhile: the picture still goes where it was added
          const task = getTask(forId);
          if (task) onNotes(forId, `${task.notes.replace(/\s+$/, '')}${task.notes.trim() ? '\n\n' : ''}${markup}`);
        }
      } catch (err) {
        toast(err?.message || 'That picture couldn’t be added.');
      } finally {
        busy -= 1;
      }
    }
    if (!busy) status.textContent = '';
  }

  fileIn.addEventListener('change', () => {
    addPictures(fileIn.files);
    fileIn.value = '';
  });
  text.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type?.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addPictures(files);
  });
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('is-drop');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop');
    if (!hasFiles(e)) return;
    e.preventDefault();
    addPictures(e.dataTransfer.files);
  });

  /* ---- open / close ---- */

  function paintScrim() {
    const show = !!id && !wide?.matches;
    if (show) scrim.hidden = false;
    // (a timer backs the frame up, as for the slide in open())
    const fade = () => scrim.classList.toggle('is-open', !!id && !wide?.matches);
    requestAnimationFrame(fade);
    setTimeout(fade, 60);
    if (!show) setTimeout(() => !id && (scrim.hidden = true), LEAVE_MS);
  }
  const onWide = () => paintScrim();
  wide?.addEventListener?.('change', onWide);

  function open(taskId) {
    const task = getTask(taskId);
    if (!task) return;
    if (id === taskId) {
      el.focus({ preventScroll: true });
      return;
    }
    flush();
    id = taskId;
    rendered = null;
    clearTimeout(leaveTimer);
    el.hidden = false;
    fill(task, { force: true });
    setEditing(false);
    el.querySelector('.tk-page-scroll').scrollTop = 0;
    // Next frame, so the slide plays from off screen (the timer backs the frame up in a tab that
    // paints no frames, a background or hidden one, where the page would stay off screen)
    const slideIn = () => id && el.classList.add('is-open');
    requestAnimationFrame(slideIn);
    setTimeout(slideIn, 60);
    document.documentElement.classList.add('tk-page-open');
    paintScrim();
    onChange(id, null);
    el.focus({ preventScroll: true });
  }

  function close() {
    if (!id) return;
    flush();
    const was = id;
    const hadFocus = el.contains(document.activeElement);
    id = null;
    editing = false;
    el.classList.remove('is-open', 'is-drop');
    document.documentElement.classList.remove('tk-page-open');
    paintScrim();
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      if (!id) el.hidden = true;
    }, LEAVE_MS);
    onChange(null, hadFocus ? was : null);
  }

  /** After the tasks changed: show what changed, or close when the task is gone. */
  function refresh() {
    if (!id) return;
    const task = getTask(id);
    if (!task) {
      clearTimeout(titleTimer);
      clearTimeout(notesTimer);
      titleTimer = notesTimer = 0;
      close();
      return;
    }
    fill(task);
  }

  // Esc closes it, last: whatever is open on top takes it first (the page's text box: back to the
  // drawn page; a dropdown, a right-click menu, a dialog, Search; a drag in the list, a rename, the
  // add bar's steps). On window, so every page handler on document has had its turn.
  function onKey(e) {
    if (!id || e.key !== 'Escape' || e.defaultPrevented || e.isComposing || modalOpen() || menuOpen()) return;
    if (!el.contains(e.target) && isTyping(e)) return;
    e.preventDefault();
    close();
  }
  window.addEventListener('keydown', onKey);
  const onHide = () => flush();
  window.addEventListener('pagehide', onHide);

  return {
    open,
    close,
    refresh,
    flush,
    get id() {
      return id;
    },
    destroy() {
      flush();
      clearTimeout(leaveTimer);
      if (id) document.documentElement.classList.remove('tk-page-open');
      id = null;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onHide);
      wide?.removeEventListener?.('change', onWide);
      el.remove();
      scrim.remove();
    },
  };
}
