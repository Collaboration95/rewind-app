'use strict';

/* ---------- 首页状态：加载、空、失败、无权限、额度用完、影片制作、延迟、已上映 ----------
   与 dev 上 CapsuleSummary / 揭晓流程的状态一一对应（loading / empty / error / denied、
   collecting 的额度、compiling / delayed / released）。文案是草稿。
   每个状态沿用方向自己的页头和配色，顶部一个按方向隐喻画的小插图随状态变化。 */
const HOME_STATES = [
  'collect',
  'loading',
  'empty',
  'error',
  'denied',
  'quota',
  'developing',
  'delayed',
  'released',
];
// 这些状态下快门不可用（加载中、没有这一期、看不到、影片在做）
const SHUTTER_OFF = ['loading', 'empty', 'error', 'denied', 'developing', 'delayed'];
NAV.home = 'collect';

// 各方向的插图：一张图，靠状态类名切换动画和显隐
function motif(id) {
  if (id === 'c7')
    return (
      `<svg class="mo mo-hearth" viewBox="0 0 200 150" aria-hidden="true">` +
      `<circle class="mo-seats" cx="100" cy="80" r="58" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="51 22" transform="rotate(-72 100 80)"/>` +
      `<g class="mo-flame"><path d="M100 36c12 16 28 30 28 52a28 28 0 0 1-56 0c0-14 7-22 14-30 2 10 7 14 11 14-4-15-1-26 3-36z"/>` +
      `<path class="mo-core" d="M100 76c7 8 13 14 13 24a13 13 0 0 1-26 0c0-7 4-11 8-15 1 4 3 6 5 6-1-6 0-11 0-15z"/></g>` +
      `<g class="mo-ash"><circle cx="88" cy="104" r="4"/><circle cx="100" cy="108" r="5"/><circle cx="112" cy="104" r="4"/></g>` +
      `<path class="mo-smoke" d="M100 96c-8-10 8-16 0-26s8-16 0-26" fill="none" stroke-width="3" stroke-linecap="round"/></svg>`
    );
  if (id === 'c9')
    return (
      `<svg class="mo mo-jar" viewBox="0 0 200 150" aria-hidden="true">` +
      `<rect class="mo-lid" x="74" y="14" width="52" height="12" rx="4"/>` +
      `<path class="mo-glass" d="M80 28h40c14 0 24 10 24 24v62c0 14-10 24-24 24H80c-14 0-24-10-24-24V52c0-14 10-24 24-24z"/>` +
      [
        [86, 70],
        [112, 56],
        [124, 90],
        [94, 108],
        [76, 92],
        [108, 80],
        [118, 116],
        [70, 60],
      ]
        .map(
          ([x, y], i) =>
            `<circle class="mo-ff f${i}" cx="${x}" cy="${y}" r="4.5" style="animation-delay:${(i * 0.37).toFixed(2)}s"/>`,
        )
        .join('') +
      `</svg>`
    );
  if (id === 'c10')
    return (
      `<svg class="mo mo-film" viewBox="0 0 200 150" aria-hidden="true">` +
      `<path class="mo-beam" d="M94 140h12l52-62H42z"/>` +
      `<rect class="mo-scr" x="36" y="10" width="128" height="72" rx="6"/>` +
      `<g class="mo-leader"><circle cx="100" cy="46" r="24" fill="none" stroke-width="2.5"/><path d="M100 22v48M76 46h48" stroke-width="1.5"/>` +
      `<text x="100" y="56" text-anchor="middle"><tspan class="mo-n mo-n3">3</tspan><tspan class="mo-n mo-n2" x="100">2</tspan><tspan class="mo-n mo-n1" x="100">1</tspan></text></g>` +
      `<g class="mo-play"><path d="M98 32l-14 14 14 14M118 32l-14 14 14 14" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g>` +
      `<g class="mo-reel"><circle cx="100" cy="122" r="14" fill="none" stroke-width="3"/>` +
      `<circle cx="100" cy="113" r="2.6"/><circle cx="108" cy="125" r="2.6"/><circle cx="92" cy="125" r="2.6"/></g></svg>`
    );
  // 暖光玻璃，以及没有专门插图的方向：一团会呼吸的暖光
  return `<div class="mo mo-glow" aria-hidden="true"><i></i><b></b></div>`;
}

