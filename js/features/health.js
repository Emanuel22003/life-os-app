// LIFE/OS — Health: not available. A grayed entry in the menu keeps the idea in sight; this page
// says so plainly, with no date and no promise. Nothing is tracked or stored, and nothing on it
// looks like something you could press: the ideas are plain words, not buttons.

import { h, pageHeader, emptyState } from '../ui.js';

const IDEAS = ['Sleep', 'Body weight', 'Water', 'Steps', 'Mood', 'Resting heart rate'];

function mount(root) {
  root.classList.add('hl-root');
  const empty = emptyState({
    icon: 'heart',
    title: 'Not available yet',
    text: 'Nothing is tracked or stored on this page.',
    action: h(
      'div',
      { class: 'hl-ideas' },
      h('h2', { class: 'hl-ideas-title', id: 'hl-ideas-title' }, 'Ideas for later, not a promise'),
      h('ul', { class: 'hl-list', 'aria-labelledby': 'hl-ideas-title' }, IDEAS.map((x) => h('li', null, x))),
    ),
  });
  empty.classList.add('hl-empty');
  root.append(
    // '··' like its place in the menu: it has no number of its own (Finance is 08)
    pageHeader({ index: '··', title: 'Health', subtitle: 'An idea for a later version of LIFE/OS, with no date and no promise.', tipId: 'health.intro' }),
    empty,
  );
}

export default { id: 'health', title: 'Health', icon: 'heart', mount };
