'use strict';

// 纯展示原型：不访问相机、网络或存储。
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
const ic = (n, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;

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

/* ---------- 程序生成的“照片” ---------- */
// 揭晓前不能出现任何成员媒体，所以这里只画虚焦的街灯、咖啡馆、海边、夜城、公园光斑，
// 看起来像真实冲洗的照片，但没有人物和内容；漏光用贡献者的专属色。
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SCENES = [
  ['#1b1a2e', '#6b3b3a', '#f0a35e', ['#ffd9a0', '#ff9f6b', '#ffe7c2']],
  ['#2a1a12', '#6e4424', '#d99a52', ['#ffe0a3', '#ffc873', '#fff1d0']],
  ['#123043', '#3f7a86', '#f2b48a', ['#fff2dc', '#ffd0a6', '#bfe6ea']],
  ['#1c1233', '#5a2d5e', '#e0708a', ['#ff9ec0', '#ffd6e6', '#9fb4ff']],
  ['#1d2a18', '#4e6b35', '#e3c070', ['#fff0b8', '#e8f5c0', '#ffd98a']],
];
const photoCache = {};
function photoFor(seed, tint) {
  const key = seed + tint;
  if (photoCache[key]) return photoCache[key];
  const W = 180,
    H = 120,
    cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d');
  if (!x) return '';
  const r = rng(seed * 9973 + 17);
  const [top, mid, glow, lights] = SCENES[seed % SCENES.length];
  let g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top);
  g.addColorStop(0.6, mid);
  g.addColorStop(1, glow);
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  g = x.createRadialGradient(W * (0.3 + r() * 0.4), H * 0.75, 0, W * 0.5, H * 0.75, W * 0.8);
  g.addColorStop(0, glow + 'cc');
  g.addColorStop(1, glow + '00');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < 3; i++) {
    const cx = r() * W,
      cy = H * (0.55 + r() * 0.4),
      rr = 25 + r() * 45;
    g = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
    g.addColorStop(0, 'rgba(10,6,4,.55)');
    g.addColorStop(1, 'rgba(10,6,4,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
  }
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 20; i++) {
    const cx = r() * W,
      cy = r() * H * 0.8,
      rr = 5 + r() * 15,
      col = lights[i % lights.length];
    g = x.createRadialGradient(cx, cy, rr * 0.2, cx, cy, rr);
    g.addColorStop(0, col + 'aa');
    g.addColorStop(0.7, col + '50');
    g.addColorStop(1, col + '00');
    x.fillStyle = g;
    x.beginPath();
    x.arc(cx, cy, rr, 0, 7);
    x.fill();
  }
  g = x.createLinearGradient(W, 0, W * 0.45, H * 0.6);
  g.addColorStop(0, tint + 'b0');
  g.addColorStop(1, tint + '00');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.globalCompositeOperation = 'source-over';
  g = x.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.7);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,.55)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H),
    px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (r() - 0.5) * 26;
    px[i] += n;
    px[i + 1] += n;
    px[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  return (photoCache[key] = cv.toDataURL('image/jpeg', 0.82));
}
let size = 5;
let anon = true; // 未参与成员不点名（借鉴 Reveal “no streak, no scolding”）
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const word = (k) => WORDS[k] ?? String(k);
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
const secs = (c) => String([0, 4, 8, 13, 19, 26][c]).padStart(2, '0');

const hidden = (x) => anon && x.c === 0 && !x.me;
const init = (x) => (hidden(x) ? '' : x.name[0]);
const label = (x) => (hidden(x) ? '' : x.me ? 'You' : x.name);

// 数据口径（提案 A）：只知道每个成员“参与了没有”，不显示别人各贡献了几条；
// 你自己的条数来自你的台账，全组总数来自周期汇总。成员的 c 只用来模拟这些数字。
function data(pool = POOL) {
  const members = pool.slice(0, size);
  const waiting = members.filter((x) => x.c === 0);
  return {
    members,
    // 不点名时，把还没贡献的人排到最后，显示成空位
    shown: anon ? [...members.filter((x) => !hidden(x)), ...members.filter(hidden)] : members,
    n: members.length,
    m: members.reduce((s, x) => s + x.c, 0),
    added: members.length - waiting.length,
    waiting,
    me: members[0],
  };
}
// 全组片段（不标注作者）：只有你自己的那几条能认出来
const WARM = ['#E9A15B', '#F2C07A', '#E48A6A', '#F5D39B', '#D98E5F'];
function moments(d) {
  const arr = Array.from({ length: d.m }, (_, i) => ({ mine: false, seed: i * 5 + 2 }));
  for (let j = 0; j < d.me.c; j++)
    arr[Math.min(d.m - 1, Math.floor(((j + 0.5) * d.m) / d.me.c))].mine = true;
  return arr;
}
const tintOf = (mo, d, i) => (mo.mine ? d.me.col : WARM[i % WARM.length]);
// 揭晓前 / 揭晓后两套文案
const pp = (a, b) => `<span class="is-pre">${a}</span><span class="is-now">${b}</span>`;

function waitLine(d) {
  const k = d.waiting.length;
  if (!k) return "Everyone's in.";
  if (anon) return `Waiting on ${k === 1 ? 'one more' : word(k) + ' more'}.`;
  const w = d.waiting.map((x) => (x.me ? 'You' : x.name));
  if (w.length === 1) return `${w[0]} ${w[0] === 'You' ? "haven't" : "hasn't"} yet.`;
  if (w.length === 2) return `${w[0]} & ${w[1]} haven't yet.`;
  return `${w.length} friends haven't yet.`;
}

/* ---------- 共用部件 ---------- */
// 5 段额度环：已用的段点亮。快门、围炉座位共用。
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

/* ---------- 底栏：统一玻璃底栏 + 变体 + 快门状态 + 角标 ---------- */
const NAV = { variant: 'a', shutter: 'collect', unread: true };

function shutter(d) {
  const left = 5 - d.me.c;
  const s = {
    collect: [ring(d.me.c), 'camera', `Add a moment · ${left} of 5 left`, ''],
    quota: [
      ring(5),
      'camera',
      'Weekly allowance used up · resets Sunday',
      'All 5 used · resets Sun',
    ],
    upload: [arcRing(0.28, true), 'camera', 'Sealing your moment', 'Sealing…'],
    sealed: [
      ring(Math.min(5, d.me.c + 1)),
      'check',
      `Moment sealed · ${Math.max(0, left - 1)} of 5 left`,
      'Sealed · not even you can peek',
    ],
    premiere: [
      arcRing(0.75),
      'play',
      'Watch the premiere together · 18 hours left',
      'Premiere · 18h left',
    ],
  }[NAV.shutter];
  return (
    `<button type="button" class="shutter" aria-label="${s[2]}"${NAV.shutter === 'quota' ? ' aria-disabled="true"' : ''}>` +
    `${s[0]}<span class="core">${ic(s[1])}</span>${s[3] ? `<span class="tip" aria-hidden="true">${s[3]}</span>` : ''}</button>`
  );
}

// D / E / F 把聊天（E 还有档案）挪到右上角
function topNav() {
  const v = NAV.variant;
  if (!'def'.includes(v)) return '';
  const chat = `<button type="button" class="tn" aria-label="Chat${NAV.unread ? ', 3 unread' : ''}">${ic('chat')}${NAV.unread ? '<i class="badge">3</i>' : ''}</button>`;
  const archive =
    v === 'e'
      ? `<button type="button" class="tn" aria-label="Archive${NAV.shutter === 'premiere' ? ', new film' : ''}">${ic('archive')}${NAV.shutter === 'premiere' ? '<i class="badge dot"></i>' : ''}</button>`
      : '';
  return `<div class="topnav">${archive}${chat}</div>`;
}

function dock(d) {
  const tabs = [
    ['home', 'Home', '', ''],
    ['chat', 'Chat', NAV.unread ? '<i class="badge">3</i>' : '', NAV.unread ? ', 3 unread' : ''],
    [
      'archive',
      'Archive',
      NAV.shutter === 'premiere' ? '<i class="badge dot"></i>' : '',
      NAV.shutter === 'premiere' ? ', new film' : '',
    ],
  ];
  const tab = ([k, l, badge, extra], on) =>
    `<button type="button" class="tab${on ? ' on' : ''}" aria-label="${l}${extra}"${on ? ' aria-current="page"' : ''}><span class="ico">${ic(k)}${badge}</span><span class="tlbl">${l}</span></button>`;
  const v = NAV.variant;
  // D 中置快门：首页 · 快门 · 档案；聊天在右上角
  if (v === 'd')
    return `<nav class="dock dock-d" aria-label="Main navigation"><div class="tabs">${tab(tabs[0], true)}${shutter(d)}${tab(tabs[2], false)}</div></nav>`;
  // E 只有快门：档案和聊天在右上角
  if (v === 'e') return `<nav class="dock dock-e" aria-label="Capture">${shutter(d)}</nav>`;
  // F 时间轴：往期影片在左，当前一期在右；点往期即看旧影片
  if (v === 'f') {
    const films = ['W33', 'W34', 'W35']
      .map(
        (w, i) =>
          `<span class="film" style="--i:${i}"><i style="background-image:url(${photoFor(40 + i * 3, WARM[i])})"></i><b>${w}</b></span>`,
      )
      .join('');
    return (
      `<nav class="dock dock-f" aria-label="Cycles"><div class="timeline"><button type="button" class="past" aria-label="Archive: films W33 to W35">${films}</button>` +
      `<span class="now-mark"><b>Now · W36</b><small>2d 14h</small></span></div>${shutter(d)}</nav>`
    );
  }
  // G 实时胶囊：显示这一期的状态，点开才出现三个页签
  if (v === 'g')
    return (
      `<nav class="dock dock-g" aria-label="Main navigation"><div class="tabs"><button type="button" class="live" aria-expanded="false" aria-label="Home · 2 days 14 hours · ${5 - d.me.c} left · show tabs">` +
      `${ic('home')}${NAV.unread ? '<i class="badge dot"></i>' : ''}<span><b>Home</b> · 2d 14h · ${5 - d.me.c} left</span>${ic('chev', 'up')}</button>` +
      `${tabs.map((x, i) => tab(x, i === 0)).join('')}</div>${shutter(d)}</nav>`
    );
  return (
    `<nav class="dock" aria-label="Main navigation"><div class="tabs${tabs.some((t) => t[2]) ? ' has-badge' : ''}">` +
    tabs
      .map(
        ([k, l, badge, extra], i) =>
          `<button type="button" class="tab${i === 0 ? ' on' : ''}" aria-label="${l}${extra}"${i === 0 ? ' aria-current="page"' : ''}><span class="ico">${ic(k)}${badge}</span><span class="tlbl">${l}</span></button>`,
      )
      .join('') +
    `</div>${shutter(d)}</nav>`
  );
}

