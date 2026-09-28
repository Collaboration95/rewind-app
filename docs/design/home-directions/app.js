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

function data() {
  const members = POOL.slice(0, size);
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
function ring(used = 2, total = 5, r = 35, c = 38, gap = 9) {
  const pt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
  };
  let segs = '';
  for (let i = 0; i < total; i++) {
    const a0 = -90 + (i * 360) / total + gap / 2;
    const a1 = -90 + ((i + 1) * 360) / total - gap / 2;
    segs += `<path class="seg${i < used ? ' on' : ''}" d="M${pt(a0)}A${r} ${r} 0 0 1 ${pt(a1)}"/>`;
  }
  return `<svg class="ring" viewBox="0 0 ${c * 2} ${c * 2}" aria-hidden="true">${segs}</svg>`;
}

const statusBar = () =>
  `<div class="sb" aria-hidden="true"><span>9:41</span><span class="island"></span><span class="sys">` +
  `<svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx=".7"/><rect x="5" y="5.5" width="3" height="6.5" rx=".7"/><rect x="10" y="3" width="3" height="9" rx=".7"/><rect x="15" y="0" width="3" height="12" rx=".7" opacity=".35"/></svg>` +
  `<svg viewBox="0 0 16 12"><path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0z"/><path d="M3.4 6.8a6.5 6.5 0 0 1 9.2 0l-1.4 1.4a4.5 4.5 0 0 0-6.4 0z"/><path d="M1.2 4.6a9.6 9.6 0 0 1 13.6 0l-1.4 1.4a7.6 7.6 0 0 0-10.8 0z"/></svg>` +
  `<svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="23" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="8" rx="2"/><rect x="24.5" y="4" width="1.8" height="4" rx=".9" opacity=".4"/></svg>` +
  `</span></div>`;

const dock = (d) =>
  `<nav class="dock" aria-label="Main navigation"><div class="tabs">` +
  [
    ['home', 'Home'],
    ['chat', 'Chat'],
    ['archive', 'Archive'],
  ]
    .map(
      ([k, l], i) =>
        `<button type="button" class="tab${i === 0 ? ' on' : ''}"${i === 0 ? ' aria-current="page"' : ''}>${ic(k)}<span>${l}</span></button>`,
    )
    .join('') +
  `</div><button type="button" class="shutter" aria-label="Add a moment · ${5 - d.me.c} of 5 left">${ring(d.me.c)}<span class="core">${ic('camera')}</span></button></nav>`;

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
        `<span class="av${x.c ? '' : ' wait'}" style="--mc:${x.col}" title="${hidden(x) ? 'Not yet' : x.name}">${init(x)}</span>`,
    )
    .join('');
