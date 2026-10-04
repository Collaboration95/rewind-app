'use strict';

/* ---------- Home states ----------
   Match dev's Home summary and premiere flow (collecting quota, NotFound / RecoverableFailure / MembershipDenied,
   moment processing failure, compiling / delayed / released). Copy is draft.
   · Quota: 5 moments or 30 s, whichever runs out first; resets every 7 days.
   · When a capsule ends the next starts right away: while the film is compiling, delayed or premiering, Home is already the new capsule, the shutter works as usual,
     with an extra status card on top.
   · No capsule: the owner can start one; members can only wait for the owner. */
const HOME_STATES = [
  'collect',
  'quota',
  'secs',
  'failed',
  'developing',
  'delayed',
  'released',
  'empty',
  'waiting',
  'error',
  'denied',
  'nogroup',
];
// No shutter in these states (no capsule, loading failed, not in the group, no group yet): rather than a greyed-out button, remove it
const SHUTTER_OFF = ['empty', 'waiting', 'error', 'denied', 'nogroup'];
NAV.home = 'collect';
// Shutter for each state: greyed out when the quota is used up, otherwise as usual
const shutterOf = (state) => (state === 'quota' || state === 'secs' ? 'quota' : 'collect');

// A breathing warm glow; state class names switch its animation and visibility
const motif = () => `<div class="mo mo-glow" aria-hidden="true"><i></i><b></b></div>`;

function stateCopy() {
  const waiting = { title: 'No capsule yet', body: 'Waiting for the owner to start one.' };
  return {
    // Only the owner can start; members see "waiting for the owner"
    empty:
      typeof isOwner === 'function' && !isOwner()
        ? waiting
        : {
            title: 'No capsule yet',
            body: 'Start one and your group’s 4 weeks begin.',
            action: 'Start a capsule',
            start: true,
          },
    waiting,
    // Just signed up, no group yet: join with an invite code or create one
    nogroup: {
      title: 'You’re not in a group yet',
      body: 'Join friends with their invite code, or start a group of your own.',
      action: 'Join with a code',
      go: 'join',
      alt: 'Create a group',
      altGo: 'create',
    },
    error: {
      title: 'Couldn’t load',
      body: 'Check your connection and try again.',
      action: 'Try again',
      retry: true,
    },
    denied: {
      title: 'You’re not in this group',
      body: 'Ask a friend to invite you again.',
      action: 'Choose another group',
      pick: true,
    },
    // The ones below are a status card at the top of Home
    failed: {
      title: 'A moment didn’t finish',
      body: 'Retry it, or delete it and retake.',
      fix: true,
    },
    developing: {
      title: 'Your film is developing',
      body: 'The last 4 weeks, ready soon.',
      progress: true,
    },
    delayed: {
      title: 'Taking a little longer',
      body: 'Everyone hears when it’s ready.',
      progress: true,
    },
    released: { title: 'Your film is here', body: 'Premiere · 18 h left', watch: true },
  }[NAV.home];
}

// Status card at the top of Home: premiere, compiling, processing failure
function stateCard() {
  const s = stateCopy();
  return (
    `<section class="glass st-card" role="status"><div class="st-ct"><b>${s.title}</b><span>${s.body}</span></div>` +
    (s.progress
      ? `<span class="st-bar" role="progressbar" aria-label="Developing"><i></i></span>`
      : '') +
    (s.watch
      ? `<button type="button" class="wt"><span class="wt-i">${ic('play')}</span>Watch</button>`
      : '') +
    (s.fix ? `<button type="button" class="st-mini" data-st-retry>Retry</button>` : '') +
    `</section>`
  );
}

// 3 moments use up the 30 s
const SECS_CLIPS = [
  ['video', 15, 'Mon'],
  ['video', 12, 'Wed'],
  ['photo', 3, 'Thu'],
];
// "Your moments this week" in this state: shared by Home and the "Your moments" page so both match
function homeClips(id, d) {
  const pool = STORY[id] || POOL;
  if (NAV.home === 'quota') return CLIPS0;
  if (NAV.home === 'secs') return SECS_CLIPS;
  // New capsule: start from 0 moments; moments newly sealed on this phone still count
  if (NEW_CYCLE.includes(NAV.home) && !snap()) return clipsOf(pool[0]).slice(POOL[0].c);
  return clipsOf(d.me);
}

