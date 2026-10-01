'use strict';

/* ---------- 首页以外的画面：登录、设置、你的片段、录视频、首映影片 ----------
   跟 dev 的产品文档对齐（proposal-rewind、product discovery handoff、UX-CONTRACT）：
   · 一期 4 周，额度每 7 天重置：5 段、共 30 秒、单段最长 15 秒；每周可以删一段重拍。
   · App 只录竖屏视频，录完可以剪；封存后自己也看不到画面，只能看时间和长度。
   · 一期结束时影片首映 24 小时，各自去看，下一期马上开始；短片可能用标着 From the archive 的旧片段补位。
   · 组长（创建者）唯一：改组名、选题目、发会过期的邀请；小组最多 10 人。周日晚 7 点提醒，可以推迟或关闭。
   从首页进入：头像 → 设置，快门 → 相机，额度那一行 → 你的片段，首映卡片 → 影片。
   画面里没有任何真实媒体：取景框和影片都是抽象的暖色光斑。 */

Object.assign(I, {
  back: '<path d="m14.5 6-6 6 6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  flash: '<path d="M13 3.5 6.5 13h5l-1 7.5L17.5 11h-5z"/>',
  flip: '<path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9"/><path d="M18 3.8v3.6h-3.6M6 20.2v-3.6h3.6"/>',
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
  pen: '<path d="M5 19l1-4L16 5l3 3L9 18z"/><path d="M14 7l3 3"/>',
  quote: '<path d="M5 18V12a5 5 0 0 1 5-5M14 18v-6a5 5 0 0 1 5-5"/>',
  snooze: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 9.5h4l-4 4h4"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
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

// 影片里的一格：按片段作者的颜色画一片抽象的光（首映后才知道是谁的）；补位的旧片段是灰调
const frame = (x, i) =>
  x.filler
    ? `<i class="fm-f filler" style="--a:#8a7a6c;--b:#d9cbb8;--x:40%;--y:45%"></i>`
    : `<i class="fm-f" style="--a:${x.col};--b:${['#ffcf8a', '#ff9f6b', '#f7b27a', '#ffd9a6'][i % 4]};--x:${20 + ((i * 37) % 60)}%;--y:${25 + ((i * 53) % 50)}%"></i>`;

// 每段的长度和日子（只是元数据，看不到画面）；和首页 secs() 的累计秒数一致
const CLIP_LEN = [4, 4, 5, 6, 7];
const CLIP_DAY = ['Mon', 'Tue', 'Thu', 'Fri', 'Sat'];
const left5 = (d) => Math.max(0, 5 - d.me.c);
const secLeft = (d) => 30 - Number(secs(Math.min(5, d.me.c)));
const tm = (s) => `0:${String(Math.floor(s)).padStart(2, '0')}`;

/* ---------- 登录（OIDC）；上拉选测试用户 ----------
   step：main | users */
function signinHTML(step) {
  return (
    `<div class="scroll si-scroll"><div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    `<section class="si-brand">${iconHTML(mix.icon, 96)}<h1>Rewind</h1><p>Little moments with your people.</p></section>` +
    `<button type="button" class="set-btn primary si-go" data-si-oidc>Sign in</button>` +
    `<p class="si-note">New here? The same button creates your account.</p></div>` +
    // 测试用户：从底部上拉
    `<section class="glass si-sheet${step === 'users' ? ' open' : ''}" aria-label="Test users">` +
    `<button type="button" class="si-grab" data-si-sheet aria-expanded="${step === 'users'}"><i></i><span>Test users</span></button>` +
    `<ul class="set-list">${POOL.slice(0, 5)
      .map(
        (x, i) =>
          `<li><button type="button" class="set-row" data-si-as="${i}"><span class="avatar sm" style="--mc:${x.col}">${x.name[0]}</span><span>${x.name}<small>${i === 0 ? 'Owner' : 'Member'} · synthetic</small></span></button></li>`,
      )
      .join('')}</ul></section>`
  );
}

/* ---------- 设置（正式账号；按 dev 的 Settings：小组与邀请、题目、周日提醒、账号） ----------
   step：main | invite | join | joined | create | rename | prompt
   组长才能改组名、选题目、发邀请；小组满 10 人时不能邀请 */
const SET = { me: 0, reminder: true, snoozed: false, group: 'Group name', prompt: 0, custom: '' };
const PROMPTS = [
  'What made you pause and smile?',
  'What is one small detail from today worth keeping?',
  'What would you like to remember about this moment?',
];
const isOwner = () => SET.me === 0;
const promptText = () => (SET.prompt === 'custom' ? SET.custom : PROMPTS[SET.prompt]);
let setUid = 0;
const setHead = (title, back = 'main') =>
  `<header class="sub-h"><button type="button" class="sub-back" ${back === 'close' ? 'data-sub-back' : `data-set-go="${back}"`} aria-label="Back">${ic('back')}</button><h1>${title}</h1><span></span></header>`;
const setRow = (icon, label, note, attrs = '', cls = '') =>
  `<li><button type="button" class="set-row${cls}"${attrs}>${ic(icon)}<span>${label}${note ? `<small>${note}</small>` : ''}</span>${attrs.includes('data-set-go') ? ic('chev', 'go') : ''}</button></li>`;
const avatarOf = (x, cls = '') =>
  `<span class="avatar${cls}" style="--mc:${x.col}">${x.name[0]}</span>`;
// 题目选择：新建小组和改题目共用
const promptPicker = (sel) => {
  const n = `pr-${++setUid}`;
  return (
    `<div class="glass set-list set-prompts" role="radiogroup" aria-label="Prompt">` +
    PROMPTS.map(
      (x, i) =>
        `<label class="set-opt"><input type="radio" name="${n}" value="${i}"${sel === i ? ' checked' : ''} /><span>${x}</span></label>`,
    ).join('') +
    `<label class="set-opt"><input type="radio" name="${n}" value="custom" data-set-custom${sel === 'custom' ? ' checked' : ''} /><span>Write a custom prompt</span></label>` +
    `<textarea class="set-custom" maxlength="160" placeholder="Write a short prompt" aria-label="Custom prompt"${sel === 'custom' ? '' : ' hidden'}>${sel === 'custom' ? SET.custom : ''}</textarea></div>`
  );
};

function settingsHTML(d, step) {
  const me = POOL[SET.me];
  const full = d.n >= 10;
  const owner = isOwner();
  const main = () =>
    setHead('Settings', 'close') +
    `<section class="glass set-me">${avatarOf(me)}<div><strong>${me.name}</strong><small>${me.name.toLowerCase()}@example.com</small></div></section>` +
    `<p class="set-k">Group</p><ul class="glass set-list">` +
    `<li class="set-grp"><div><strong>${SET.group}</strong><small>${owner ? 'Owner' : 'Member'} · ${d.n} of 10 members</small></div><div class="stack">${d.members
      .map((x) => `<span class="av" style="--mc:${x.col}">${x.name[0]}</span>`)
      .join('')}</div></li>` +
    (owner
      ? setRow('pen', 'Group name', SET.group, ' data-set-go="rename"') +
        setRow('quote', 'Prompt', promptText(), ' data-set-go="prompt"') +
        (full
          ? `<li><div class="set-row off">${ic('link')}<span>Invite friends<small>The group is full · 10 of 10</small></span></div></li>`
          : setRow('link', 'Invite friends', '', ' data-set-go="invite"'))
      : `<li><div class="set-row off">${ic('quote')}<span>Prompt<small>${promptText()}</small></span></div></li>` +
        `<li class="set-hint">Only the owner can change the prompt or invite friends.</li>`) +
    `</ul><ul class="glass set-list set-more">` +
    setRow('key', 'Have an invite?', '', ' data-set-go="join"') +
    setRow('plus', 'Create a group', '', ' data-set-go="create"') +
    `</ul><p class="set-k">Reminder</p><ul class="glass set-list">` +
    `<li><label class="set-row">${ic('bell')}<span>Sunday at 7 PM<small>${SET.reminder ? (SET.snoozed ? 'Snoozed until next Sunday' : 'A nudge to add a moment') : 'Off'}</small></span>` +
    `<input type="checkbox" role="switch" class="sw" data-set-rem${SET.reminder ? ' checked' : ''} /></label></li>` +
    (SET.reminder
      ? setRow(
          'snooze',
          SET.snoozed ? 'Undo snooze' : 'Snooze this week',
          '',
          ` data-set-snooze aria-pressed="${SET.snoozed}"`,
        ) + setRow('send', 'Send a test reminder', '', ' data-set-test')
      : '') +
    `</ul><p class="set-k">Account</p><ul class="glass set-list">` +
    setRow('out', 'Sign out', '', ' data-set-out', ' out') +
    `</ul><p class="set-foot">Rewind · signed in with your Rewind account</p>`;
  const pages = {
    main,
    invite: () =>
      setHead('Invite friends') +
      `<section class="glass set-card set-inv"><p class="set-k">Invite code</p><b class="inv-code">7K2Q X9MB</b>` +
      `<p class="set-note">Works once · expires in 24 hours</p></section>` +
      `<button type="button" class="set-btn primary" data-set-toast="share">${ic('share')}Share invite link</button>` +
      `<div class="set-two"><button type="button" class="set-btn" data-set-toast="link">${ic('link')}Copy link</button>` +
      `<button type="button" class="set-btn" data-set-toast="code">${ic('copy')}Copy code</button></div>` +
      `<p class="set-foot">${d.n} of 10 members in ${SET.group}</p>`,
    join: () =>
      setHead('Have an invite?') +
      `<p class="set-lead">Enter the 8-character code a friend sent you.</p>` +
      `<label class="glass set-field"><span>Invite code</span><input data-set-code maxlength="9" placeholder="8-character code" autocomplete="off" autocapitalize="characters" spellcheck="false" /></label>` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-join data-busy="Joining…">Accept invitation</button>`,
    joined: () =>
      setHead('Have an invite?') +
      `<section class="glass set-card set-ok"><span class="set-okic">${ic('check')}</span><h2>Joined Saturday table</h2>` +
      `<p class="set-note">The code is now used.</p></section>` +
      `<button type="button" class="set-btn primary" data-sub-back>Go to the group</button>`,
    create: () =>
      setHead('New group') +
      `<label class="glass set-field"><span>Group name</span><input data-set-name maxlength="80" placeholder="e.g. Saturday table" autocomplete="off" /></label>` +
      `<p class="set-k">Prompt</p>${promptPicker(0)}` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-create data-busy="Creating group…">Create group</button>`,
    rename: () =>
      setHead('Group name') +
      `<label class="glass set-field"><span>Group name</span><input data-set-name maxlength="80" value="${SET.group}" autocomplete="off" /></label>` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-rename data-busy="Saving…">Save</button>`,
    prompt: () =>
      setHead('Prompt') +
      `<p class="set-lead">Everyone sees it on Home for this cycle.</p>${promptPicker(SET.prompt)}` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-prompt data-busy="Saving…">Save</button>`,
  };
  return (
    `<div class="scroll">` +
    `<div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    (pages[step] || main)() +
    `</div>`
  );
}

/* ---------- 你的片段：只有元数据；每周可以删一段重拍 ----------
   step：list | confirm | done */
const MINE = { deleted: false, pick: null };
function mineHTML(d, step) {
  const n = d.me.c;
  const used = Number(secs(Math.min(5, n)));
  const rows = Array.from(
    { length: n },
    (_, i) =>
      `<li><button type="button" class="set-row" data-mine-pick="${i}"${MINE.deleted ? ' disabled' : ''}>${ic('lock')}<span>Moment ${i + 1}<small>${CLIP_LEN[i]} s · ${CLIP_DAY[i]}</small></span>${MINE.deleted ? '' : ic('trash', 'go del')}</button></li>`,
  ).join('');
  return (
    `<div class="scroll"><div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    `<header class="sub-h"><button type="button" class="sub-back" data-sub-back aria-label="Back">${ic('back')}</button><h1>Your moments</h1><span></span></header>` +
    `<section class="glass set-card mine-sum"><b>${n} of 5</b><p class="set-note">${used} of 30 s · resets in 3 days</p></section>` +
    `<p class="set-lead">Sealed until the film. You can see when, not what.</p>` +
    (n
      ? `<ul class="glass set-list">${rows}</ul>`
      : `<p class="set-lead">Nothing sealed yet this week.</p>`) +
    `<p class="set-foot">${MINE.deleted ? 'You used this week’s delete. It comes back in 3 days.' : 'Once a week, you can delete one and retake it.'}</p>` +
    (step === 'done'
      ? `<button type="button" class="set-btn primary" data-mine-retake>${ic('camera')}Retake now</button>`
      : '') +
    `</div>` +
    (step === 'confirm'
      ? `<div class="set-dim" data-mine-keep></div><section class="glass set-dlg" role="dialog" aria-label="Delete moment confirmation">` +
        `<h2>Delete moment ${(MINE.pick ?? 0) + 1}?</h2><p>It’s gone for good, and its ${CLIP_LEN[MINE.pick ?? 0]} s go back to your week. You can do this once a week.</p>` +
        `<button type="button" class="set-btn" data-mine-keep>Keep it</button>` +
        `<button type="button" class="set-btn danger" data-mine-del data-busy="Deleting…">Delete</button></section>`
      : '')
  );
}

/* ---------- 相机：只录竖屏视频 ----------
   data-step：perm（还没给权限）| view | rec | review | upload | sealed */
function cameraHTML(d, step, o = {}) {
  const t = o.t ?? 0;
  const len = o.len ?? 6.2;
  const pct = o.pct ?? 0;
  return (
    bokeh() +
    `<div class="cam-top"><button type="button" class="cam-ic" data-sub-back aria-label="Close">${ic('close')}</button>` +
    `<span class="cam-pill" data-sec="${secLeft(d)}">${left5(d)} left · ${secLeft(d)} s</span>` +
    `<button type="button" class="cam-ic" aria-label="Flash">${ic('flash')}</button></div>` +
    `<p class="cam-time" aria-live="off"><i></i><span>${tm(t)}</span> / ${tm(Math.min(15, secLeft(d)))}</p>` +
    // 没给权限：录视频要相机和麦克风
    `<section class="cam-perm glass"><h2>Allow camera and mic</h2><p>Rewind records short videos with sound.</p>` +
    `<button type="button" class="cam-allow" data-cam-allow>Allow</button></section>` +
    // 取景、录制
    `<div class="cam-bottom"><div class="cam-row"><button type="button" class="cam-mine" data-cam-mine aria-label="Your moments: ${d.me.c} sealed">${ic('lock')}<b>${d.me.c}</b></button>` +
    `<button type="button" class="cam-shut" data-cam-shoot aria-label="Start recording">${arcRing(Math.max(0.001, t / 15))}<span class="cam-core"></span></button>` +
    `<button type="button" class="cam-ic" aria-label="Flip camera">${ic('flip')}</button></div></div>` +
    // 看一眼、剪一下，再封存
    `<div class="cam-play" aria-hidden="true">${ic('play')}</div>` +
    `<section class="cam-rev">` +
    `<div class="trim" data-len="${len}"><div class="trim-strip">${'<i></i>'.repeat(9)}<span class="trim-shade" style="left:0%;right:0%"></span></div>` +
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
      .join('')}</div>` +
    `<div class="cam-acts"><button type="button" class="cam-retake" data-cam-retake>Retake</button>` +
    `<button type="button" class="cam-seal" data-cam-seal>${ic('lock')}<span>Seal</span></button></div></section>` +
    // 上传中：可以取消
    `<section class="cam-up" role="status"><div class="cam-upbar"><i style="width:${pct}%"></i></div>` +
    `<p><span data-cam-pct>Uploading ${pct}%</span></p>` +
    `<button type="button" class="cam-retake" data-cam-cancel>Cancel</button></section>` +
    // 封存好了
    `<section class="cam-done" role="status"><span class="cam-ok">${ic('check')}</span><h2>Sealed</h2>` +
    `<p>${Math.max(0, left5(d) - 1)} left · finishing in the background</p></section>`
  );
}

/* ---------- 首映影片：直接放，24 小时内各自看 ----------
   data-step：play | end */
function filmHTML(d, step) {
  const who = d.members.filter((x) => x.c > 0);
  const moments = who.flatMap((x) => Array.from({ length: x.c }, () => x));
  // 片子偏短时，第 3 格用一段标着 From the archive 的旧片段补位
  moments.splice(2, 0, { filler: true });
  return (
    `<div class="fm-frames" aria-hidden="true">${moments.map(frame).join('')}</div>` +
    // 补位的旧片段在放的时候，角上标出来（标签不放在模糊的画面里）
    `<span class="fm-tag">From the archive</span>` +
    `<div class="fm-top"><button type="button" class="cam-ic" data-sub-back aria-label="Close">${ic('close')}</button>` +
    `<span class="fm-title">${SET.group}<small>Premiere · 18 h left</small></span><span class="cam-ic cam-ph" aria-hidden="true"></span></div>` +
    // 放映中
    `<div class="fm-bar" aria-hidden="true">${moments.map(() => '<i><b></b></i>').join('')}</div>` +
    `<div class="fm-ctl"><button type="button" class="glass-btn" data-fm-chat>${ic('chat')}Talk about it</button>` +
    `<button type="button" class="cam-ic" data-fm-pause aria-label="Pause">${ic('pause')}</button></div>` +
    // 片尾
    `<section class="fm-end"><h2>Your film</h2><p>${plural(moments.length - 1, 'moment')} · 2 min 14 s</p>` +
    `<div class="fm-cast">${who.map((x) => `<span><i class="av" style="--mc:${x.col}">${x.name[0]}</i>${x.me ? 'You' : x.name}</span>`).join('')}</div>` +
    `<div class="fm-acts"><button type="button" class="glass-btn" data-fm-replay>${ic('replay')}Replay</button>` +
    `<button type="button" class="glass-btn" data-fm-save="film">${ic('save')}Save film</button></div>` +
    `<button type="button" class="fm-link" data-fm-save="mine">Save your own moments</button>` +
    `<p class="fm-note">It stays in Archive.</p></section>`
  );
}

/* ---------- 画一台“子画面”手机 ---------- */
function subScreen(kind, id, o = {}) {
  const d = dataFor(id);
  const step =
    o.step ||
    { signin: 'main', settings: 'main', mine: 'list', camera: 'view', film: 'play' }[kind];
  const body = {
    signin: () => signinHTML(step),
    settings: () => settingsHTML(d, step),
    mine: () => mineHTML(d, step),
    camera: () => cameraHTML(d, step, o),
    film: () => filmHTML(d, step),
  }[kind]();
  const dark = kind === 'camera' || kind === 'film';
  return (
    `<div class="device"><div class="screen ${id} sub sub-${kind}${dark ? ' dark' : ''}" data-kind="${kind}" data-step="${step}" data-t="${o.t ?? 0}">` +
    `${statusBar()}${body}<span class="home-ind" aria-hidden="true"></span></div></div>`
  );
}

// 从首页那台手机进入：记下是从首页来的，返回时重画首页
function openSub(scr, kind, o = {}) {
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  if (!wrap) return;
  stopTimers(scr);
  wrap.dataset.from = 'home';
  wrap.innerHTML = subScreen(kind, id, o);
  const ns = wrap.querySelector('.screen');
  ns.classList.add('sub-in');
  if (kind === 'film') startFilm(ns);
  return ns;
}
// 同一台手机换一步：重画，记得它是不是从首页来的
function redraw(scr, kind, o) {
  const wrap = scr.closest('.phone-wrap');
  const from = wrap.dataset.from;
  stopTimers(scr);
  wrap.innerHTML = subScreen(kind, scr.classList[1], o);
  if (from) wrap.dataset.from = from;
  return wrap.querySelector('.screen');
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
    fx(ns.querySelector('.mine-row'), 'fx-roll', 700);
    const sh = ns.querySelector('.shutter');
    if (sh) flashTip(sh, 'Sealed');
  }
}

/* ---------- 计时器（录制、上传、放映），换画面时一起停掉 ---------- */
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
// 按钮在等结果时：换成“进行中”的字、不能再点（UX-CONTRACT）
function busy(btn, ms, done) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = btn.dataset.busy || '…';
  setTimeout(
    () => {
      if (!btn.isConnected) return done();
      btn.innerHTML = label;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      done();
    },
    reduceMotion() ? 100 : ms,
  );
}

