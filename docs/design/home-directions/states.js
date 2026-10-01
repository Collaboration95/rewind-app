'use strict';

/* ---------- 首页状态：空、失败、无权限、额度用完、影片制作、延迟、已上映 ----------
   与 dev 上 CapsuleSummary / 揭晓流程的状态一一对应（empty / error / denied、
   collecting 的额度、compiling / delayed / released）。文案是草稿。
   每个状态沿用页头和配色，顶部一团暖光随状态变化。 */
const HOME_STATES = [
  'collect',
  'empty',
  'error',
  'denied',
  'quota',
  'developing',
  'delayed',
  'released',
];
// 这些状态下不显示快门（没有这一期、读取失败、不在小组、影片在做、已上映）：
// 一时用不了的按钮不灰着摆在那里，直接拿掉；已上映时“一起看”在正文里，不再放第二个入口
const SHUTTER_OFF = ['empty', 'error', 'denied', 'developing', 'delayed', 'released'];
NAV.home = 'collect';

// 一团会呼吸的暖光，靠状态类名切换动画和显隐
const motif = () => `<div class="mo mo-glow" aria-hidden="true"><i></i><b></b></div>`;

function stateCopy(d) {
  return {
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

// 换掉首页正文：保留页头（头像、组名、周数）和页头前的背景暖光
function stateBody(c, d) {
  // 额度用完：正文照常，你自己的条数按 5 条画；点灰掉的快门会提示原因（见 app.js）
  if (NAV.home === 'quota')
    return bodies[c.id](data((STORY[c.id] || POOL).map((x, i) => (i === 0 ? { ...x, c: 5 } : x))));
  const full = bodies[c.id](d);
  const at = full.indexOf('<header class="top"');
  const end = full.indexOf('</header>', at) + '</header>'.length;
  const head = at < 0 ? '' : full.slice(0, end);
  const s = stateCopy(d);
  return (
    head +
    `<section class="st" aria-live="polite">${motif()}` +
    `<h2 class="st-h">${s.title}</h2><p class="st-p">${s.body}</p>` +
    (s.progress
      ? `<span class="st-bar" role="progressbar" aria-label="Developing"><i></i></span>`
      : '') +
    (s.action
      ? `<button type="button" class="st-btn${s.primary ? ' primary' : ''}"${s.retry ? ' data-st-retry' : ''}>${s.primary ? ic('play') : ''}${s.action}</button>`
      : '') +
    `</section>`
  );
}

// 这个状态下有没有快门（函数声明，app.js 经 window 调用）
function shutterOff() {
  return SHUTTER_OFF.includes(NAV.home);
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

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-st-retry]')) return;
  // 状态页里只说明，不改动其他页的状态
  if (e.target.closest('#states-view')) return rvToast(t('sts.retryToast'));
  // 演示“重试”：直接回到正常的首页
  setHome('collect');
});
$('state')?.addEventListener('change', (e) => setHome(e.target.value));

/* ---------- 状态页：暖光玻璃的每个状态排在一起 ---------- */
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
function svPhone(state) {
  const c = concepts[0];
  const html = withHome(state, () => screen(c, dataFor(c.id)));
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
    // 收集中那台可以单独触发几个事件，看动画
    `<div class="sv-ev" role="group"><span>${t('sts.ev')}</span>` +
    ['join', 'seal', 'reveal', 'reset']
      .map((k) => `<button type="button" data-sv-ev="${k}">${t('sts.ev.' + k)}</button>`)
      .join('') +
    `</div>` +
    `<div class="sv-grid">${HOME_STATES.map(svPhone).join('')}</div>`;
  try {
    if (document.body.classList.contains('view-states'))
      history.replaceState(null, '', statesHash());
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}

// 事件按钮：作用在状态页里“收集中”那台手机上
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sv-ev]');
  if (!b) return;
  const ev = b.dataset.svEv;
  const scr = document.querySelector('#states-view .screen.st-collect');
  if (!scr) return;
  if (ev === 'reset') {
    delete STORY[scr.classList[1]];
    return renderStatesView();
  }
  if (ev === 'join') gatherFlight(scr);
  if (ev === 'reveal' && !scr.classList.contains('revealed')) reveal(scr);
  if (ev === 'seal') {
    const btn = scr.querySelector('.shutter');
    if (!btn) return;
    btn.classList.remove('press');
    void btn.offsetWidth;
    btn.classList.add('press');
    sealFlight(scr, btn);
  }
});

// 打开时如果网址是 #states…，直接进状态页
const openStatesFromHash = () => {
  if (readStatesHash()) setView('states');
};
openStatesFromHash();
addEventListener('load', openStatesFromHash);
addEventListener('hashchange', openStatesFromHash);
