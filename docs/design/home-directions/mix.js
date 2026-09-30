'use strict';

/* ---------- App icon 搭配：选一个 Home 方向 + 一个图标，放进真实场景里看 ----------
   场景：手机桌面（60 px 与各种小尺寸）、启动页过渡到这个方向的真实首页、通知横幅、配色对照。
   搭配写进网址（#mix=c6+G，+t 表示圆点跟随方向强调色），复制链接即可分享。 */

// 各方向的底色、墨色、强调色（取自方向的主配色，近似值）
const PAL = {
  c1: ['#141210', '#f3e6d6', '#f08a5d'],
  c2: ['#f1e8dc', '#2a2522', '#b5482f'],
  c3: ['#16122e', '#f4f1ff', '#b36bff'],
  c4: ['#1b0d0d', '#ecdcc0', '#c99a3c'],
  c5: ['#f3f2ee', '#121212', '#ff4d12'],
  c6: ['#fff3e2', '#3a2a22', '#ff9f6b'],
  c7: ['#1a1210', '#f4d9b8', '#ff7a2f'],
  c8: ['#f0e4d0', '#2a2522', '#b93a2b'],
  c9: ['#1e1210', '#e8c9a4', '#ffd27a'],
  c10: ['#150f10', '#f2ead8', '#c8402f'],
  c11: ['#f5f1ea', '#2a2522', '#e2725a'],
  sp: ['#ffffff', '#111111', '#ff4d12'],
};
const WALLS = {
  light: 'linear-gradient(160deg, #f4efe7, #d8d0c4)',
  teal: 'linear-gradient(170deg, #a9d3c9, #5f9f98)',
  dark: 'linear-gradient(160deg, #2c2a33, #0f0e12)',
};

let mix = { dir: 'c6', icon: 'G', tint: false, wall: 'teal' };

const iconOf = (id) =>
  ICON_FAMILY.find((i) => i.id === id) ||
  ICON_REFS.find((i) => i.id === id) ||
  Object.values(ICON_PAIRS).find((i) => i.id === id) ||
  ICON_FAMILY[0];
const iconName = (ic) =>
  ic.name
    ? L(ic.name)
    : `${t('mix.pairOf')} ${nameOf(concepts.find((c) => 'p:' + c.id === ic.id))}`;
// 同一个图标在页面上会出现很多次：svg 本身不带尺寸，由外层决定
const iconHTML = (id, size, cls = '') =>
  `<span class="mx-icon ${cls}" style="width:${size}px;height:${size}px">${iconOf(id).svg}</span>`;

const dirName = (id) => (id === 'sp' ? t('mix.sp') : nameOf(concepts.find((c) => c.id === id)));
const dirNo = (id) => (id === 'sp' ? '—' : concepts.find((c) => c.id === id).no);

// 亮度（0–1），用于判断图标和界面是不是一深一浅
function lum(hex) {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ---------- 网址 ---------- */
function mixHash() {
  return `#mix=${mix.dir}+${encodeURIComponent(mix.icon)}${mix.tint ? '+t' : ''}`;
}
function readHash() {
  const m = /^#mix(?:=([^+]*)\+([^+]*)(\+t)?)?$/.exec(location.hash);
  if (!m) return false;
  if (m[1] && (PAL[m[1]] || m[1] === 'sp')) mix.dir = m[1];
  if (m[2]) {
    const id = decodeURIComponent(m[2]);
    if (iconOf(id).id === id) mix.icon = id;
  }
  mix.tint = Boolean(m[3]);
  return true;
}

/* ---------- 视图切换：评审 / 搭配 ---------- */
function setView(v) {
  const on = v === 'mix';
  document.body.classList.toggle('view-mix', on);
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.view === 'mix') === on)));
  if (on) renderMix();
  try {
    history.replaceState(null, '', on ? mixHash() : location.pathname + location.search);
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}

