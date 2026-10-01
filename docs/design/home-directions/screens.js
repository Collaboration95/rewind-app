'use strict';

/* ---------- 首页以外的画面：设置、拍照、录视频、周日影片 ----------
   跟 dev 上的流程对应（Settings、CameraCaptureScreen、VideoCaptureScreen、首映 / 档案）。
   从首页那台手机进入：头像 → 设置，快门 → 相机，揭晓后的“一起看” → 影片。
   “画面”页把每个流程的关键步骤并排摆出来，每台手机都能接着点。
   画面里没有任何真实媒体：取景框和影片都是抽象的暖色光斑。 */

Object.assign(I, {
  back: '<path d="m14.5 6-6 6 6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  flash: '<path d="M13 3.5 6.5 13h5l-1 7.5L17.5 11h-5z"/>',
  flip: '<path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9"/><path d="M18 3.8v3.6h-3.6M6 20.2v-3.6h3.6"/>',
  users:
    '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17.5 14.6c1.6.6 2.6 2 3 4.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  out: '<path d="M14 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H14M10 12h10M16.5 8.5 20 12l-3.5 3.5"/>',
  pause: '<path d="M8.5 6v12M15.5 6v12"/>',
  save: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>',
  replay: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4.5V9h4.5"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/>',
  share:
    '<path d="M12 15V4M8 7.5 12 4l4 3.5"/><path d="M8.5 10H7a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 17 10h-1.5"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M15.5 7.5l2 2M17.5 5.5l1.5 1.5"/>',
  send: '<path d="M4 11.5 20 4l-6.5 16-2.5-6.5z"/><path d="m11 13.5 9-9.5"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>',
});

// 取景框里的暖色光斑（虚焦的灯），位置固定，慢慢漂
const BOKEH = [
  [22, 30, 120, '#ffcf8a'],
  [70, 22, 90, '#ff9f6b'],
  [48, 52, 160, '#f7b27a'],
  [16, 70, 100, '#ffd9a6'],
  [80, 64, 130, '#e9805a'],
  [58, 84, 80, '#ffe2b8'],
];
const bokeh = () =>
  `<div class="cam-view" aria-hidden="true">${BOKEH.map(
    ([x, y, r, c], i) =>
      `<i style="left:${x}%;top:${y}%;width:${r}px;height:${r}px;background:${c};animation-delay:${-i * 1.7}s"></i>`,
  ).join('')}</div>`;

// 影片里的一格：按片段的作者色画一片抽象的光（揭晓后才知道是谁的）
const frame = (x, i) =>
  `<i class="fm-f" style="--a:${x.col};--b:${['#ffcf8a', '#ff9f6b', '#f7b27a', '#ffd9a6'][i % 4]};--x:${20 + ((i * 37) % 60)}%;--y:${25 + ((i * 53) % 50)}%"></i>`;

const left5 = (d) => Math.max(0, 5 - d.me.c);
const secLeft = (d) => 30 - Number(secs(Math.min(5, d.me.c)));
const tm = (s) => `0:${String(Math.floor(s)).padStart(2, '0')}`;

/* ---------- 设置（按 dev 的 Settings：成员、小组与邀请、周日提醒、Demo 账号） ----------
   step：main | invite | join | joined | create | member | reset（清空数据的确认框） */
// 演示状态：当前扮演的样例成员、提醒开关；只在这一页里记着
const SET = { me: 0, reminder: true };
const PROMPTS = [
  'What made you pause and smile?',
  'What is one small detail from today worth keeping?',
  'What would you like to remember about this moment?',
];
let setUid = 0;
const setHead = (title, back = 'main') =>
  `<header class="sub-h"><button type="button" class="sub-back" ${back === 'close' ? 'data-sub-back' : `data-set-go="${back}"`} aria-label="Back">${ic('back')}</button><h1>${title}</h1><span></span></header>`;