const me = (withName = true) =>
  `<button type="button" class="me" aria-label="Alex · profile and settings" aria-haspopup="dialog"><span class="avatar">A</span>${
    withName ? `<span class="me-n">Alex</span>${ic('chev', 'chev')}` : ''
  }</button>`;

const meSheet = (d) =>
  `<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-label="Profile and settings">` +
  `<div class="sh-head"><span class="avatar">A</span><div><strong>Alex</strong><small>Local demo · synthetic member</small></div></div>` +
  `<div class="sh-group"><small>Current group</small><strong>Weekend People</strong><span>${plural(d.n, 'member')} · Owner</span></div><ul>` +
  [
    ['swap', 'Switch demo member'],
    ['link', 'Invite to group'],
    ['bell', 'Sunday 7 PM reminder'],
    ['gear', 'Settings'],
  ]
    .map(([i, l]) => `<li><button type="button">${ic(i)}<span>${l}</span></button></li>`)
    .join('') +
  `</ul></div>`;

const holes = (n) => `<div class="holes" aria-hidden="true">${'<i></i>'.repeat(n)}</div>`;
const crew = (d) =>
  d.shown
    .map(
      (x) =>
        `<span class="av${x.c ? '' : ' wait'}" data-who="${x.name}" style="--mc:${x.col}" title="${hidden(x) ? 'Not yet' : x.name}">${init(x)}</span>`,
    )
    .join('');
