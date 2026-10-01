'use strict';

/* ---------- 底栏图标：几套方案放进 Warm Glass + G 胶囊里试 ----------
   只在这个页面画手机时临时换图标（ICON_SET），其他页面不受影响。
   图标都是 24×24：.f 实心（跟随文字色），.d 实心强调色；
   iOS 方案里 .o 是线性、.s 是实心，选中的页签显示实心。 */
const D_HOME = I.home,
  D_CHAT = I.chat,
  D_ARCHIVE = I.archive,
  D_CAMERA = I.camera;

const DOCK_SETS = [
  {
    id: 'now',
    style: 'line',
    name: ['Current', '现在的'],
    note: ['The outline icons from the prototype.', '原型里的线性图标。'],
    icons: null,
  },
  {
    id: 'ios',
    style: 'ios',
    name: ['iOS style', 'iOS 风格'],
    note: ['Outline when idle, filled when selected.', '未选中是线性，选中变实心。'],
    icons: {
      home: `<g class="o">${D_HOME}</g><g class="s"><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/></g>`,
      chat: `<g class="o">${D_CHAT}</g><g class="s">${D_CHAT}</g>`,
      archive:
        `<g class="o">${D_ARCHIVE}</g><g class="s"><rect x="3.5" y="4.5" width="17" height="4" rx="1"/>` +
        `<path fill-rule="evenodd" d="M5 9.5h14V18a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18zm4.6 2.2a.8.8 0 0 0 0 1.6h4.8a.8.8 0 0 0 0-1.6z"/></g>`,
      camera: `<g class="o">${D_CAMERA}</g><g class="s"><path fill-rule="evenodd" d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/></g>`,
    },
  },
  {
    id: 'rewind',
    style: 'line',
    name: ['Rewind metaphors', 'Rewind 隐喻'],
    note: [
      'Home is warm light, Chat is two dots, Archive is a film reel.',
      '首页是一团暖光，聊天是两个点，档案是一盘胶片。',
    ],
    icons: {
      home: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M5.6 18.4l1.5-1.5M16.9 7.1l1.5-1.5"/>',
      chat: '<path d="M20 11.5c0 4-3.6 7-8 7-1 0-1.9-.1-2.7-.4L5 20l1-3.6C4.8 15.1 4 13.4 4 11.5c0-4 3.6-7 8-7s8 3 8 7z"/><circle class="f" cx="9.8" cy="11.5" r="1.15"/><circle class="f" cx="14.2" cy="11.5" r="1.15"/>',
      archive:
        // 片盘：中间一个轴，四周四个孔（三个点会像一张脸）
        '<circle cx="11" cy="12" r="7.5"/><circle class="f" cx="11" cy="12" r="1"/><circle cx="11" cy="8.3" r="1.5"/><circle cx="14.7" cy="12" r="1.5"/><circle cx="11" cy="15.7" r="1.5"/><circle cx="7.3" cy="12" r="1.5"/><path d="M11 19.5h9"/>',
      camera: '<circle cx="12" cy="12" r="7.5"/><circle class="f" cx="12" cy="12" r="3"/>',
    },
  },
  {
    id: 'duo',
    style: 'line',
    name: ['Warm duotone', '暖色双色'],
    note: ['Outline with one warm accent in each icon.', '线性图标，每个加一处暖色。'],
    icons: {
      home: `<rect class="d" x="10" y="14.8" width="4" height="5.2" rx=".8"/>${D_HOME}`,
      chat: `${D_CHAT}<circle class="d" cx="12" cy="12" r="2.3"/>`,
      archive: `<rect class="d" x="3.5" y="4.5" width="17" height="4" rx="1"/>${D_ARCHIVE}`,
      camera: `${D_CAMERA}<circle class="d" cx="12" cy="12.5" r="2"/>`,
    },
  },
  {
    id: 'hand',
    style: 'hand',
    name: ['Hand-drawn', '手绘'],
    note: ['Wobbly pen lines, like the scratchpad wordmarks.', '手绘线条，和草稿本字标同一风格。'],
    icons: { home: D_HOME, chat: D_CHAT, archive: D_ARCHIVE, camera: D_CAMERA },
  },
  {
    id: 'min',
    style: 'min',
    name: ['Minimal', '极简'],
    note: ['A roof, two dots, three lines, a ring.', '屋顶、两个点、三条线、一个圈。'],
    icons: {
      home: '<path d="M5 19.5v-9L12 5l7 5.5v9"/>',
      chat: '<circle class="f" cx="8.5" cy="12" r="1.7"/><circle class="f" cx="15.5" cy="12" r="1.7"/>',
      archive: '<path d="M5 7.5h14M5 12h14M5 16.5h14"/>',
      camera: '<circle cx="12" cy="12" r="6.5"/>',
    },
  },
];