const setRow = (icon, label, note, attrs = '', cls = '') =>
  `<li><button type="button" class="set-row${cls}"${attrs}>${ic(icon)}<span>${label}</span>${note ? `<em>${note}</em>` : ''}${attrs.includes('data-set-go') ? ic('chev', 'go') : ''}</button></li>`;
const avatarOf = (x, cls = '') =>
  `<span class="avatar${cls}" style="--mc:${x.col}">${x.name[0]}</span>`;

function settingsHTML(d, step) {
  const me = POOL[SET.me];
  const main = () =>
    setHead('Settings', 'close') +
    `<button type="button" class="glass set-me" data-set-go="member">${avatarOf(me)}<div><strong>${me.name}</strong><small>Sample member · Demo</small></div>${ic('chev', 'go')}</button>` +
    `<p class="set-k">Group</p><ul class="glass set-list">` +
    `<li class="set-grp"><div><strong>Group name</strong><small>Owner · ${d.n} of 10 members</small></div><div class="stack">${d.members
      .map((x) => `<span class="av" style="--mc:${x.col}">${x.name[0]}</span>`)
      .join('')}</div></li>` +
    setRow('link', 'Invite friends', '', ' data-set-go="invite"') +
    setRow('key', 'Have an invite?', '', ' data-set-go="join"') +
    setRow('plus', 'Create a group', '', ' data-set-go="create"') +
    `</ul><p class="set-k">Reminder</p><ul class="glass set-list">` +
    `<li><label class="set-row">${ic('bell')}<span>Sunday at 7 PM<small>A nudge to add a moment</small></span>` +
    `<input type="checkbox" role="switch" class="sw" data-set-rem${SET.reminder ? ' checked' : ''} /></label></li>` +
    setRow('send', 'Send a test reminder', '', ' data-set-test') +
    `</ul><p class="set-k">Demo access</p><ul class="glass set-list">` +
    setRow('out', 'Sign out of Demo', '', ' data-set-out') +
    setRow('trash', 'Reset local Demo data', '', ' data-set-go="reset"', ' out') +
    `</ul><p class="set-foot">Rewind · Demo access on this device</p>`;
  const pages = {
    main,
    reset: main,
    invite: () =>
      setHead('Invite friends') +
      `<section class="glass set-card set-inv"><p class="set-k">Invite code</p><b class="inv-code">7K2Q X9MB</b>` +
      `<p class="set-note">Works once · expires in 24 hours</p></section>` +
      `<button type="button" class="set-btn primary" data-set-toast="share">${ic('share')}Share invite link</button>` +
      `<div class="set-two"><button type="button" class="set-btn" data-set-toast="link">${ic('link')}Copy link</button>` +
      `<button type="button" class="set-btn" data-set-toast="code">${ic('copy')}Copy code</button></div>` +
      `<p class="set-foot">${d.n} of 10 members in Group name</p>`,
    join: () =>
      setHead('Have an invite?') +
      `<p class="set-lead">Enter the 8-character code a friend sent you.</p>` +
      `<label class="glass set-field"><span>Invite code</span><input data-set-code maxlength="9" placeholder="8-character code" autocomplete="off" autocapitalize="characters" spellcheck="false" /></label>` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-join>Accept invitation</button>`,
    joined: () =>
      setHead('Have an invite?') +
      `<section class="glass set-card set-ok"><span class="set-okic">${ic('check')}</span><h2>Joined Saturday table</h2>` +
      `<p class="set-note">The code is now used.</p></section>` +
      `<button type="button" class="set-btn primary" data-sub-back>Go to the group</button>`,
    create: () => {
      const n = `pr-${++setUid}`;
      return (
        setHead('New group') +
        `<label class="glass set-field"><span>Group name</span><input data-set-name maxlength="80" placeholder="e.g. Saturday table" autocomplete="off" /></label>` +
        `<p class="set-k">Prompt</p><div class="glass set-list set-prompts" role="radiogroup" aria-label="Prompt">` +
        PROMPTS.map(
          (x, i) =>
            `<label class="set-opt"><input type="radio" name="${n}" value="${i}"${i === 0 ? ' checked' : ''} /><span>${x}</span></label>`,
        ).join('') +
        `<label class="set-opt"><input type="radio" name="${n}" value="custom" data-set-custom /><span>Write a custom prompt</span></label>` +
        `<textarea class="set-custom" maxlength="160" placeholder="Write a short prompt" aria-label="Custom prompt" hidden></textarea></div>` +
        `<p class="set-err" role="alert"></p>` +
        `<button type="button" class="set-btn primary" data-set-create>Create group</button>`
      );
    },
    member: () =>
      setHead('Switch member') +
      `<p class="set-lead">Demo only: act as one of the sample members on this device.</p>` +
      `<ul class="glass set-list">` +
      d.members
        .map(
          (x, i) =>
            `<li><button type="button" class="set-row" data-set-me="${i}" aria-pressed="${i === SET.me}">${avatarOf(x, ' sm')}<span>${x.name}<small>Sample member</small></span>${i === SET.me ? ic('check', 'sel') : ''}</button></li>`,
        )
        .join('') +
      `</ul>`,
  };
  return (
    `<div class="scroll">` +
    `<div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    (pages[step] || main)() +
    `</div>` +
    // 清空本地数据：先确认
    (step === 'reset'
      ? `<div class="set-dim" data-set-go="main"></div><section class="glass set-dlg" role="dialog" aria-label="Reset local Demo data confirmation">` +
        `<h2>Reset local Demo data?</h2><p>Groups, moments and the member you chose on this device are cleared.</p>` +
        `<button type="button" class="set-btn" data-set-go="main">Keep local data</button>` +
        `<button type="button" class="set-btn danger" data-set-reset>Reset</button></section>`
      : '')
  );
}