function stateCopy(d) {
  return {
    loading: { title: '', body: 'Loading…' },
    empty: {
      title: 'No capsule this week',
      body: 'When the owner starts one, it opens here.',
      action: 'Start a capsule',
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
    },
    developing: { title: 'Your film is developing', body: 'Opens Sunday 8 PM.', progress: true },
    delayed: { title: 'Taking a little longer', body: 'Still developing.', progress: true },
    released: {
      title: 'Your film is here',
      body: `${plural(d.m, 'moment')} · 2 min 14 s`,
      action: 'Watch together',
      primary: true,
    },
  }[NAV.home];
}

// 换掉首页正文：保留方向自己的页头（头像、组名、周数）和页头前的背景装饰
function stateBody(c, d) {
  // 额度用完：你自己的条数按 5 条画，和顶部提示对得上
  if (NAV.home === 'quota')
    d = data((STORY[c.id] || POOL).map((x, i) => (i === 0 ? { ...x, c: 5 } : x)));
  const full = bodies[c.id](d);
  const at = full.indexOf('<header class="top"');
  const end = full.indexOf('</header>', at) + '</header>'.length;
  const head = at < 0 ? '' : full.slice(0, end);
  if (NAV.home === 'quota')
    return (
      head + `<p class="st-banner" role="status">All 5 used · resets Sunday</p>` + full.slice(end)
    );
  const s = stateCopy(d);
  if (NAV.home === 'loading')
    return (
      head +
      `<section class="st st-load" aria-busy="true">${motif(c.id)}` +
      `<span class="sk sk-k"></span><span class="sk sk-h"></span><span class="sk sk-h2"></span>` +
      `<span class="sk sk-card"></span><span class="sk sk-row"></span><span class="sk sk-row"></span>` +
      `<p class="st-cap" role="status">${s.body}</p></section>`
    );
  return (
    head +
    `<section class="st" aria-live="polite">${motif(c.id)}` +
    (s.kicker ? `<p class="st-k">${s.kicker}</p>` : '') +
    `<h2 class="st-h">${s.title}</h2><p class="st-p">${s.body}</p>` +
    (s.progress
      ? `<span class="st-bar" role="progressbar" aria-label="Developing"><i></i></span>`
      : '') +
    (s.action
      ? `<button type="button" class="st-btn${s.primary ? ' primary' : ''}"${s.retry ? ' data-st-retry' : ''}>${s.primary ? ic('play') : ''}${s.action}</button>`
      : '') +
    (s.note ? `<p class="st-note">${s.note}</p>` : '') +
    `</section>`
  );
}

// 快门不可用时的样子与说明（返回 null 表示照常）
function shutterOff() {
  if (!SHUTTER_OFF.includes(NAV.home)) return null;
  const why = {
    loading: ['Loading', ''],
    empty: ['No capsule to add to', ''],
    error: ['Capture unavailable', ''],
    denied: ['Capture unavailable', ''],
    developing: ['Capture is closed while the film develops', 'Closed · developing'],
    delayed: ['Capture is closed while the film develops', 'Closed · developing'],
  }[NAV.home];
  return [ring(0), 'camera', why[0], why[1]];
}

// 切换首页状态：顺带把快门状态对上（额度用完、首映）
function setHome(v) {
  NAV.home = HOME_STATES.includes(v) ? v : 'collect';
  NAV.shutter = NAV.home === 'quota' ? 'quota' : NAV.home === 'released' ? 'premiere' : 'collect';
  if ($('state')) $('state').value = NAV.home;
  if ($('shutter-state')) $('shutter-state').value = NAV.shutter;
  clearStories();
  render();
  window.relangMix?.();
}

let retryTimer;
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-st-retry]')) return;
  // 状态页里只说明，不改动其他页的状态
  if (e.target.closest('#states-view')) return rvToast(t('sts.retryToast'));
  // 演示“重试”：先显示加载，再恢复正常
  setHome('loading');
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => setHome('collect'), reduceMotion() ? 300 : 1600);
});
$('state')?.addEventListener('change', (e) => setHome(e.target.value));

/* ---------- 状态页：按状态看（一个状态、各方向并排）/ 按方向看（一个方向、全部状态） ---------- */
// arch：状态页自己的“含废案”开关，默认关，和侧栏的设置无关
let sv = { by: 'state', state: 'loading', dir: 'c9', arch: false };

