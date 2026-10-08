// LIFE/OS — Health: on stand-by. A grayed "Soon" entry in the menu keeps the idea in sight; this
// page says what it will be. Nothing is tracked or stored yet.

import { h, pageHeader, emptyState } from '../ui.js';

const PLANNED = ['Sleep', 'Body weight', 'Water', 'Steps', 'Mood', 'Resting heart rate'];

function mount(root) {
  root.append(
    pageHeader({ index: '08', title: 'Health', subtitle: 'On stand-by: planned for a later version of LIFE/OS.' }),
    emptyState({
      icon: 'heart',
      title: 'Health tracking is coming',
      text: 'This page is a reminder that it’s planned. Nothing is tracked here yet.',
    }),
    h('section', { class: 'hl-planned panel', 'aria-label': 'Planned' }, h('div', { class: 'label' }, 'Ideas for it'), h('ul', { class: 'hl-list' }, PLANNED.map((x) => h('li', null, x))), h('p', { class: 'hl-note' }, 'Each with a daily log and a graph over time, like Training’s progress graphs.')),
  );
}

export default { id: 'health', title: 'Health', icon: 'heart', mount };
