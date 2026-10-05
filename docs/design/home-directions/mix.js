'use strict';

/* ---------- App icon: Campfire, where people meet it ----------
   The launch screen opening into Warm Glass Home, the home screen, small sizes and a notification. */

const WARM = { bg: '#fff3e2', ink: '#3a2a22' };
// Two plain wallpapers so the wallpaper colour doesn't sway the choice
const WALLS = {
  light: 'linear-gradient(160deg, #fbfbfa, #e8e8e5)',
  dark: 'linear-gradient(160deg, #1f1f21, #000)',
};

// Other apps on the home screen: simplified common icons, only for context
const APP_ICONS = {
  gmail:
    '<rect width="60" height="60" fill="#fff"/><rect x="11" y="20" width="8" height="24" rx="2" fill="#4285F4"/><rect x="41" y="20" width="8" height="24" rx="2" fill="#34A853"/><path d="M14 22l16 12 16-12" fill="none" stroke="#EA4335" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="45" cy="21" r="3.5" fill="#FBBC04"/>',
  maps: '<rect width="60" height="60" fill="#f1f3f4"/><path d="M0 44 44 0h16v8L8 60H0z" fill="#fce8a6"/><path d="M0 22 22 0h9L0 31z" fill="#cde8cf"/><path d="M36 11a11 11 0 0 1 11 11c0 9-11 22-11 22S25 31 25 22a11 11 0 0 1 11-11z" fill="#EA4335"/><circle cx="36" cy="22" r="4" fill="#a50e0e"/>',
  chrome:
    '<rect width="60" height="60" fill="#fff"/><path d="M30 30 12.7 20A20 20 0 0 1 47.3 20z" fill="#EA4335"/><path d="M30 30 47.3 20A20 20 0 0 1 30 50z" fill="#FBBC04"/><path d="M30 30V50A20 20 0 0 1 12.7 20z" fill="#34A853"/><circle cx="30" cy="30" r="9" fill="#fff"/><circle cx="30" cy="30" r="7" fill="#4285F4"/>',
  youtube:
    '<rect width="60" height="60" fill="#fff"/><rect x="11" y="17" width="38" height="26" rx="8" fill="#FF0000"/><path d="M26 23v14l12-7z" fill="#fff"/>',
  whatsapp:
    '<rect width="60" height="60" fill="#25D366"/><circle cx="30" cy="29" r="15" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M15 46l3-10 7 6z" fill="#fff"/><path d="M24 22c0 8 6 14 14 14l2-3-4-2-2 2c-3-1-5-3-6-6l2-2-2-4z" fill="#fff"/>',
  instagram:
    '<defs><linearGradient id="mx-ig" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".5" stop-color="#d62976"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs><rect width="60" height="60" fill="url(#mx-ig)"/><rect x="15" y="15" width="30" height="30" rx="9" fill="none" stroke="#fff" stroke-width="3.5"/><circle cx="30" cy="30" r="7" fill="none" stroke="#fff" stroke-width="3.5"/><circle cx="39.5" cy="20.5" r="2" fill="#fff"/>',
  spotify:
    '<rect width="60" height="60" fill="#121212"/><circle cx="30" cy="30" r="19" fill="#1DB954"/><g fill="none" stroke="#121212" stroke-linecap="round"><path d="M19 24c8-3 17-2 23 2" stroke-width="3.5"/><path d="M20 31c7-2 14-1 19 2" stroke-width="3"/><path d="M21 37c5-1 11-1 15 2" stroke-width="2.5"/></g>',
  photos:
    '<rect width="60" height="60" fill="#fff"/>' +
    ['#f5a623', '#f8d81c', '#7ed321', '#3ec7b1', '#4a90e2', '#8e44ec', '#e91e63', '#ff5722']
      .map(
        (c, i) =>
          `<ellipse cx="30" cy="19" rx="5.5" ry="9.5" fill="${c}" opacity=".85" transform="rotate(${i * 45} 30 30)"/>`,
      )
      .join(''),
  camera:
    '<rect width="60" height="60" fill="#d8d8d8"/><rect x="11" y="20" width="38" height="25" rx="5" fill="#3a3a3c"/><rect x="23" y="16" width="14" height="6" rx="2" fill="#3a3a3c"/><circle cx="30" cy="32" r="8" fill="#8e8e93"/><circle cx="30" cy="32" r="5" fill="#1c1c1e"/>',
  calendar:
    '<rect width="60" height="60" fill="#fff"/><text x="30" y="18" text-anchor="middle" font-family="Inter,sans-serif" font-size="8" font-weight="600" fill="#ff3b30">WED</text><text x="30" y="45" text-anchor="middle" font-family="Inter,sans-serif" font-size="26" fill="#111">30</text>',
  settings:
    '<rect width="60" height="60" fill="#8e8e93"/><circle cx="30" cy="30" r="15" fill="none" stroke="#d1d1d6" stroke-width="6" stroke-dasharray="4 3.2"/><circle cx="30" cy="30" r="11" fill="#636366"/><circle cx="30" cy="30" r="5" fill="#8e8e93"/>',
  phone:
    '<rect width="60" height="60" fill="#34C759"/><path d="M21 17c2-1 4 0 5 2l2 5c0 2-1 3-3 4 1 4 4 7 8 8 1-2 2-3 4-3l5 2c2 1 3 3 2 5-1 3-4 4-7 4-10-1-18-9-19-19 0-3 1-6 3-8z" fill="#fff"/>',
  safari:
    '<rect width="60" height="60" fill="#fff"/><circle cx="30" cy="30" r="20" fill="#1a8cff"/><path d="M39 21l-7 11-4-4z" fill="#ff3b30"/><path d="M21 39l7-11 4 4z" fill="#fff"/>',
  messages:
    '<rect width="60" height="60" fill="#34C759"/><ellipse cx="30" cy="28" rx="16" ry="13" fill="#fff"/><path d="M17 41l3-7 6 3z" fill="#fff"/>',
  music:
    '<rect width="60" height="60" fill="#fc3c44"/><path d="M26 40V20l14-3v18" fill="none" stroke="#fff" stroke-width="3.5"/><circle cx="23" cy="40" r="4" fill="#fff"/><circle cx="37" cy="36" r="4" fill="#fff"/>',
};
const appIcon = (k, size) =>
  `<span class="mx-icon" style="width:${size}px;height:${size}px"><svg viewBox="0 0 60 60">${APP_ICONS[k]}</svg></span>`;