const bars = (cls, used, total = 5) =>
  `<div class="${cls}" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<i${i < used ? ' class="on"' : ''}></i>`).join('')}</div>`;
const tex = (i, k = 0) =>
  `--a:${((i * 29 + k * 41) % 70) + 15}%;--b:${((i * 47 + k * 23) % 60) + 20}%`;

/* ---------- 各方案 ---------- */
const bodies = {
  c1: (d) => {
    // 全组已封存的片段做成一条倾斜的胶片，斜向下缓慢走片；只有你的那几格带你的颜色
    const ms = moments(d);
    const base = ms.length ? ms : Array(4).fill(null);
    let reel = [];
    while (reel.length < 8) reel = reel.concat(base);
    const num = (k) => String((k % base.length) + 1).padStart(2, '0');
    const cells = reel
      .map(
        (mo, k) =>
          `<div class="cell">${holes(3)}<p class="edge">${k % 2 ? '◂ ' + num(k) : 'REWIND 400'}</p>${
            mo
              ? `<div class="fr sealed${mo.mine ? ' mine' : ''}" style="background-image:url(${photoFor(mo.seed, tintOf(mo, d, k))})">${ic('lock')}</div>`
              : '<div class="fr blank"></div>'
          }<p class="edge low">${num(k)} ▸ ${num(k)}A</p>${holes(3)}</div>`,
      )
      .join('');
    return `
    <header class="top">${me()}<span class="tag">ROLL 036</span></header>
    <p class="eyebrow"><i></i>${pp('Developing · private roll', 'Developed · premiere now')}</p>
    <h1 class="title">Weekend People</h1>
    <div class="count is-pre" role="img" aria-label="2 days 14 hours until reveal">
      <div><b>02</b><span>Days</span></div><em>:</em><div><b>14</b><span>Hours</span></div>
    </div>
    <p class="now is-now">Lights on.</p>
    <p class="when">${pp('Lights on for all of us at once · Sun 8:00 PM', 'Everyone got it at 8:00 PM · watch together')}</p>
    <section class="strip" data-seal style="--me:${d.me.col}" aria-label="The group's roll: ${plural(d.m, 'moment')} sealed, not even you can peek">
      <div class="track" style="--dur:${reel.length * 3.2}s">${cells}${cells}</div>
    </section>
    <div class="meta"><span><b>${d.me.c}</b> of 5 yours · <b>${secs(d.me.c)}</b>/30 sec</span><span class="mini-crew"><span class="stack">${crew(d)}</span>${d.added}/${d.n} in</span></div>
    <section class="prompt"><p class="lbl">This week's prompt</p><h2>What made you pause and smile?</h2></section>`;
  },

  c2: (d) => {
    // 全组片段排成小样，不标注是谁拍的；只有你的几格有你的颜色小点
    const ms = moments(d);
    const rows = Math.max(1, Math.ceil(ms.length / 5));
    const cells = [...ms, ...Array(rows * 5 - ms.length).fill(null)];
    const fh = Math.round(Math.max(16, Math.min(44, 176 / rows)));
    return `
    <header class="top">${me()}<span class="tag">W36 · SEP</span></header>
    <p class="eyebrow">A week with your people</p>
    <h1 class="title">Weekend <i>People</i></h1>
    <figure class="neg" data-seal aria-label="Contact sheet: ${plural(d.m, 'moment')} sealed until Sunday">
      ${holes(20)}
      <div class="grid5" style="--fh:${fh}px;--me:${d.me.col}">${cells
        .map((mo, k) =>
          mo
            ? `<i class="fr sealed${mo.mine ? ' mine' : ''}" style="${tex(k)};--ph:url(${photoFor(mo.seed, tintOf(mo, d, k))})"></i>`
            : '<i class="fr blank"></i>',
        )
        .join('')}</div>
      ${holes(20)}
      <figcaption><strong>${pp(`${d.m} little ${d.m === 1 ? 'moment' : 'moments'}.`, 'Developed.')}</strong><span>${pp('Not even you can peek', 'Watch together now')}</span></figcaption>
    </figure>
    <p class="cap"><i>${d.added} of ${d.n} in · <em>${waitLine(d)}</em></i><span style="color:${d.me.col}">● yours</span></p>
    <div class="when"><div><small>${pp('Open together in', 'Opened together')}</small><strong>${pp('2 days, 14 hours', 'Just now')}</strong></div><div class="r"><small>Sunday</small><strong>8:00 PM</strong></div></div>
    <section class="prompt"><small>This week's prompt</small><h2>What made you pause and smile?</h2></section>
    <div class="week"><div><small>Your week</small>${bars('sq', d.me.c)}</div><p>${d.me.c} / 5 moments<br><span>${secs(d.me.c)} / 30 sec</span></p></div>`;
  },

  c3: (d) => `
    <div class="orb" aria-hidden="true"><i></i><i></i><i></i></div>
    <header class="top">${me(false)}<button type="button" class="grp">Weekend People ${ic('chev')}</button><span class="tag">W36</span></header>
    <section class="hero" data-seal aria-label="${plural(d.m, 'moment')} developing, sealed until reveal">
      <b>${pp(d.m, 'Now')}</b><span>${pp(`${d.m === 1 ? 'moment' : 'moments'} developing`, 'showing, for all of us')}</span>
      <p class="chip">${pp(`${ic('lock')} Sealed · not even you can peek`, 'Opened for everyone at once')}</p>
    </section>
    <div class="count"><strong>${pp('2d 14h', 'Now')}</strong><span>${pp('opens for all of us at once<br>Sunday · 8:00 PM', 'everyone got it at 8:00 PM<br>watch together')}</span></div>
    <section class="glass">
      <small>This week's prompt</small>
      <h2>What made you pause and smile?</h2>
      <div class="rowx"><div class="stack">${crew(d)}</div><span>${d.added} of ${d.n} in</span></div>
      <div class="rowx">${bars('pills', d.me.c)}<span>You · ${d.me.c}/5 · ${secs(d.me.c)}/30s</span></div>
    </section>`,

  c4: (d) => `
    <header class="top">${me(false)}<span class="mark">Rewind</span><span class="tag">Nº 036</span></header>
    <p class="eyebrow">${pp('Private premiere · all at once', 'Now showing · all at once')}</p>
    <article class="ticket" aria-label="Premiere ticket: Weekend People, Sunday 28 September, 8:00 PM">
      <div class="t-main" data-seal>
        <span class="foil" aria-hidden="true">${ic('rewind')}</span>
        <div class="t-row"><span>Admit ${word(d.n)}</span></div>
        <h1>Weekend People</h1>
        <p class="by">a film by ${word(d.n)} friends</p>
        <dl>
          <div><dt>Date</dt><dd>Sun 28 Sep</dd></div>
          <div><dt>Doors</dt><dd>${pp('8:00 PM', 'Open now')}</dd></div>
          <div><dt>Reels</dt><dd>${d.m} sealed</dd></div>
        </dl>
        <div class="t-foot"><span class="barcode" aria-hidden="true"></span><span class="serial">Roll 036 · Nº ${String(d.m).padStart(4, '0')}</span></div>
      </div>
      <div class="t-stub">
        <div class="curtain"><small>Curtain in</small><p><b>02</b><span>d</span><b>14</b><span>h</span></p></div>
        <div class="seats"><small>Seats · ${d.added} / ${d.n}</small><div>${d.shown
          .map(
            (x) =>
              `<span class="seat${x.c ? '' : ' empty'}" data-who="${x.name}" style="--mc:${x.col}" title="${hidden(x) ? 'Saved seat' : x.name}">${init(x)}</span>`,
          )
          .join('')}</div></div>
      </div>
    </article>
    <section class="feature"><small>${pp("Tonight's feature", 'Now showing')}</small><h2>What made you pause and smile?</h2></section>
    <div class="reel"><small>Your reel</small>${bars('rf', d.me.c)}<span>${d.me.c} of 5 · ${secs(d.me.c)}/30 sec</span></div>`,

  c5: (d) => `
    <header class="top">${me(false)}<span class="tag">Weekend People <em>— W36</em></span></header>
    <p class="eyebrow"><i></i>${pp(`Developing · ${plural(d.m, 'moment')} sealed`, `Open · ${plural(d.m, 'moment')}`)}</p>
    <div class="big" data-seal role="img" aria-label="Opens in 2 days 14 hours, Sunday 20:00"><b>${pp('02', '00')}</b><div><span>days</span><strong>${pp('14 hrs', 'Now')}</strong><span>Sun · 20:00</span></div></div>
    <p class="lead">${pp(`until it opens for all ${word(d.n)} of us at once.`, `open now, for all ${word(d.n)} of us at once.`)}</p>
    <section class="prompt"><small>01 — Prompt</small><h2>What made you pause and smile?</h2></section>
    <section class="table"><small>02 — This week · not even you can peek</small>
      ${[
        ['Friends in', `${d.added} / ${d.n}`, (d.added / d.n) * 100],
        ['Your moments', `${d.me.c} / 5`, d.me.c * 20],
        ['Seconds used', `${secs(d.me.c)} / 30`, (secs(d.me.c) / 30) * 100],
      ]
        .map(
          ([l, v, p]) =>
            `<div class="tr"><span>${l}</span><b>${v}</b><i style="--p:${p}%"></i></div>`,
        )
        .join('')}
    </section>`,

  c6: (d) => `
    <div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>
    <header class="top">${me(false)}<button type="button" class="grp">Weekend People ${ic('chev')}</button><span class="tag">W36</span></header>
    <section class="hero" data-seal aria-label="${plural(d.m, 'moment')}, sealed until Sunday">
      <p class="kept">${pp(`kept warm for the ${word(d.n)} of us`, `opened for the ${word(d.n)} of us`)}</p>
      <b>${pp(d.m, 'Open')}</b>
      <span>little ${d.m === 1 ? 'moment' : 'moments'}</span>
      <p class="chip">${pp(`${ic('lock')} Sealed · not even you can peek`, 'Opened for everyone at once')}</p>
    </section>
    <div class="count"><strong>${pp('2 days, 14 hours', 'Right now')}</strong><span>${pp('opens for all of us at once · Sun 8 PM', 'everyone got it at 8 PM · watch together')}</span></div>
    <section class="glass">
      <small>This week's prompt</small>
      <h2>What made you pause and smile?</h2>
      <div class="rowx"><div class="stack">${crew(d)}</div><span>${d.added} of ${d.n} are in</span></div>
      <div class="rowx">${bars('pills', d.me.c)}<span>You · ${d.me.c}/5 · ${secs(d.me.c)}/30s</span></div>
    </section>`,

  c7: (d) => {
    const R = 128,
      CX = 165,
      CY = 170;
    const heat = (0.45 + 0.55 * Math.min(1, d.m / (d.n * 3))).toFixed(2);
    // 只显示谁到了：到了的人一圈满光；只有你自己的座位显示你的 5 段额度
    const seats = d.shown
      .map((x, i) => {
        const a = ((-90 + (i * 360) / d.n) * Math.PI) / 180;
        const rg = x.me
          ? ring(x.c, 5, 24, 26, 14)
          : `<svg class="ring" viewBox="0 0 52 52" aria-hidden="true"><circle class="${x.c ? 'full' : 'none'}" cx="26" cy="26" r="24"/></svg>`;
        const tip = hidden(x)
          ? 'Saved seat'
          : x.me
            ? `You · ${x.c}/5`
            : `${x.name} · ${x.c ? 'in' : 'not yet'}`;
        return `<div class="seat${x.c ? '' : ' cold'}${x.me ? ' me' : ''}" data-who="${x.name}" style="--mc:${x.col};--ring-on:${x.col};left:${(CX + R * Math.cos(a)).toFixed(1)}px;top:${(CY + R * Math.sin(a)).toFixed(1)}px" title="${tip}">${rg}<span class="avatar">${init(x)}</span><small>${label(x)}</small></div>`;
      })
      .join('');
    const embers = [-18, 10, -4, 22, -26, 4, 16]
      .map(
        (dx, i) =>
          `<i class="ember" style="--dx:${dx}px;margin-left:${(i % 3) * 8 - 8}px;animation-delay:${(i * 0.62).toFixed(2)}s"></i>`,
      )
      .join('');
    return `
    <header class="top">${me(false)}<button type="button" class="grp">Weekend People ${ic('chev')}</button><span class="tag">W36</span></header>
    <section class="hearth" data-seal style="--heat:${heat}" aria-label="${d.n} members around the fire, ${d.added} in, ${plural(d.m, 'moment')} sealed">
      <div class="fire" aria-hidden="true"><i></i><i></i></div>
      ${embers}
      <div class="mid"><strong>${pp('2d 14h', 'Now')}</strong><span>${pp('until we gather', "we're gathered")}</span><span>${pp('Sunday · 8 PM', 'watch together')}</span></div>
      ${seats}
    </section>
    <p class="byfire">${pp(`<b>${plural(d.m, 'moment')}</b> by the fire · sealed, even from you`, `<b>${plural(d.m, 'moment')}</b> in the light · watch together`)}</p>
    <section class="glass">
      <small>This week's prompt</small>
      <h2>What made you pause and smile?</h2>
      <div class="rowx"><span>${d.added} of ${d.n} gathered</span><span>${waitLine(d)}</span></div>
      <div class="rowx">${bars('pills', d.me.c)}<span>You · ${d.me.c}/5 · ${secs(d.me.c)}/30s</span></div>
    </section>`;
  },

  c8: (d) => `
    <header class="top">${me()}<span class="tag">W36</span></header>
    <p class="eyebrow">A letter to ourselves</p>
    <article class="env" data-seal aria-label="Sealed letter with ${plural(d.m, 'moment')} inside, opens Sunday 8 PM">
      <div class="letter-paper" aria-hidden="true"><p class="hand">Dear us,</p><p class="lp-body">${plural(d.m, 'moment')}, all here.<br>Opened together, right now.</p><span class="lp-cta">${ic('play')} Watch together</span></div>
      <div class="pocket" aria-hidden="true"></div>
      <div class="flap-shadow"></div><div class="flap"></div>
      <span class="seal">${ic('rewind')}</span>
      <div class="addr"><small>To</small><p class="hand">Weekend People</p><small>From</small><p class="hand sm">the ${word(d.n)} of us</p></div>
      <div class="post" aria-hidden="true"><span>Opens</span><b>SUN</b><span>8 PM</span></div>
    </article>
    <div class="opens"><div><small>${pp('Opens for everyone in', 'Opened for everyone')}</small><strong>${pp('2 days, 14 hours', 'Just now')}</strong></div><div class="r"><small>Inside</small><strong>${plural(d.m, 'moment')}</strong></div></div>
    <section class="letter"><p class="hand">Dear us,</p><h2>What made you pause and smile?</h2></section>
    <section class="signed"><small>Sealed by · not even you can peek</small><div class="stamps">${d.shown
      .map(
        (x) =>
          `<span class="stamp${x.c ? '' : ' blank'}" data-who="${x.name}" style="--st:${x.col}" title="${hidden(x) ? 'Stamp still to come' : x.name}"><i>${init(x)}</i></span>`,
      )
      .join('')}</div><p>${waitLine(d)}</p></section>`,

  c9: (d) => {
    // 每个片段一只萤火虫；你的萤火虫是你的颜色，其他人的都是暖黄，不暴露谁拍了几条
    const fl = moments(d)
      .map(
        (mo, i) =>
          `<i class="fly${mo.mine ? ' mine' : ''}" style="--mc:${tintOf(mo, d, i)};--k:${i};--ex:${((i % 5) - 2) * 22}px;left:${8 + ((i * 37 + 11) % 80)}%;top:${10 + ((i * 53 + 7) % 78)}%;animation-delay:${-((i * 0.9) % 6).toFixed(1)}s;animation-duration:${5 + (i % 4)}s"></i>`,
      )
      .join('');
    return `
    <header class="top">${me(false)}<button type="button" class="grp">Weekend People ${ic('chev')}</button><span class="tag">W36</span></header>
    <section class="jarwrap" aria-label="${plural(d.m, 'moment')} caught in the jar, sealed until Sunday">
      <div class="jarglow" aria-hidden="true"></div>
      <div class="jar" aria-hidden="true"><span class="lid"></span><span class="neck"></span><div class="body" data-seal>${fl}</div><span class="label"><em>open</em> Sun · 8 PM</span></div>
    </section>
    <p class="caught">${pp(`<b>${d.m}</b> ${d.m === 1 ? 'moment' : 'moments'} caught this week`, `<b>${d.m}</b> ${d.m === 1 ? 'moment' : 'moments'}, set free`)}</p>
    <p class="sealed">${pp(`${ic('lock')} Sealed · not even you can peek`, 'Opened for everyone at once')}</p>
    <div class="count"><span>${pp('We let them out together in', 'We let them out together')}</span><strong>${pp('2 days, 14 hours', 'just now')}</strong></div>
    <section class="glass">
      <small>This week's prompt</small>
      <h2>What made you pause and smile?</h2>
      <div class="rowx"><div class="stack">${crew(d)}</div><span>${d.added} of ${d.n} in</span></div>
      <div class="rowx">${bars('pills', d.me.c)}<span>You · ${d.me.c}/5 · ${secs(d.me.c)}/30s</span></div>
    </section>`;
  },

  c10: (d) => {
    const stars = d.shown
      .filter((x) => x.c > 0)
      .map(
        (x) => `<span data-who="${x.name}" style="color:${x.col}">${x.me ? 'You' : x.name}</span>`,
      )
      .join('<i>·</i>');
    const still = d.waiting.length
      ? anon
        ? `and ${word(d.waiting.length)} more still filming`
        : `${d.waiting.map((x) => (x.me ? 'You' : x.name)).join(' & ')} still filming`
      : 'the whole cast is in';
    return `
    <header class="top">${me(false)}<span class="mark">Rewind</span><span class="tag">W36</span></header>
    <section class="theatre" aria-label="Premiere Sunday 8 PM for all members at once">
      <span class="projector" aria-hidden="true"></span>
      <span class="beam" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div class="screen-card" data-seal>
        <small>${pp('Coming Sunday · 8 PM', 'Now showing')}</small>
        <h1>Weekend People</h1>
        <p>${pp(`in 2 days, 14 hours · for all ${word(d.n)} of us at once`, `for all ${word(d.n)} of us, right now`)}</p>
        <div class="leader is-now" aria-hidden="true"><span>3</span><span>2</span><span>1</span></div>
      </div>
    </section>
    <section class="credits">
      <small>Starring</small>
      <p class="names">${stars || '—'}</p>
      <p class="still">${still}</p>
      <p class="feat">${pp(`featuring ${plural(d.m, 'sealed moment')} · not even you can peek`, `featuring ${plural(d.m, 'moment')} · now showing`)}</p>
    </section>
    <section class="theme"><small>This week's theme</small><h2>What made you pause and smile?</h2></section>
    <div class="reel"><small>Your scenes</small>${bars('rf', d.me.c)}<span>${d.me.c} of 5 · ${secs(d.me.c)}/30s</span></div>`;
  },

  c11: (d) => {
    // 全组一条片轨（不标注作者，只有你的几格是你的颜色）+ 成员参与标记
    const ms = moments(d);
    return `
    <header class="top">${me()}<span class="tag">W36</span></header>
    <h1 class="title">Weekend People</h1>
    <p class="pill-count"><span class="dot"></span>${pp(`Premieres in <b>2d 14h</b> · Sun 8 PM, to all ${word(d.n)} at once`, `Premiering now · to all ${word(d.n)} at once`)}</p>
    <section class="board" data-seal style="--me:${d.me.col}" aria-label="Our reel: ${plural(d.m, 'clip')}, ${d.added} of ${d.n} members in, sealed">
      <div class="board-h"><div><small>Our reel so far</small><strong>${plural(d.m, 'clip')}</strong></div><span class="lock">${ic('lock')} ${pp('not even you can peek', 'open to everyone')}</span></div>
      <div class="reelbar">${ms.length ? ms.map((mo, k) => `<i class="${mo.mine ? 'mine' : ''}" style="--k:${k}"></i>`).join('') : '<em>No clips yet</em>'}<span class="playhead" aria-hidden="true"></span></div>
      <div class="chips">${d.shown
        .map(
          (x) =>
            `<span class="pchip${x.c ? ' in' : ''}${x.me ? ' me' : ''}" data-who="${x.name}" style="--mc:${x.col}" title="${hidden(x) ? 'Not yet' : x.name + (x.c ? ' · in' : ' · not yet')}">${x.c ? ic('check') : ''}${x.me ? 'You' : init(x)}</span>`,
        )
        .join('')}</div>
      <p class="legend"><i></i>yours<i class="o"></i>everyone else · who made which stays sealed</p>
    </section>
    <section class="prompt"><small>This week's prompt</small><h2>What made you pause and smile?</h2></section>
    <p class="foot-note">${d.added} of ${d.n} are in · ${waitLine(d)}</p>`;
  },
};