// 设置里换一页：重画这台手机，记得它是不是从首页来的
function goSettings(scr, step) {
  const wrap = scr.closest('.phone-wrap');
  const from = wrap.dataset.from;
  wrap.innerHTML = subScreen('settings', scr.classList[1], { step });
  if (from) wrap.dataset.from = from;
  return wrap.querySelector('.screen');
}
// 测试提醒：像系统通知一样从顶部落下
function testReminder(scr) {
  scr.querySelector('.set-push')?.remove();
  const n = document.createElement('div');
  n.className = 'set-push';
  n.setAttribute('role', 'status');
  n.innerHTML = `${iconHTML(mix.icon, 38)}<div><b>Rewind test reminder</b><span>Local reminders are working on this device.</span></div><em>now</em>`;
  scr.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}
const normCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- 相机：拍照 / 录视频 ----------
   data-mode：photo | video；data-step：perm（还没给权限）| view | rec | review | sealing | sealed */
function cameraHTML(d, mode, step, o = {}) {
  const video = mode === 'video';
  const t = o.t ?? 0;
  const len = o.len ?? 6.2;
  return (
    bokeh() +
    `<div class="cam-flashfx" aria-hidden="true"></div>` +
    `<div class="cam-top"><button type="button" class="cam-ic" data-sub-back aria-label="Close">${ic('close')}</button>` +
    `<span class="cam-pill">${video ? `${secLeft(d)} s left` : `${left5(d)} of 5 left`}</span>` +
    `<button type="button" class="cam-ic" aria-label="Flash">${ic('flash')}</button></div>` +
    `<p class="cam-time" aria-live="off"><i></i><span>${tm(t)}</span> / ${tm(Math.min(15, secLeft(d)))}</p>` +
    // 没给权限
    `<section class="cam-perm glass"><h2>Allow the camera</h2><p>${video ? 'Recording needs the camera and microphone.' : 'Rewind needs the camera to add a moment.'}</p>` +
    `<button type="button" class="cam-allow" data-cam-allow>Allow</button></section>` +
    // 取景、录制
    `<div class="cam-bottom"><div class="cam-modes" role="tablist" aria-label="Capture mode">` +
    `<button type="button" role="tab" data-cam-mode="photo" aria-selected="${!video}">Photo</button>` +
    `<button type="button" role="tab" data-cam-mode="video" aria-selected="${video}">Video</button></div>` +
    `<div class="cam-row"><span class="cam-mine" aria-label="${d.me.c} of your moments sealed">${ic('lock')}<b>${d.me.c}</b></span>` +
    `<button type="button" class="cam-shut" data-cam-shoot aria-label="${video ? 'Start recording' : 'Take photo'}">${arcRing(video ? Math.max(0.001, t / 15) : 0.001)}<span class="cam-core"></span></button>` +
    `<button type="button" class="cam-ic" aria-label="Flip camera">${ic('flip')}</button></div></div>` +
    // 看一眼再封存
    (video ? `<div class="cam-play" aria-hidden="true">${ic('play')}</div>` : '') +
    `<section class="cam-rev">` +
    (video
      ? `<div class="trim" data-len="${len}"><div class="trim-strip">${'<i></i>'.repeat(9)}<span class="trim-shade" style="left:0%;right:0%"></span></div>` +
        `<span class="trim-win" style="left:0%;right:0%"><b class="h l" data-trim="l"></b><b class="h r" data-trim="r"></b></span></div>` +
        `<p class="trim-t">0.0 – ${len.toFixed(1)} s · ${len.toFixed(1)} s</p>` +
        `<div class="looks" role="group" aria-label="Look">${[
          ['none', 'Original'],
          ['soft', 'Soft focus'],
          ['contrast', 'High contrast'],
        ]
          .map(
            ([k, l], i) =>
              `<button type="button" data-look="${k}" aria-pressed="${i === 0}">${l}</button>`,
          )
          .join('')}</div>`
      : '') +
    `<div class="cam-acts"><button type="button" class="cam-retake" data-cam-retake>Retake</button>` +
    `<button type="button" class="cam-seal" data-cam-seal>${ic('lock')}<span>Seal</span></button></div></section>` +
    // 封存好了
    `<section class="cam-done" role="status"><span class="cam-ok">${ic('check')}</span><h2>Sealed</h2>` +
    `<p>${Math.max(0, left5(d) - 1)} of 5 left</p></section>`
  );
}