let mix = { wall: 'light' };
// The same icon shows many times on the page: the svg has no size, the wrapper sets it
const iconHTML = (size, cls = '') =>
  `<span class="mx-icon ${cls}" style="width:${size}px;height:${size}px">${APP_ICON.svg}</span>`;

const mixHash = () => '#mix';
const readHash = () => /^#mix(=.*)?$/.test(location.hash);

/* ---------- Page tabs ---------- */
const VIEWS = ['final', 'states', 'screens', 'mix'];
function setView(v) {
  const view = VIEWS.includes(v) ? v : 'home';
  VIEWS.forEach((k) => document.body.classList.toggle('view-' + k, view === k));
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  rerenderView();
  try {
    history.replaceState(
      null,
      '',
      {
        mix: mixHash,
        states: () => statesHash(), // states.js
        screens: () => '#screens',
        final: () => '#final',
      }[view]?.() || location.pathname + location.search,
    );
  } catch {
    /* sandboxed frames can't change the address bar */
  }
}
// Redraw whichever tab is showing (group size, shuffle and reset call this)
function rerenderView() {
  const on = (k) => document.body.classList.contains('view-' + k);
  if (on('mix')) renderMix();
  if (on('states')) window.renderStatesView?.();
  if (on('screens')) window.renderScreensView?.();
  if (on('final')) window.renderFinalView?.();
}
const relangMix = rerenderView;