function stateBody(c, d) {
  // Swap in data where "your moments this week" is list
  const mine = (list) => {
    const me = { ...d.me, c: list.length, clips: list };
    return { ...d, me, members: [me, ...d.members.slice(1)] };
  };
  if (NAV.home === 'quota' || NAV.home === 'secs') return bodies[c.id](mine(homeClips(c.id, d)));
  if (NAV.home === 'failed') return bodies[c.id](d, { card: stateCard() });
  if (NEW_CYCLE.includes(NAV.home))
    return bodies[c.id](mine(homeClips(c.id, d)), { card: stateCard() });
  // No capsule / loading failed / not in the group: replace the body, keep the header
  const full = bodies[c.id](d);
  const at = full.indexOf('<header class="top"');
  const end = full.indexOf('</header>', at) + '</header>'.length;
  const head = at < 0 ? '' : full.slice(0, end);
  const s = stateCopy();
  return (
    head +
    `<section class="st" aria-live="polite">${motif()}` +
    `<h2 class="st-h">${s.title}</h2><p class="st-p">${s.body}</p>` +
    (s.action
      ? `<button type="button" class="st-btn${s.go ? ' primary' : ''}"${s.retry ? ' data-st-retry' : ''}${s.pick ? ' data-gm-open' : ''}${s.start ? ' data-st-start' : ''}${s.go ? ` data-gm-go="${s.go}"` : ''}>${s.action}</button>`
      : '') +
    (s.alt
      ? `<button type="button" class="st-btn st-alt" data-gm-go="${s.altGo}">${s.alt}</button>`
      : '') +
    `</section>`
  );
}

// Whether this state has a shutter (function declaration; app.js calls it via window)
function shutterOff() {
  return SHUTTER_OFF.includes(NAV.home);
}

// Switch Home state and sync the shutter state with it
function setHome(v) {
  NAV.home = HOME_STATES.includes(v) ? v : 'collect';
  SEEN.archive = false;
  NAV.shutter = shutterOf(NAV.home);
  clearStories();
  render();
  window.relangMix?.();
}

// Start a capsule (owner): this group starts at week 1, 28 days, 0 moments
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-st-start]')) return;
  if (e.target.closest('#states-view')) return rvToast(t('sts.startToast'));
  Object.assign(grp(), { cyc: { week: 1, days: 28, reset: 7 }, clips: [], c: 0 });
  setHome('collect');
  rvToast(t('scr.toast.started'));
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-st-retry]')) return;
  // On the states page it only explains; it doesn't change other pages' state
  if (e.target.closest('#states-view')) return rvToast(t('sts.retryToast'));
  // Demo "Retry": go straight back to the normal Home
  setHome('collect');
});

/* ---------- States page: all states side by side ---------- */
// Draw a phone in the given state without affecting the state chosen in the sidebar
function withHome(state, fn) {
  const keep = { home: NAV.home, shutter: NAV.shutter };
  NAV.home = state;
  NAV.shutter = shutterOf(state);
  try {
    return fn();
  } finally {
    Object.assign(NAV, keep);
  }
}
function svPhone(state) {
  const c = concepts[0];
  const html = withHome(state, () => pureIf(true, () => screen(c, dataFor(c.id))));
  return (
    `<figure class="sv-ph" data-state="${state}"><div class="card sv-card" data-id="${c.id}"><div class="phone-wrap">${html}</div></div>` +
    `<figcaption><b>${t('state.' + state)}</b><span>${t('sts.when.' + state)}</span>` +
    `<span><em>${t('sts.shut')}</em> ${t('sts.shut.' + state)}</span></figcaption></figure>`
  );
}

const statesHash = () => '#states';
const readStatesHash = () => /^#states(=.*)?$/.test(location.hash);

function renderStatesView() {
  const root = $('states-view');
  if (!root) return;
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('sts.k')}</p><h1>${t('sts.h1')}</h1><p>${t('sts.p')}</p></header>` +
    // The Collecting phone can trigger a few events on its own to show the animations
    `<div class="sv-ev" role="group"><span>${t('sts.ev')}</span>` +
    ['seal', 'reveal', 'reset']
      .map((k) => `<button type="button" data-sv-ev="${k}">${t('sts.ev.' + k)}</button>`)
      .join('') +
    `</div>` +
    `<div class="sv-grid">${HOME_STATES.map(svPhone).join('')}</div>`;
  try {
    if (document.body.classList.contains('view-states'))
      history.replaceState(null, '', statesHash());
  } catch {
    /* Fine if a sandboxed frame can't change the address bar */
  }
}

// Event buttons: act on the "Collecting" phone on the states page
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sv-ev]');
  if (!b) return;
  const ev = b.dataset.svEv;
  const scr = document.querySelector('#states-view [data-state="collect"] .screen');
  if (!scr) return;
  if (ev === 'reset') {
    delete STORY[scr.classList[1]];
    return renderStatesView();
  }
  if (ev === 'reveal') return reveal(scr);
  if (ev === 'seal') {
    const btn = scr.querySelector('.shutter');
    if (!btn) return;
    btn.classList.remove('press');
    void btn.offsetWidth;
    btn.classList.add('press');
    sealFlight(scr, btn);
  }
});

// If the URL is #states… on load, go straight to the states page
const openStatesFromHash = () => {
  if (readStatesHash()) setView('states');
};
openStatesFromHash();
addEventListener('load', openStatesFromHash);
addEventListener('hashchange', openStatesFromHash);
