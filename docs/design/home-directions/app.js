'use strict';

// 纯展示原型：不访问相机，只展示暖光玻璃首页的设计与交互。
const $ = (id) => document.getElementById(id);

const I = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z"/>',
  archive:
    '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V8.5M10 12h4"/>',
  camera:
    '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  chev: '<path d="m7 10 5 5 5-5"/>',
  swap: '<path d="M7 8h12l-3.5-3.5M17 16H5l3.5 3.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>',
  rewind: '<path d="M11.5 7 6.5 12l5 5M18 7l-5 5 5 5"/>',
  check: '<path d="m5.5 12.5 4.2 4.2L18.5 8"/>',
  play: '<path d="M8.5 5.8v12.4a.6.6 0 0 0 .9.5l10-6.2a.6.6 0 0 0 0-1l-10-6.2a.6.6 0 0 0-.9.5Z"/>',
};
// 底栏图标方案（底栏图标页临时换用）；null 时用上面的原版
let ICON_SET = null;
const ic = (n, cls = '') => {
  const o = ICON_SET?.icons?.[n];
  return `<svg class="ic ${cls}${o ? ' set-' + ICON_SET.style : ''}" viewBox="0 0 24 24" aria-hidden="true">${o || I[n]}</svg>`;
};

/* ---------- 共享数据：所有数字都从这里算，不写死 ---------- */
// 成员专属色（借鉴 Reveal：每人一种颜色，贯穿头像、额度环、影片字幕）
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
const secs = (c) => String([0, 4, 8, 13, 19, 26][c]).padStart(2, '0');

// 首页只显示你自己的额度（dev 的首页也是这样）；成员的 c 只用来模拟你的条数和片尾名单
function data(pool = POOL) {
  const members = pool.slice(0, size);
  return { members, n: members.length, m: members.reduce((s, x) => s + x.c, 0), me: members[0] };
}
// 一期 4 周，从小组开始那天算；额度每 7 天重置（dev 文档）。演示固定在第 2 周。
// 影片制作中、比平时慢、首映时，下一期已经开始了：第 1 周
const NEW_CYCLE = ['developing', 'delayed', 'released'];
const cyc = () =>
  NEW_CYCLE.includes(NAV.home) ? { week: 1, days: 27, reset: 7 } : { week: 2, days: 16, reset: 3 };

/* ---------- 共用部件 ---------- */
// 5 段额度环：已用的段点亮。
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
// 连续弧：首映剩余时间，或封存中的转圈
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

/* ---------- 底栏：玻璃底栏 + 快门状态 + 角标 ---------- */
const NAV = { shutter: 'collect', unread: true, home: 'collect' };

function shutter(d) {
  const left = 5 - d.me.c;
  const reset = plural(cyc().reset, 'day');
  // 没有这一期、读取失败、不在小组时没有快门（见 states.js）
  if (NAV.home !== 'collect' && window.shutterOff?.()) return '';
  // 5 段和 30 秒哪个先用完都算用完
  const secsOut = NAV.home === 'secs';
  // 第 4 项是点一下才短暂出现的提示，不常驻（常驻会挡住正文）
  const s = {
    collect: [ring(d.me.c), 'camera', `Add a moment · ${left} of 5 left`, ''],
    quota: [
      ring(5),
      'camera',
      secsOut
        ? `This week's 30 seconds are used · resets in ${reset}`
        : `This week's 5 moments are used · resets in ${reset}`,
      secsOut ? `30 s used · resets in ${reset}` : `All 5 used · resets in ${reset}`,
    ],
    upload: [arcRing(0.28, true), 'camera', 'Uploading your moment', 'Uploading…'],
    sealed: [
      ring(Math.min(5, d.me.c + 1)),
      'check',
      `Moment sealed · ${Math.max(0, left - 1)} of 5 left`,
      'Sealed',
    ],
  }[NAV.shutter];
  return (
    `<button type="button" class="shutter" aria-label="${s[2]}"${NAV.shutter === 'quota' ? ' aria-disabled="true"' : ''}${s[3] ? ` data-tip="${s[3]}"` : ''}>` +
    `${s[0]}<span class="core">${ic(s[1])}</span></button>`
  );
}

function dock(d) {
  // 不在这个小组里：聊天、档案、快门都属于这个小组，整个底栏不显示
  if (NAV.home === 'denied') return '';
  const tabs = [
    ['home', 'Home', '', ''],
    ['chat', 'Chat', NAV.unread ? '<i class="badge">3</i>' : '', NAV.unread ? ', 3 unread' : ''],
    [
      'archive',
      'Archive',
      NAV.home === 'released' ? '<i class="badge dot"></i>' : '',
      NAV.home === 'released' ? ', new film' : '',
    ],
  ];
  const tab = ([k, l, badge, extra], on) =>
    `<button type="button" class="tab${on ? ' on' : ''}" aria-label="${l}${extra}"${on ? ' aria-current="page"' : ''}><span class="ico">${ic(k)}${badge}</span><span class="tlbl">${l}</span></button>`;
  // 三个页签一直展开（Home / Chat / Archive），快门单独一颗
  return `<nav class="dock dock-g open" aria-label="Main navigation"><div class="tabs">${tabs.map((x, i) => tab(x, i === 0)).join('')}</div>${shutter(d)}</nav>`;
}