/* ---------- Drawing ---------- */
const APP_NAMES = {
  gmail: 'Gmail',
  maps: 'Maps',
  chrome: 'Chrome',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  spotify: 'Spotify',
  photos: 'Photos',
  camera: 'Camera',
  calendar: 'Calendar',
  settings: 'Settings',
};
function homeScreenHTML() {
  const apps = [
    'gmail',
    'maps',
    'chrome',
    'youtube',
    'whatsapp',
    'rewind',
    'instagram',
    'spotify',
    'photos',
    'camera',
    'calendar',
    'settings',
  ];
  const cell = (a) =>
    a === 'rewind'
      ? `<figure class="me">${iconHTML(52)}<figcaption>Rewind</figcaption></figure>`
      : `<figure>${appIcon(a, 52)}<figcaption>${APP_NAMES[a]}</figcaption></figure>`;
  const walls = Object.keys(WALLS)
    .map(
      (w) =>
        `<button type="button" data-mx-wall="${w}" aria-pressed="${mix.wall === w}" style="background:${WALLS[w]}" aria-label="${w === 'light' ? 'Light' : 'Dark'} wallpaper"></button>`,
    )
    .join('');
  return (
    `<div class="mx-home ${mix.wall}" style="background:${WALLS[mix.wall]}"><div class="mx-status">9:41</div><div class="mx-apps">${apps.map(cell).join('')}</div>` +
    `<div class="mx-dock">${['phone', 'safari', 'messages', 'music'].map((a) => appIcon(a, 52)).join('')}</div></div>` +
    `<div class="mx-walls" role="group" aria-label="Wallpaper">${walls}</div>`
  );
}

// The launch screen sits inside the screen, so it is clipped by the screen corners
const splashHTML = (size = 190) =>
  `<div class="mx-splash" style="background:${WARM.bg}">${iconHTML(size)}<span style="color:${WARM.ink}">Rewind</span></div>`;
function phoneHTML() {
  const c = concepts[0];
  const phone = screen(c, dataFor(c.id)).replace(/<\/div><\/div>$/, splashHTML() + '</div></div>');
  return (
    `<div class="card mx-phone" data-id="${c.id}"><div class="phone-wrap">${phone}</div></div>` +
    `<button type="button" class="ghost mx-replay" data-mx-replay>Replay the launch</button>`
  );
}

let splashTimer;
function playSplash() {
  const s = document.querySelector('#mix .mx-splash');
  if (!s) return;
  // Hide Home while the launch screen shows, so Home's motion layers don't paint over it
  const scr = s.closest('.screen');
  scr.classList.add('splashing');
  s.classList.remove('gone');
  clearTimeout(splashTimer);
  splashTimer = setTimeout(
    () => {
      scr.classList.remove('splashing');
      s.classList.add('gone');
    },
    reduceMotion() ? 0 : 1300,
  );
}

function renderMix() {
  const root = $('mix');
  if (!root) return;
  root.innerHTML =
    `<header class="main-h"><p class="k">APP ICON</p><h1>${APP_ICON.name}</h1><p>${APP_ICON.note} Here it is on the launch screen, the home screen, in small sizes and in a notification.</p></header>` +
    `<div class="mx-grid"><aside class="mx-pick">${iconHTML(180)}` +
    `<p class="lbl">For the App Store</p><p class="hint">Export as a 1024 × 1024 PNG: square, no transparency and no rounded corners, since iOS rounds it. Outline the shapes; the svg in icons.js is the source.</p></aside>` +
    `<div class="mx-stage">` +
    `<div class="mx-row"><section class="mx-block"><p class="lbl">Launch → Home</p>${phoneHTML()}</section>` +
    `<section class="mx-block"><p class="lbl">On the home screen</p>${homeScreenHTML()}` +
    `<p class="lbl">Sizes</p><div class="mx-sizerow">${[
      [120, 'App Store'],
      [60, 'Home screen'],
      [40, 'Spotlight'],
      [29, 'Settings'],
    ]
      .map(([s, l]) => `<figure>${iconHTML(s)}<figcaption>${s} px · ${l}</figcaption></figure>`)
      .join('')}</div>` +
    `<p class="lbl">Notification</p><div class="mx-notif">${iconHTML(38)}<div><b>Rewind</b><span>It’s Sunday. Add a moment before the week resets.</span></div><em>now</em></div>` +
    `</section></div></div></div>`;
  playSplash();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-view],[data-mx-wall],[data-mx-replay]');
  if (!b) return;
  const d = b.dataset;
  if (d.view) return setView(d.view);
  if (d.mxWall) {
    mix.wall = d.mxWall;
    return renderMix();
  }
  if ('mxReplay' in d) return playSplash();
});

// Opening with #mix… goes straight to this tab (htmlpreview settles late, so check again on load)
const openMixFromHash = () => {
  if (readHash()) setView('mix');
};
openMixFromHash();
addEventListener('load', openMixFromHash);
addEventListener('hashchange', openMixFromHash);
