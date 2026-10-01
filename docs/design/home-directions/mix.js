'use strict';

/* ---------- App icon 搭配：选一个首页 + 一个图标，放进真实场景里看 ----------
   场景：手机桌面（60 px 与各种小尺寸）、启动页过渡到这个方向的真实首页、通知横幅、配色对照。
   搭配写进网址（#mix=c6+G，+t 表示圆点跟随方向强调色），复制链接即可分享。 */

// 首页的底色、墨色、强调色（暖光玻璃，和草稿本风格的对照稿）
const PAL = {
  c6: ['#fff3e2', '#3a2a22', '#ff9f6b'],
  sp: ['#ffffff', '#111111', '#ff4d12'],
};
// 桌面壁纸只留黑白两种，避免壁纸颜色干扰对图标的判断
const WALLS = {
  light: 'linear-gradient(160deg, #fbfbfa, #e8e8e5)',
  dark: 'linear-gradient(160deg, #1f1f21, #000)',
};

// 桌面上的其他 App：常见软件图标的简化画法（仅作桌面环境参照）
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

// 图标底色：只给白底的字标族换，选项少一点
const ICON_BGS = { white: '#ffffff', cream: '#f3ebdd', black: '#161514', home: '' };

let mix = { dir: 'c6', icon: 'G', tint: false, wall: 'light', bg: 'white' };

const iconOf = (id) =>
  ICON_FAMILY.find((i) => i.id === id) ||
  ICON_REFS.find((i) => i.id === id) ||
  Object.values(ICON_PAIRS).find((i) => i.id === id) ||
  ICON_FAMILY[0];
const iconName = (ic) =>
  ic.name
    ? L(ic.name)
    : `${t('mix.pairOf')} ${nameOf(concepts.find((c) => 'p:' + c.id === ic.id))}`;
// 页面上显示的编号：字标族用数字，首页配套图标和参考不编号
const iconNo = (ic) => (ic.no ? String(ic.no) : '');
const canBg = (ic) => ic.bg === '#fff';
const bgHex = () => (mix.bg === 'home' ? PAL[mix.dir][0] : ICON_BGS[mix.bg]);
const iconBg = (ic) => (canBg(ic) ? bgHex() : ic.bg);
// 换底色：第一个白色填充就是底板；底色深时把黑色墨水换成浅色
function iconSVG(ic) {
  if (!canBg(ic) || mix.bg === 'white') return ic.svg;
  const bg = bgHex();
  const s = ic.svg.replace('fill="#fff"', `fill="${bg}"`);
  return lum(bg) < 0.3 ? s.replace(/(fill|stroke)="#111"/g, '$1="#f4efe7"') : s;
}
// 同一个图标在页面上会出现很多次：svg 本身不带尺寸，由外层决定
const iconHTML = (id, size, cls = '') =>
  `<span class="mx-icon ${cls}" style="width:${size}px;height:${size}px">${iconSVG(iconOf(id))}</span>`;

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
// #mix=首页+图标[+t 圆点跟随强调色][+bg-cream 图标底色]
function mixHash() {
  return (
    `#mix=${mix.dir}+${encodeURIComponent(mix.icon)}` +
    (mix.tint ? '+t' : '') +
    (mix.bg === 'white' ? '' : '+bg-' + mix.bg)
  );
}
function readHash() {
  const m = /^#mix(?:=(.*))?$/.exec(location.hash);
  if (!m) return false;
  const [dir, icon, ...rest] = (m[1] || '').split('+');
  if (dir && PAL[dir]) mix.dir = dir;
  if (icon) {
    const id = decodeURIComponent(icon);
    if (iconOf(id).id === id) mix.icon = id;
  }
  mix.tint = rest.includes('t');
  const bg = (rest.find((x) => x.startsWith('bg-')) || '').slice(3);
  mix.bg = bg in ICON_BGS ? bg : 'white';
  return true;
}