/* ---------- 相机 ---------- */
function shoot(scr) {
  if (scr.dataset.step === 'rec' && TIMERS_SUB.has(scr)) return stopRec(scr);
  // 最长 15 秒，也不能超过本周剩下的秒数
  const max = Math.min(15, Number(scr.querySelector('.cam-pill').dataset.sec));
  const t0 = Date.now() - (scr._t || Number(scr.dataset.t) || 0) * 1000;
  goStep(scr, 'rec');
  scr.querySelector('.cam-shut').setAttribute('aria-label', 'Stop recording');
  every(scr, 100, () => {
    const t = Math.min(max, (Date.now() - t0) / 1000);
    scr._t = t;
    scr.querySelector('.cam-time span').textContent = tm(t);
    scr.querySelector('.cam-shut .ring').outerHTML = arcRing(Math.max(0.001, t / 15));
    if (t >= max) stopRec(scr);
  });
}
function stopRec(scr) {
  // 画面页里停在录制中的那台没有计时器，按它显示的秒数算
  const len = Math.max(1, scr._t || Number(scr.dataset.t) || 0);
  redraw(scr, 'camera', { step: 'review', len });
}
// 上传：进度可以看、可以取消；传完就封存，处理在后台
function upload(scr) {
  goStep(scr, 'upload');
  let pct = 0;
  const bar = scr.querySelector('.cam-upbar i');
  const txt = scr.querySelector('[data-cam-pct]');
  every(scr, reduceMotion() ? 40 : 90, () => {
    pct = Math.min(100, pct + 7);
    bar.style.width = pct + '%';
    txt.textContent = `Uploading ${pct}%`;
    if (pct < 100) return;
    stopTimers(scr);
    const me = storyPool(scr.classList[1])[0];
    if (me.c < 5) me.c += 1;
    goStep(scr, 'sealed');
    // 从首页来的：停一下再回首页，额度那一行跟着变
    if (scr.closest('.phone-wrap').dataset.from === 'home')
      later(scr, 1200, () => closeSub(scr, true));
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

/* ---------- 首映影片 ---------- */
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

/* ---------- 设置里的小交互 ---------- */
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
// 题目选择器里选中的题目；自己写但没写时返回 null
function pickedPrompt(scr) {
  const custom = scr.querySelector('[data-set-custom]').checked;
  if (!custom) return Number(scr.querySelector('.set-opt input:checked').value);
  const own = scr.querySelector('.set-custom').value.trim();
  return own ? { custom: own } : null;
}
const err = (scr, text) => (scr.querySelector('.set-err').textContent = text);

document.addEventListener('click', (e) => {
  const b = e.target.closest(
    '[data-sub-back],[data-cam-shoot],[data-cam-allow],[data-cam-retake],[data-cam-seal],[data-cam-cancel],[data-cam-mine],[data-look],' +
      '[data-set-go],[data-set-toast],[data-set-test],[data-set-out],[data-set-snooze],[data-set-join],[data-set-create],[data-set-rename],[data-set-prompt],' +
      '[data-si-sheet],[data-si-as],[data-si-oidc],[data-mine-pick],[data-mine-keep],[data-mine-del],[data-mine-retake],' +
      '[data-fm-pause],[data-fm-replay],[data-fm-save],[data-fm-chat]',
  );
  if (!b || b.disabled) return;
  const scr = b.closest('.screen');
  const d = b.dataset;
  if ('subBack' in d) return closeSub(scr);
  // 相机
  if ('camShoot' in d) return shoot(scr);
  if ('camAllow' in d) return goStep(scr, 'view');
  if ('camRetake' in d) {
    scr._t = 0;
    return redraw(scr, 'camera', {});
  }
  if ('camSeal' in d) return upload(scr);
  if ('camCancel' in d) {
    stopTimers(scr);
    goStep(scr, 'review');
    return rvToast(t('scr.toast.cancel'));
  }
  if ('camMine' in d) return redraw(scr, 'mine', {});
  if (d.look) {
    b.parentElement
      .querySelectorAll('[data-look]')
      .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    scr.dataset.look = d.look;
    return;
  }
  // 设置
  if (d.setGo) return redraw(scr, 'settings', { step: d.setGo });
  if (d.setToast) return rvToast(t('scr.toast.' + d.setToast));
  if ('setTest' in d) return testReminder(scr);
  if ('setSnooze' in d) {
    SET.snoozed = !SET.snoozed;
    redraw(scr, 'settings', { step: 'main' });
    return rvToast(t(SET.snoozed ? 'scr.toast.snoozed' : 'scr.toast.unsnoozed'));
  }
  if ('setOut' in d) return redraw(scr, 'signin', {});
  if ('setJoin' in d) {
    const code = normCode(scr.querySelector('[data-set-code]').value);
    if (!/^(?:[A-Z0-9]{8}|[A-Z]{6})$/.test(code))
      return err(scr, 'Enter the eight-character invite code using letters and numbers.');
    return busy(b, 700, () => redraw(scr, 'settings', { step: 'joined' }));
  }
  if ('setCreate' in d) {
    const name = scr.querySelector('[data-set-name]').value.trim();
    if (!name) return err(scr, 'Enter a group name.');
    if (pickedPrompt(scr) === null) return err(scr, 'Write a prompt, or pick one above.');
    return busy(b, 800, () => {
      redraw(scr, 'settings', { step: 'main' });
      rvToast(t('scr.toast.created').replace('{name}', name));
    });
  }
  if ('setRename' in d) {
    const name = scr.querySelector('[data-set-name]').value.trim();
    if (!name) return err(scr, 'Enter a group name.');
    return busy(b, 600, () => {
      SET.group = name;
      redraw(scr, 'settings', { step: 'main' });
      rvToast(t('scr.toast.saved'));
    });
  }
  if ('setPrompt' in d) {
    const p = pickedPrompt(scr);
    if (p === null) return err(scr, 'Write a prompt, or pick one above.');
    return busy(b, 600, () => {
      if (typeof p === 'number') SET.prompt = p;
      else Object.assign(SET, { prompt: 'custom', custom: p.custom });
      redraw(scr, 'settings', { step: 'main' });
      rvToast(t('scr.toast.saved'));
    });
  }
  // 登录
  if ('siSheet' in d) {
    const open = scr.querySelector('.si-sheet').classList.toggle('open');
    b.setAttribute('aria-expanded', String(open));
    goStep(scr, open ? 'users' : 'main');
    return;
  }
  if ('siOidc' in d) return rvToast(t('scr.toast.oidc'));
  if (d.siAs) {
    SET.me = Number(d.siAs);
    rvToast(t('scr.toast.as').replace('{name}', POOL[SET.me].name));
    return closeSub(scr);
  }
  // 你的片段
  if (d.minePick) {
    MINE.pick = Number(d.minePick);
    return redraw(scr, 'mine', { step: 'confirm' });
  }
  if ('mineKeep' in d) return redraw(scr, 'mine', { step: 'list' });
  if ('mineDel' in d) {
    return busy(b, 600, () => {
      const me = storyPool(scr.classList[1])[0];
      me.c = Math.max(0, me.c - 1);
      MINE.deleted = true;
      redraw(scr, 'mine', { step: 'done' });
      rvToast(t('scr.toast.deleted'));
    });
  }
  if ('mineRetake' in d) return redraw(scr, 'camera', {});
  // 影片
  if ('fmPause' in d) {
    // 停着的那台（画面页）：点一下从这一格接着放
    if (!TIMERS_SUB.has(scr)) {
      scr.classList.remove('paused');
      b.innerHTML = ic('pause');
      b.setAttribute('aria-label', 'Pause');
      return startFilm(scr);
    }
    const p = scr.classList.toggle('paused');
    b.innerHTML = ic(p ? 'play' : 'pause');
    b.setAttribute('aria-label', p ? 'Play' : 'Pause');
    return;
  }
  if ('fmReplay' in d) {
    scr._i = 0;
    return startFilm(scr);
  }
  if (d.fmSave) return rvToast(t('scr.toast.save.' + d.fmSave));
  if ('fmChat' in d) return rvToast(t('scr.toast.chat'));
});

// 测试用户的面板也可以往上拖开、往下拖收起
document.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('[data-si-sheet]');
  if (!g) return;
  const y0 = e.clientY;
  const up = (ev) => {
    removeEventListener('pointerup', up);
    const dy = ev.clientY - y0;
    if (Math.abs(dy) < 24) return;
    const scr = g.closest('.screen');
    const sheet = scr.querySelector('.si-sheet');
    if (dy < 0 !== sheet.classList.contains('open')) g.click();
  };
  addEventListener('pointerup', up);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-set-rem]')) {
    SET.reminder = el.checked;
    if (!el.checked) SET.snoozed = false;
    redraw(el.closest('.screen'), 'settings', { step: 'main' });
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
  const scroll = e.target.closest('.scroll');
  // 重新输入时先清掉上一次的错误
  if (e.target.matches('[data-set-name], .set-custom, [data-set-code]') && scroll)
    scroll.querySelector('.set-err').textContent = '';
  if (!e.target.matches('[data-set-code]')) return;
  const v = normCode(e.target.value).slice(0, 8);
  e.target.value = v.length > 4 ? v.slice(0, 4) + ' ' + v.slice(4) : v;
});