// 用指定的状态画一台手机，不影响侧栏里选的状态
function withHome(state, fn) {
  const keep = { home: NAV.home, shutter: NAV.shutter };
  NAV.home = state;
  NAV.shutter = state === 'quota' ? 'quota' : state === 'released' ? 'premiere' : 'collect';
  try {
    return fn();
  } finally {
    Object.assign(NAV, keep);
  }
}
function svPhone(id, state, label) {
  const c = concepts.find((x) => x.id === id);
  const html = withHome(state, () => screen(c, dataFor(id)));
  return `<figure class="sv-ph"><div class="card sv-card" data-id="${id}"><div class="phone-wrap">${html}</div></div><figcaption>${label}</figcaption></figure>`;
}

const statesHash = () => `#states=${sv.by === 'state' ? sv.state : sv.dir}`;
function readStatesHash() {
  const m = /^#states(?:=(.+))?$/.exec(location.hash);
  if (!m) return false;
  if (HOME_STATES.includes(m[1])) Object.assign(sv, { by: 'state', state: m[1] });
  else if (concepts.some((c) => c.id === m[1]))
    Object.assign(sv, { by: 'dir', dir: m[1], arch: sv.arch || isArchived(m[1]) });
  return true;
}

function renderStatesView() {
  const root = $('states-view');
  if (!root) return;
  const dirs = concepts.filter((c) => !isArchived(c.id) || sv.arch);
  if (!dirs.some((c) => c.id === sv.dir)) sv.dir = dirs[0].id;
  const by = (k) =>
    `<button type="button" data-sv-by="${k}" aria-pressed="${sv.by === k}">${t('sts.by.' + k)}</button>`;
  const chips =
    sv.by === 'state'
      ? HOME_STATES.map(
          (s) =>
            `<button type="button" data-sv-state="${s}" aria-pressed="${sv.state === s}">${t('state.' + s)}</button>`,
        )
      : dirs.map(
          (c) =>
            `<button type="button" data-sv-dir="${c.id}" aria-pressed="${sv.dir === c.id}"><span>${c.no}</span>${nameOf(c)}</button>`,
        );
  const grid =
    sv.by === 'state'
      ? dirs.map((c) => svPhone(c.id, sv.state, `${c.no} ${nameOf(c)}`))
      : HOME_STATES.map((s) => svPhone(sv.dir, s, t('state.' + s)));
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('sts.k')}</p><h1>${t('sts.h1')}</h1><p>${t('sts.p')}</p></header>` +
    `<div class="sv-bar"><div class="sv-by" role="group" aria-label="${t('sts.h1')}">${by('state')}${by('dir')}</div>` +
    `<div class="sv-chips" role="group">${chips.join('')}</div>` +
    `<label class="check sv-arch" for="sv-arch"><input type="checkbox" id="sv-arch"${sv.arch ? ' checked' : ''} /> <span>${t('sts.arch', { n: ARCHIVED.length })}</span></label></div>` +
    (sv.by === 'state'
      ? `<dl class="sv-notes"><div><dt>${t('sts.when')}</dt><dd>${t('sts.when.' + sv.state)}</dd></div>` +
        `<div><dt>${t('sts.shut')}</dt><dd>${t('sts.shut.' + sv.state)}</dd></div></dl>`
      : '') +
    `<div class="sv-grid by-${sv.by}">${grid.join('')}</div>`;
  startFlies(root, {});
  try {
    if (document.body.classList.contains('view-states'))
      history.replaceState(null, '', statesHash());
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sv-by],[data-sv-state],[data-sv-dir]');
  if (!b) return;
  const d = b.dataset;
  if (d.svBy) sv.by = d.svBy;
  if (d.svState) sv.state = d.svState;
  if (d.svDir) sv.dir = d.svDir;
  renderStatesView();
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'sv-arch') return;
  sv.arch = e.target.checked;
  renderStatesView();
});

// 打开时如果网址是 #states…，直接进状态页
const openStatesFromHash = () => {
  if (readStatesHash()) setView('states');
};
openStatesFromHash();
addEventListener('load', openStatesFromHash);
addEventListener('hashchange', openStatesFromHash);