/* ---------- 视图切换：首页 / 搭配 / 状态 / 底栏图标 ---------- */
function setView(v) {
  const view = ['mix', 'states', 'screens', 'dockicons'].includes(v) ? v : 'home';
  document.body.classList.toggle('view-mix', view === 'mix');
  document.body.classList.toggle('view-states', view === 'states');
  document.body.classList.toggle('view-screens', view === 'screens');
  document.body.classList.toggle('view-dockicons', view === 'dockicons');
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  if (view === 'mix') renderMix();
  if (view === 'states') window.renderStatesView?.();
  if (view === 'screens') window.renderScreensView?.();
  if (view === 'dockicons') window.renderDockView?.();
  try {
    history.replaceState(
      null,
      '',
      view === 'mix'
        ? mixHash()
        : view === 'states'
          ? statesHash() // 定义在 states.js（同一页面的全局常量）
          : view === 'screens'
            ? '#screens'
            : view === 'dockicons'
              ? dockHash() // 定义在 dockicons.js
              : location.pathname + location.search,
    );
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}

/* ---------- 绘制 ---------- */
function pickerHTML() {
  const dirBtn = (id) =>
    `<button type="button" data-mx-dir="${id}" aria-pressed="${mix.dir === id}"><span>${dirNo(id)}</span>${dirName(id)}</button>`;
  const tile = (ic) =>
    `<button type="button" class="mx-tile" data-mx-icon="${ic.id}" aria-pressed="${mix.icon === ic.id}" title="${iconName(ic)}">${iconHTML(ic.id, 46)}<b>${iconNo(ic)}</b>${ic.new ? `<i>${t('mix.new')}</i>` : ''}</button>`;
  const pair = mix.dir === 'sp' ? null : ICON_PAIRS[mix.dir];
  const acc = iconOf(mix.icon).acc;
  const cat = (k) =>
    `<p class="mx-sub">${t('mix.cat.' + k)}</p><div class="mx-tiles">${ICON_FAMILY.filter(
      (i) => i.cat === k,
    )
      .map(tile)
      .join('')}</div>`;
  return (
    `<p class="lbl">${t('mix.dir')}</p><div class="mx-dirs">${dirBtn('c6')}${dirBtn('sp')}</div>` +
    `<p class="lbl">${t('mix.family')}</p>${cat('word')}${cat('mark')}` +
    (pair ? `<p class="lbl">${t('mix.pair')}</p><div class="mx-tiles">${tile(pair)}</div>` : '') +
    `<p class="lbl">${t('mix.refs')}</p><div class="mx-tiles">${ICON_REFS.map(tile).join('')}</div>` +
    `<p class="lbl">${t('mix.bgLabel')}</p><div class="mx-bgs${canBg(iconOf(mix.icon)) ? '' : ' off'}" role="group" aria-label="${t('mix.bgLabel')}">` +
    Object.keys(ICON_BGS)
      .map(
        (k) =>
          `<button type="button" data-mx-bg="${k}" aria-pressed="${mix.bg === k}"${canBg(iconOf(mix.icon)) ? '' : ' disabled'}><i style="background:${k === 'home' ? PAL[mix.dir][0] : ICON_BGS[k]}"></i>${t('mix.bg.' + k)}</button>`,
      )
      .join('') +
    `</div>` +
    (canBg(iconOf(mix.icon)) ? '' : `<p class="hint">${t('mix.bgNone')}</p>`) +
    `<label class="check${acc ? '' : ' off'}" for="mx-tint"><input type="checkbox" id="mx-tint"${mix.tint ? ' checked' : ''}${acc ? '' : ' disabled'} /> <span>${t('mix.tint')}</span></label>` +
    `<p class="hint">${t(acc ? 'mix.tintHint' : 'mix.tintNone')}</p>` +
    `<button type="button" class="rv-send mx-share" data-mx-share>${t('mix.share')}</button>`
  );
}

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
      ? `<figure class="me">${iconHTML(mix.icon, 52)}<figcaption>Rewind</figcaption></figure>`
      : `<figure>${appIcon(a, 52)}<figcaption>${t('mix.app.' + a)}</figcaption></figure>`;
  const walls = Object.keys(WALLS)
    .map(
      (w) =>
        `<button type="button" data-mx-wall="${w}" aria-pressed="${mix.wall === w}" style="background:${WALLS[w]}" aria-label="${t('mix.wall.' + w)}"></button>`,
    )
    .join('');
  return (
    `<div class="mx-home ${mix.wall}" style="background:${WALLS[mix.wall]}"><div class="mx-status">9:41</div><div class="mx-apps">${apps.map(cell).join('')}</div>` +
    `<div class="mx-dock">${['phone', 'safari', 'messages', 'music'].map((a) => appIcon(a, 52)).join('')}</div></div>` +
    `<div class="mx-walls" role="group" aria-label="${t('mix.wall')}">${walls}</div>`
  );
}