/* ---------- 绘制 ---------- */
function pickerHTML() {
  const dirs = concepts.filter((c) => !isArchived(c.id) || showArch);
  const dirBtn = (id) =>
    `<button type="button" data-mx-dir="${id}" aria-pressed="${mix.dir === id}"${isArchived(id) ? ' class="arch"' : ''}><span>${dirNo(id)}</span>${dirName(id)}</button>`;
  const tile = (ic) =>
    `<button type="button" class="mx-tile" data-mx-icon="${ic.id}" aria-pressed="${mix.icon === ic.id}" title="${iconName(ic)}">${iconHTML(ic.id, 46)}<b>${ic.id.startsWith('p:') ? '' : ic.id.startsWith('r:') ? '' : ic.id}</b>${ic.new ? `<i>${t('mix.new')}</i>` : ''}</button>`;
  const pair = mix.dir === 'sp' ? null : ICON_PAIRS[mix.dir];
  const acc = iconOf(mix.icon).acc;
  return (
    `<p class="lbl">${t('mix.dir')}</p><div class="mx-dirs">${dirs.map((c) => dirBtn(c.id)).join('')}${dirBtn('sp')}</div>` +
    (showArch ? '' : `<p class="hint">${t('mix.archHint')}</p>`) +
    `<p class="lbl">${t('mix.family')}</p><div class="mx-tiles">${ICON_FAMILY.map(tile).join('')}</div>` +
    (pair ? `<p class="lbl">${t('mix.pair')}</p><div class="mx-tiles">${tile(pair)}</div>` : '') +
    `<p class="lbl">${t('mix.refs')}</p><div class="mx-tiles">${ICON_REFS.map(tile).join('')}</div>` +
    `<label class="check${acc ? '' : ' off'}" for="mx-tint"><input type="checkbox" id="mx-tint"${mix.tint ? ' checked' : ''}${acc ? '' : ' disabled'} /> <span>${t('mix.tint')}</span></label>` +
    `<p class="hint">${t(acc ? 'mix.tintHint' : 'mix.tintNone')}</p>` +
    `<button type="button" class="rv-send mx-share" data-mx-share>${t('mix.share')}</button>`
  );
}

function homeScreenHTML() {
  const apps = [
    'camera',
    'photos',
    'messages',
    'maps',
    'weather',
    'rewind',
    'notes',
    'music',
    'clock',
    'mail',
    'calendar',
    'files',
  ];
  const grads = [
    '#8fa6b8',
    '#e9b872',
    '#8cc084',
    '#7aa7d9',
    '#6fb1d8',
    '',
    '#e9d27a',
    '#e07a8a',
    '#3a3a3a',
    '#6a95d8',
    '#f2f2f2',
    '#7d8fa8',
  ];
  const cell = (a, i) =>
    a === 'rewind'
      ? `<figure class="me">${iconHTML(mix.icon, 52)}<figcaption>Rewind</figcaption></figure>`
      : `<figure><span class="ph" style="background:${grads[i]}"></span><figcaption>${t('mix.app.' + a)}</figcaption></figure>`;
  const walls = Object.keys(WALLS)
    .map(
      (w) =>
        `<button type="button" data-mx-wall="${w}" aria-pressed="${mix.wall === w}" style="background:${WALLS[w]}" aria-label="${t('mix.wall.' + w)}"></button>`,
    )
    .join('');
  return (
    `<div class="mx-home ${mix.wall}" style="background:${WALLS[mix.wall]}"><div class="mx-status">9:41</div><div class="mx-apps">${apps.map(cell).join('')}</div>` +
    `<div class="mx-dock">${['#8cc084', '#7aa7d9', '#e9b872', '#6a95d8'].map((g) => `<span class="ph" style="background:${g}"></span>`).join('')}</div></div>` +
    `<div class="mx-walls" role="group" aria-label="${t('mix.wall')}">${walls}</div>`
  );
}

function scratchPhoneHTML() {
  return (
    `<div class="device"><div class="screen sp-screen"><div class="sp-top"><div class="av wob">A</div><div class="chip wob">W36</div></div>` +
    `<h4>Weekend People</h4><div class="sub">Opens for all five of us at once · Sun 8 PM</div>` +
    `<div class="count">02<small>days</small> 14<small>hrs</small></div><div class="q">What made you pause and smile?</div>` +
    `<div class="row"><span>Friends in</span><i>4 / 5</i></div><div class="row"><span>Your moments</span><i>2 / 5</i></div><div class="row"><span>Seconds used</span><i>08 / 30</i></div>` +
    `<div class="sub" style="margin-top:12px">Sealed · not even you can peek</div>` +
    `<div class="sp-dock"><div class="pill wob"><b>Home</b><span>Chat</span><span>Archive</span></div><div class="shut">●</div></div></div></div>`
  );
}

function phoneHTML() {
  const c = concepts.find((x) => x.id === mix.dir);
  const bg = PAL[mix.dir][0];
  return (
    `<div class="card mx-phone" data-id="${mix.dir}"><div class="phone-wrap">${c ? screen(c, dataFor(c.id)) : scratchPhoneHTML()}</div>` +
    `<div class="mx-splash" style="background:${bg}">${iconHTML(mix.icon, 118)}<span style="color:${PAL[mix.dir][1]}">Rewind</span></div></div>` +
    `<button type="button" class="ghost mx-replay" data-mx-replay>${t('mix.replay')}</button>`
  );
}

function paletteHTML() {
  const ic = iconOf(mix.icon);
  const [bg, ink, acc] = PAL[mix.dir];
  const sw = (hex, label) =>
    `<span class="sw"><i style="background:${hex}"></i>${label}<code>${hex}</code></span>`;
  const gap = Math.abs(lum(ic.bg) - lum(bg));
  return (
    `<div class="mx-pal"><div><p class="lbl">${t('mix.palDir')}</p>${sw(bg, t('mix.bg'))}${sw(ink, t('mix.ink'))}${sw(acc, t('mix.acc'))}</div>` +
    `<div><p class="lbl">${t('mix.palIcon')}</p>${sw(ic.bg, t('mix.bg'))}${ic.acc ? sw(mix.tint ? acc : '#ff4d12', t('mix.acc')) : ''}</div></div>` +
    `<p class="mx-hint">${t(gap > 0.45 ? 'mix.hintFlip' : 'mix.hintSame')}</p>`
  );
}