const bars = (cls, used, total = 5) =>
  `<div class="${cls}" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<i${i < used ? ' class="on"' : ''}></i>`).join('')}</div>`;
const tex = (i, k = 0) =>
  `--a:${((i * 29 + k * 41) % 70) + 15}%;--b:${((i * 47 + k * 23) % 60) + 20}%`;

/* ---------- 各方案 ---------- */
const bodies = {
  c1: (d) => `
    <header class="top">${me()}<span class="tag">ROLL 036</span></header>
    <p class="eyebrow"><i></i>Developing · private roll</p>
    <h1 class="title">Weekend People</h1>
    <div class="count" role="img" aria-label="2 days 14 hours until reveal">
      <div><b>02</b><span>Days</span></div><em>:</em><div><b>14</b><span>Hours</span></div>
    </div>
    <p class="when">Lights on for all of us at once · Sun 8:00 PM</p>
    <section class="strip" aria-label="Your roll: ${d.me.c} of 5 frames exposed and sealed">
      ${holes(24)}
      <div class="edge"><span>REWIND 400</span><span>YOUR ROLL · NO PEEKING ▸</span></div>
      <div class="frames">${Array.from({ length: 5 }, (_, k) =>
        k < d.me.c
          ? `<div class="fr sealed">${ic('lock')}<span>0${k + 1}</span></div>`
          : `<div class="fr${k === d.me.c ? ' next' : ''}">${k === d.me.c ? '<small>NEXT</small>' : ''}<span>0${k + 1}</span></div>`,
      ).join('')}</div>
      <div class="edge low"><span>01A</span><span>02A</span><span>03A</span><span>04A</span><span>05A</span></div>
      ${holes(24)}
    </section>
    <div class="meta"><span><b>${d.me.c}</b> of 5 exposed</span><span><b>${secs(d.me.c)}</b> / 30 sec</span></div>
    <section class="prompt"><p class="lbl">This week's prompt</p><h2>What made you pause and smile?</h2></section>
    <div class="crew"><div class="stack">${crew(d)}</div><p><b>${d.added} of ${d.n}</b> are in</p></div>`,

  c2: (d) => {
    const rh = Math.round(Math.max(15, Math.min(30, 150 / d.n)));
    return `
    <header class="top">${me()}<span class="tag">W36 · SEP</span></header>
    <p class="eyebrow">A week with your people</p>
    <h1 class="title">Weekend <i>People</i></h1>
    <figure class="neg" aria-label="Contact sheet: one row per member, ${plural(d.m, 'moment')} sealed until Sunday">
      ${holes(20)}
      <div class="rows" style="--rh:${rh}px">${d.shown
        .map(
          (x, i) =>
            `<div class="row${x.me ? ' me' : ''}" style="--mc:${x.col}"><b>${init(x)}</b>${Array.from(
              { length: 5 },
              (_, k) => `<i class="fr ${k < x.c ? 'sealed' : 'blank'}" style="${tex(i, k)}"></i>`,
            ).join('')}</div>`,
        )
        .join('')}</div>
      ${holes(20)}
      <figcaption><strong>${d.m} little ${d.m === 1 ? 'moment' : 'moments'}.</strong><span>Not even you can peek</span></figcaption>
    </figure>
    <p class="cap"><i>${d.added} of ${d.n} in · <em>${waitLine(d)}</em></i><span style="color:${d.me.col}">● you</span></p>
    <div class="when"><div><small>Open together in</small><strong>2 days, 14 hours</strong></div><div class="r"><small>Sunday</small><strong>8:00 PM</strong></div></div>
    <section class="prompt"><small>This week's prompt</small><h2>What made you pause and smile?</h2></section>
    <div class="week"><div><small>Your week</small>${bars('sq', d.me.c)}</div><p>${d.me.c} / 5 moments<br><span>${secs(d.me.c)} / 30 sec</span></p></div>`;
  },

  c3: (d) => `
    <div class="orb" aria-hidden="true"><i></i><i></i><i></i></div>
    <header class="top">${me(false)}<button type="button" class="grp">Weekend People ${ic('chev')}</button><span class="tag">W36</span></header>
    <section class="hero" aria-label="${plural(d.m, 'moment')} developing, sealed until reveal">
      <b>${d.m}</b><span>${d.m === 1 ? 'moment' : 'moments'} developing</span>
      <p class="chip">${ic('lock')} Sealed · not even you can peek</p>
    </section>
    <div class="count"><strong>2d 14h</strong><span>opens for all of us at once<br>Sunday · 8:00 PM</span></div>
    <section class="glass">
      <small>This week's prompt</small>
      <h2>What made you pause and smile?</h2>
      <div class="rowx"><div class="stack">${crew(d)}</div><span>${d.added} of ${d.n} in</span></div>
      <div class="rowx">${bars('pills', d.me.c)}<span>You · ${d.me.c}/5 · ${secs(d.me.c)}/30s</span></div>
    </section>`,

  c4: (d) => `
    <header class="top">${me(false)}<span class="mark">Rewind</span><span class="tag">Nº 036</span></header>
    <p class="eyebrow">Private premiere · all at once</p>
    <article class="ticket" aria-label="Premiere ticket: Weekend People, Sunday 28 September, 8:00 PM">
      <div class="t-main">
        <div class="t-row"><span>Admit ${word(d.n)}</span><span>Roll 036</span></div>
        <h1>Weekend People</h1>
        <p class="by">a film by ${word(d.n)} friends</p>
        <dl>
          <div><dt>Date</dt><dd>Sun 28 Sep</dd></div>
          <div><dt>Doors</dt><dd>8:00 PM</dd></div>
          <div><dt>Reels</dt><dd>${d.m} sealed</dd></div>
        </dl>
      </div>
      <div class="t-stub">
        <div class="curtain"><small>Curtain in</small><p><b>02</b><span>d</span><b>14</b><span>h</span></p></div>
        <div class="seats"><small>Seats · ${d.added} / ${d.n}</small><div>${d.shown
          .map(
            (x) =>
              `<span class="seat${x.c ? '' : ' empty'}" style="--mc:${x.col}" title="${hidden(x) ? 'Saved seat' : x.name}">${init(x)}</span>`,
          )
          .join('')}</div></div>
      </div>
    </article>
    <section class="feature"><small>Tonight's feature</small><h2>What made you pause and smile?</h2></section>
    <div class="reel"><small>Your reel</small>${bars('rf', d.me.c)}<span>${d.me.c} of 5 · ${secs(d.me.c)}/30 sec</span></div>`,

  c5: (d) => `
    <header class="top">${me(false)}<span class="tag">Weekend People <em>— W36</em></span></header>
    <p class="eyebrow"><i></i>Developing · ${plural(d.m, 'moment')} sealed</p>
    <div class="big" role="img" aria-label="Opens in 2 days 14 hours, Sunday 20:00"><b>02</b><div><span>days</span><strong>14 hrs</strong><span>Sun · 20:00</span></div></div>
    <p class="lead">until it opens for all ${word(d.n)} of us at once.</p>
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
    <section class="hero" aria-label="${plural(d.m, 'moment')}, sealed until Sunday">
      <p class="kept">kept warm for the ${word(d.n)} of us</p>
      <b>${d.m}</b>
      <span>little ${d.m === 1 ? 'moment' : 'moments'}</span>
      <p class="chip">${ic('lock')} Sealed · not even you can peek</p>
    </section>
    <div class="count"><strong>2 days, 14 hours</strong><span>opens for all of us at once · Sun 8 PM</span></div>
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
    const seats = d.shown
      .map((x, i) => {
        const a = ((-90 + (i * 360) / d.n) * Math.PI) / 180;
        return `<div class="seat${x.c ? '' : ' cold'}${x.me ? ' me' : ''}" style="--mc:${x.col};--ring-on:${x.col};left:${(CX + R * Math.cos(a)).toFixed(1)}px;top:${(CY + R * Math.sin(a)).toFixed(1)}px" title="${hidden(x) ? 'Saved seat' : `${x.name} · ${x.c}/5`}">${ring(x.c, 5, 24, 26, 14)}<span class="avatar">${init(x)}</span><small>${label(x)}</small></div>`;
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
    <section class="hearth" style="--heat:${heat}" aria-label="${d.n} members around the fire, ${plural(d.m, 'moment')} sealed">
      <div class="fire" aria-hidden="true"><i></i><i></i></div>
      ${embers}
      <div class="mid"><strong>2d 14h</strong><span>until we gather</span><span>Sunday · 8 PM</span></div>
      ${seats}
    </section>
    <p class="byfire"><b>${plural(d.m, 'moment')}</b> by the fire · sealed, even from you</p>
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
    <article class="env" aria-label="Sealed letter with ${plural(d.m, 'moment')} inside, opens Sunday 8 PM">
      <div class="flap-shadow"></div><div class="flap"></div>
      <span class="seal">${ic('rewind')}</span>
      <div class="addr"><small>To</small><p class="hand">Weekend People</p><small>From</small><p class="hand sm">the ${word(d.n)} of us</p></div>
      <div class="post" aria-hidden="true"><span>Opens</span><b>SUN</b><span>8 PM</span></div>
    </article>
    <div class="opens"><div><small>Opens for everyone in</small><strong>2 days, 14 hours</strong></div><div class="r"><small>Inside</small><strong>${plural(d.m, 'moment')}</strong></div></div>
    <section class="letter"><p class="hand">Dear us,</p><h2>What made you pause and smile?</h2></section>
    <section class="signed"><small>Sealed by · not even you can peek</small><div class="stamps">${d.shown
      .map(
        (x) =>
          `<span class="stamp${x.c ? '' : ' blank'}" style="--st:${x.col}" title="${hidden(x) ? 'Stamp still to come' : x.name}"><i>${init(x)}</i></span>`,
      )
      .join('')}</div><p>${waitLine(d)}</p></section>`,

  c9: (d) => {
    // 每个片段一只萤火虫，颜色 = 贡献者的专属色
    const flies = [];
    d.members.forEach((x) => {
      for (let k = 0; k < x.c; k++) flies.push(x.col);
    });
    const fl = flies
      .map(
        (col, i) =>
          `<i class="fly" style="--mc:${col};left:${8 + ((i * 37 + 11) % 80)}%;top:${10 + ((i * 53 + 7) % 78)}%;animation-delay:${-((i * 0.9) % 6).toFixed(1)}s;animation-duration:${5 + (i % 4)}s"></i>`,
      )
      .join('');
    return `
    <header class="top">${me(false)}<button type="button" class="grp">Weekend People ${ic('chev')}</button><span class="tag">W36</span></header>
    <section class="jarwrap" aria-label="${plural(d.m, 'moment')} caught in the jar, sealed until Sunday">
      <div class="jarglow" aria-hidden="true"></div>
      <div class="jar" aria-hidden="true"><span class="lid"></span><span class="neck"></span><div class="body">${fl}</div><span class="label"><em>open</em> Sun · 8 PM</span></div>
    </section>
    <p class="caught"><b>${d.m}</b> ${d.m === 1 ? 'moment' : 'moments'} caught this week</p>
    <p class="sealed">${ic('lock')} Sealed · not even you can peek</p>
    <div class="count"><span>We let them out together in</span><strong>2 days, 14 hours</strong></div>
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
      .map((x) => `<span style="color:${x.col}">${x.me ? 'You' : x.name}</span>`)
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
      <div class="screen-card">
        <small>Coming Sunday · 8 PM</small>
        <h1>Weekend People</h1>
        <p>in 2 days, 14 hours · for all ${word(d.n)} of us at once</p>
      </div>
    </section>
    <section class="credits">
      <small>Starring</small>
      <p class="names">${stars || '—'}</p>
      <p class="still">${still}</p>
      <p class="feat">featuring ${plural(d.m, 'sealed moment')} · not even you can peek</p>
    </section>
    <section class="theme"><small>This week's theme</small><h2>What made you pause and smile?</h2></section>
    <div class="reel"><small>Your scenes</small>${bars('rf', d.me.c)}<span>${d.me.c} of 5 · ${secs(d.me.c)}/30s</span></div>`;
  },

  c11: (d) => `
    <header class="top">${me()}<span class="tag">W36</span></header>
    <h1 class="title">Weekend People</h1>
    <p class="pill-count"><span class="dot"></span>Premieres in <b>2d 14h</b> · Sun 8 PM, to all ${word(d.n)} at once</p>
    <section class="board" aria-label="Our reel: ${plural(d.m, 'clip')} from ${d.added} of ${d.n} members, sealed">
      <div class="board-h"><div><small>Our reel so far</small><strong>${plural(d.m, 'clip')}</strong></div><span class="lock">${ic('lock')} not even you can peek</span></div>
      <div class="lanes" style="--n:${d.n}">${d.shown
        .map(
          (x) =>
            `<div class="lane${x.me ? ' me' : ''}${x.c ? '' : ' idle'}" style="--mc:${x.col}">${Array.from(
              { length: 5 },
              (_, k) => `<i${4 - k < x.c ? ' class="on"' : ''}></i>`,
            ).join('')}<b>${x.me ? 'You' : init(x)}</b></div>`,
        )
        .join('')}</div>
    </section>
    <section class="prompt"><small>This week's prompt</small><h2>What made you pause and smile?</h2></section>
    <p class="foot-note">${d.added} of ${d.n} are in · ${waitLine(d)}</p>`,
};

/* ---------- 方案清单与评审信息 ---------- */
const concepts = [
  {
    id: 'c9',
    group: 'r3',
    no: '09',
    zh: '萤火虫罐',
    en: 'Firefly Jar',
    nav: 'glass',
    key: '暖色玻璃罐 · 一个片段一只萤火虫',
    notes: [
      '玻璃质感 + 温馨：罐子在暮色里微微发光',
      '萤火虫颜色 = 贡献者专属色，数量 = 片段数，人数多少都成立',
      '“We let them out together”：一起放出来 = 一起揭晓',
    ],
    fonts: 'Fraunces (SOFT) · Caveat · Geist',
    review: ['罐中萤火', 3, 3, 2, '中高', '片段很多时粒子性能；颜色靠近时难分辨'],
  },
  {
    id: 'c10',
    group: 'r3',
    no: '10',
    zh: '放映夜',
    en: 'Movie Night',
    nav: 'glass',
    key: '放映机光束 · 幕布预告 · 片头字幕',
    notes: [
      '暗房杂志 × 首映票根的混合，借鉴 Capsl 的“电影式揭晓”',
      '“Starring …” 名单按成员专属色排出，随人数换行',
      '未参与的人写成 “and one more still filming”，不点名',
    ],
    fonts: 'Fraunces · DM Mono · Geist',
    review: ['家庭放映 + 片头字幕', 2, 2, 3, '中', '与 04 首映票根概念重叠，需二选一或合并'],
  },
  {
    id: 'c11',
    group: 'r3',
    no: '11',
    zh: '彩色分轨',
    en: 'Colour Lanes',
    nav: 'glass',
    key: '浅色 · 每人一条彩色音轨',
    notes: [
      '借鉴 Reveal：每个成员一种颜色，叠在一起就是这期影片',
      '每条轨 5 格 = 每人每周额度，亮起即已贡献',
      '最接近剪辑软件的直觉，信息最直接',
    ],
    fonts: 'Geist',
    review: ['多轨剪辑时间线', 2, 3, 2, '低', '展示每人贡献数，隐私感弱；偏工具'],
  },
  {
    id: 'c6',
    group: 'r2',
    no: '06',
    zh: '暖光玻璃',
    en: 'Warm Glass',
    nav: 'glass',
    key: '03 的温馨版 · 奶油底 · 蜜桃暖光 · 软衬线',
    notes: [
      '保留玻璃质感与底栏，冷紫换成蜜桃 / 蜂蜜色',
      '浅色，像午后阳光照进房间',
      '文案 “kept warm for the five of us”',
    ],
    fonts: 'Fraunces (SOFT) · Geist',
    review: ['午后暖光', 3, 3, 1, '中', '浅色玻璃的文字对比度需逐一验证'],
  },
  {
    id: 'c7',
    group: 'r2',
    no: '07',
    zh: '围炉',
    en: 'Hearth',
    nav: 'glass',
    key: '暖黑 · 火光 · 成员围坐一圈',
    notes: [
      '成员按人数自动围成一圈；每人外圈是自己颜色的 5 段额度环',
      '火光亮度随全组片段数变化',
      '不点名时，没来的人是“留着的空位”',
    ],
    fonts: 'Fraunces (SOFT) · Geist',
    review: ['围坐火堆', 3, 3, 2, '中高', '小屏 / 150% 大字体下环形会拥挤'],
  },
  {
    id: 'c8',
    group: 'r2',
    no: '08',
    zh: '蜡封信',
    en: 'Sealed Letter',
    nav: 'glass',
    key: '暖纸 · 蜡封 · 邮戳 · 钢笔字',
    notes: [
      '这一期是一封写给我们自己的信，周日一起拆',
      '成员是邮票（专属色），没来的人是空邮票框',
      '题目写成 “Dear us,” 开头',
    ],
    fonts: 'Fraunces · Caveat · Inter',
    review: ['写给自己的信', 3, 2, 2, '中', '手写体可读性；中文界面需另找手写字体'],
  },
  {
    id: 'c1',
    group: 'r1',
    no: '01',
    zh: '暗房杂志',
    en: 'Darkroom Editorial',
    key: '暖黑底 · 安全灯橙 · 等宽大数字',
    notes: [
      '主角是倒计时',
      '5 格胶片 = 你本周的额度，已拍的封存，下一格标 NEXT',
      '快门外圈 5 段与胶片同步',
    ],
    fonts: 'Inter Tight · JetBrains Mono',
    review: ['暗房冲洗', 1, 3, 2, '低', '偏酷、偏工具感'],
  },
  {
    id: 'c2',
    group: 'r1',
    no: '02',
    zh: '相纸索引页',
    en: 'Contact Sheet',
    key: '暖纸 · 铁锈红 · 衬线标题',
    notes: [
      '每人一行、每行 5 格，行数跟着人数走',
      '行首字母用成员专属色',
      '“Not even you can peek”',
    ],
    fonts: 'Instrument Serif · Inter · DM Mono',
    review: ['冲洗小样', 2, 2, 1, '中', '每人一行会暴露个人贡献数；10 人时行很密'],
  },
  {
    id: 'c3',
    group: 'r1',
    no: '03',
    zh: '玻璃胶囊',
    en: 'Glass Capsule',
    nav: 'glass',
    key: '深色 · 流动光球 · 毛玻璃',
    notes: [
      '主角是流动的“显影光球”，中间是全组片段数',
      '其余信息收进一张玻璃卡片',
      '导航只显示图标，选中项展开文字',
    ],
    fonts: 'Geist',
    review: ['显影光球', 1, 3, 1, '中', '偏冷；Android 上大面积模糊有性能风险'],
  },
  {
    id: 'c4',
    group: 'r1',
    no: '04',
    zh: '首映票根',
    en: 'Premiere Ticket',
    key: '影院暗红 · 票根米色 · 金色',
    notes: [
      '日期、开场、倒计时都在票上',
      'Admit N / 座位 = 人数，座位用成员专属色',
      '把 Premiere / Archive 概念提前埋进首页',
    ],
    fonts: 'Bodoni Moda · DM Mono · Inter',
    review: ['首映电影票', 2, 2, 3, '中', '票面信息密；依赖 Bodoni 字体气质'],
  },
  {
    id: 'c5',
    group: 'r1',
    no: '05',
    zh: '极简排版',
    en: 'Quiet Swiss',
    key: '纯排版 · 黑白 + 一个橙色',
    notes: [
      '没有任何图像，只靠字号对比',
      '额度用细线表格，信息密度最高',
      'Expo 落地成本最低，适合作对照组',
    ],
    fonts: 'Inter Tight',
    review: ['纯排版', 1, 3, 1, '低', '情感弱，温馨感最低'],
  },
];
const GROUPS = { r3: '第三轮 · 借鉴竞品的新方向', r2: '第二轮 · 温馨方向', r1: '第一轮' };

const screen = (c, d) =>
  `<div class="device"><div class="screen ${c.id}${c.nav === 'glass' ? ' gnav' : ''}">${statusBar()}<div class="scroll">${bodies[c.id](d)}</div>${dock(d)}${meSheet(d)}<span class="home-ind" aria-hidden="true"></span></div></div>`;

let current = 'all';

function render() {
  const d = data();
  let html = '',
    last = '';
  for (const c of concepts) {
    if (c.group !== last) {
      html += `<h2 class="gal-h">${GROUPS[c.group]}</h2>`;
      last = c.group;
    }
    html +=
      `<article class="card" data-id="${c.id}" aria-label="${c.no} ${c.zh}">` +
      `<header class="card-h"><span class="no">${c.no}</span><div><h2>${c.zh}</h2><p>${c.en}</p></div><div class="card-vote" data-vote="${c.id}"></div></header>` +
      `<div class="phone-wrap">${screen(c, d)}</div>` +
      `<div class="notes"><p class="key">${c.key}</p><ul>${c.notes.map((n) => `<li>${n}</li>`).join('')}</ul><p class="fonts">字体 · ${c.fonts}</p></div>` +
      `</article>`;
  }
  $('gallery').innerHTML = html;
  applyPick();
  paintVotes();
}

function renderReview() {
  $('review-body').innerHTML = concepts
    .map(
      (c) =>
        `<tr><th scope="row"><span>${c.no}</span>${c.zh}</th><td>${c.review[0]}</td><td>${c.review[4]}</td><td>${c.review[5]}</td><td data-vote="${c.id}"></td></tr>`,
    )
    .join('');
}

/* ---------- Issue 投票：读取公开评论上的表情数 ---------- */
const REPO = 'Collaboration95/rewind-app';
const votes = {};
function voteChip(id) {
  const v = votes[id];
  if (!v) return '<span class="vote-none">—</span>';
  return `<a class="vote" href="${v.url}" target="_blank" rel="noreferrer" title="在 Issue 里投票和评论"><span>👍 ${v.up}</span><span>❤️ ${v.heart}</span><em>去评论 ↗</em></a>`;
}
function paintVotes() {
  document
    .querySelectorAll('[data-vote]')
    .forEach((el) => (el.innerHTML = voteChip(el.dataset.vote)));
}
async function loadVotes() {
  const n = window.REVIEW_ISSUE;
  const st = $('vote-status');
  if (!n) {
    st.textContent = '投票 Issue 尚未发布。';
    return;
  }
  st.innerHTML = `投票与评论在 <a href="https://github.com/${REPO}/issues/${n}" target="_blank" rel="noreferrer">#${n}</a>，票数打开页面时读取。`;
  try {
    let all = [];
    for (let page = 1; page < 5; page++) {
      const r = await fetch(
        `https://api.github.com/repos/${REPO}/issues/${n}/comments?per_page=100&page=${page}`,
        {
          headers: { Accept: 'application/vnd.github+json' },
        },
      );
      if (!r.ok) throw new Error(String(r.status));
      const list = await r.json();
      all = all.concat(list);
      if (list.length < 100) break;
    }
    for (const c of all) {
      const m = /<!--\s*rewind-concept:(c\d+)\s*-->/.exec(c.body || '');
      if (m)
        votes[m[1]] = {
          up: c.reactions?.['+1'] ?? 0,
          heart: c.reactions?.heart ?? 0,
          url: c.html_url,
        };
    }
    paintVotes();
  } catch {
    st.innerHTML += ' 票数暂时读取失败（GitHub 公共接口每小时限 60 次），请直接打开 Issue 查看。';
  }
}

function renderPick() {
  let html = `<button type="button" data-pick="all"><span>··</span>全部对比</button>`,
    last = '';
  for (const c of concepts) {
    if (c.group !== last) {
      html += `<p class="pick-h">${GROUPS[c.group]}</p>`;
      last = c.group;
    }
    html += `<button type="button" data-pick="${c.id}"><span>${c.no}</span>${c.zh}</button>`;
  }
  $('pick').innerHTML = html;
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
  try {
    history.replaceState(null, '', id === 'all' ? location.pathname + location.search : '#' + id);
  } catch {
    /* 在受限的框架里改不了地址栏也没关系 */
  }
}

const closeSheets = () =>
  document.querySelectorAll('.screen.open').forEach((s) => s.classList.remove('open'));

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-close]');
  if (!t) return;
  if (t.dataset.pick) return pick(t.dataset.pick);
  if (t.dataset.anon) {
    anon = t.dataset.anon === '1';
    document
      .querySelectorAll('[data-anon]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    return render();
  }
  if (t.id === 'shuffle') {
    const bag = [0, 0, 1, 1, 2, 2, 3, 4, 5];
    POOL.forEach((p) => (p.c = bag[Math.floor(Math.random() * bag.length)]));
    return render();
  }
  if (t.id === 'restore') {
    POOL.forEach((p, i) => (p.c = DEFAULT_C[i]));
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
  if (t.classList.contains('tab')) {
    t.parentElement.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('on', b === t);
      if (b === t) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    return;
  }
  if (t.classList.contains('shutter')) {
    t.classList.remove('press');
    void t.offsetWidth;
    t.classList.add('press');
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheets());
$('zoom').addEventListener('input', (e) => setZoom(e.target.value));
$('members').addEventListener('input', (e) => {
  size = Number(e.target.value);
  $('membersv').textContent = size + ' 人';
  render();
});

renderPick();
renderReview();
render();
setZoom($('zoom').value);
// 支持 index.html#c9 直接打开某个方案
if (concepts.some((c) => c.id === location.hash.slice(1))) pick(location.hash.slice(1));
loadVotes();