/* ---------- 方案清单与评审信息 ---------- */
// 方案清单：说明与评审信息都是 [英文, 中文]
const concepts = [
  {
    id: 'c9',
    group: 'r3',
    no: '09',
    zh: '萤火虫罐',
    en: 'Firefly Jar',
    key: ['Warm glass jar · one firefly per moment', '暖色玻璃罐 · 一个片段一只萤火虫'],
    notes: [
      [
        'Glass and warmth: the jar glows softly at dusk',
        'One firefly per moment, as many as the group total; yours glow in your colour, the rest are warm gold',
        '“We let them out together”: letting them out is the shared reveal',
      ],
      [
        '玻璃质感 + 温馨：罐子在暮色里微微发光',
        '一个片段一只萤火虫，数量 = 全组片段数；你的萤火虫是你的颜色，其余统一暖黄',
        '“We let them out together”：一起放出来 = 一起揭晓',
      ],
    ],
    fonts: 'Fraunces (SOFT) · Caveat · Geist',
    review: [
      ['Fireflies in a jar', '罐中萤火'],
      ['Medium–high', '中高'],
      ['Many fireflies may cost performance', '片段很多时粒子性能'],
    ],
  },
  {
    id: 'c10',
    group: 'r3',
    no: '10',
    zh: '放映夜',
    en: 'Movie Night',
    key: ['Projector beam · screen trailer · opening credits', '放映机光束 · 幕布预告 · 片头字幕'],
    notes: [
      [
        'A mix of Darkroom and Premiere Ticket, with the cinematic reveal of Capsl',
        '“Starring …” lists who is in, in their colours, wrapping as the group grows',
        'Members not in yet become “and one more still filming”, unnamed',
      ],
      [
        '暗房杂志 × 首映票根的混合，借鉴 Capsl 的“电影式揭晓”',
        '“Starring …” 名单按成员专属色排出，随人数换行',
        '未参与的人写成 “and one more still filming”，不点名',
      ],
    ],
    fonts: 'Fraunces · DM Mono · Geist',
    review: [
      ['Home screening and opening credits', '家庭放映 + 片头字幕'],
      ['Medium', '中'],
      [
        'Overlaps with 04 Premiere Ticket; pick one or merge',
        '与 04 首映票根概念重叠，需二选一或合并',
      ],
    ],
  },
  {
    id: 'c11',
    group: 'r3',
    no: '11',
    zh: '共同片轨',
    en: 'Shared Reel',
    key: ['Light · one reel for the group · who-is-in chips', '浅色 · 全组一条片轨 · 成员参与标记'],
    notes: [
      [
        'Changed for the new data scope from one lane per person to one reel for the group: a total, no names attached',
        'Your clips are in your colour; members are only marked in ✓ or not yet',
        'At the reveal a playhead sweeps the reel, like a screening starting',
      ],
      [
        '按新口径从“每人一条轨”改为“全组一条片轨”：只数总数，不标作者',
        '你的几格是你的颜色；成员只标“已参与 ✓ / 还没有”',
        '揭晓时播放头从头扫到尾，像开始放映',
      ],
    ],
    fonts: 'Geist',
    review: [
      ['Editing timeline', '剪辑时间线'],
      ['Low', '低'],
      ['Feels like a tool; less warm than 07 or 09', '偏工具，情感弱于 07 / 09'],
    ],
  },
  {
    id: 'c6',
    group: 'r2',
    no: '06',
    zh: '暖光玻璃',
    en: 'Warm Glass',
    key: [
      'The warm take on 03 · cream · peach light · soft serif',
      '03 的温馨版 · 奶油底 · 蜜桃暖光 · 软衬线',
    ],
    notes: [
      [
        'Keeps the glass texture and dock; cool purple becomes peach and honey',
        'Light theme, like afternoon sun in a room',
        'Copy: “kept warm for the five of us”',
      ],
      [
        '保留玻璃质感与底栏，冷紫换成蜜桃 / 蜂蜜色',
        '浅色，像午后阳光照进房间',
        '文案 “kept warm for the five of us”',
      ],
    ],
    fonts: 'Fraunces (SOFT) · Geist',
    review: [
      ['Afternoon light', '午后暖光'],
      ['Medium', '中'],
      [
        'Light glass needs a contrast check for every text colour',
        '浅色玻璃的文字对比度需逐一验证',
      ],
    ],
  },
  {
    id: 'c7',
    group: 'r2',
    no: '07',
    zh: '围炉',
    en: 'Hearth',
    key: ['Warm black · firelight · members in a circle', '暖黑 · 火光 · 成员围坐一圈'],
    notes: [
      [
        'Members sit in a circle sized to the group; those who are in glow in their colour, and only your seat shows your 5-segment allowance',
        'The fire grows brighter with the group total',
        'When not named, members not in yet are a saved seat',
      ],
      [
        '成员按人数自动围成一圈；到了的人亮一圈自己的颜色，只有你的座位显示你的 5 段额度',
        '火光亮度随全组片段数变化',
        '不点名时，没来的人是“留着的空位”',
      ],
    ],
    fonts: 'Fraunces (SOFT) · Geist',
    review: [
      ['Around the fire', '围坐火堆'],
      ['Medium–high', '中高'],
      [
        'The circle gets crowded on small screens or at 150% text',
        '小屏 / 150% 大字体下环形会拥挤',
      ],
    ],
  },
  {
    id: 'c8',
    group: 'r2',
    no: '08',
    zh: '蜡封信',
    en: 'Sealed Letter',
    key: ['Warm paper · wax seal · postmark · fountain pen', '暖纸 · 蜡封 · 邮戳 · 钢笔字'],
    notes: [
      [
        'Each cycle is a letter to ourselves, opened together on Sunday',
        'Members are stamps in their colour; a blank stamp is someone not in yet',
        'The prompt opens with “Dear us,”',
      ],
      [
        '这一期是一封写给我们自己的信，周日一起拆',
        '成员是邮票（专属色），没来的人是空邮票框',
        '题目写成 “Dear us,” 开头',
      ],
    ],
    fonts: 'Fraunces · Caveat · Inter',
    review: [
      ['A letter to ourselves', '写给自己的信'],
      ['Medium', '中'],
      [
        'Handwriting readability; a Chinese UI needs its own handwriting face',
        '手写体可读性；中文界面需另找手写字体',
      ],
    ],
  },
  {
    id: 'c1',
    group: 'r1',
    no: '01',
    zh: '暗房杂志',
    en: 'Darkroom Editorial',
    key: [
      'Warm black · safelight orange · large monospace numerals',
      '暖黑底 · 安全灯橙 · 等宽大数字',
    ],
    notes: [
      [
        'The countdown is the hero',
        'A tilted, realistic film runs diagonally; each frame is one of the group’s moments, and only yours carry your colour',
        'At the reveal every frame develops from dark and the locks disappear',
      ],
      [
        '主角是倒计时',
        '倾斜的写实胶片斜向下走片，每格是全组的一个片段，只有你的带你的颜色',
        '揭晓时每格从暗到亮“显影”，锁消失',
      ],
    ],
    fonts: 'Inter Tight · JetBrains Mono',
    review: [
      ['Darkroom developing', '暗房冲洗'],
      ['Low', '低'],
      ['Feels cool and tool-like', '偏酷、偏工具感'],
    ],
  },
  {
    id: 'c2',
    group: 'r1',
    no: '02',
    zh: '相纸索引页',
    en: 'Contact Sheet',
    key: ['Warm paper · rust red · serif titles', '暖纸 · 铁锈红 · 衬线标题'],
    notes: [
      [
        'Every moment in the group laid out as a contact sheet; rows grow with the total, no names attached',
        'Only your frames carry a dot in your colour; at the reveal they develop one by one',
        '“Not even you can peek”',
      ],
      [
        '全组片段排成小样，行数跟着片段数走，不标注是谁拍的',
        '只有你的几格带你的颜色小点；揭晓时每格依次显影',
        '“Not even you can peek”',
      ],
    ],
    fonts: 'Instrument Serif · Inter · DM Mono',
    review: [
      ['Contact sheet', '冲洗小样'],
      ['Medium', '中'],
      ['Frames get small when the group adds many moments', '片段多时每格很小'],
    ],
  },
  {
    id: 'c3',
    group: 'r1',
    no: '03',
    zh: '玻璃胶囊',
    en: 'Glass Capsule',
    key: ['Dark · drifting light · frosted glass', '深色 · 流动光球 · 毛玻璃'],
    notes: [
      [
        'The hero is a drifting “developing” light with the group total inside',
        'Everything else sits in one glass card',
        'The source of the glass dock that every direction now uses',
      ],
      [
        '主角是流动的“显影光球”，中间是全组片段数',
        '其余信息收进一张玻璃卡片',
        '所有方向共用的玻璃底栏就来自这里',
      ],
    ],
    fonts: 'Geist',
    review: [
      ['Developing light', '显影光球'],
      ['Medium', '中'],
      ['Cool palette; large blurs may be heavy on Android', '偏冷；Android 上大面积模糊有性能风险'],
    ],
  },
  {
    id: 'c4',
    group: 'r1',
    no: '04',
    zh: '首映票根',
    en: 'Premiere Ticket',
    key: ['Cinema red · cream ticket · gold', '影院暗红 · 票根米色 · 金色'],
    notes: [
      [
        'Date, doors and countdown sit on a realistic ticket that drifts down on entry',
        'Admit N and one seat per member; empty seats are members not in yet',
        'At the reveal the stub tears off along the perforation',
      ],
      [
        '日期、开场、倒计时都在一张写实票上，入场时从上方飘落',
        'Admit N / 座位 = 人数，空座是还没参与的人',
        '揭晓时票根沿打孔撕下',
      ],
    ],
    fonts: 'Bodoni Moda · DM Mono · Inter',
    review: [
      ['Premiere ticket', '首映电影票'],
      ['Medium', '中'],
      ['Dense ticket; relies on the character of Bodoni', '票面信息密；依赖 Bodoni 字体气质'],
    ],
  },
  {
    id: 'c5',
    group: 'r1',
    no: '05',
    zh: '极简排版',
    en: 'Quiet Swiss',
    key: ['Type only · black and white plus one orange', '纯排版 · 黑白 + 一个橙色'],
    notes: [
      [
        'No imagery, only contrast in type size',
        'The allowance is a thin-rule table, the densest information',
        'The cheapest to build in Expo; a good baseline',
      ],
      [
        '没有任何图像，只靠字号对比',
        '额度用细线表格，信息密度最高',
        'Expo 落地成本最低，适合作对照组',
      ],
    ],
    fonts: 'Inter Tight',
    review: [
      ['Type only', '纯排版'],
      ['Low', '低'],
      ['Least emotional and least warm', '情感弱，温馨感最低'],
    ],
  },
];
const nameOf = (c) => (LANG === 'zh' ? c.zh : c.en);
const altName = (c) => (LANG === 'zh' ? c.en : c.zh);