function galleryHTML() {
  const card = (ic) =>
    `<figure class="mx-card${mix.icon === ic.id ? ' on' : ''}"><button type="button" data-mx-icon="${ic.id}">${iconHTML(ic.id, 150)}</button>` +
    `<figcaption><b>${ic.id.startsWith('r:') ? '' : ic.id} <small>${L(ic.name)}</small>${ic.new ? `<i>${t('mix.new')}</i>` : ''}</b><span>${L(ic.note)}</span>` +
    `<span class="mx-sizes">${iconHTML(ic.id, 60)}${iconHTML(ic.id, 29)}</span></figcaption></figure>`;
  return `<div class="mx-gallery">${ICON_FAMILY.map(card).join('')}${ICON_REFS.map(card).join('')}</div>`;
}

let splashTimer;
function playSplash() {
  const s = document.querySelector('.mx-splash');
  if (!s) return;
  s.classList.remove('gone');
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => s.classList.add('gone'), reduceMotion() ? 0 : 1300);
}

function renderMix() {
  const root = $('mix');
  if (!root) return;
  const ic = iconOf(mix.icon);
  const acc = mix.tint && ic.acc ? PAL[mix.dir][2] : '';
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('mix.k')}</p><h1>${t('mix.h1')}</h1><p>${t('mix.p')}</p></header>` +
    `<div class="mx-grid"><aside class="mx-pick">${pickerHTML()}</aside>` +
    `<div class="mx-stage" style="${acc ? `--acc:${acc}` : ''}">` +
    `<p class="mx-now"><b>${dirNo(mix.dir)} ${dirName(mix.dir)}</b> + <b>${ic.id.startsWith('p:') || ic.id.startsWith('r:') ? '' : ic.id + ' '}${iconName(ic)}</b></p>` +
    `<div class="mx-row"><section class="mx-block"><p class="lbl">${t('mix.launch')}</p>${phoneHTML()}</section>` +
    `<section class="mx-block"><p class="lbl">${t('mix.homeScreen')}</p>${homeScreenHTML()}` +
    `<p class="lbl">${t('mix.sizes')}</p><div class="mx-sizerow">${[120, 60, 40, 29].map((s) => `<figure>${iconHTML(mix.icon, s)}<figcaption>${s} px · ${t('mix.size.' + s)}</figcaption></figure>`).join('')}</div>` +
    `<p class="lbl">${t('mix.notif')}</p><div class="mx-notif">${iconHTML(mix.icon, 38)}<div><b>Rewind</b><span>${t('mix.notifText')}</span></div><em>${t('mix.now')}</em></div>` +
    `<p class="lbl">${t('mix.pal')}</p>${paletteHTML()}</section></div></div></div>` +
    `<h2 class="gal-h mx-fam-h">${t('mix.famH')}</h2><p class="hint">${t('mix.famP')}</p>${galleryHTML()}`;
  const card = root.querySelector('.mx-phone');
  if (card && mix.dir !== 'sp') startFlies(card, {});
  playSplash();
  try {
    if (document.body.classList.contains('view-mix')) history.replaceState(null, '', mixHash());
  } catch {
    /* 同上 */
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest(
    '[data-view],[data-mx-dir],[data-mx-icon],[data-mx-wall],[data-mx-replay],[data-mx-share]',
  );
  if (!b) return;
  const d = b.dataset;
  if (d.view) return setView(d.view);
  if (d.mxDir) {
    mix.dir = d.mxDir;
    return renderMix();
  }
  if (d.mxIcon) {
    mix.icon = d.mxIcon;
    renderMix();
    if (b.closest('.mx-gallery'))
      $('mix').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' });
    return;
  }
  if (d.mxWall) {
    mix.wall = d.mxWall;
    return renderMix();
  }
  if ('mxReplay' in d) return playSplash();
  if ('mxShare' in d) {
    const url = location.href.split('#')[0] + mixHash();
    return copyText(url).then((ok) => rvToast(t(ok ? 'mix.copied' : 'rv.copyFail')));
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'mx-tint') return;
  mix.tint = e.target.checked;
  renderMix();
});

// 切换语言、展开废案时重画
function relangMix() {
  if (document.body.classList.contains('view-mix')) renderMix();
}

// 打开时如果网址是 #mix…，直接进搭配页（htmlpreview 会晚一点就位，所以加载后再看一次）
const openMixFromHash = () => {
  if (readHash()) setView('mix');
};
openMixFromHash();
addEventListener('load', openMixFromHash);
addEventListener('hashchange', openMixFromHash);