/* ---------- 周日影片：等大家 → 一起看 → 片尾 ----------
   data-step：wait | play | end */
function filmHTML(d, step) {
  const who = d.members.filter((x) => x.c > 0);
  const moments = who.flatMap((x) => Array.from({ length: x.c }, () => x));
  const here = who.slice(0, Math.max(1, who.length - 1));
  const avs = (list) =>
    list
      .map((x) => `<span class="av" style="--mc:${x.col}" title="${x.name}">${x.name[0]}</span>`)
      .join('');
  return (
    `<div class="fm-frames" aria-hidden="true">${moments.map(frame).join('')}</div>` +
    `<div class="fm-top"><button type="button" class="cam-ic" data-sub-back aria-label="Close">${ic('close')}</button>` +
    `<span class="fm-title">Group name<small>Sunday film</small></span><span class="cam-ic cam-ph" aria-hidden="true"></span></div>` +
    // 等大家
    `<section class="fm-wait"><p class="fm-k">Starts in</p><b class="fm-count" data-fm-count>0:05</b>` +
    `<div class="stack">${avs(here)}<span class="av wait"></span></div><p class="fm-here">${here.length} of ${d.n} here</p>` +
    `<button type="button" class="fm-skip" data-fm-start>Start now</button></section>` +
    // 放映中
    `<div class="fm-bar" aria-hidden="true">${moments.map(() => '<i><b></b></i>').join('')}</div>` +
    `<div class="fm-ctl"><div class="stack">${avs(here)}</div><span class="fm-with">Watching together</span>` +
    `<button type="button" class="cam-ic" data-fm-pause aria-label="Pause">${ic('pause')}</button></div>` +
    // 片尾
    `<section class="fm-end"><h2>Your film</h2><p>${plural(moments.length, 'moment')} · 2 min 14 s</p>` +
    `<div class="fm-cast">${who.map((x) => `<span><i class="av" style="--mc:${x.col}">${x.name[0]}</i>${x.me ? 'You' : x.name}</span>`).join('')}</div>` +
    `<div class="fm-acts"><button type="button" class="glass-btn" data-fm-replay>${ic('replay')}Replay</button>` +
    `<button type="button" class="glass-btn" data-fm-save>${ic('save')}Save</button></div>` +
    `<p class="fm-note">Then it moves to Archive.</p></section>`
  );
}

