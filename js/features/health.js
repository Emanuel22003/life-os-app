// LIFE/OS — Health: not available. A grayed entry in the menu keeps the idea in sight; this page
// says so plainly, with no date and no promise. Nothing is tracked or stored.

import { h, pageHeader, emptyState } from '../ui.js';

const IDEAS = ['Sleep', 'Body weight', 'Water', 'Steps', 'Mood', 'Resting heart rate'];

function mount(root) {
  root.append(
    pageHeader({ index: '08', title: 'Health', subtitle: 'Not available: an idea for a later version, with no date and no promise.' }),
    emptyState({
      icon: 'heart',
      title: 'Nothing here yet',
      text: 'Nothing is tracked or stored on this page.',
    }),
    h('section', { class: 'hl-planned panel', 'aria-label': 'Ideas' }, h('div', { class: 'label' }, 'Ideas (not a promise)'), h('ul', { class: 'hl-list' }, IDEAS.map((x) => h('li', null, x)))),
  );
}

export default { id: 'health', title: 'Health', icon: 'heart', mount };
