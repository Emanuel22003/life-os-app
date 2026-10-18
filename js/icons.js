// LIFE/OS — the shared icon set: the icons you can pick for a habit or a section (their words and
// suggestions are in icons.logic.js) and the few that stand for an idea everywhere (overdue,
// tomorrow, no date, month / week / day). Same grid as ui.js's: 24px, 1.5 stroke, currentColor.
// An icon a page already registered under the same name stays as it is.

import { registerIcon, hasIcon } from './ui.js';

// Many basic shapes match Feather (MIT, (c) 2013-2023 Cole Bemis) and Lucide (ISC, (c) Lucide Icons
// and Contributors); their notices are in legal/credits.html.
const SET = {
  // Body and health
  droplet: '<path d="M12 3.2s6 6.4 6 10.8a6 6 0 0 1-12 0c0-4.4 6-10.8 6-10.8Z"/><path d="M9 14.5a3 3 0 0 0 3 3"/>',
  glass: '<path d="M6 3h12l-1.6 16.4A1.8 1.8 0 0 1 14.6 21H9.4a1.8 1.8 0 0 1-1.8-1.6Z"/><path d="M6.7 9.5h10.6"/>',
  coffee: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17M7.5 3.5v2M11 3v2.5M14.5 3.5v2"/>',
  utensils: '<path d="M5.5 3v5.5a2 2 0 0 0 4 0V3M7.5 3v18"/><path d="M18 21V3c-2.3 1.2-3.8 3.8-3.8 7.6 0 1.6 1.2 2.6 3.8 2.6"/>',
  apple: '<path d="M12 7.5c-1.6-1.2-5.4-1.6-6.8 1.6-1.3 3-.3 7.4 1.6 10 1.3 1.8 2.9 2.4 5.2 1.3 2.3 1.1 3.9.5 5.2-1.3 1.9-2.6 2.9-7 1.6-10-1.4-3.2-5.2-2.8-6.8-1.6Z"/><path d="M12 7.5c0-2 1-3.6 3-4.3"/>',
  pill: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="m9.5 9.5 5 5"/>',
  tooth: '<path d="M7.6 3.5C5 3.5 3.5 5.6 3.5 8c0 2.9 1.4 4.4 1.9 7.2.5 3 1 5.3 2.4 5.3s1.6-3.8 4.2-3.8 2.8 3.8 4.2 3.8 1.9-2.3 2.4-5.3c.5-2.8 1.9-4.3 1.9-7.2 0-2.4-1.5-4.5-4.1-4.5-1.9 0-2.9 1-4.4 1s-2.5-1-4.4-1Z"/>',
  bed: '<path d="M3 5v15M3 15h18v5M21 15v-2.5a3 3 0 0 0-3-3h-7V15"/><circle cx="7" cy="11.8" r="1.8"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  heart: '<path d="M12 20.5s-8.5-4.8-8.5-11a4.6 4.6 0 0 1 8.5-2.5 4.6 4.6 0 0 1 8.5 2.5c0 6.2-8.5 11-8.5 11Z"/>',
  scale: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.2 9.2a5.4 5.4 0 0 1 7.6 0L13.2 12h-2.4Z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  lotus: '<path d="M12 20c-2.6-2.4-3.8-5.2-3.8-8S9.6 6.6 12 4.5c2.4 2.1 3.8 4.7 3.8 7.5s-1.2 5.6-3.8 8Z"/><path d="M12 20c-4.2 0-8-1.6-9-5.2 3 0 6.3 1.3 9 5.2Zm0 0c4.2 0 8-1.6 9-5.2-3 0-6.3 1.3-9 5.2Z"/>',
  // Moving
  dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  run: '<circle cx="15.5" cy="4.5" r="1.8"/><path d="M13.5 8 11 13.5l3 3-1 4.5M11 13.5 8 17.5H5M13 8.5l3 2.5 3.5-.5M13 8.5l-3.8.8-2 3"/>',
  walk: '<path d="M7.2 3.5c1.6 0 2.6 1.7 2.6 4.1 0 2-.8 3.4-.6 5.4H5.4c0-2-1-3-1-5.4s1.2-4.1 2.8-4.1Z"/><path d="M5.7 16h3.4"/><path d="M16.8 8.5c1.6 0 2.8 1.7 2.8 4.1 0 2.4-1 3.4-1 5.4h-3.8c.2-2-.6-3.4-.6-5.4 0-2.4 1-4.1 2.6-4.1Z"/><path d="M15 21h3.4"/>',
  bike: '<circle cx="6" cy="16.5" r="3.5"/><circle cx="18" cy="16.5" r="3.5"/><path d="M6 16.5 9.5 9h6l2.5 7.5M9.5 9 8.3 6.5h2.4M15.5 9l-3.5 7.5H6"/>',
  stretch: '<circle cx="12" cy="4.5" r="1.8"/><path d="M4.5 9.5h15M12 9.5v4.5l-3.5 6.5M12 14l3.5 6.5"/>',
  mountain: '<path d="m2.5 20 7-12 4.2 7 2.3-3.8L21.5 20Z"/><path d="m7.8 11 1.7 1.3 1.6-1.4"/>',
  activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  // Mind and learning
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5Z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20M8 7.5h8"/>',
  pen: '<path d="M4 20h4L19.2 8.8a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14.5 7.5 3 3"/>',
  graduation: '<path d="m2 9.5 10-5 10 5-10 5Z"/><path d="M6 11.5v4.8c3.4 2.4 8.6 2.4 12 0v-4.8M22 9.5v5.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>',
  // Life and home
  sparkles: '<path d="m11 3 1.8 4.6 4.7 1.9-4.7 1.8L11 16l-1.8-4.7-4.7-1.8 4.7-1.9Z"/><path d="m18.5 14.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
  shirt: '<path d="M8.5 3.5 3.5 6l2 4.5 2-1V20.5h9V9.5l2 1 2-4.5-5-2.5c0 1.6-1.6 2.9-3.5 2.9S8.5 5.1 8.5 3.5Z"/>',
  sprout: '<path d="M12 21v-9"/><path d="M12 12C12 8.1 9.3 5 4.5 5c0 4 2.7 7 7.5 7ZM12 10c0-3.4 2.4-6 7-6 0 3.4-2.4 6-7 6"/>',
  paw: '<circle cx="6.5" cy="10" r="1.8"/><circle cx="10.5" cy="6" r="1.8"/><circle cx="15" cy="6.5" r="1.8"/><circle cx="18.5" cy="10.5" r="1.8"/><path d="M8.5 17.6c0-3.1 2-5.6 4.4-5.6S17 14 17 16.5 15.6 20 13.6 20c-1 0-1.5-.7-2.4-.7s-1.3.7-2.2.7-.5-.9-.5-2.4Z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 6.3"/>',
  phone: '<path d="M5.2 3.5h3.6l1.8 4.6-2.3 1.4a11 11 0 0 0 6.2 6.2l1.4-2.3 4.6 1.8v3.6a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 3.2 5.6a2 2 0 0 1 2-2.1Z"/>',
  'phone-off': '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2M3.5 3.5l17 17"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.2 8.5-6.2"/>',
  // Work and money
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M3 12.5h18"/>',
  coins: '<ellipse cx="9" cy="6.8" rx="6" ry="2.8"/><path d="M3 6.8v4.4c0 1.5 2.7 2.8 6 2.8M15 6.8v2"/><ellipse cx="15" cy="13.2" rx="6" ry="2.8"/><path d="M9 13.2v4.2c0 1.5 2.7 2.8 6 2.8s6-1.3 6-2.8v-4.2"/>',
  cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3.5H5l2.6 12h11.2l2-8.5H6"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8v12"/><path d="M12 8C9.8 8 7.5 7.3 7.5 5.6S9.7 3.4 12 8Zm0 0c2.2 0 4.5-.7 4.5-2.4S14.3 3.4 12 8Z"/>',
  cake: '<path d="M4 21h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z"/><path d="M4 16.2c1.3 1 2.7 1 4 0s2.7-1 4 0 2.7 1 4 0 2.7-1 4 0M12 12V8.5"/><path d="M12 8.5c-.9 0-1.5-.7-1.5-1.6 0-1 1.5-3.1 1.5-3.1s1.5 2.1 1.5 3.1c0 .9-.6 1.6-1.5 1.6Z"/>',
  plane: '<path d="M21 4.5c.6-.6.6-1.6 0-2.1s-1.5-.6-2.1 0L15 6.3 5.8 3.8 4 5.6l7.4 4.5-3.6 3.6-2.7-.4L3.4 15l3.6 1.9L9 20.5l1.7-1.7-.4-2.7 3.6-3.6 4.5 7.4 1.8-1.8L17.7 9Z"/>',
  car: '<path d="M3.5 16.5v-4.2l2-5.3h13l2 5.3v4.2Z"/><path d="M5.5 16.5v2.5h2.5v-2.5M16 16.5v2.5h2.5v-2.5M3.5 12.3h17"/><circle cx="7.5" cy="14.4" r=".6"/><circle cx="16.5" cy="14.4" r=".6"/>',
  gamepad: '<rect x="2.5" y="7" width="19" height="11" rx="4.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="15.3" cy="11.5" r=".9"/><circle cx="17.7" cy="13.7" r=".9"/>',
  tv: '<rect x="3" y="6.5" width="18" height="12" rx="2"/><path d="m8.5 2.5 3.5 4 3.5-4M8.5 21.5h7"/>',
  // General
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  star: '<path d="m12 3.2 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.2l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>',
  // Ideas that show up everywhere
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8 5.2-5.7"/>',
  'check-square': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12.4 2.8 2.8 5.2-5.7"/>',
  'circle-slash': '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  sunrise: '<path d="M12 3v5M5.6 9.6 7 11M18.4 9.6 17 11M2.5 17h19M7 17a5 5 0 0 1 10 0M6 21h12"/>',
  grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
  columns: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M9.2 3.5v17M14.8 3.5v17"/>',
  rows: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9h17M7 12.8h10M7 16.5h7"/>',
  tag: '<path d="M3 12V4.2A1.2 1.2 0 0 1 4.2 3H12l9 9-9 9Z"/><circle cx="7.6" cy="7.6" r="1.4"/>',
  play: '<path d="M7 4.5v15l12-7.5Z"/>',
  repeat: '<path d="m17 2.5 3 3-3 3"/><path d="M4 11.5v-1a5 5 0 0 1 5-5h11M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 0 1-5 5H4"/>',
  'map-pin': '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
};

for (const [name, svg] of Object.entries(SET)) if (!hasIcon(name)) registerIcon(name, svg);