/* ---------- 画一台“子画面”手机 ---------- */
function subScreen(kind, id, o = {}) {
  const d = dataFor(id);
  const step = o.step || { settings: 'main', camera: 'view', film: 'wait' }[kind];
  const mode = o.mode || 'photo';
  const body =
    kind === 'settings'
      ? settingsHTML(d, step)
      : kind === 'camera'
        ? cameraHTML(d, mode, step, o)
        : filmHTML(d, step);
  const dark = kind !== 'settings';
  return (
    `<div class="device"><div class="screen ${id} sub sub-${kind}${dark ? ' dark' : ''}" data-kind="${kind}" data-step="${step}" data-mode="${mode}" data-t="${o.t ?? 0}">` +
    `${statusBar()}${body}<span class="home-ind" aria-hidden="true"></span></div></div>`
  );
}

// 从首页那台手机进入：记下是从首页来的，返回时重画首页
function openSub(scr, kind, o = {}) {
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  if (!wrap) return;
  wrap.dataset.from = 'home';
  wrap.innerHTML = subScreen(kind, id, o);
  const ns = wrap.querySelector('.screen');
  ns.classList.add('sub-in');
  if (kind === 'film') startWait(ns);
  return ns;
}
function closeSub(scr, sealed) {
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  stopTimers(scr);
  // 画面页里的手机：回到这一步一开始的样子
  if (wrap.dataset.from !== 'home') {
    const fig = wrap.closest('[data-sub]');
    wrap.innerHTML = subScreen(fig.dataset.sub, id, JSON.parse(fig.dataset.opts || '{}'));
    return;
  }
  delete wrap.dataset.from;
  const ns = renderCard(id, scr);
  if (sealed && ns) {
    fx(ns.querySelector('.hero b'), 'fx-roll', 700);
    const sh = ns.querySelector('.shutter');
    if (sh) flashTip(sh, 'Sealed');
  }
}

/* ---------- 计时器（录制、倒数、放映），换画面时一起停掉 ---------- */
const TIMERS_SUB = new WeakMap();
function every(scr, ms, fn) {
  const list = TIMERS_SUB.get(scr) || [];
  list.push(setInterval(fn, ms));
  TIMERS_SUB.set(scr, list);
}
function later(scr, ms, fn) {
  const list = TIMERS_SUB.get(scr) || [];
  list.push(setTimeout(fn, ms));
  TIMERS_SUB.set(scr, list);
}
function stopTimers(scr) {
  (TIMERS_SUB.get(scr) || []).forEach((h) => (clearInterval(h), clearTimeout(h)));
  TIMERS_SUB.delete(scr);
}
const goStep = (scr, step) => (scr.dataset.step = step);