const screen = (c, d) =>
  `<div class="device"><div class="screen ${c.id} gnav nav-${NAV.variant} sh-${NAV.shutter}${NAV.variant === 'c' ? ' mini' : ''}">${statusBar()}${topNav()}<div class="scroll">${bodies[c.id](d)}</div>${dock(d)}${meSheet(d)}<span class="home-ind" aria-hidden="true"></span></div></div>`;

let current = 'all';

// 每台手机的演示数据（播放 / 按快门只改这一台；重置即删除）
const STORY = {};
const storyPool = (id) => (STORY[id] ||= POOL.map((p) => ({ ...p })));
const dataFor = (id) => data(STORY[id] || POOL);
// 暗房的胶片一直在走：重绘前记下位置（px），重绘后让新胶片从同一位置接着走，不跳回起点
function filmPos(root) {
  const m = {};
  root?.querySelectorAll('.card').forEach((card) => {
    const tr = card.querySelector('.track');
    if (tr) m[card.dataset.id] = new DOMMatrix(getComputedStyle(tr).transform).m41;
  });
  return m;
}
function keepFilm(root, pos) {
  root?.querySelectorAll('.card').forEach((card) => {
    const tr = card.querySelector('.track');
    const x0 = pos[card.dataset.id];
    if (!tr || x0 === undefined) return;
    const half = tr.scrollWidth / 2,
      dur = parseFloat(tr.style.getPropertyValue('--dur')) || 30;
    const t = (((((x0 + half) / half) * dur) % dur) + dur) % dur;
    tr.style.animationDelay = `-${t.toFixed(3)}s`;
  });
}
/* ---------- 萤火虫：随机游走与明灭 ----------
   每只各自随机挑落点：多数时候在附近慢慢飘，偶尔飞远，偶尔悬停；路线是平滑的弧线。
   明灭各自随机、互不同步。重绘时从原位置接着飞，你的和别人的分开对应，新来的从瓶口进来。 */
const JAR_W = 196,
  JAR_H = 220; // 罐身内部尺寸（与 styles-r3.css 的 .c9 .jar / .body 一致）