function scratchPhoneHTML() {
  return (
    `<div class="device"><div class="screen sp-screen"><div class="sp-top"><div class="av wob">A</div><div class="chip wob">W36</div></div>` +
    `<h4>Group name</h4><div class="sub">Sun 8 PM</div>` +
    `<div class="count">02<small>days</small> 14<small>hrs</small></div><div class="q">What made you pause and smile?</div>` +
    `<div class="row"><span>Friends in</span><i>4 / 5</i></div><div class="row"><span>Your moments</span><i>2 / 5</i></div><div class="row"><span>Seconds used</span><i>08 / 30</i></div>` +
    `<div class="sp-dock"><div class="pill wob"><b>Home</b><span>Chat</span><span>Archive</span></div><div class="shut">●</div></div></div></div>`
  );
}

function phoneHTML() {
  const c = concepts.find((x) => x.id === mix.dir);
  const [bg, ink] = PAL[mix.dir];
  // 启动页放在屏幕里面，跟着屏幕的圆角裁切，不会露出底下的首页
  const splash = `<div class="mx-splash" style="background:${bg}">${iconHTML(mix.icon, 190)}<span style="color:${ink}">Rewind</span></div>`;
  const phone = (c ? screen(c, dataFor(c.id)) : scratchPhoneHTML()).replace(
    /<\/div><\/div>$/,
    splash + '</div></div>',
  );
  return (
    `<div class="card mx-phone" data-id="${mix.dir}"><div class="phone-wrap">${phone}</div></div>` +
    `<button type="button" class="ghost mx-replay" data-mx-replay>${t('mix.replay')}</button>` +
    `<p class="mx-anim">${t('mix.animNote')}</p>`
  );
}

function paletteHTML() {
  const ic = iconOf(mix.icon);
  const [bg, ink, acc] = PAL[mix.dir];
  const sw = (hex, label) =>
    `<span class="sw"><i style="background:${hex}"></i>${label}<code>${hex}</code></span>`;
  const gap = Math.abs(lum(iconBg(ic)) - lum(bg));
  return (
    `<div class="mx-pal"><div><p class="lbl">${t('mix.palDir')}</p>${sw(bg, t('mix.bg'))}${sw(ink, t('mix.ink'))}${sw(acc, t('mix.acc'))}</div>` +
    `<div><p class="lbl">${t('mix.palIcon')}</p>${sw(iconBg(ic), t('mix.bg'))}${ic.acc ? sw(mix.tint ? acc : '#ff4d12', t('mix.acc')) : ''}</div></div>` +
    `<p class="mx-hint">${t(gap > 0.45 ? 'mix.hintFlip' : 'mix.hintSame')}</p>`
  );
}