/* ---------- 相机 ---------- */
function shoot(scr) {
  if (scr.dataset.mode === 'photo') {
    // 快门一闪，停在这一帧
    fx(scr.querySelector('.cam-flashfx'), 'go', 500);
    return later(scr, reduceMotion() ? 0 : 180, () => goStep(scr, 'review'));
  }
  if (scr.dataset.step === 'rec' && TIMERS_SUB.has(scr)) return stopRec(scr);
  // 录视频：最长 15 秒，也不能超过本周剩下的秒数
  const max = Math.min(15, Number(scr.querySelector('.cam-pill').textContent.match(/\d+/)[0]));
  const t0 = Date.now() - (scr._t || Number(scr.dataset.t) || 0) * 1000;
  goStep(scr, 'rec');
  scr.querySelector('.cam-shut').setAttribute('aria-label', 'Stop recording');
  every(scr, 100, () => {
    const t = Math.min(max, (Date.now() - t0) / 1000);
    scr._t = t;
    scr.querySelector('.cam-time span').textContent = tm(t);
    const ring = scr.querySelector('.cam-shut .ring');
    ring.outerHTML = arcRing(Math.max(0.001, t / 15));
    if (t >= max) stopRec(scr);
  });
}
function stopRec(scr) {
  stopTimers(scr);
  // 画面页里停在录制中的那台没有计时器，按它显示的秒数算
  const len = Math.max(1, scr._t || Number(scr.dataset.t) || 0);
  const wrap = scr.closest('.phone-wrap');
  const from = wrap.dataset.from;
  // 用录好的长度重画复核这一步
  wrap.innerHTML = subScreen('camera', scr.classList[1], { mode: 'video', step: 'review', len });
  if (from) wrap.dataset.from = from;
}
function seal(scr) {
  goStep(scr, 'sealing');
  later(scr, reduceMotion() ? 200 : 1100, () => {
    const id = scr.classList[1];
    const me = storyPool(id)[0];
    if (me.c < 5) me.c += 1;
    goStep(scr, 'sealed');
    // 从首页来的：停一下再回首页，数字跟着加一
    if (scr.closest('.phone-wrap').dataset.from === 'home')
      later(scr, 1100, () => closeSub(scr, true));
  });
}

