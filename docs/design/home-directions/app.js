'use strict';

// Display-only prototype: no camera access; it only shows the Warm Glass Home design and interactions.
const $ = (id) => document.getElementById(id);

// Dock icons: warm duotone (outline plus one accent, .d) with a film reel for Archive (.f is filled ink)
const I = {
  home: '<rect class="d" x="10" y="14.8" width="4" height="5.2" rx=".8"/><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z"/><circle class="d" cx="12" cy="12" r="2.3"/>',
  // Reel: a hub in the middle and four holes around it (three would look like a face)
  archive:
    '<circle cx="11" cy="12" r="7.5"/><circle class="f" cx="11" cy="12" r="1"/><circle cx="11" cy="8.3" r="1.5"/><circle cx="14.7" cy="12" r="1.5"/><circle cx="11" cy="15.7" r="1.5"/><circle cx="7.3" cy="12" r="1.5"/><path d="M11 19.5h9"/>',
  camera:
    '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/><circle class="d" cx="12" cy="12.5" r="2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  chev: '<path d="m7 10 5 5 5-5"/>',
  swap: '<path d="M7 8h12l-3.5-3.5M17 16H5l3.5 3.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>',
  rewind: '<path d="M11.5 7 6.5 12l5 5M18 7l-5 5 5 5"/>',
  check: '<path d="m5.5 12.5 4.2 4.2L18.5 8"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  play: '<path d="M8.5 5.8v12.4a.6.6 0 0 0 .9.5l10-6.2a.6.6 0 0 0 0-1l-10-6.2a.6.6 0 0 0-.9.5Z"/>',
};
const ic = (n, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;

/* ---------- Shared data: every number is derived from here, nothing hard-coded ---------- */
// Per-member colour (borrowed from Reveal: one colour per person across avatar, quota ring and film captions)
const COLORS = [
  '#E07A5F',
  '#E9B44C',
  '#7FB08F',
  '#6D90C4',
  '#B480B0',
  '#E58F9F',
  '#4FA69C',
  '#C7895A',
  '#8D95C9',
  '#CFA66E',
];
const POOL = [
  { name: 'Alex', c: 2, me: true },
  { name: 'Bea', c: 3 },
  { name: 'Chen', c: 1 },
  { name: 'Dev', c: 0 },
  { name: 'Emi', c: 2 },
  { name: 'Faye', c: 4 },
  { name: 'Gus', c: 0 },
  { name: 'Hana', c: 1 },
  { name: 'Ivo', c: 5 },
  { name: 'Jun', c: 2 },
].map((p, i) => ({ ...p, col: COLORS[i] }));
const DEFAULT_C = POOL.map((p) => p.c);

let size = 5;
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
// Each of your moments this week: [type, seconds, day]. A photo takes 3 s in the film and counts toward the 30 s (Sprint 2 plan)
const CLIPS0 = [
  ['video', 4, 'Mon'],
  ['video', 4, 'Tue'],
  ['photo', 3, 'Thu'],
  ['video', 6, 'Fri'],
  ['video', 7, 'Sat'],
];
const clipsOf = (x) => x.clips || CLIPS0.slice(0, x.c);
const usedSecs = (x) => clipsOf(x).reduce((s, c) => s + c[1], 0);
function addClip(x, kind, len) {
  x.clips = [...clipsOf(x), [kind, len, 'Today']];
  x.c = x.clips.length;
}
function dropClip(x, i) {
  x.clips = clipsOf(x).filter((_, k) => k !== i);
  x.c = x.clips.length;
}

// Snapshot of the current group: the sample group uses the sidebar sample data; other groups, and a sample group that started a new capsule, use their own saved data.
// PURE: the states page draws the sample group as it originally is, ignoring the snapshot
let PURE = false;
function pureIf(on, fn) {
  const keep = PURE;
  PURE = on;
  try {
    return fn();
  } finally {
    PURE = keep;
  }
}
const snap = () => {
  const g = typeof grp === 'function' ? grp() : null;
  return g && g.clips && !(g.sample && PURE) ? g : null;
};
// Your record in this group: sealing and deleting change this
const myRec = (id) => snap() || storyPool(id)[0];

// Home shows only your own quota (as dev's Home does); members' c only simulates your count and the film credits
function data(pool = POOL) {
  const g = snap();
  const members = pool.slice(0, g?.n ?? size);
  if (g) members[0] = { ...members[0], clips: g.clips, c: g.clips.length };
  // Newly signed-up account: use its own name and colour
  const who = typeof SET !== 'undefined' && SET.who;
  if (who) members[0] = { ...members[0], name: who.name, col: who.col };
  return { members, n: members.length, m: members.reduce((s, x) => s + x.c, 0), me: members[0] };
}
// A capsule lasts 4 weeks from the group's start; quota resets every 7 days (dev docs). The demo is fixed at week 2.
// While the film is compiling, delayed or premiering, the next capsule has already started: week 1
const NEW_CYCLE = ['developing', 'delayed', 'released'];
const cyc = () =>
  NEW_CYCLE.includes(NAV.home)
    ? { week: 1, days: 27, reset: 7 }
    : snap()?.cyc || { week: 2, days: 16, reset: 3 };

/* ---------- Shared parts ---------- */
// 5-moment quota ring: used moments light up.
const polar = (c, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
};
function ring(used = 2, total = 5, r = 35, c = 38, gap = 9) {
  const pt = (deg) => polar(c, r, deg);
  let segs = '';
  for (let i = 0; i < total; i++) {
    const a0 = -90 + (i * 360) / total + gap / 2;
    const a1 = -90 + ((i + 1) * 360) / total - gap / 2;
    segs += `<path class="seg${i < used ? ' on' : ''}" d="M${pt(a0)}A${r} ${r} 0 0 1 ${pt(a1)}"/>`;
  }
  return `<svg class="ring" viewBox="0 0 ${c * 2} ${c * 2}" aria-hidden="true">${segs}</svg>`;
}
// Continuous arc: premiere time left, or the sealing spinner
function arcRing(frac, spin = false) {
  const end = -90 + 360 * Math.min(frac, 0.999);
  return `<svg class="ring${spin ? ' spin' : ''}" viewBox="0 0 76 76" aria-hidden="true"><circle class="base" cx="38" cy="38" r="35"/><path class="arc" d="M${polar(38, 35, -90)}A35 35 0 ${frac > 0.5 ? 1 : 0} 1 ${polar(38, 35, end)}"/></svg>`;
}

const statusBar = () =>
  `<div class="sb" aria-hidden="true"><span>9:41</span><span class="island"></span><span class="sys">` +
  `<svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx=".7"/><rect x="5" y="5.5" width="3" height="6.5" rx=".7"/><rect x="10" y="3" width="3" height="9" rx=".7"/><rect x="15" y="0" width="3" height="12" rx=".7" opacity=".35"/></svg>` +
  `<svg viewBox="0 0 16 12"><path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0z"/><path d="M3.4 6.8a6.5 6.5 0 0 1 9.2 0l-1.4 1.4a4.5 4.5 0 0 0-6.4 0z"/><path d="M1.2 4.6a9.6 9.6 0 0 1 13.6 0l-1.4 1.4a7.6 7.6 0 0 0-10.8 0z"/></svg>` +
  `<svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="23" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="8" rx="2"/><rect x="24.5" y="4" width="1.8" height="4" rx=".9" opacity=".4"/></svg>` +
  `</span></div>`;

/* ---------- Dock: glass dock + shutter state + badges ---------- */
const NAV = { shutter: 'collect', unread: true, home: 'collect' };
// Seen badges: unread clears after opening Chat; the "new film" dot clears after opening Archive
const SEEN = { chat: false, archive: false };
// Unread only in the first group (where the sample conversation is); gone once seen
const unreadNow = () => NAV.unread && !SEEN.chat && (typeof isSample === 'undefined' || isSample());

function shutter(d) {
  const reset = plural(cyc().reset, 'day');
  // No shutter when there is no capsule, loading failed or you are not in the group (see states.js)
  if (NAV.home !== 'collect' && window.shutterOff?.()) return '';
  // Count what Home shows: whichever of 5 moments or 30 s runs out first means used up
  const list = typeof homeClips === 'function' ? homeClips(concepts[0].id, d) : clipsOf(d.me);
  const n = list.length;
  const secs = list.reduce((s, c) => s + c[1], 0);
  const left = 5 - n;
  const full = NAV.shutter === 'quota' || n >= 5 || secs >= 30;
  const secsOut = n < 5 && (NAV.home === 'secs' || secs >= 30);
  // Item 4 is a tip that appears briefly on tap, not permanently (it would cover the content)
  const s = {
    collect: [ring(n), 'camera', `Add a moment · ${left} of 5 left`, ''],
    quota: [
      ring(5),
      'camera',
      secsOut
        ? `This week's 30 seconds are used · resets in ${reset}`
        : `This week's 5 moments are used · resets in ${reset}`,
      secsOut ? `30 s used · resets in ${reset}` : `All 5 used · resets in ${reset}`,
    ],
  }[full ? 'quota' : 'collect'];
  return (
    `<button type="button" class="shutter" aria-label="${s[2]}"${full ? ' aria-disabled="true"' : ''}${s[3] ? ` data-tip="${s[3]}"` : ''}>` +
    `${s[0]}<span class="core">${ic(s[1])}</span></button>`
  );
}

function dock(d, at = 'home') {
  // Not in this group or no group yet: chat, archive and the shutter belong to a group, so hide the whole dock
  if (NAV.home === 'denied' || NAV.home === 'nogroup') return '';
  const unread = unreadNow() && at !== 'chat';
  const film = NAV.home === 'released' && !SEEN.archive && at !== 'archive';
  const tabs = [
    ['home', 'Home', '', ''],
    ['chat', 'Chat', unread ? '<i class="badge">3</i>' : '', unread ? ', 3 unread' : ''],
    ['archive', 'Archive', film ? '<i class="badge dot"></i>' : '', film ? ', new film' : ''],
  ];
  const tab = ([k, l, badge, extra]) =>
    `<button type="button" class="tab${k === at ? ' on' : ''}" data-tab-go="${k}" aria-label="${l}${extra}"${k === at ? ' aria-current="page"' : ''}><span class="ico">${ic(k)}${badge}</span><span class="tlbl">${l}</span></button>`;
  // The three tabs stay expanded (Home / Chat / Archive); the shutter is a separate button on every page
  return `<nav class="dock dock-g open" aria-label="Main navigation"><div class="tabs">${tabs.map(tab).join('')}</div>${shutter(d)}</nav>`;
}

const acting = () => (typeof SET === 'undefined' ? POOL[0] : SET.who || POOL[SET.me]);
const me = () =>
  `<button type="button" class="me" aria-label="${acting().name} · settings"><span class="avatar">${acting().name[0]}</span></button>`;
// Header: group name centred, tap to switch groups (see tabs.js); avatar top right opens Settings
const topBar = () =>
  NAV.home === 'nogroup'
    ? `<header class="top"><span class="top-sp" aria-hidden="true"></span><span class="grp brand">Rewind</span>${me()}</header>`
    : `<header class="top"><span class="top-sp" aria-hidden="true"></span><button type="button" class="grp" aria-haspopup="menu" aria-expanded="false" aria-label="${typeof groupName === 'function' ? esc(groupName()) : 'Group name'} · switch group"><span class="grp-t">${typeof groupName === 'function' ? esc(groupName()) : 'Group name'}</span>${ic('chev')}</button>${me()}</header>`;

const bars = (cls, used, total = 5) =>
  `<div class="${cls}" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<i${i < used ? ' class="on"' : ''}></i>`).join('')}</div>`;

// Your moments this week: only type, day and seconds (media is hidden once sealed)
const hist = (x) => {
  const list = clipsOf(x);
  if (!list.length) return `<p class="hist none">Nothing sealed yet this week</p>`;
  return `<div class="hist" aria-label="Your moments this week">${list
    .map(
      ([kind, len, day], i) =>
        `<span class="hc${NAV.home === 'failed' && i === list.length - 1 ? ' bad' : ''}">${ic(kind === 'photo' ? 'camera' : 'play')}${day} · ${len} s</span>`,
    )
    .join('')}</div>`;
};

/* ---------- Home body ---------- */
const bodies = {
  // o.card: a status card under the header for premiere, compiling or processing failure
  c6: (d, o = {}) => {
    const k = cyc();
    const used = usedSecs(d.me);
    const prompt =
      typeof promptText === 'function' ? promptText() : 'What made you pause and smile?';
    return `
    <div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="glow-low" aria-hidden="true"></div>
    ${topBar()}
    ${o.card || ''}
    <section class="hero${o.card ? ' slim' : ''}" aria-label="${plural(k.days, 'day')} until the film">
      <b>${k.days}</b>
      <span>days until our film</span>
    </section>
    <div class="count"><strong>Week ${k.week} of 4</strong><span>Your moments reset in ${plural(k.reset, 'day')}</span></div>
    <section class="glass">
      <small>This cycle's prompt</small>
      <h2>${prompt}</h2>
      <button type="button" class="rowx mine-row" data-open-mine aria-label="Your moments: ${d.me.c} of 5, ${used} of 30 seconds">${bars('pills', d.me.c)}<span>You · ${d.me.c} of 5 · ${used} of 30 s</span>${ic('chev', 'go')}</button>
      ${hist(d.me)}
    </section>`;
  },
};

/* ---------- Home notes ---------- */
const concepts = [
  {
    id: 'c6',
    no: '06',
    en: 'Warm Glass',
    key: 'Cream · peach light · soft serif',
    notes: [
      'Glass cards and dock over a peach and honey glow',
      'Light theme, like afternoon sun in a room',
    ],
    fonts: 'Fraunces (SOFT) · Geist',
  },
];
const nameOf = (c) => c.en;

// tab: which dock page (home | chat | archive; the last two are in tabs.js); o: this page's demo options, used by the screens page
const screen = (c, d, tab = 'home', o = {}) => {
  // No group at all yet (just signed up): only the "no group" Home
  if (typeof grp === 'function' && !grp() && NAV.home !== 'nogroup')
    return withHome('nogroup', () => screen(c, d, 'home', o));
  const body =
    tab !== 'home' && typeof tabBody === 'function'
      ? tabBody(tab, d, o)
      : `<div class="scroll">${NAV.home === 'collect' ? bodies[c.id](d) : stateBody(c, d)}</div>`;
  const menu = o.menu && typeof groupMenu === 'function' ? groupMenu(NAV.home) : '';
  return `<div class="device"><div class="screen ${c.id} gnav nav-g sh-${NAV.shutter} st-${NAV.home} tab-${tab}" data-tab="${tab}" data-home="${NAV.home}" data-o="${encodeURIComponent(JSON.stringify(o))}">${statusBar()}${body}${dock(d, tab)}${menu}<span class="home-ind" aria-hidden="true"></span></div></div>`;
};
// Read back this phone's demo options
const optsOf = (scr) => {
  try {
    return JSON.parse(decodeURIComponent(scr.dataset.o || '%7B%7D'));
  } catch {
    return {};
  }
};

// Per-phone demo data (Play / shutter change only this phone; reset deletes it)
const STORY = {};
const storyPool = (id) => (STORY[id] ||= POOL.map((p) => ({ ...p })));
const dataFor = (id) => data(STORY[id] || POOL);

function renderCard(id, from) {
  const c = concepts.find((x) => x.id === id);
  // from: the phone being animated; phones on the states page redraw as "Collecting"
  const card = from?.closest('.card') || document.querySelector(`.card[data-id="${id}"]`);
  const wrap = card?.querySelector('.phone-wrap');
  if (c && wrap) {
    const sv = !!card.closest('#states-view');
    // Just joined or created a group: don't go back to "no group yet"
    if (wrap.dataset.home === 'nogroup' && typeof grp === 'function' && grp())
      delete wrap.dataset.home;
    const home = wrap.dataset.home || (sv ? 'collect' : NAV.home);
    const draw = () => pureIf(sv, () => screen(c, dataFor(id), wrap.dataset.tab || 'home'));
    wrap.innerHTML = home === NAV.home ? draw() : withHome(home, draw);
  }
  return wrap?.querySelector('.screen');
}
// Switch tabs on the same phone, or redraw this page with new options; the phone's state is unchanged
function goTab(scr, tab = scr.dataset.tab, o = {}) {
  if (typeof stopTimers === 'function') stopTimers(scr);
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  const c = concepts.find((x) => x.id === id);
  const home = scr.dataset.home;
  wrap.dataset.tab = tab;
  wrap.dataset.home = home;
  const draw = () => pureIf(!!wrap.closest('#states-view'), () => screen(c, dataFor(id), tab, o));
  wrap.innerHTML = home === NAV.home ? draw() : withHome(home, draw);
  return wrap.querySelector('.screen');
}
const clearStories = () => Object.keys(STORY).forEach((k) => delete STORY[k]);

function render() {
  const c = concepts[0];
  $('gallery').innerHTML =
    `<article class="card show" data-id="${c.id}" aria-label="${nameOf(c)}">` +
    `<header class="card-h"><div><h2>${nameOf(c)}</h2></div></header>` +
    `<div class="card-ctl"><button type="button" class="ctl" data-play="${c.id}" title="${t('play.title')}">${ic('play')}${t('play')}</button><span class="step" id="step-${c.id}" aria-live="polite"></span></div>` +
    `<div class="phone-wrap">${screen(c, dataFor(c.id))}</div>` +
    `<div class="notes"><p class="key">${c.key}</p><ul>${c.notes
      .map((n) => `<li>${n}</li>`)
      .join('')}</ul><p class="fonts">${t('fonts')} · ${c.fonts}</p></div>` +
    `</article>`;
}

// On narrow screens, shrink the phone to the available width to avoid horizontal scroll
const fitScale = () => Math.min(1, ($('gallery').clientWidth || 410) / 410);
const setZoom = (v) => {
  $('zoom').value = v;
  $('zoomv').textContent = v + '%';
  document.documentElement.style.setProperty('--s', Math.min(v / 100, fitScale()));
  // The states and mix pages derive their phone size from this value
  document.documentElement.style.setProperty('--z', Math.min(v / 100, fitScale()));
};
// Recalculate when the window narrows, to avoid horizontal scroll
addEventListener('resize', () => setZoom($('zoom').value));

/* ---------- Motion: intro, and "sealing" on shutter press ---------- */
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let introTimer;
// Play only while the page is visible (requestAnimationFrame doesn't fire on hidden pages), so thumbnails don't freeze at the first frame
function playIntro() {
  requestAnimationFrame(() => {
    const g = $('gallery');
    g.classList.remove('intro');
    void g.offsetWidth;
    g.classList.add('intro');
    clearTimeout(introTimer);
    introTimer = setTimeout(() => g.classList.remove('intro'), 2600);
  });
}

// A short toast at the bottom of the page
let toastTimer;
function rvToast(text) {
  let el = $('rv-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rv-toast';
    el.className = 'rv-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* Fall back to the old method when the Clipboard API is unavailable */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function flashTip(btn, text) {
  btn.querySelector('.tip.flash')?.remove();
  const tip = document.createElement('span');
  tip.className = 'tip flash';
  tip.setAttribute('aria-hidden', 'true');
  tip.textContent = text;
  btn.appendChild(tip);
  setTimeout(() => tip.remove(), 1900);
}

/* ---------- Motion: you press the shutter ---------- */
// Attach a one-off effect class to an element
function fx(el, cls, ms = 1000) {
  if (!el) return;
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// After sealing: the quota row bounces
const FX = {
  c6: { sealed: (ns) => fx(ns.querySelector('.mine-row'), 'fx-roll', 700) },
};

// You press the shutter: seal a moment
async function sealFlight(scr, btn, then) {
  if (NAV.shutter !== 'collect') return then?.();
  const id = scr.classList[1];
  const mine = storyPool(id)[0];
  if (mine.c >= 5) {
    flashTip(btn, `All 5 used · resets in ${plural(cyc().reset, 'day')}`);
    return then?.();
  }
  const S = FX[id] || {};
  addClip(mine, 'video', 5);
  const ns = renderCard(id, scr);
  if (ns) {
    S.sealed?.(ns);
    const nb = ns.querySelector('.shutter');
    if (nb) flashTip(nb, 'Sealed');
  }
  then?.();
}

// Reveal: the 4 weeks are up, the film premieres for 24 hours, and the next capsule starts right away
function reveal(scr) {
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  const c = concepts.find((x) => x.id === id);
  if (!wrap || !c) return;
  wrap.innerHTML = withHome('released', () => screen(c, dataFor(id)));
  wrap.querySelector('.st-card')?.classList.add('fx-in');
}

// Play: ① you press the shutter and seal → ② this capsule ends and the film premieres
const TIMERS = {};
function setStep(id, text) {
  const el = $('step-' + id);
  if (el) el.textContent = text;
}
function playStory(id) {
  resetCard(id);
  const scrOf = () => document.querySelector(`.card[data-id="${id}"] .screen`);
  const later = (ms, fn) => (TIMERS[id] ||= []).push(setTimeout(fn, ms));
  setStep(id, t('step.1'));
  later(500, () => {
    const scr = scrOf();
    const btn = scr?.querySelector('.shutter');
    if (!scr || !btn) return;
    btn.classList.add('press');
    sealFlight(scr, btn, () =>
      later(1500, () => {
        setStep(id, t('step.2'));
        const s2 = scrOf();
        if (s2) reveal(s2);
        later(3000, () => setStep(id, t('step.done')));
      }),
    );
  });
}
function resetCard(id) {
  (TIMERS[id] || []).forEach(clearTimeout);
  TIMERS[id] = [];
  delete STORY[id];
  const w = document.querySelector(`.card[data-id="${id}"] .phone-wrap`);
  if (w) {
    delete w.dataset.tab;
    delete w.dataset.home;
  }
  renderCard(id);
  setStep(id, '');
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.play) {
    // Play demos a collecting capsule: return to the normal state first
    if (NAV.home !== 'collect') window.setHome?.('collect');
    return playStory(t.dataset.play);
  }
  if (t.id === 'shuffle') {
    const bag = [0, 0, 1, 1, 2, 2, 3, 4, 5];
    POOL.forEach((p) => {
      p.c = bag[Math.floor(Math.random() * bag.length)];
      delete p.clips;
    });
    clearStories();
    render();
    return window.relangMix?.();
  }
  if (t.id === 'replay') return playIntro();
  if (t.id === 'restore') {
    POOL.forEach((p, i) => {
      p.c = DEFAULT_C[i];
      delete p.clips;
    });
    // If the sample group started a new capsule, reset it to the sample too
    const s = typeof SET === 'undefined' ? null : SET.list.find((g) => g.sample);
    if (s) {
      delete s.cyc;
      delete s.clips;
    }
    clearStories();
    render();
    return window.relangMix?.();
  }
  const scr = t.closest('.screen');
  if (!scr) return;
  // Avatar → Settings; "Watch together" after the reveal → Sunday film (see screens.js)
  if (t.classList.contains('me')) return openSub(scr, 'settings');
  if (t.classList.contains('wt')) {
    SEEN.archive = true;
    return openSub(scr, 'film');
  }
  if (t.hasAttribute('data-open-mine')) return openSub(scr, 'mine');
  // Dock tabs: Home, Chat, Archive (Chat and Archive are in tabs.js)
  if (t.dataset.tabGo) {
    const k = t.dataset.tabGo;
    if (k === scr.dataset.tab) return;
    const o = {};
    // Entering Chat with unread: draw a "3 new messages" divider before the new messages
    if (k === 'chat' && unreadNow()) {
      o.fresh = true;
      SEEN.chat = true;
    }
    if (k === 'archive' && scr.dataset.home === 'released') SEEN.archive = true;
    return goTab(scr, k, o);
  }
  if (t.classList.contains('shutter')) {
    // Unavailable shutter: a small shake for "no", then briefly explain why above the shutter
    if (t.getAttribute('aria-disabled') === 'true') {
      t.classList.remove('nope');
      void t.offsetWidth;
      t.classList.add('nope');
      return t.dataset.tip && flashTip(t, t.dataset.tip);
    }
    // Shutter → camera (photo / video); returns to Home after sealing
    openSub(scr, 'camera');
  }
});
$('zoom').addEventListener('input', (e) => setZoom(e.target.value));
$('hints').addEventListener('change', (e) =>
  $('gallery').classList.toggle('hints', e.target.checked),
);
// Group size: Home doesn't show it, so redraw the current tab (states, screens) too
$('members').addEventListener('input', (e) => {
  size = Number(e.target.value);
  $('membersv').textContent = t('members.unit', { n: size });
  clearStories();
  render();
  window.relangMix?.();
});

applyI18n();
$('membersv').textContent = t('members.unit', { n: size });
render();
setZoom($('zoom').value);
playIntro();