/* ---------- “画面”页：每个流程的关键步骤并排 ---------- */
const FLOWS = [
  [
    'signin',
    'signin',
    [
      ['main', {}],
      ['users', { step: 'users' }],
    ],
  ],
  [
    'set',
    'settings',
    [
      ['main', {}],
      ['invite', { step: 'invite' }],
      ['join', { step: 'join' }],
      ['create', { step: 'create' }],
      ['prompt', { step: 'prompt' }],
    ],
  ],
  [
    'mine',
    'mine',
    [
      ['list', {}],
      ['confirm', { step: 'confirm' }],
    ],
  ],
  [
    'video',
    'camera',
    [
      ['perm', { step: 'perm' }],
      ['view', {}],
      ['rec', { step: 'rec', t: 6 }],
      ['review', { step: 'review' }],
      ['upload', { step: 'upload', pct: 42 }],
      ['sealed', { step: 'sealed' }],
    ],
  ],
  [
    'film',
    'film',
    [
      ['play', { step: 'play' }],
      ['filler', { step: 'play', at: 2 }],
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
  // 放映中的几台停在某一格，点播放键接着放
  root.querySelectorAll('[data-sub="film"]').forEach((fig) => {
    const o = JSON.parse(fig.dataset.opts);
    if (o.step !== 'play') return;
    const s = fig.querySelector('.screen');
    const at = o.at ?? 4;
    s.querySelectorAll('.fm-f')[at]?.classList.add('on');
    s.querySelectorAll('.fm-bar i').forEach((b, k) => b.classList.toggle('done', k < at));
    s.querySelectorAll('.fm-bar i')[at]?.classList.add('now');
    s.classList.add('paused');
    const p = s.querySelector('[data-fm-pause]');
    p.innerHTML = ic('play');
    p.setAttribute('aria-label', 'Play');
    s._i = at;
  });
  try {
    if (document.body.classList.contains('view-screens'))
      history.replaceState(null, '', '#screens');
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}

const openScreensFromHash = () => {
  if (/^#screens$/.test(location.hash)) setView('screens');
};
openScreensFromHash();
addEventListener('load', openScreensFromHash);
addEventListener('hashchange', openScreensFromHash);