const acting = () => (typeof SET === 'undefined' ? POOL[0] : POOL[SET.me]);
const me = () =>
  `<button type="button" class="me" aria-label="${acting().name} · settings"><span class="avatar">${acting().name[0]}</span></button>`;

const bars = (cls, used, total = 5) =>
  `<div class="${cls}" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<i${i < used ? ' class="on"' : ''}></i>`).join('')}</div>`;

/* ---------- 首页正文 ---------- */
const bodies = {
  // o.card：首映、制作中、处理失败时放在页头下面的一张状态卡；o.secs：30 秒用完时的秒数
  c6: (d, o = {}) => {
    const k = cyc();
    const used = o.secs ?? Number(secs(Math.min(5, d.me.c)));
    const prompt =
      typeof promptText === 'function' ? promptText() : 'What made you pause and smile?';
    return `
    <div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="glow-low" aria-hidden="true"></div>
    <header class="top"><span class="top-sp" aria-hidden="true"></span><button type="button" class="grp">${typeof SET === 'undefined' ? 'Group name' : SET.group} ${ic('chev')}</button>${me()}</header>
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
    </section>`;
  },
};

/* ---------- 首页说明 ---------- */
// 说明都是 [英文, 中文]
const concepts = [
  {
    id: 'c6',
    no: '06',
    zh: '暖光玻璃',
    en: 'Warm Glass',
    key: ['Cream · peach light · soft serif', '奶油底 · 蜜桃暖光 · 软衬线'],
    notes: [
      [
        'Glass cards and dock over a peach and honey glow',
        'Light theme, like afternoon sun in a room',
      ],
      ['玻璃卡片和底栏，底下一团蜜桃 / 蜂蜜色暖光', '浅色，像午后阳光照进房间'],
    ],
    fonts: 'Fraunces (SOFT) · Geist',
  },
];
const nameOf = (c) => (LANG === 'zh' ? c.zh : c.en);
const altName = (c) => (LANG === 'zh' ? c.en : c.zh);

const screen = (c, d) =>
  `<div class="device"><div class="screen ${c.id} gnav nav-g sh-${NAV.shutter} st-${NAV.home}">${statusBar()}<div class="scroll">${NAV.home === 'collect' ? bodies[c.id](d) : stateBody(c, d)}</div>${dock(d)}<span class="home-ind" aria-hidden="true"></span></div></div>`;

// 每台手机的演示数据（播放 / 按快门只改这一台；重置即删除）
const STORY = {};
const storyPool = (id) => (STORY[id] ||= POOL.map((p) => ({ ...p })));
const dataFor = (id) => data(STORY[id] || POOL);

function renderCard(id, from) {
  const c = concepts.find((x) => x.id === id);
  // from：动画所在的那台手机；状态页里的手机按“收集中”重画
  const card = from?.closest('.card') || document.querySelector(`.card[data-id="${id}"]`);
  const wrap = card?.querySelector('.phone-wrap');
  if (c && wrap) {
    const draw = () => screen(c, dataFor(id));
    wrap.innerHTML = card.closest('#states-view') ? withHome('collect', draw) : draw();
  }
  return wrap?.querySelector('.screen');
}
const clearStories = () => Object.keys(STORY).forEach((k) => delete STORY[k]);

function render() {
  const c = concepts[0];
  $('gallery').innerHTML =
    `<article class="card show" data-id="${c.id}" aria-label="${nameOf(c)}">` +
    `<header class="card-h"><div><h2>${nameOf(c)}</h2>${LANG === 'zh' ? `<p>${altName(c)}</p>` : ''}</div></header>` +
    `<div class="card-ctl"><button type="button" class="ctl" data-play="${c.id}" title="${t('play.title')}">${ic('play')}${t('play')}</button><span class="step" id="step-${c.id}" aria-live="polite"></span></div>` +
    `<div class="phone-wrap">${screen(c, dataFor(c.id))}</div>` +
    `<div class="notes"><p class="key">${L(c.key)}</p><ul>${L(c.notes)
      .map((n) => `<li>${n}</li>`)
      .join('')}</ul><p class="fonts">${t('fonts')} · ${c.fonts}</p></div>` +
    `</article>`;
}

// 窄屏时按可用宽度自动缩小手机，避免横向滚动
const fitScale = () => Math.min(1, ($('gallery').clientWidth || 410) / 410);
const setZoom = (v) => {
  $('zoom').value = v;
  $('zoomv').textContent = v + '%';
  document.documentElement.style.setProperty('--s', Math.min(v / 100, fitScale()));
  // 状态页、搭配页按这个值换算自己的手机大小
  document.documentElement.style.setProperty('--z', Math.min(v / 100, fitScale()));
};
// 窗口变窄时重新算一次，避免横向滚动
addEventListener('resize', () => setZoom($('zoom').value));

/* ---------- 动效：入场，与按快门的“封存” ---------- */
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let introTimer;
// 只在页面可见时播放（requestAnimationFrame 在隐藏页面不触发），避免缩略图停在动画起点
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

// 页面底部的一条短提示
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
    /* 剪贴板接口不可用时退回旧办法 */
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

/* ---------- 动效：你按快门 ---------- */
// 给元素挂一个一次性的效果类
function fx(el, cls, ms = 1000) {
  if (!el) return;
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// 封存之后：额度那一行跳一下
const FX = {
  c6: { sealed: (ns) => fx(ns.querySelector('.mine-row'), 'fx-roll', 700) },
};

// 你按快门：封存一个片段
async function sealFlight(scr, btn, then) {
  if (NAV.shutter !== 'collect') return then?.();
  const id = scr.classList[1];
  const mine = storyPool(id)[0];
  if (mine.c >= 5) {
    flashTip(btn, `All 5 used · resets in ${plural(cyc().reset, 'day')}`);
    return then?.();
  }
  const S = FX[id] || {};
  mine.c += 1;
  const ns = renderCard(id, scr);
  if (ns) {
    S.sealed?.(ns);
    const nb = ns.querySelector('.shutter');
    if (nb) flashTip(nb, 'Sealed');
  }
  then?.();
}

// 揭晓：4 周到了，影片首映 24 小时，下一期马上开始
function reveal(scr) {
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  const c = concepts.find((x) => x.id === id);
  if (!wrap || !c) return;
  wrap.innerHTML = withHome('released', () => screen(c, dataFor(id)));
  wrap.querySelector('.st-card')?.classList.add('fx-in');
}

// 播放：①你按快门封存 → ②这一期结束，影片首映
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
  renderCard(id);
  setStep(id, '');
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.lang) return setLang(t.dataset.lang);
  if (t.dataset.play) {
    // 播放演示的是收集中的一期：先回到正常状态
    if (NAV.home !== 'collect') window.setHome?.('collect');
    return playStory(t.dataset.play);
  }
  if (t.id === 'shuffle') {
    const bag = [0, 0, 1, 1, 2, 2, 3, 4, 5];
    POOL.forEach((p) => (p.c = bag[Math.floor(Math.random() * bag.length)]));
    clearStories();
    return render();
  }
  if (t.id === 'replay') return playIntro();
  if (t.id === 'restore') {
    POOL.forEach((p, i) => (p.c = DEFAULT_C[i]));
    clearStories();
    return render();
  }
  const scr = t.closest('.screen');
  if (!scr) return;
  // 头像 → 设置；揭晓后的“一起看” → 周日影片（见 screens.js）
  if (t.classList.contains('me')) return openSub(scr, 'settings');
  if (t.classList.contains('wt')) return openSub(scr, 'film');
  if (t.hasAttribute('data-open-mine')) return openSub(scr, 'mine');
  if (t.classList.contains('tab')) {
    t.parentElement.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('on', b === t);
      if (b === t) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    return;
  }
  if (t.classList.contains('shutter')) {
    // 用不了的快门：轻晃一下表示“不行”，再在快门上方短暂说明原因
    if (t.getAttribute('aria-disabled') === 'true') {
      t.classList.remove('nope');
      void t.offsetWidth;
      t.classList.add('nope');
      return t.dataset.tip && flashTip(t, t.dataset.tip);
    }
    // 快门 → 相机（拍照 / 录视频），封存后回到首页
    openSub(scr, 'camera');
  }
});
$('zoom').addEventListener('input', (e) => setZoom(e.target.value));
$('hints').addEventListener('change', (e) =>
  $('gallery').classList.toggle('hints', e.target.checked),
);
$('shutter-state').addEventListener('change', (e) => {
  NAV.shutter = e.target.value;
  render();
});
$('unread').addEventListener('change', (e) => {
  NAV.unread = e.target.checked;
  render();
});
$('members').addEventListener('input', (e) => {
  size = Number(e.target.value);
  $('membersv').textContent = t('members.unit', { n: size });
  clearStories();
  render();
});

function setLang(l) {
  LANG = l === 'zh' ? 'zh' : 'en';
  try {
    localStorage.setItem('rewind-lang', LANG);
  } catch {
    /* 存不了也没关系 */
  }
  applyI18n();
  $('membersv').textContent = t('members.unit', { n: size });
  render();
  window.relangMix?.();
}

applyI18n();
$('membersv').textContent = t('members.unit', { n: size });
render();
setZoom($('zoom').value);
playIntro();