let dv = { set: 'ios' };

// 用某套图标、G 胶囊、收集中状态画东西，画完恢复
function withSet(id, fn) {
  const keep = { set: ICON_SET, variant: NAV.variant };
  const s = DOCK_SETS.find((x) => x.id === id);
  ICON_SET = s && s.icons ? s : null;
  NAV.variant = 'g';
  try {
    return withHome('collect', fn);
  } finally {
    ICON_SET = keep.set;
    NAV.variant = keep.variant;
  }
}
const dvScreen = () =>
  withSet(dv.set, () =>
    screen(
      concepts.find((c) => c.id === 'c6'),
      dataFor('c6'),
    ),
  );

function renderDockView() {
  const root = $('dock-view');
  if (!root) return;
  const phone = (cls, label) =>
    `<figure class="dv-ph ${cls}"><div class="card dv-card" data-id="c6"><div class="phone-wrap">${dvScreen()}</div></div><figcaption>${label}</figcaption></figure>`;
  const sample = (s) =>
    withSet(
      s.id,
      () =>
        `<span class="dv-sample c6"><span class="dv-bar"><i class="on">${ic('home')}</i><i>${ic('chat')}</i><i>${ic('archive')}</i></span><span class="dv-shut">${ic('camera')}</span></span>`,
    );
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('dv.k')}</p><h1>${t('dv.h1')}</h1><p>${t('dv.p')}</p></header>` +
    `<div class="dv-row">${phone('', t('dv.closed'))}${phone('dv-open', t('dv.open'))}` +
    `<figure class="dv-ph dv-zoom"><div class="dv-crop"><div class="card dv-card" data-id="c6"><div class="phone-wrap">${dvScreen()}</div></div></div><figcaption>${t('dv.zoom')}</figcaption></figure></div>` +
    `<div class="dv-sets">${DOCK_SETS.map(
      (s) =>
        `<button type="button" class="dv-set" data-dv-set="${s.id}" aria-pressed="${dv.set === s.id}">${sample(s)}<b>${L(s.name)}</b><span>${L(s.note)}</span></button>`,
    ).join('')}</div>`;
  // 第二台和特写显示展开后的底栏
  root
    .querySelectorAll('.dv-open .dock-g, .dv-zoom .dock-g')
    .forEach((d) => d.classList.add('open'));
  try {
    if (document.body.classList.contains('view-dockicons'))
      history.replaceState(null, '', dockHash());
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}

const dockHash = () => `#dock=${dv.set}`;
function readDockHash() {
  const m = /^#dock(?:=(.+))?$/.exec(location.hash);
  if (!m) return false;
  if (DOCK_SETS.some((s) => s.id === m[1])) dv.set = m[1];
  return true;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-dv-set]');
  if (!b) return;
  dv.set = b.dataset.dvSet;
  renderDockView();
});

const openDockFromHash = () => {
  if (readDockHash()) setView('dockicons');
};
openDockFromHash();
addEventListener('load', openDockFromHash);
addEventListener('hashchange', openDockFromHash);
