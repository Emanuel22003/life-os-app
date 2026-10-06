// LIFE/OS — 04 // Calendar: pointer drags (create / move / resize on the timelines, tasks and
// events onto days). One drag at a time; Escape or a pointercancel aborts it. Touch input
// never starts a drag (the page has to scroll), so taps stay taps.

let active = null; // { cancel }

/** True while a drag is in progress (the page defers re-renders until it ends). */
export const isDragging = () => !!active?.started;

/** Abort the drag in progress (route change, re-mount). */
export function cancelDrag() {
  active?.cancel();
}

/**
 * Track one pointer from pointerdown.
 * opts: { threshold = 4, touch = false,
 *         onStart(e, d), onMove(e, d), onEnd(e, d), onCancel(d), onClick(e) }
 * d = { x0, y0, dx, dy, x, y } in client pixels. A press that never moves past the
 * threshold ends with onClick instead of onStart / onEnd.
 * Returns false (and does nothing) for a non-primary button or a touch pointer without `touch`.
 */
export function trackPointer(e, opts) {
  if (e.button !== 0 || (!opts.touch && e.pointerType === 'touch')) return false;
  active?.cancel();
  const threshold = opts.threshold ?? 4;
  const pointerId = e.pointerId;
  const d = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, x: e.clientX, y: e.clientY };
  const self = { started: false, cancel };
  active = self;
  // No pointer capture: document listeners follow the pointer, and a press that turns out to
  // be a plain click keeps its natural target (capture would retarget the click)

  function update(ev) {
    d.x = ev.clientX;
    d.y = ev.clientY;
    d.dx = d.x - d.x0;
    d.dy = d.y - d.y0;
  }

  function onMove(ev) {
    if (ev.pointerId !== pointerId) return;
    update(ev);
    if (!self.started) {
      if (Math.hypot(d.dx, d.dy) < threshold) return;
      self.started = true;
      document.documentElement.classList.add('cal-dragging');
      opts.onStart?.(ev, d);
    }
    ev.preventDefault();
    opts.onMove?.(ev, d);
  }

  function onUp(ev) {
    if (ev.pointerId !== pointerId) return;
    update(ev);
    const started = self.started;
    finish(true);
    if (started) opts.onEnd?.(ev, d);
    else opts.onClick?.(ev);
  }

  function onKey(ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  }

  function cancel() {
    const started = self.started;
    finish();
    if (started) opts.onCancel?.(d);
  }

  function onPointerCancel(ev) {
    if (ev.pointerId === pointerId) cancel();
  }

  // A click right after a drag would otherwise land on whatever is under the pointer
  function swallowClick(ev) {
    ev.stopPropagation();
    ev.preventDefault();
  }

  function finish(released = false) {
    if (active === self) active = null;
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onPointerCancel, true);
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.classList.remove('cal-dragging');
    if (self.started) {
      // Swallow the click that follows the release (still to come when Escape cancelled)
      document.addEventListener('click', swallowClick, true);
      const stop = () => setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
      if (released) stop();
      else document.addEventListener('pointerup', stop, { capture: true, once: true });
    }
    self.started = false;
  }

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('keydown', onKey, true);
  return true;
}

/**
 * The droppable day ([data-drop-day]) or Unscheduled tray ([data-drop-tray]) under a point.
 * Looks through everything stacked there, so bars and chips lying on a day never hide it.
 */
export function dropTargetAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const target = el.closest?.('[data-drop-day], [data-drop-tray]');
    if (!target) continue;
    if (target.hasAttribute('data-drop-tray')) return { el: target, tray: true, day: null };
    return { el: target, tray: false, day: target.dataset.dropDay };
  }
  return null;
}

/**
 * A floating copy of `source` that follows the pointer (pointer-events: none, so hit tests
 * see what is underneath). Returns { move(x, y), remove() }.
 */
export function ghostOf(source, x, y) {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  ghost.classList.add('cal-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  const offX = Math.min(Math.max(x - rect.left, 0), rect.width);
  const offY = Math.min(Math.max(y - rect.top, 0), rect.height);
  Object.assign(ghost.style, { width: `${Math.max(rect.width, 80)}px`, height: `${rect.height}px` });
  document.body.append(ghost);
  const move = (px, py) => {
    ghost.style.transform = `translate(${px - offX}px, ${py - offY}px)`;
  };
  move(x, y);
  return { move, remove: () => ghost.remove() };
}

/**
 * Scroll `scroller` while a dragged pointer rests near its top or bottom edge. onScroll() runs
 * after each step, so the caller can re-apply the pointer position. -> { update(y), stop() }
 */
export function edgeScroller(scroller, onScroll) {
  const EDGE = 40;
  const MAX_STEP = 18;
  let y = null;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (y === null || !scroller?.isConnected) return;
    const r = scroller.getBoundingClientRect();
    let v = 0;
    if (y < r.top + EDGE) v = -Math.min(MAX_STEP, Math.ceil((r.top + EDGE - y) / 3));
    else if (y > r.bottom - EDGE) v = Math.min(MAX_STEP, Math.ceil((y - (r.bottom - EDGE)) / 3));
    if (!v) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += v;
    if (scroller.scrollTop === before) return;
    onScroll?.();
    raf = requestAnimationFrame(tick);
  };
  return {
    update(py) {
      y = py;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      y = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
