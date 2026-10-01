'use strict';

/* ---------- 首页状态 ----------
   与 dev 的首页摘要和首映流程对应（collecting 的额度、NotFound / RecoverableFailure / MembershipDenied、
   片段处理失败、compiling / delayed / released）。文案是草稿。
   · 额度：5 段或 30 秒，哪个先用完都算用完，每 7 天重置。
   · 一期结束时下一期马上开始：影片制作中、比平时慢、首映时，首页已经是新一期，快门照常能用，
     上面多一张状态卡。
   · 没有这一期：组长能开始，组员只能等组长。 */
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
];
// 这些状态下不显示快门（没有这一期、读取失败、不在小组）：用不了的按钮不灰着摆在那里，直接拿掉
const SHUTTER_OFF = ['empty', 'waiting', 'error', 'denied'];
NAV.home = 'collect';
// 每个状态对应的快门：额度用完就灰掉，其余照常
const shutterOf = (state) => (state === 'quota' || state === 'secs' ? 'quota' : 'collect');

// 一团会呼吸的暖光，靠状态类名切换动画和显隐
const motif = () => `<div class="mo mo-glow" aria-hidden="true"><i></i><b></b></div>`;

function stateCopy() {
  return {
    empty: {
      title: 'No capsule yet',
      body: 'Start one and your group’s 4 weeks begin.',
      action: 'Start a capsule',
    },
    waiting: { title: 'No capsule yet', body: 'Waiting for the owner to start one.' },
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
    // 下面几种是首页上方的一张状态卡
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

// 首页上方的状态卡：首映、制作中、处理失败
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

function stateBody(c, d) {
  const pool = STORY[c.id] || POOL;
  // 换成“你这周的片段是 list”的数据
  const mine = (list) =>
    data(pool.map((x, i) => (i === 0 ? { ...x, c: list.length, clips: list } : x)));
  if (NAV.home === 'quota') return bodies[c.id](mine(CLIPS0));
  // 3 段就用完了 30 秒
  if (NAV.home === 'secs')
    return bodies[c.id](
      mine([
        ['video', 15, 'Mon'],
        ['video', 12, 'Wed'],
        ['photo', 3, 'Thu'],
      ]),
    );
  if (NAV.home === 'failed') return bodies[c.id](d, { card: stateCard() });
  // 新一期：从 0 段开始；在这台手机上新封存的照样算进去
  if (NEW_CYCLE.includes(NAV.home))
    return bodies[c.id](mine(clipsOf(pool[0]).slice(POOL[0].c)), { card: stateCard() });
  // 没有这一期 / 读取失败 / 不在小组：换掉正文，保留页头
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
      ? `<button type="button" class="st-btn"${s.retry ? ' data-st-retry' : ''}${s.pick ? ' data-gm-open' : ''}>${s.action}</button>`
      : '') +
    `</section>`
  );
}

// 这个状态下有没有快门（函数声明，app.js 经 window 调用）
function shutterOff() {
  return SHUTTER_OFF.includes(NAV.home);
}

// 切换首页状态：顺带把快门状态对上
function setHome(v) {
  NAV.home = HOME_STATES.includes(v) ? v : 'collect';
  SEEN.archive = false;
  NAV.shutter = shutterOf(NAV.home);
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

/* ---------- 状态页：所有状态排在一起 ---------- */
// 用指定的状态画一台手机，不影响侧栏里选的状态
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
    ['seal', 'reveal', 'reset']
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

// 打开时如果网址是 #states…，直接进状态页
const openStatesFromHash = () => {
  if (readStatesHash()) setView('states');
};
openStatesFromHash();
addEventListener('load', openStatesFromHash);
addEventListener('hashchange', openStatesFromHash);