const rand = (a, b) => a + Math.random() * (b - a);
const clampTo = (v, a, b) => Math.max(a, Math.min(b, v));
const flyXY = (f) => {
  const m = new DOMMatrix(getComputedStyle(f).transform);
  return { x: m.m41, y: m.m42 };
};
function flyPos(root) {
  const m = {};
  root?.querySelectorAll('.card').forEach((card) => {
    const flies = card.querySelectorAll('.c9 .fly.js');
    if (!flies.length) return;
    const saved = { mine: [], other: [] };
    flies.forEach((f) => saved[f.classList.contains('mine') ? 'mine' : 'other'].push(flyXY(f)));
    m[card.dataset.id] = saved;
  });
  return m;
}
function startFlies(root, keep = {}) {
  if (reduceMotion()) return;
  const cards = root?.classList?.contains('card') ? [root] : root?.querySelectorAll('.card') || [];
  cards.forEach((card) => {
    const flies = card.querySelectorAll('.c9 .jar .fly');
    if (!flies.length) return;
    const saved = keep[card.dataset.id];
    const left = saved ? { mine: [...saved.mine], other: [...saved.other] } : null;
    flies.forEach((f) => {
      const kind = f.classList.contains('mine') ? 'mine' : 'other';
      // 有旧位置就接着飞；多出来的那只从瓶口进来；首次渲染用初始位置
      const p = left
        ? left[kind].shift() || { x: JAR_W / 2 - 4, y: 6 }
        : {
            x: (parseFloat(f.style.left) / 100) * JAR_W,
            y: (parseFloat(f.style.top) / 100) * JAR_H,
          };
      f.classList.add('js');
      f._p = p;
      f.style.transform = `translate(${p.x}px, ${p.y}px)`;
      setTimeout(() => wander(f), rand(0, 600));
      setTimeout(() => blink(f), rand(0, 2500));
    });
  });
}
// 沿二次贝塞尔弧线飞到下一个随机落点
function wander(f) {
  if (!f.isConnected || f.dataset.free) return;
  const p = f._p;
  const far = Math.random() < 0.22;
  const r = far ? 95 : 36;
  const q = {
    x: clampTo(p.x + rand(-r, r), 8, JAR_W - 18),
    y: clampTo(p.y + rand(-r, r), 12, JAR_H - 20),
  };
  // 控制点也限制在罐内，弧线就不会穿出玻璃
  const c = {
    x: clampTo((p.x + q.x) / 2 + rand(-34, 34), 8, JAR_W - 18),
    y: clampTo((p.y + q.y) / 2 + rand(-34, 34), 12, JAR_H - 20),
  };
  const frames = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8,
      u = 1 - t;
    const x = u * u * p.x + 2 * u * t * c.x + t * t * q.x;
    const y = u * u * p.y + 2 * u * t * c.y + t * t * q.y;
    frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` });
  }
  const dist = Math.hypot(q.x - p.x, q.y - p.y);
  const a = f.animate(frames, {
    duration: 600 + dist * rand(16, 34),
    easing: 'ease-in-out',
    fill: 'forwards',
  });
  a.onfinish = () => {
    if (!f.isConnected || f.dataset.free) return;
    f._p = q;
    f.style.transform = `translate(${q.x}px, ${q.y}px)`;
    a.cancel();
    setTimeout(() => wander(f), Math.random() < 0.3 ? rand(400, 1600) : rand(0, 120));
  };
}
// 一闪一闪：暗下去再亮起来，间隔随机
function blink(f) {
  if (!f.isConnected || f.dataset.free) return;
  f.animate(
    [
      { opacity: 1, filter: 'brightness(1)' },
      { opacity: 0.2, filter: 'brightness(.6)', offset: 0.45 },
      { opacity: 1, filter: 'brightness(1.4)' },
    ],
    { duration: rand(700, 1600), easing: 'ease-in-out' },
  ).onfinish = () => setTimeout(() => blink(f), rand(500, 3200));
}
// 揭晓：每只从当前位置绕向瓶口，再依次飞出去
function freeFlies(scr) {
  scr.querySelectorAll('.c9 .jar .fly').forEach((f, i) => {
    const p = f.classList.contains('js') ? flyXY(f) : { x: JAR_W / 2, y: JAR_H / 2 };
    f.dataset.free = '1';
    f.getAnimations().forEach((a) => a.cancel());
    f.classList.add('js');
    const neck = { x: JAR_W / 2 - 4 + rand(-14, 14), y: -12 };
    // 先在罐内绕向瓶口（避开上方圆角），再从瓶口飞出
    const mid = {
      x: clampTo((p.x + neck.x) / 2 + rand(-40, 40), 40, JAR_W - 48),
      y: clampTo((p.y + neck.y) / 2 + rand(-10, 20), 40, JAR_H - 30),
    };
    const out = { x: neck.x + rand(-130, 130), y: rand(-360, -260) };
    const tr = (o) => `translate(${o.x.toFixed(1)}px, ${o.y.toFixed(1)}px)`;
    f.animate(
      [
        { transform: tr(p), opacity: 1 },
        { transform: tr(mid), opacity: 1, offset: 0.35 },
        { transform: tr(neck), opacity: 1, offset: 0.6 },
        { transform: tr(out), opacity: 0 },
      ],
      { duration: rand(2400, 3400), delay: 500 + i * 90, easing: 'ease-in', fill: 'forwards' },
    );
  });
}

function renderCard(id) {
  const c = concepts.find((x) => x.id === id);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  const wrap = card?.querySelector('.phone-wrap');
  if (c && wrap) {
    const pos = filmPos(card.parentElement);
    const fpos = flyPos(card.parentElement);
    wrap.innerHTML = screen(c, dataFor(id));
    keepFilm(card.parentElement, { [id]: pos[id] });
    startFlies(card, { [id]: fpos[id] });
  }
  return wrap?.querySelector('.screen');
}
const clearStories = () => Object.keys(STORY).forEach((k) => delete STORY[k]);

function render() {
  let html = '',
    last = '';
  for (const c of concepts) {
    if (c.group !== last) {
      html += `<h2 class="gal-h">${t('group.' + c.group)}</h2>`;
      last = c.group;
    }
    html +=
      `<article class="card" data-id="${c.id}" aria-label="${c.no} ${nameOf(c)}">` +
      `<header class="card-h"><span class="no">${c.no}</span><div><h2>${nameOf(c)}</h2><p>${altName(c)}</p></div></header>` +
      `<div class="card-ctl"><button type="button" class="ctl" data-play="${c.id}" title="${t('play.title')}">${ic('play')}${t('play')}</button><span class="step" id="step-${c.id}" aria-live="polite"></span></div>` +
      `<div class="phone-wrap">${screen(c, dataFor(c.id))}</div>` +
      `<div class="notes"><div class="vote-bar" data-votebar="${c.id}"></div><p class="key">${L(c.key)}</p><ul>${L(
        c.notes,
      )
        .map((n) => `<li>${n}</li>`)
        .join('')}</ul><p class="fonts">${t('fonts')} · ${c.fonts}</p></div>` +
      `</article>`;
  }
  const pos = filmPos($('gallery'));
  const fpos = flyPos($('gallery'));
  $('gallery').innerHTML = html;
  keepFilm($('gallery'), pos);
  startFlies($('gallery'), fpos);
  applyPick();
  paintVotes();
}

function renderReview() {
  $('review-body').innerHTML = concepts
    .map(
      (c) =>
        `<tr><th scope="row"><span>${c.no}</span>${nameOf(c)}</th><td>${L(c.review[0])}</td><td>${L(c.review[1])}</td><td>${L(c.review[2])}</td><td data-vote="${c.id}"></td></tr>`,
    )
    .join('');
}

/* ---------- Issue 投票与评论 ---------- */
// 读取：打开页面时通过 GitHub 公共接口读取评审 Issue 的评论（不需要登录，每小时 60 次）。
// 写入：投票和评论都在 GitHub 上完成；静态页面无法替人登录或代为点赞。
const REPO = 'Collaboration95/rewind-app';
const votes = {};
let voteMode = 'none'; // none：Issue 未发布；live：真实数据；sample：样式预览
// 评论内容来自 GitHub，显示前一律转义
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
// 评论归属：引用回复里带着方向标题，或以编号开头（如 “07:”）
const tagsFor = () => [
  ...concepts.map((c) => ({
    id: c.id,
    re: new RegExp(`(^|[^0-9])${c.no}\\s*[·.:：]|${c.en}|#${c.id}\\b`, 'i'),
  })),
  ...[...'abcdefg'].map((v) => ({
    id: 'nav-' + v,
    re: new RegExp(`dock\\s*${v}\\b|底栏\\s*${v.toUpperCase()}(?![a-z])`, 'i'),
  })),
];
const plain = (md) =>
  md
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join(' ')
    .replace(/<!--[\s\S]*?-->|<[^>]+>/g, '')
    .replace(/[#*_`[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function link(v, inner, cls) {
  return voteMode === 'live'
    ? `<a class="${cls}" href="${esc(v.url)}" target="_blank" rel="noreferrer">${inner}</a>`
    : `<span class="${cls}">${inner}</span>`;
}
// 评审表与侧栏用的紧凑版
function voteChip(id) {
  const v = votes[id];
  if (!v) return '<span class="vote-none">—</span>';
  return link(
    v,
    `<span>👍 ${v.up}</span><span>❤️ ${v.heart}</span><span>💬 ${v.count}</span>`,
    'vote',
  );
}
// 每个方向下面的投票栏
function voteBar(id) {
  const v = votes[id];
  if (!v)
    return voteMode === 'none'
      ? `<p class="vb-off">${t('vb.off')}</p>`
      : `<p class="vb-off">${t('vb.empty')}</p>`;
  const list = v.latest
    .map((c) =>
      link(
        c,
        c.sample
          ? `<b>${t('vb.sampleWho')}</b><span>${t('vb.sampleText')}</span>`
          : `<b>${esc(c.who)}</b><span>${esc(c.text)}</span>`,
        'vb-item',
      ),
    )
    .join('');
  return (
    `<div class="vb-row">${link(v, `👍 <b>${v.up}</b>`, 'vb')}${link(v, `❤️ <b>${v.heart}</b>`, 'vb')}${link(v, `💬 <b>${v.count}</b>`, 'vb')}` +
    `${voteMode === 'live' ? link(v, t('vb.go'), 'vb go') : `<span class="vb sample">${t('vb.sample')}</span>`}</div>` +
    (list ? `<div class="vb-list">${list}</div>` : '')
  );
}
function paintVotes() {
  document
    .querySelectorAll('[data-vote]')
    .forEach((el) => (el.innerHTML = voteChip(el.dataset.vote)));
  document
    .querySelectorAll('[data-votebar]')
    .forEach((el) => (el.innerHTML = voteBar(el.dataset.votebar)));
}

// 样式预览：只填数字和占位文字，不编造任何组员意见
function sampleVotes(on) {
  Object.keys(votes).forEach((k) => delete votes[k]);
  voteMode = on ? 'sample' : 'none';
  document.body.classList.toggle('has-issue', on);
  if (on) {
    concepts.forEach((c, i) => {
      const count = (i * 3) % 4;
      votes[c.id] = {
        up: (i * 7 + 3) % 6,
        heart: i % 4 === 0 ? 1 : 0,
        count,
        latest: count ? [{ sample: true }] : [],
      };
    });
    [...'abcdefg'].forEach(
      (v, i) =>
        (votes['nav-' + v] = { up: [2, 1, 0, 1, 2, 3, 0][i], heart: 0, count: 0, latest: [] }),
    );
  }
  paintVotes();
}

async function loadVotes() {
  const n = window.REVIEW_ISSUE;
  const st = $('vote-status');
  if (!n) {
    st.textContent = t('vote.none');
    return;
  }
  voteMode = 'live';
  document.body.classList.add('has-issue', 'live-issue');
  st.innerHTML = t('vote.live', {
    n: `<a href="https://github.com/${REPO}/issues/${Number(n)}" target="_blank" rel="noreferrer">#${Number(n)}</a>`,
  });
  try {
    let all = [];
    for (let page = 1; page < 5; page++) {
      const r = await fetch(
        `https://api.github.com/repos/${REPO}/issues/${Number(n)}/comments?per_page=100&page=${page}`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (!r.ok) throw new Error(String(r.status));
      const list = await r.json();
      all = all.concat(list);
      if (list.length < 100) break;
    }
    const tags = tagsFor();
    for (const c of all) {
      const m = /<!--\s*rewind-concept:(c\d+|nav-[a-g])\s*-->/.exec(c.body || '');
      if (m)
        votes[m[1]] = {
          up: c.reactions?.['+1'] ?? 0,
          heart: c.reactions?.heart ?? 0,
          url: c.html_url,
          count: 0,
          latest: [],
        };
    }
    for (const c of all) {
      const body = c.body || '';
      if (/rewind-concept:/.test(body)) continue;
      for (const t of tags) {
        const v = votes[t.id];
        if (!v || !t.re.test(body)) continue;
        v.count += 1;
        v.latest.unshift({
          who: c.user?.login || '',
          text: plain(body).slice(0, 90),
          url: c.html_url,
        });
        v.latest = v.latest.slice(0, 2);
      }
    }
    paintVotes();
  } catch {
    st.innerHTML += t('vote.fail');
  }
}

function renderPick() {
  let html = `<button type="button" data-pick="all"><span>··</span>${t('pick.all')}</button>`,
    last = '';
  for (const c of concepts) {
    if (c.group !== last) {
      html += `<p class="pick-h">${t('group.' + c.group)}</p>`;
      last = c.group;
    }
    html += `<button type="button" data-pick="${c.id}"><span>${c.no}</span>${nameOf(c)}</button>`;
  }
  $('pick').innerHTML = html;
  applyPick();
}

// 窄屏时按可用宽度自动缩小手机，避免横向滚动
const fitScale = () => Math.min(1, ($('gallery').clientWidth || 410) / 410);
const setZoom = (v) => {
  $('zoom').value = v;
  $('zoomv').textContent = v + '%';
  document.documentElement.style.setProperty('--s', Math.min(v / 100, fitScale()));
};
addEventListener('resize', () => setZoom($('zoom').value));

function applyPick() {
  document
    .querySelectorAll('[data-pick]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === current)));
  document.body.classList.toggle('single', current !== 'all');
  $('gallery').classList.toggle('single', current !== 'all');
  document
    .querySelectorAll('.card')
    .forEach((c) => c.classList.toggle('show', c.dataset.id === current));
}
function pick(id) {
  current = id;
  applyPick();
  setZoom(id === 'all' ? 72 : 100);
  playIntro();
  try {
    history.replaceState(null, '', id === 'all' ? location.pathname + location.search : '#' + id);
  } catch {
    /* 在受限的框架里改不了地址栏也没关系 */
  }
}

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

function flashTip(btn, text) {
  btn.querySelector('.tip.flash')?.remove();
  const tip = document.createElement('span');
  tip.className = 'tip flash';
  tip.setAttribute('aria-hidden', 'true');
  tip.textContent = text;
  btn.appendChild(tip);
  setTimeout(() => tip.remove(), 1900);
}

/* ---------- 动效：朋友加入 与 你按快门 ----------
   两者刻意区分：
   · 朋友加入——你看不到他拍了什么，只知道他来了：从屏幕外进来，用这个方向自己的隐喻，不出现照片。
   · 你按快门——你知道自己拍了什么：从快门出发，你的照片变成这个方向的隐喻物件。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const play = (el, frames, opts) =>
  new Promise((res) => {
    const a = el.animate(frames, opts);
    a.onfinish = () => res();
    a.oncancel = () => res();
  });
// 元素中心在手机画面里的坐标（画面按缩放比例换算回 390 宽）
function pt(scr, el) {
  const sr = scr.getBoundingClientRect(),
    k = sr.width / 390,
    r = (el || scr).getBoundingClientRect();
  return { x: (r.left + r.width / 2 - sr.left) / k, y: (r.top + r.height / 2 - sr.top) / k };
}
// 给元素挂一个一次性的效果类
function fx(el, cls, ms = 1000) {
  if (!el) return;
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}
const sweep = (el, cls, ms) => (fx(el, cls, ms), wait(ms));
const glow = (c) => `0 0 10px 4px ${c}, 0 0 26px 10px ${c}55`;

// 你的照片（正面是照片，背面按方向不同：锁 / 负片）
function card(scr, at, mine, back = 'lock') {
  const photo = photoFor(mine.c * 5 + 3, mine.col);
  const el = document.createElement('div');
  el.className = 'flyer';
  el.style.left = at.x + 'px';
  el.style.top = at.y + 'px';
  el.innerHTML =
    `<i class="face front" style="background-image:url(${photo})"></i>` +
    (back === 'negative'
      ? `<i class="face back negative" style="background-image:url(${photo})"></i>`
      : `<i class="face back">${ic('lock')}</i>`);
  scr.appendChild(el);
  return el;
}
// 照片沿弧线飞到目标：flip 翻面；dissolve 化成光；endScale 落点大小
function cardFly(scr, from, to, mine, o = {}) {
  const { flip = true, dissolve = false, endScale = 0.3, lift = 70, dur = 1300, back } = o;
  const el = card(scr, from, mine, back);
  const dx = to.x - from.x,
    dy = to.y - from.y,
    y = flip ? 180 : 0;
  const at = (p, l, extra) =>
    `perspective(600px) translate(calc(-50% + ${dx * p}px), calc(-50% + ${dy * p - l}px)) ${extra}`;
  return play(
    el,
    [
      { transform: at(0, 0, 'scale(.4) rotateY(0deg)'), opacity: 0, filter: 'none' },
      {
        transform: at(0.2, lift, 'scale(1.15) rotateY(0deg) rotate(-6deg)'),
        opacity: 1,
        filter: 'none',
        offset: 0.3,
      },
      {
        transform: at(0.6, lift * 0.55, `scale(1) rotateY(${y}deg) rotate(4deg)`),
        opacity: 1,
        filter: dissolve ? 'blur(2px) brightness(1.4)' : 'none',
        offset: 0.68,
      },
      {
        transform: at(1, 0, `scale(${endScale}) rotateY(${y}deg)`),
        opacity: 0,
        filter: dissolve ? 'blur(12px) brightness(2.4)' : 'none',
      },
    ],
    { duration: dur, easing: 'cubic-bezier(.3,.7,.3,1)' },
  ).then(() => el.remove());
}
// 一点光沿路径飞：wander 先绕一圈再进；toColor 进去之后变色
function dotFly(scr, from, to, color, o = {}) {
  const { size = 12, dur = 1500, wander = false, toColor, firefly = false } = o;
  const d = document.createElement('i');
  d.className = firefly ? 'orb-dot firefly' : 'orb-dot';
  d.style.cssText = `left:${from.x}px;top:${from.y}px;width:${size}px;height:${size}px;margin:${-size / 2}px 0 0 ${-size / 2}px;--mc:${color}`;
  scr.appendChild(d);
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const c0 = { background: color, boxShadow: glow(color) };
  const c1 = toColor ? { background: toColor, boxShadow: glow(toColor) } : c0;
  const frames = wander
    ? [
        { transform: 'translate(0,0) scale(.4)', opacity: 0, ...c0, offset: 0 },
        {
          transform: `translate(${dx * 0.3}px, ${dy * 0.15 - 40}px) scale(1.2)`,
          opacity: 1,
          ...c0,
          offset: 0.22,
        },
        {
          transform: `translate(${dx * 0.55 + 46}px, ${dy * 0.4 + 16}px) scale(1)`,
          opacity: 0.6,
          ...c0,
          offset: 0.42,
        },
        {
          transform: `translate(${dx * 0.8 - 34}px, ${dy * 0.62 - 34}px) scale(1.15)`,
          opacity: 1,
          ...c0,
          offset: 0.62,
        },
        { transform: `translate(${dx}px, ${dy - 26}px) scale(1)`, opacity: 1, ...c0, offset: 0.8 },
        {
          transform: `translate(${dx}px, ${dy + 18}px) scale(.8)`,
          opacity: 1,
          ...c1,
          offset: 0.93,
        },
        { transform: `translate(${dx}px, ${dy + 26}px) scale(.6)`, opacity: 0, ...c1, offset: 1 },
      ]
    : [
        { transform: 'translate(0,0) scale(.4)', opacity: 0, ...c0 },
        {
          transform: `translate(${dx * 0.25 - 30}px, ${dy * 0.15 - 30}px) scale(1.3)`,
          opacity: 1,
          ...c0,
          offset: 0.25,
        },
        {
          transform: `translate(${dx * 0.7}px, ${dy * 0.6 - 40}px) scale(1)`,
          opacity: 1,
          ...c0,
          offset: 0.7,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(.5)`, opacity: 0, ...c1 },
      ];
  return play(d, frames, { duration: dur, easing: 'cubic-bezier(.35,.6,.3,1)' }).then(() =>
    d.remove(),
  );
}
// 照片先在快门上方缩成一点光，再以光的样子飞向目标（萤火虫、木炭）
async function cardToDot(scr, from, to, mine, color, o = {}) {
  const el = card(scr, from, mine);
  const mx = -40,
    my = -120;
  await play(
    el,
    [
      { transform: 'translate(-50%,-50%) scale(.4)', opacity: 0, filter: 'none' },
      {
        transform: `translate(calc(-50% + ${mx}px), calc(-50% + ${my}px)) scale(1.1)`,
        opacity: 1,
        filter: 'none',
        offset: 0.45,
      },
      {
        transform: `translate(calc(-50% + ${mx}px), calc(-50% + ${my}px)) scale(.1)`,
        opacity: 0.9,
        filter: 'blur(3px) brightness(2.6)',
      },
    ],
    { duration: 950, easing: 'cubic-bezier(.3,.7,.3,1)' },
  );
  el.remove();
  await dotFly(scr, { x: from.x + mx, y: from.y + my }, to, color, { size: 10, dur: 1150, ...o });
}
// 火星向上飘
function sparks(scr, at, n = 10) {
  for (let i = 0; i < n; i++) {
    const e = document.createElement('i');
    e.className = 'spark';
    e.style.cssText = `left:${at.x}px;top:${at.y}px`;
    scr.appendChild(e);
    const a = (i / n) * Math.PI * 2;
    play(
      e,
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        {
          transform: `translate(${Math.cos(a) * 34}px, ${-70 - (i % 4) * 22}px) scale(.3)`,
          opacity: 0,
        },
      ],
      { duration: 900 + (i % 3) * 250, easing: 'cubic-bezier(.2,.7,.3,1)' },
    ).then(() => e.remove());
  }
}
const q = (root, sel) => root?.querySelector(sel);
const lastOf = (root, sel) => {
  const all = root?.querySelectorAll(sel);
  return all?.length ? all[all.length - 1] : null;
};
const EDGE_R = { x: 384, y: 170 };
const EDGE_L = { x: 6, y: 130 };

// 每个方向的一对动画：join 发生在数据变化前；joined 在重绘后点亮新出现的元素。seal / sealed 同理。
const FX = {
  c1: {
    // 暗房：安全灯的红光扫过胶片——有人曝了一格；你的照片翻过来变成它自己的负片
    join: (scr) => sweep(q(scr, '.strip'), 'fx-safelight', 1200),
    joined: (ns, f) => fx(q(ns, `.mini-crew [data-who="${f.name}"]`), 'fx-pop', 700),
    seal: (scr, btn, me) =>
      cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.strip')), me, {
        back: 'negative',
        endScale: 0.5,
      }),
    sealed: (ns) => fx(q(ns, '.strip'), 'absorb', 900),
  },
  c2: {
    // 相纸：放大机曝光一闪；你的那格被油性笔圈出来
    join: (scr) => sweep(q(scr, '.neg'), 'fx-expose', 1100),
    joined: (ns) => fx(q(ns, 'figcaption strong .is-pre'), 'fx-roll', 700),
    seal: (scr, btn, me) => cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.neg')), me),
    sealed: (ns) => fx(lastOf(ns, '.grid5 .fr.mine'), 'fx-grease', 1400),
  },
  c3: {
    // 玻璃胶囊：他颜色的一点光融进光球；你的照片化成光溶进去
    join: (scr, f) => dotFly(scr, EDGE_R, pt(scr, q(scr, '.hero b')), f.col),
    joined: (ns) => fx(q(ns, '.hero b .is-pre'), 'fx-roll', 700),
    seal: (scr, btn, me) =>
      cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.hero b')), me, { flip: false, dissolve: true }),
    sealed: (ns) => fx(q(ns, '.hero b .is-pre'), 'fx-roll', 700),
  },
  c4: {
    // 首映票根：他的座位被“盖章”入座；你的照片飞进票面，Reels 数字翻动
    join: () => wait(250),
    joined: (ns, f) => fx(q(ns, `.seat[data-who="${f.name}"]`), 'fx-stamp', 900),
    seal: (scr, btn, me) =>
      cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.t-main dl div:nth-child(3) dd')), me),
    sealed: (ns) => {
      fx(q(ns, '.t-main dl div:nth-child(3) dd'), 'fx-roll', 700);
      fx(lastOf(ns, '.rf i.on'), 'fx-pop', 700);
    },
  },
  c5: {
    // 极简排版：不用图，只让对应的那一行横线伸长、数字翻动
    join: () => wait(250),
    joined: (ns) => fx(q(ns, '.table .tr:nth-of-type(1)'), 'fx-bar', 1000),
    seal: () => wait(200),
    sealed: (ns) => {
      fx(q(ns, '.table .tr:nth-of-type(2)'), 'fx-bar', 1000);
      fx(q(ns, '.table .tr:nth-of-type(3)'), 'fx-bar', 1000);
    },
  },
  c6: {
    // 暖光玻璃：一粒暖光飘进阳光里；你的照片化成阳光
    join: (scr, f) =>
      dotFly(scr, EDGE_R, pt(scr, q(scr, '.hero b')), f.col, { toColor: '#ffc98a' }),
    joined: (ns) => fx(q(ns, '.hero b .is-pre'), 'fx-roll', 700),
    seal: (scr, btn, me) =>
      cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.hero b')), me, { flip: false, dissolve: true }),
    sealed: (ns) => fx(q(ns, '.hero b .is-pre'), 'fx-roll', 700),
  },
  c7: {
    // 围炉：一点光落到他的空座，光环画一圈，再有火星飘进火里；
    // 你的照片化成一块发光的木炭添进火里——添一份温度，而不是烧掉照片
    join: (scr, f) =>
      dotFly(scr, EDGE_R, pt(scr, q(scr, `.seat[data-who="${f.name}"]`)), f.col, { dur: 1300 }),
    joined: async (ns, f) => {
      const seat = q(ns, `.seat[data-who="${f.name}"]`);
      fx(seat, 'fx-arrive', 1100);
      await wait(500);
      if (!ns.isConnected) return;
      await dotFly(ns, pt(ns, seat), pt(ns, q(ns, '.mid')), f.col, { size: 7, dur: 800 });
      fx(q(ns, '.fire'), 'fx-flare', 1000);
    },
    seal: async (scr, btn, me) => {
      await cardToDot(scr, pt(scr, btn), pt(scr, q(scr, '.mid')), me, '#ffb060');
      fx(q(scr, '.fire'), 'fx-flare', 1000);
      sparks(scr, pt(scr, q(scr, '.mid')));
      await wait(350);
    },
    sealed: (ns) => fx(q(ns, '.seat.me .ring'), 'fx-pop', 700),
  },
  c8: {
    // 蜡封信：他的邮票“啪”地贴上；你的照片滑进信封，蜡封再压一下
    join: () => wait(250),
    joined: (ns, f) => fx(q(ns, `.stamp[data-who="${f.name}"]`), 'fx-slap', 900),
    seal: (scr, btn, me) =>
      cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.seal')), me, {
        flip: false,
        endScale: 0.2,
        dur: 1200,
      }),
    sealed: (ns) => fx(q(ns, '.seal'), 'fx-press', 900),
  },
  c9: {
    // 萤火虫罐：一只他颜色的萤火虫从暮色里绕一圈，从瓶口飞进去，进罐后变成暖金色（谁的就不知道了）；
    // 你的照片在快门上方缩成一只你颜色的萤火虫，再飞进罐里
    join: (scr, f) =>
      dotFly(scr, EDGE_L, pt(scr, q(scr, '.jar .neck')), f.col, {
        size: 9,
        dur: 2100,
        wander: true,
        toColor: '#F2C07A',
        firefly: true,
      }),
    joined: (ns) => fx(q(ns, '.caught b'), 'fx-roll', 700),
    seal: (scr, btn, me) =>
      cardToDot(scr, pt(scr, btn), pt(scr, q(scr, '.jar .neck')), me, me.col, {
        wander: true,
        size: 13,
        firefly: true,
      }),
    sealed: (ns) => fx(q(ns, '.jar .body'), 'absorb', 900),
  },
  c10: {
    // 放映夜：放映机闪一下，他的名字像打字一样出现在 Starring 里；你的照片被装进放映机，光束一亮
    join: (scr) => sweep(q(scr, '.beam'), 'fx-flicker', 900),
    joined: (ns, f) => fx(q(ns, `.names [data-who="${f.name}"]`), 'fx-type', 1300),
    seal: async (scr, btn, me) => {
      await cardFly(scr, pt(scr, btn), pt(scr, q(scr, '.projector')), me, {
        flip: false,
        endScale: 0.08,
        lift: 130,
      });
      await sweep(q(scr, '.beam'), 'fx-flicker', 700);
    },
    sealed: (ns) => fx(lastOf(ns, '.rf i.on'), 'fx-pop', 700),
  },
  c11: {
    // 共同片轨：一格新片段从右边滑进来，他的标签打上 ✓；你的照片缩成你颜色的一格嵌进去
    join: () => wait(250),
    joined: (ns, f) => {
      fx(lastOf(ns, '.reelbar i'), 'fx-slidein', 800);
      fx(q(ns, `.pchip[data-who="${f.name}"]`), 'fx-pop', 700);
    },
    seal: (scr, btn, me) =>
      cardFly(scr, pt(scr, btn), pt(scr, lastOf(scr, '.reelbar i') || q(scr, '.reelbar')), me, {
        flip: false,
        endScale: 0.45,
      }),
    sealed: (ns) => fx(lastOf(ns, '.reelbar i.mine'), 'fx-pop', 700),
  },
};

// 你按快门：封存一个片段
async function sealFlight(scr, btn, then) {
  if (NAV.shutter !== 'collect' || scr.classList.contains('revealed')) return then?.();
  const id = scr.classList[1];
  const mine = storyPool(id)[0];
  if (mine.c >= 5) {
    flashTip(btn, 'All 5 used this week');
    return then?.();
  }
  const S = FX[id] || {};
  if (!reduceMotion() && S.seal) await S.seal(scr, btn, mine);
  if (!scr.isConnected) return;
  mine.c += 1;
  const ns = renderCard(id);
  if (ns) {
    S.sealed?.(ns);
    const nb = ns.querySelector('.shutter');
    if (nb) flashTip(nb, 'Sealed · not even you can peek');
  }
  then?.();
}

// 朋友加入：一位还没参与的朋友添了一个片段
async function gatherFlight(scr, then) {
  const id = scr.classList[1];
  const friend = storyPool(id)
    .slice(0, size)
    .find((x) => !x.me && x.c === 0);
  if (!friend) return then?.();
  const S = FX[id] || {};
  if (!reduceMotion() && S.join) await S.join(scr, friend);
  if (!scr.isConnected) return;
  friend.c = 1;
  const ns = renderCard(id);
  if (ns) {
    toast(ns, friend, `${friend.name} added a moment`);
    if (!reduceMotion()) await S.joined?.(ns, friend);
  }
  then?.();
}

function toast(scr, who, text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `<i style="--mc:${who.col}">${who.name[0]}</i>${text}`;
  scr.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// 揭晓：周日 8 点，所有人同一时刻打开；每个方向有自己的拆封动效
function reveal(scr) {
  scr.classList.add('revealed');
  if (scr.classList.contains('c9') && !reduceMotion()) freeFlies(scr);
  const btn = scr.querySelector('.shutter');
  if (btn) {
    btn.setAttribute('aria-label', 'Watch the premiere together');
    btn.innerHTML = `${arcRing(0.999)}<span class="core">${ic('play')}</span>`;
    flashTip(btn, 'Premiere · watch together');
  }
}

// 播放：①朋友加入 → ②你按快门封存 → ③时间到，一起揭晓
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
  gatherFlight(scrOf(), () =>
    later(700, () => {
      setStep(id, t('step.2'));
      const scr = scrOf();
      const btn = scr?.querySelector('.shutter');
      if (!scr || !btn) return;
      btn.classList.add('press');
      sealFlight(scr, btn, () =>
        later(1300, () => {
          setStep(id, t('step.3'));
          const s2 = scrOf();
          if (s2) reveal(s2);
          later(3200, () => setStep(id, t('step.done')));
        }),
      );
    }),
  );
}
function resetCard(id) {
  (TIMERS[id] || []).forEach(clearTimeout);
  TIMERS[id] = [];
  delete STORY[id];
  renderCard(id);
  setStep(id, '');
}

const closeSheets = () =>
  document.querySelectorAll('.screen.open').forEach((s) => s.classList.remove('open'));

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-close]');
  if (!t) return;
  if (t.dataset.pick) return pick(t.dataset.pick);
  if (t.dataset.lang) return setLang(t.dataset.lang);
  if (t.dataset.nav) {
    NAV.variant = t.dataset.nav;
    document
      .querySelectorAll('[data-nav]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    return render();
  }
  if (t.dataset.anon) {
    anon = t.dataset.anon === '1';
    document
      .querySelectorAll('[data-anon]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    return render();
  }
  if (t.dataset.play) return playStory(t.dataset.play);
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
  if (t.classList.contains('me')) {
    const open = !scr.classList.contains('open');
    closeSheets();
    scr.classList.toggle('open', open);
    return;
  }
  if (t.hasAttribute('data-close')) return scr.classList.remove('open');
  if (t.classList.contains('live')) {
    t.closest('.dock')?.classList.add('open');
    t.setAttribute('aria-expanded', 'true');
    return;
  }
  if (t.classList.contains('tab')) {
    // 缩小态下，点小胶囊先展开
    if (scr.classList.contains('mini')) return scr.classList.remove('mini');
    t.parentElement.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('on', b === t);
      if (b === t) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const dg = t.closest('.dock-g');
    if (dg) setTimeout(() => dg.classList.remove('open'), 450);
    return;
  }
  if (t.classList.contains('shutter')) {
    if (t.getAttribute('aria-disabled') === 'true') return;
    t.classList.remove('press');
    void t.offsetWidth;
    t.classList.add('press');
    sealFlight(scr, t);
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheets());
$('zoom').addEventListener('input', (e) => setZoom(e.target.value));
$('shutter-state').addEventListener('change', (e) => {
  NAV.shutter = e.target.value;
  render();
});
$('unread').addEventListener('change', (e) => {
  NAV.unread = e.target.checked;
  render();
});
// “滚动缩小”变体：往下滚缩小，往上滚展开
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target;
    if (NAV.variant !== 'c' || !el.classList?.contains('scroll')) return;
    const last = Number(el.dataset.y || 0);
    const scr = el.closest('.screen');
    if (el.scrollTop > last + 4 && el.scrollTop > 24) scr.classList.add('mini');
    else if (el.scrollTop < last - 4) scr.classList.remove('mini');
    el.dataset.y = el.scrollTop;
  },
  true,
);
$('vote-sample').addEventListener('change', (e) => sampleVotes(e.target.checked));
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
  renderPick();
  renderReview();
  render();
  if (voteMode === 'sample') sampleVotes(true);
  else if (voteMode === 'none') $('vote-status').textContent = t('vote.none');
  else loadVotes();
}

applyI18n();
$('membersv').textContent = t('members.unit', { n: size });
renderPick();
renderReview();
render();
setZoom($('zoom').value);
// 支持 index.html#c9 直接打开某个方案。
// htmlpreview 会把脚本改成内联执行，那时锚点可能还没就位，所以加载完成后再检查一次。
const openFromHash = () => {
  const h = location.hash.slice(1);
  if (h !== current && concepts.some((c) => c.id === h)) pick(h);
};
openFromHash();
addEventListener('load', openFromHash);
addEventListener('hashchange', openFromHash);
setTimeout(openFromHash, 400);
loadVotes();
playIntro();