// 剪辑：拖两边的把手
function dragTrim(e) {
  const h = e.target.closest('[data-trim]');
  if (!h) return;
  e.preventDefault();
  const trim = h.closest('.trim');
  const win = trim.querySelector('.trim-win');
  const len = Number(trim.dataset.len);
  const box = trim.getBoundingClientRect();
  const move = (ev) => {
    const p = Math.min(100, Math.max(0, ((ev.clientX - box.left) / box.width) * 100));
    const l = parseFloat(win.style.left);
    const r = parseFloat(win.style.right);
    // 至少留半秒
    const gap = (0.5 / len) * 100;
    if (h.dataset.trim === 'l') win.style.left = Math.min(p, 100 - r - gap) + '%';
    else win.style.right = Math.min(100 - p, 100 - l - gap) + '%';
    // 窗口外面压暗的那一层跟着走
    const shade = trim.querySelector('.trim-shade');
    shade.style.left = win.style.left;
    shade.style.right = win.style.right;
    const a = (parseFloat(win.style.left) / 100) * len;
    const b = len - (parseFloat(win.style.right) / 100) * len;
    trim.nextElementSibling.textContent = `${a.toFixed(1)} – ${b.toFixed(1)} s · ${(b - a).toFixed(1)} s`;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
document.addEventListener('pointerdown', dragTrim);

/* ---------- 周日影片 ---------- */
function startWait(scr) {
  let n = 5;
  const el = scr.querySelector('[data-fm-count]');
  every(scr, 1000, () => {
    n -= 1;
    if (el) el.textContent = tm(Math.max(0, n));
    if (n <= 0) startFilm(scr);
  });
}
function startFilm(scr) {
  stopTimers(scr);
  goStep(scr, 'play');
  const frames = [...scr.querySelectorAll('.fm-f')];
  const bars = [...scr.querySelectorAll('.fm-bar i')];
  let i = scr._i || 0;
  const show = () => {
    frames.forEach((f, k) => f.classList.toggle('on', k === i));
    bars.forEach((b, k) => b.classList.toggle('done', k < i));
    bars.forEach((b, k) => b.classList.toggle('now', k === i));
  };
  show();
  every(scr, reduceMotion() ? 600 : 1400, () => {
    if (scr.classList.contains('paused')) return;
    i += 1;
    scr._i = i;
    if (i >= frames.length) {
      stopTimers(scr);
      scr._i = 0;
      return goStep(scr, 'end');
    }
    show();
  });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest(
    '[data-sub-back],[data-cam-shoot],[data-cam-mode],[data-cam-allow],[data-cam-retake],[data-cam-seal],[data-look],[data-set-go],[data-set-toast],[data-set-test],[data-set-out],[data-set-reset],[data-set-me],[data-set-join],[data-set-create],[data-fm-start],[data-fm-pause],[data-fm-replay],[data-fm-save]',
  );
  if (!b) return;
  const scr = b.closest('.screen');
  const d = b.dataset;
  if ('subBack' in d) return closeSub(scr);
  if ('camShoot' in d) return shoot(scr);
  if (d.camMode) {
    if (scr.dataset.step === 'rec' || d.camMode === scr.dataset.mode) return;
    const wrap = scr.closest('.phone-wrap');
    const from = wrap.dataset.from;
    wrap.innerHTML = subScreen('camera', scr.classList[1], { mode: d.camMode, step: 'view' });
    if (from) wrap.dataset.from = from;
    return;
  }
  if ('camAllow' in d) return goStep(scr, 'view');
  if ('camRetake' in d) {
    scr._t = 0;
    const wrap = scr.closest('.phone-wrap');
    const from = wrap.dataset.from;
    wrap.innerHTML = subScreen('camera', scr.classList[1], {
      mode: scr.dataset.mode,
      step: 'view',
    });
    if (from) wrap.dataset.from = from;
    return;
  }
  if ('camSeal' in d) return seal(scr);
  if (d.look) {
    b.parentElement
      .querySelectorAll('[data-look]')
      .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    scr.dataset.look = d.look;
    return;
  }
  if (d.setGo) return goSettings(scr, d.setGo);
  if (d.setToast) return rvToast(t('scr.toast.' + d.setToast));
  if ('setTest' in d) return testReminder(scr);
  if ('setOut' in d) return rvToast(t('scr.toast.out'));
  if ('setReset' in d) {
    goSettings(scr, 'main');
    return rvToast(t('scr.toast.reset'));
  }
  if (d.setMe) {
    SET.me = Number(d.setMe);
    return goSettings(scr, 'member');
  }
  if ('setJoin' in d) {
    const code = normCode(scr.querySelector('[data-set-code]').value);
    if (/^(?:[A-Z0-9]{8}|[A-Z]{6})$/.test(code)) return goSettings(scr, 'joined');
    scr.querySelector('.set-err').textContent =
      'Enter the eight-character invite code using letters and numbers.';
    return;
  }
  if ('setCreate' in d) {
    const name = scr.querySelector('[data-set-name]').value.trim();
    const custom = scr.querySelector('[data-set-custom]').checked;
    const own = scr.querySelector('.set-custom').value.trim();
    const err = scr.querySelector('.set-err');
    if (!name) return (err.textContent = 'Enter a group name.');
    if (custom && !own) return (err.textContent = 'Write a prompt, or pick one above.');
    goSettings(scr, 'main');
    return rvToast(t('scr.toast.created').replace('{name}', name));
  }
  if ('fmStart' in d) return startFilm(scr);
  if ('fmPause' in d) {
    const p = scr.classList.toggle('paused');
    b.innerHTML = ic(p ? 'play' : 'pause');
    b.setAttribute('aria-label', p ? 'Play' : 'Pause');
    return;
  }
  if ('fmReplay' in d) {
    scr._i = 0;
    return startFilm(scr);
  }
  if ('fmSave' in d) return rvToast(t('scr.saved'));
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-set-rem]')) {
    SET.reminder = el.checked;
    return rvToast(t(el.checked ? 'scr.toast.remOn' : 'scr.toast.remOff'));
  }
  // 选了“自己写”才出现输入框
  if (el.matches('.set-opt input')) {
    const ta = el.closest('.set-prompts').querySelector('.set-custom');
    ta.hidden = !el.matches('[data-set-custom]');
    if (!ta.hidden) ta.focus();
  }
});
document.addEventListener('input', (e) => {
  // 重新输入时先清掉上一次的错误
  if (e.target.matches('[data-set-name], .set-custom'))
    e.target.closest('.scroll').querySelector('.set-err').textContent = '';
  if (!e.target.matches('[data-set-code]')) return;
  const v = normCode(e.target.value).slice(0, 8);
  e.target.value = v.length > 4 ? v.slice(0, 4) + ' ' + v.slice(4) : v;
  e.target.closest('.scroll').querySelector('.set-err').textContent = '';
});