// 分组标题带上编号区间，比如“字母类 · 1–15”
function catTitle(k) {
  const list = ICON_FAMILY.filter((i) => i.cat === k);
  return `${t('mix.cat.' + k)} · ${list[0].no}–${list.at(-1).no}`;
}
function galleryHTML() {
  const card = (ic) =>
    `<figure class="mx-card${mix.icon === ic.id ? ' on' : ''}"><button type="button" data-mx-icon="${ic.id}">${iconHTML(ic.id, 150)}</button>` +
    `<figcaption><b>${iconNo(ic)} <small>${L(ic.name)}</small>${ic.new ? `<i>${t('mix.new')}</i>` : ''}</b><span>${L(ic.note)}</span>` +
    `<span class="mx-sizes">${iconHTML(ic.id, 60)}${iconHTML(ic.id, 29)}</span></figcaption></figure>`;
  const group = (title, list) =>
    `<h3 class="mx-cat-h">${title}</h3><div class="mx-gallery">${list.map(card).join('')}</div>`;
  return (
    group(
      catTitle('word'),
      ICON_FAMILY.filter((i) => i.cat === 'word'),
    ) +
    group(
      catTitle('mark'),
      ICON_FAMILY.filter((i) => i.cat === 'mark'),
    ) +
    group(t('mix.refs'), ICON_REFS)
  );
}

let splashTimer;
function playSplash() {
  const s = document.querySelector('.mx-splash');
  if (!s) return;
  // 启动页显示期间先把首页藏起来，免得首页的动画图层画到启动页上面
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
  const ic = iconOf(mix.icon);
  const acc = mix.tint && ic.acc ? PAL[mix.dir][2] : '';
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('mix.k')}</p><h1>${t('mix.h1')}</h1><p>${t('mix.p')}</p></header>` +
    `<div class="mx-grid"><aside class="mx-pick">${pickerHTML()}</aside>` +
    `<div class="mx-stage" style="${acc ? `--acc:${acc}` : ''}">` +
    `<p class="mx-now"><b>${dirNo(mix.dir)} ${dirName(mix.dir)}</b> + <b>${ic.no ? ic.no + ' ' : ''}${iconName(ic)}</b></p>` +
    `<div class="mx-row"><section class="mx-block"><p class="lbl">${t('mix.launch')}</p>${phoneHTML()}</section>` +
    `<section class="mx-block"><p class="lbl">${t('mix.homeScreen')}</p>${homeScreenHTML()}` +
    `<p class="lbl">${t('mix.sizes')}</p><div class="mx-sizerow">${[120, 60, 40, 29].map((s) => `<figure>${iconHTML(mix.icon, s)}<figcaption>${s} px · ${t('mix.size.' + s)}</figcaption></figure>`).join('')}</div>` +
    `<p class="lbl">${t('mix.notif')}</p><div class="mx-notif">${iconHTML(mix.icon, 38)}<div><b>Rewind</b><span>${t('mix.notifText')}</span></div><em>${t('mix.now')}</em></div>` +
    `<p class="lbl">${t('mix.pal')}</p>${paletteHTML()}</section></div></div></div>` +
    `<h2 class="gal-h mx-fam-h">${t('mix.famH')}</h2><p class="hint">${t('mix.famP')}</p>${galleryHTML()}`;
  playSplash();
  try {
    if (document.body.classList.contains('view-mix')) history.replaceState(null, '', mixHash());
  } catch {
    /* 同上 */
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest(
    '[data-view],[data-mx-dir],[data-mx-icon],[data-mx-wall],[data-mx-bg],[data-mx-replay],[data-mx-share]',
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
  if (d.mxBg) {
    mix.bg = d.mxBg;
    return renderMix();
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

// 切换语言时重画
function relangMix() {
  if (document.body.classList.contains('view-mix')) renderMix();
  if (document.body.classList.contains('view-states')) window.renderStatesView?.();
  if (document.body.classList.contains('view-screens')) window.renderScreensView?.();
  if (document.body.classList.contains('view-dockicons')) window.renderDockView?.();
}

// 打开时如果网址是 #mix…，直接进搭配页（htmlpreview 会晚一点就位，所以加载后再看一次）
const openMixFromHash = () => {
  if (readHash()) setView('mix');
};
openMixFromHash();
addEventListener('load', openMixFromHash);
addEventListener('hashchange', openMixFromHash);