/* ---------- “画面”页：每个流程的关键步骤并排 ---------- */
const FLOWS = [
  [
    'set',
    'settings',
    [
      ['main', {}],
      ['invite', { step: 'invite' }],
      ['join', { step: 'join' }],
      ['create', { step: 'create' }],
      ['member', { step: 'member' }],
      ['reset', { step: 'reset' }],
    ],
  ],
  [
    'photo',
    'camera',
    [
      ['perm', { step: 'perm' }],
      ['view', {}],
      ['review', { step: 'review' }],
      ['sealed', { step: 'sealed' }],
    ],
  ],
  [
    'video',
    'camera',
    [
      ['view', { mode: 'video' }],
      ['rec', { mode: 'video', step: 'rec', t: 6 }],
      ['review', { mode: 'video', step: 'review' }],
      ['sealed', { mode: 'video', step: 'sealed' }],
    ],
  ],
  [
    'film',
    'film',
    [
      ['wait', {}],
      ['play', { step: 'play' }],
      ['end', { step: 'end' }],
    ],
  ],
];

function renderScreensView() {
  const root = $('screens-view');
  if (!root) return;
  const id = concepts[0].id;
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('scr.k')}</p><h1>${t('scr.h1')}</h1><p>${t('scr.p')}</p></header>` +
    FLOWS.map(
      ([k, kind, steps]) =>
        `<section class="scr-flow"><h2 class="gal-h">${t('scr.' + k)}</h2><p class="hint">${t('scr.' + k + '.p')}</p><div class="sv-grid">` +
        steps
          .map(
            ([s, o]) =>
              `<figure class="sv-ph" data-sub="${kind}" data-opts='${JSON.stringify(o)}'><div class="card sv-card" data-id="${id}"><div class="phone-wrap">${subScreen(kind, id, o)}</div></div>` +
              `<figcaption><b>${t(`scr.${k}.${s}`)}</b></figcaption></figure>`,
          )
          .join('') +
        `</div></section>`,
    ).join('');
  // 放映中这一台停在第 4 格
  root.querySelectorAll('.sub-film[data-step="play"]').forEach((s) => {
    s.querySelectorAll('.fm-f')[3]?.classList.add('on');
    s.querySelectorAll('.fm-bar i').forEach((b, k) => b.classList.toggle('done', k < 3));
    s.querySelectorAll('.fm-bar i')[3]?.classList.add('now');
    s.classList.add('paused');
    const p = s.querySelector('[data-fm-pause]');
    p.innerHTML = ic('play');
    p.setAttribute('aria-label', 'Play');
    s._i = 3;
  });
  try {
    if (document.body.classList.contains('view-screens'))
      history.replaceState(null, '', '#screens');
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}
// 放映中那台停着：点播放键从这一格接着放
document.addEventListener(
  'click',
  (e) => {
    const b = e.target.closest('[data-fm-pause]');
    const scr = b?.closest('.sub-film');
    if (!scr || TIMERS_SUB.has(scr) || !scr.classList.contains('paused')) return;
    e.stopImmediatePropagation();
    scr.classList.remove('paused');
    b.innerHTML = ic('pause');
    b.setAttribute('aria-label', 'Pause');
    startFilm(scr);
  },
  true,
);

const openScreensFromHash = () => {
  if (/^#screens$/.test(location.hash)) setView('screens');
};
openScreensFromHash();
addEventListener('load', openScreensFromHash);
addEventListener('hashchange', openScreensFromHash);
