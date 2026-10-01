'use strict';

/* ---------- 首页以外的画面：登录、设置、你的片段、相机、首映影片 ----------
   以 dev 上最新的 Sprint 2 用户流程（doc/planning/sprints/sprint-2-user-journey-plan.md，9 月 27 日）为准，
   其余按 proposal-rewind、UX-CONTRACT：
   · 一期 4 周，额度每 7 天重置：5 段、共 30 秒；视频单段最长 15 秒；照片算 1 段、在影片里占 3 秒。
   · 相机有视频和照片；视频录完可以剪、选效果（dev 现有的三种），再提交；每周可以删一段重拍。
   · 封存后自己也看不到画面，只能看时间和长度。
   · 一期结束时影片首映 24 小时，各自去看，下一期马上开始；短片可能用标着 From the archive 的旧片段补位。
   · 组长唯一：改组名、选题目、发会过期的邀请；小组最多 10 人。周日提醒可以改时间、推迟或关闭；可以切换小组。
   · 登录：管理员预先建好的用户名和密码；欢迎页另有分开的 Try Demo，Demo 身份的控制单独放在设置里。
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
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  users:
    '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17.5 14.6c1.6.6 2.6 2 3 4.4"/>',
  video: '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="m15.5 10.5 5-3v9l-5-3"/>',
});

// 用户输入放进页面前转义
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );

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

const left5 = (d) => Math.max(0, 5 - d.me.c);
const secLeft = (d) => Math.max(0, 30 - usedSecs(d.me));
const tm = (s) => `0:${String(Math.floor(s)).padStart(2, '0')}`;
// 照片在影片里固定占 3 秒
const PHOTO_SECS = 3;

/* ---------- 演示状态：当前登录的人、小组、题目、提醒 ---------- */
const SET = {
  me: 0,
  demo: false,
  // who：新注册的账号（名字、颜色、邮箱或手机号）；样例账号时为 null
  who: null,
  list: [],
  gi: 0,
  prompt: 0,
  custom: '',
  reminder: true,
  snoozed: false,
  time: '7 PM',
};
const PROMPTS = [
  'What made you pause and smile?',
  'What is one small detail from today worth keeping?',
  'What would you like to remember about this moment?',
];
const TIMES = ['6 PM', '7 PM', '8 PM', '9 PM'];
// 自定义时间：'19:30' ↔ '7:30 PM'
const to12 = (v) => {
  const [h, m] = v.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
const to24 = (v) => {
  const [, h, m = '0', ap] = v.match(/(\d+)(?::(\d+))? (AM|PM)/);
  return `${String((Number(h) % 12) + (ap === 'PM' ? 12 : 0)).padStart(2, '0')}:${m.padStart(2, '0')}`;
};
// 每个小组一条记录。样例小组（sample）用侧栏的样例数据；其他小组是固定的快照：
// n 几个人、no 第几期、cyc 这一期到哪了、clips 你这周的片段、owner 你是不是组长
const GROUPS0 = () => [
  { id: 'g1', name: 'Group name', sample: true },
  {
    id: 'g2',
    name: 'Saturday table',
    owner: false,
    n: 4,
    no: 1,
    cyc: { week: 3, days: 9, reset: 2 },
    prompt: 1,
    clips: [
      ['photo', 3, 'Sun'],
      ['video', 6, 'Mon'],
    ],
  },
];
SET.list = GROUPS0();
// 原型里的邀请码：BOOKCLUB 能加入；其余几个演示加入失败
const INVITES = {
  BOOKCLUB: {
    id: 'g3',
    name: 'Book club',
    owner: false,
    n: 6,
    no: 1,
    cyc: { week: 2, days: 18, reset: 4 },
    prompt: 2,
    clips: [],
  },
  EXPIRED1: 'expired',
  USEDCODE: 'used',
  FULLFULL: 'full',
};
const JOIN_ERR = {
  none: 'That code doesn’t match a group. Check it with your friend.',
  expired: 'This invite has expired. Ask your friend for a new one.',
  used: 'This invite was already used. Ask your friend for a new one.',
  full: 'That group is full (10 of 10). Ask the owner.',
};
const grp = () => SET.list[SET.gi];
const isSample = () => !!grp()?.sample;
const groupName = () => grp()?.name ?? '';
// 样例小组里 Alex 是组长；其他小组看记录
const isOwner = () => {
  const g = grp();
  if (!g) return false;
  return g.sample ? SET.me === 0 && !SET.who : !!g.owner;
};
// 题目跟着小组走：样例小组记在 SET 上，其他小组记在自己的记录上
const promptOf = () => (isSample() || !grp() ? SET : grp());
const promptText = () => {
  const r = promptOf();
  return r.prompt === 'custom' ? r.custom : PROMPTS[r.prompt ?? 0];
};
// 换回样例账号（登录、Demo、清空数据）：小组也回到样例
const sampleAccount = () => Object.assign(SET, { who: null, list: GROUPS0(), gi: 0 });

/* ---------- 欢迎和登录 ----------
   step：welcome | form | wrong | offline | expired | demo
   正式账号是管理员建好的用户名和密码（原型里密码是 rewind）；Try Demo 是分开的一条路，选一个标明 synthetic 的演示成员 */
function signinHTML(step) {
  if (/^up/.test(step)) return signupHTML(step);
  const form = ['form', 'wrong', 'offline'].includes(step);
  const errText = {
    wrong: 'Wrong username or password.',
    offline: 'You’re offline. Try again when you’re connected.',
  }[step];
  const welcome =
    `<section class="si-brand">${iconHTML(mix.icon, 96)}<h1>Rewind</h1><p>Small moments with your people, opened together every 4 weeks.</p></section>` +
    (step === 'expired'
      ? `<p class="si-alert" role="status">You were signed out. Please sign in again.</p>`
      : '') +
    `<button type="button" class="set-btn primary si-go" data-si-go="form">Sign in</button>` +
    `<button type="button" class="set-btn si-up" data-si-go="up">Create an account</button>`;
  const login =
    `<header class="sub-h"><button type="button" class="sub-back" data-si-go="welcome" aria-label="Back">${ic('back')}</button><h1>Sign in</h1><span></span></header>` +
    `<label class="glass set-field"><span>Email, phone or username</span><input data-si-user autocomplete="username" autocapitalize="none" spellcheck="false" value="${form && step !== 'form' ? 'alex' : ''}" /></label>` +
    `<label class="glass set-field si-pass"><span>Password</span><input data-si-pass type="password" autocomplete="current-password" value="${form && step !== 'form' ? 'notright' : ''}" /></label>` +
    `<p class="set-err" role="alert">${errText || ''}</p>` +
    `<button type="button" class="set-btn primary" data-si-submit data-busy="Signing in…">Sign in</button>` +
    `<p class="si-note">Forgot your password? <button type="button" class="up-link" data-si-forgot>Reset it</button></p>` +
    `<p class="si-note">New here? <button type="button" class="up-link" data-si-go="up">Create an account</button></p>`;
  return (
    `<div class="scroll si-scroll${form ? ' form' : ''}"><div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    (form ? login : welcome) +
    `</div>` +
    // Try Demo：和正式登录分开，从底部上拉
    (form
      ? ''
      : `<section class="glass si-sheet${step === 'demo' ? ' open' : ''}" aria-label="Try Demo">` +
        `<button type="button" class="si-grab" data-si-sheet aria-expanded="${step === 'demo'}"><i></i><span>Try Demo</span></button>` +
        `<p class="si-sub">Synthetic members, kept apart from real accounts.</p>` +
        `<ul class="set-list">${POOL.slice(0, 5)
          .map(
            (x, i) =>
              `<li><button type="button" class="set-row" data-si-as="${i}"><span class="avatar sm" style="--mc:${x.col}">${x.name[0]}</span><span>${x.name}<small>${i === 0 ? 'Owner' : 'Member'} · synthetic</small></span></button></li>`,
          )
          .join('')}</ul></section>`)
  );
}

/* ---------- 注册：邮箱或手机号 → 验证码 → 名字和密码 → 加入或新建小组 ----------
   step：up | upbad | upcode | upcodebad | upname；注册完回到“还没有小组”的首页
   原型里验证码是 123456；alex@ 开头的邮箱当作已经注册过 */
const UP = { via: 'email', to: 'mia@example.com', cc: '+65', name: 'Mia' };
const upHead = (title, back) =>
  `<header class="sub-h"><button type="button" class="sub-back" data-si-go="${back}" aria-label="Back">${ic('back')}</button><h1>${title}</h1><span></span></header>`;
function signupHTML(step) {
  const email = UP.via === 'email';
  const shown = email ? UP.to : `${UP.cc} ${UP.to}`;
  const pages = {
    up: () =>
      upHead('Create account', 'welcome') +
      `<div class="up-via" role="tablist" aria-label="Sign up with">` +
      [
        ['email', 'Email'],
        ['phone', 'Phone'],
      ]
        .map(
          ([k, l]) =>
            `<button type="button" role="tab" data-up-via="${k}" aria-selected="${UP.via === k}">${l}</button>`,
        )
        .join('') +
      `</div>` +
      (email
        ? `<label class="glass set-field"><span>Email</span><input data-up-to type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="you@example.com" value="${step === 'upbad' ? 'alex@example.com' : ''}" /></label>`
        : `<div class="glass set-field up-phone"><span>Phone number</span><div><select data-up-cc aria-label="Country code">${[
            '+65',
            '+86',
            '+60',
            '+1',
            '+44',
          ]
            .map((c) => `<option${c === UP.cc ? ' selected' : ''}>${c}</option>`)
            .join('')}</select>` +
          `<input data-up-to type="tel" inputmode="tel" autocomplete="tel-national" placeholder="8123 4567" aria-label="Phone number" /></div></div>`) +
      `<p class="set-err" role="alert">${step === 'upbad' ? 'An account already uses this email. <button type="button" class="up-link" data-si-go="form">Sign in instead</button>' : ''}</p>` +
      `<button type="button" class="set-btn primary" data-up-send data-busy="Sending…">Send code</button>` +
      `<p class="si-note">We’ll send a 6-digit code to check it’s you.</p>` +
      `<p class="si-note">Already have an account? <button type="button" class="up-link" data-si-go="form">Sign in</button></p>`,
    upcode: () =>
      upHead('Enter the code', 'up') +
      `<p class="set-lead">We sent a 6-digit code to <b>${esc(shown)}</b>.</p>` +
      `<label class="glass set-field up-code"><span>Code</span><input data-up-code inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" value="${step === 'upcodebad' ? '482913' : ''}" /></label>` +
      `<p class="set-err" role="alert">${step === 'upcodebad' ? 'That code doesn’t match. Check it, or send a new one.' : ''}</p>` +
      `<button type="button" class="set-btn primary" data-up-verify data-busy="Checking…">Continue</button>` +
      `<button type="button" class="up-resend" data-up-resend disabled>Send a new code in 0:30</button>` +
      `<p class="si-note">In the prototype the code is 123456.</p>`,
    upname: () =>
      upHead('About you', 'up') +
      `<p class="set-lead">Your group sees your name.</p>` +
      `<label class="glass set-field"><span>Name</span><input data-up-name autocomplete="name" maxlength="40" placeholder="Your name" /></label>` +
      `<label class="glass set-field si-pass"><span>Password</span><input data-up-pass type="password" autocomplete="new-password" placeholder="At least 8 characters" /></label>` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-up-create data-busy="Creating account…">Create account</button>`,
  };
  const page = { upbad: 'up', upcodebad: 'upcode' }[step] || step;
  return (
    `<div class="scroll si-scroll form up-${page}"><div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    pages[page]() +
    `</div>`
  );
}
// 重发验证码的倒计时
function resendTimer(scr) {
  const b = scr.querySelector('[data-up-resend]');
  if (!b) return;
  let n = 30;
  b.disabled = true;
  every(scr, reduceMotion() ? 100 : 1000, () => {
    n -= 1;
    if (n > 0) return (b.textContent = `Send a new code in 0:${String(n).padStart(2, '0')}`);
    stopTimers(scr);
    b.disabled = false;
    b.textContent = 'Send a new code';
  });
}

/* ---------- 设置 ----------
   step：main | groups | time | invite | join | joined | create | rename | prompt | member | reset
   组长才能改组名、选题目、发邀请；小组满 10 人时不能邀请；Demo 身份的控制只在用 Demo 登录时出现 */
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
    `<textarea class="set-custom" maxlength="160" placeholder="Write a short prompt" aria-label="Custom prompt"${sel === 'custom' ? '' : ' hidden'}>${sel === 'custom' ? esc(promptOf().custom || '') : ''}</textarea></div>`
  );
};

function settingsHTML(d, step, o = {}) {
  const me = acting();
  const full = d.n >= 10;
  const owner = isOwner();
  // 还没有小组：小组这一块只有加入和新建
  const noGroup = () =>
    `<p class="set-k">Group</p><ul class="glass set-list"><li class="set-hint">You’re not in a group yet.</li>` +
    setRow('key', 'Have an invite?', '', ' data-set-go="join"') +
    setRow('plus', 'Create a group', '', ' data-set-go="create"') +
    `</ul>`;
  const main = () =>
    setHead('Settings', 'close') +
    `<section class="glass set-me">${avatarOf(me)}<div><strong>${esc(me.name)}</strong><small>${SET.demo ? 'Demo · synthetic member' : esc(me.handle || me.name.toLowerCase())}</small></div></section>` +
    (grp() ? groupBlock() : noGroup()) +
    reminderBlock();
  const groupBlock = () =>
    `<p class="set-k">Group</p><ul class="glass set-list">` +
    `<li class="set-grp"><div><strong>${esc(groupName())}</strong><small>${owner ? 'Owner' : 'Member'} · ${d.n} of 10 members</small></div><div class="stack">${d.members
      .map((x) => `<span class="av" style="--mc:${x.col}">${x.name[0]}</span>`)
      .join('')}</div></li>` +
    (owner
      ? setRow('pen', 'Group name', esc(groupName()), ' data-set-go="rename"') +
        setRow('quote', 'Prompt', promptText(), ' data-set-go="prompt"') +
        (full
          ? `<li><div class="set-row off">${ic('link')}<span>Invite friends<small>The group is full · 10 of 10</small></span></div></li>`
          : setRow('link', 'Invite friends', '', ' data-set-go="invite"'))
      : `<li><div class="set-row off">${ic('quote')}<span>Prompt<small>${promptText()}</small></span></div></li>` +
        `<li class="set-hint">Only the owner can change the prompt or invite friends.</li>`) +
    `</ul><ul class="glass set-list set-more">` +
    setRow('users', 'Switch group', plural(SET.list.length, 'group'), ' data-set-go="groups"') +
    setRow('key', 'Have an invite?', '', ' data-set-go="join"') +
    setRow('plus', 'Create a group', '', ' data-set-go="create"') +
    `</ul>`;
  const reminderBlock = () =>
    `<p class="set-k">Reminder</p><ul class="glass set-list">` +
    `<li><label class="set-row">${ic('bell')}<span>Weekly reminder<small>${SET.reminder ? (SET.snoozed ? 'Snoozed until next Sunday' : `Sundays at ${SET.time}`) : 'Off'}</small></span>` +
    `<input type="checkbox" role="switch" class="sw" data-set-rem${SET.reminder ? ' checked' : ''} /></label></li>` +
    (SET.reminder
      ? setRow('clock', 'Time', `Sundays at ${SET.time}`, ' data-set-go="time"') +
        setRow(
          'snooze',
          SET.snoozed ? 'Undo snooze' : 'Snooze this week',
          '',
          ` data-set-snooze aria-pressed="${SET.snoozed}"`,
        ) +
        setRow('send', 'Send a test reminder', '', ' data-set-test')
      : '') +
    `</ul><p class="set-k">Account</p><ul class="glass set-list">` +
    setRow('out', SET.demo ? 'Sign out of Demo' : 'Sign out', '', ' data-set-out', ' out') +
    `</ul>` +
    // Demo 身份的控制：只在用 Demo 登录时出现，和正式账号分开
    (SET.demo
      ? `<p class="set-k">Demo</p><ul class="glass set-list set-demo">` +
        setRow('users', 'Switch demo member', me.name, ' data-set-go="member"') +
        setRow('trash', 'Reset local Demo data', '', ' data-set-go="reset"', ' out') +
        `</ul>`
      : '') +
    `<p class="set-foot">Rewind · ${SET.demo ? 'Demo on this device' : 'signed in as ' + esc(me.handle || me.name.toLowerCase())}</p>`;
  const pages = {
    main,
    reset: main,
    groups: () =>
      setHead('Switch group') +
      `<ul class="glass set-list">` +
      SET.list
        .map(
          ({ name: g }, i) =>
            `<li><button type="button" class="set-row" data-set-group="${i}" aria-pressed="${i === SET.gi}">${ic('users')}<span>${esc(g)}<small>${i === SET.gi ? 'Current group' : 'Tap to switch'}</small></span>${i === SET.gi ? ic('check', 'sel') : ''}</button></li>`,
        )
        .join('') +
      `</ul><ul class="glass set-list set-more">` +
      setRow('key', 'Have an invite?', '', ' data-set-go="join"') +
      setRow('plus', 'Create a group', '', ' data-set-go="create"') +
      `</ul>`,
    time: () => {
      const n = `tm-${++setUid}`;
      const own = !TIMES.includes(SET.time);
      return (
        setHead('Reminder time') +
        `<p class="set-lead">Every Sunday, in your group’s time zone.</p>` +
        `<div class="glass set-list set-prompts" role="radiogroup" aria-label="Reminder time">` +
        TIMES.map(
          (x) =>
            `<label class="set-opt"><input type="radio" name="${n}" value="${x}" data-set-time${x === SET.time ? ' checked' : ''} /><span>${x}</span></label>`,
        ).join('') +
        `<label class="set-opt"><input type="radio" name="${n}" value="own" data-set-time-own${own ? ' checked' : ''} /><span>Custom time${own ? `<small>${SET.time}</small>` : ''}</span></label>` +
        `<label class="set-tm"${own ? '' : ' hidden'}><span>Time</span><input type="time" step="300" data-set-time-at value="${to24(own ? SET.time : '7:30 PM')}" /></label>` +
        `</div>`
      );
    },
    invite: () =>
      setHead('Invite friends') +
      `<section class="glass set-card set-inv"><p class="set-k">Invite code</p><b class="inv-code">7K2Q X9MB</b>` +
      `<p class="set-note">Works once · expires in 24 hours</p></section>` +
      `<button type="button" class="set-btn primary" data-set-toast="share">${ic('share')}Share invite link</button>` +
      `<div class="set-two"><button type="button" class="set-btn" data-set-toast="link">${ic('link')}Copy link</button>` +
      `<button type="button" class="set-btn" data-set-toast="code">${ic('copy')}Copy code</button></div>` +
      `<p class="set-foot">${d.n} of 10 members in ${esc(groupName())}</p>`,
    join: () =>
      setHead('Have an invite?', o.back) +
      `<p class="set-lead">Enter the 8-character code a friend sent you.</p>` +
      `<label class="glass set-field"><span>Invite code</span><input data-set-code maxlength="9" placeholder="8-character code" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${o.joinErr ? 'EXPI RED1' : ''}" /></label>` +
      `<p class="set-err" role="alert">${o.joinErr ? JOIN_ERR[o.joinErr] : ''}</p>` +
      `<button type="button" class="set-btn primary" data-set-join data-busy="Joining…">Accept invitation</button>` +
      `<p class="set-foot">In the prototype, BOOK CLUB joins a group; EXPIRED1, USEDCODE and FULLFULL show what goes wrong.</p>`,
    joined: () =>
      setHead('Have an invite?') +
      `<section class="glass set-card set-ok"><span class="set-okic">${ic('check')}</span><h2>Joined ${esc(SET.list[SET.joined]?.name || 'Book club')}</h2>` +
      `<p class="set-note">The code is now used.</p></section>` +
      `<button type="button" class="set-btn primary" data-set-gojoined>Go to the group</button>`,
    create: () =>
      setHead('New group', o.back) +
      `<label class="glass set-field"><span>Group name</span><input data-set-name maxlength="80" placeholder="e.g. Saturday table" autocomplete="off" /></label>` +
      `<p class="set-k">Prompt</p>${promptPicker(0)}` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-create${o.back === 'close' ? ' data-close' : ''} data-busy="Creating group…">Create group</button>`,
    rename: () =>
      setHead('Group name') +
      `<label class="glass set-field"><span>Group name</span><input data-set-name maxlength="80" value="${esc(groupName())}" autocomplete="off" /></label>` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-rename data-busy="Saving…">Save</button>`,
    prompt: () =>
      setHead('Prompt') +
      `<p class="set-lead">Everyone sees it on Home for this cycle.</p>${promptPicker(promptOf().prompt ?? 0)}` +
      `<p class="set-err" role="alert"></p>` +
      `<button type="button" class="set-btn primary" data-set-prompt data-busy="Saving…">Save</button>`,
    member: () =>
      setHead('Switch demo member') +
      `<p class="set-lead">Demo only: act as one of the synthetic members on this device.</p>` +
      `<ul class="glass set-list">` +
      d.members
        .map(
          (x, i) =>
            `<li><button type="button" class="set-row" data-set-me="${i}" aria-pressed="${i === SET.me}">${avatarOf(x, ' sm')}<span>${x.name}<small>${i === 0 ? 'Owner' : 'Member'} · synthetic</small></span>${i === SET.me ? ic('check', 'sel') : ''}</button></li>`,
        )
        .join('') +
      `</ul>`,
  };
  return (
    `<div class="scroll">` +
    `<div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    (pages[step] || main)() +
    `</div>` +
    // 清空 Demo 数据：先确认，写明范围（UX-CONTRACT）
    (step === 'reset'
      ? `<div class="set-dim" data-set-go="main"></div><section class="glass set-dlg" role="dialog" aria-label="Reset local Demo data confirmation">` +
        `<h2>Reset local Demo data?</h2><p>The Demo session, local groups, your member choice and saved moments on this device are cleared. Real accounts are not touched.</p>` +
        `<button type="button" class="set-btn" data-set-go="main">Keep local data</button>` +
        `<button type="button" class="set-btn danger" data-set-reset data-busy="Resetting…">Reset</button></section>`
      : '')
  );
}

/* ---------- 你的片段：只有元数据；每周可以删一段重拍 ----------
   step：list | confirm | done */
// deleted：这周已经删过的小组（每个小组每周一次）
const MINE = { deleted: {}, pick: null, bad: false };
const usedDelete = () => !!MINE.deleted[grp()?.id];
function mineHTML(d, step, id) {
  const clips = homeClips(id, d);
  const secs = clips.reduce((s, c) => s + c[1], 0);
  const reset = plural(cyc().reset, 'day');
  // 处理失败的是最后一段（首页的标签也标在最后一段）
  const bad = NAV.home === 'failed' ? clips.length - 1 : -1;
  const kindOf = (k) => (k === 'photo' ? 'Photo' : 'Video');
  const rows = clips
    .map(([kind, len, day], i) =>
      i === bad
        ? `<li class="mine-bad"><div class="set-row">${ic(kind === 'photo' ? 'camera' : 'video')}<span>${kindOf(kind)}<small>${len} s · ${day} · didn’t finish uploading</small></span></div>` +
          `<div class="mine-fix"><button type="button" class="set-btn" data-mine-retry data-busy="Retrying…">${ic('replay')}Retry</button>` +
          `<button type="button" class="set-btn" data-mine-pick="${i}" data-mine-bad>${ic('trash')}Delete</button></div></li>`
        : `<li><button type="button" class="set-row" data-mine-pick="${i}"${usedDelete() ? ' disabled' : ''}>${ic(kind === 'photo' ? 'camera' : 'video')}<span>${kindOf(kind)}<small>${len} s · ${day} · sealed</small></span>${usedDelete() ? '' : ic('trash', 'go del')}</button></li>`,
    )
    .join('');
  const pick = clips[MINE.pick ?? 0] || ['video', 0];
  return (
    `<div class="scroll"><div class="glow" aria-hidden="true"><i></i><i></i><i></i></div>` +
    `<header class="sub-h"><button type="button" class="sub-back" data-sub-back aria-label="Back">${ic('back')}</button><h1>Your moments</h1><span></span></header>` +
    `<section class="glass set-card mine-sum"><b>${clips.length} of 5</b><p class="set-note">${secs} of 30 s · resets in ${reset}</p></section>` +
    `<p class="set-lead">Sealed until the film. You can see when, not what.</p>` +
    (clips.length
      ? `<ul class="glass set-list">${rows}</ul>`
      : `<p class="set-lead">Nothing sealed yet this week.</p>`) +
    `<p class="set-foot">${usedDelete() ? `You used this week’s delete. It comes back in ${reset}.` : 'Once a week, you can delete one and retake it.'}</p>` +
    (step === 'done'
      ? `<button type="button" class="set-btn primary" data-mine-retake>${ic('camera')}Retake now</button>`
      : '') +
    `</div>` +
    (step === 'confirm'
      ? `<div class="set-dim" data-mine-keep></div><section class="glass set-dlg" role="dialog" aria-label="Delete moment confirmation">` +
        `<h2>Delete this ${pick[0] === 'photo' ? 'photo' : 'video'}?</h2><p>${MINE.bad ? `It didn’t finish, so this doesn’t use your weekly delete. Its ${pick[1]} s go back to your week.` : `It’s gone for good, and its ${pick[1]} s go back to your week. You can do this once a week.`}</p>` +
        `<button type="button" class="set-btn" data-mine-keep>Keep it</button>` +
        `<button type="button" class="set-btn danger" data-mine-del data-busy="Deleting…">Delete</button></section>`
      : '')
  );
}

/* ---------- 相机：视频和照片 ----------
   data-mode：video | photo；data-step：perm | view | rec | review | upload | sealed */
function cameraHTML(d, mode, step, o = {}) {
  const video = mode === 'video';
  const t = o.t ?? 0;
  const len = o.len ?? 6.2;
  const pct = o.pct ?? 0;
  return (
    bokeh() +
    `<div class="cam-flashfx" aria-hidden="true"></div>` +
    `<div class="cam-top"><button type="button" class="cam-ic" data-sub-back aria-label="Close">${ic('close')}</button>` +
    `<span class="cam-pill" data-sec="${secLeft(d)}">${left5(d)} left · ${secLeft(d)} s</span>` +
    `<button type="button" class="cam-ic" aria-label="Flash">${ic('flash')}</button></div>` +
    `<p class="cam-time" aria-live="off"><i></i><span>${tm(t)}</span> / ${tm(Math.min(15, secLeft(d)))}</p>` +
    // 没给权限：视频要相机和麦克风，照片只要相机
    `<section class="cam-perm glass"><h2>${video ? 'Allow camera and mic' : 'Allow the camera'}</h2><p>${video ? 'Rewind records short videos with sound.' : 'Rewind needs the camera to take a photo.'}</p>` +
    `<button type="button" class="cam-allow" data-cam-allow>Allow</button></section>` +
    // 取景、录制
    `<div class="cam-bottom"><div class="cam-modes" role="tablist" aria-label="Capture mode">` +
    `<button type="button" role="tab" data-cam-mode="video" aria-selected="${video}">Video</button>` +
    `<button type="button" role="tab" data-cam-mode="photo" aria-selected="${!video}">Photo</button></div>` +
    `<div class="cam-row"><button type="button" class="cam-mine" data-cam-mine aria-label="Your moments: ${d.me.c} sealed">${ic('lock')}<b>${d.me.c}</b></button>` +
    `<button type="button" class="cam-shut" data-cam-shoot aria-label="${video ? 'Start recording' : 'Take photo'}">${arcRing(video ? Math.max(0.001, t / 15) : 0.001)}<span class="cam-core"></span></button>` +
    `<button type="button" class="cam-ic" aria-label="Flip camera">${ic('flip')}</button></div></div>` +
    // 看一眼（视频还能剪、选效果），再封存
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
      : `<p class="trim-t">Counts as one moment · ${PHOTO_SECS} s in the film</p>`) +
    `<div class="cam-acts"><button type="button" class="cam-retake" data-cam-retake>Retake</button>` +
    `<button type="button" class="cam-seal" data-cam-seal>${ic('lock')}<span>Seal</span></button></div></section>` +
    // 上传中：可以取消
    `<section class="cam-up" role="status"><div class="cam-upbar"><i style="width:${pct}%"></i></div>` +
    `<p><span data-cam-pct>Uploading ${pct}%</span></p>` +
    `<button type="button" class="cam-retake" data-cam-cancel>Cancel</button></section>` +
    // 封存好了
    `<section class="cam-done" role="status"><span class="cam-ok">${ic('check')}</span><h2>Sealed</h2>` +
    `<p>${Math.max(0, left5(d) - 1)} left · finishing in the background</p>` +
    `<div class="cam-tell"><button type="button" class="set-btn primary" data-cam-tell>${ic('chat')}Tell the group</button>` +
    `<button type="button" class="cam-fin" data-cam-done>Done</button></div>` +
    `<p class="cam-hint">Only your words go to Chat. The ${video ? 'video' : 'photo'} stays sealed.</p></section>`
  );
}

// 影片长度：每段平均 8 秒，加一段 3 秒的补位
const filmSecs = (n) => n * 8 + 3;
const filmLen = (n) => {
  const s = filmSecs(n);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/* ---------- 首映影片：直接放，24 小时内各自看 ----------
   data-step：play | end */
function filmHTML(d, o = {}) {
  const who = d.members.filter((x) => x.c > 0);
  const moments = who.flatMap((x) => Array.from({ length: x.c }, () => x));
  // 片子偏短时，第 3 格用一段标着 From the archive 的旧片段补位
  moments.splice(2, 0, { filler: true });
  return (
    `<div class="fm-frames" aria-hidden="true">${moments.map(frame).join('')}</div>` +
    // 补位的旧片段在放的时候，角上标出来（标签不放在模糊的画面里）
    `<span class="fm-tag">From the archive</span>` +
    `<div class="fm-top"><button type="button" class="cam-ic" data-sub-back aria-label="Close">${ic('close')}</button>` +
    `<span class="fm-title"><b>${esc(groupName())}</b><small>${o.film && typeof filmInfo === 'function' ? filmInfo(o.film) : 'Premiere · 18 h left'}</small></span><span class="cam-ic cam-ph" aria-hidden="true"></span></div>` +
    // 放映中
    `<div class="fm-bar" aria-hidden="true">${moments.map(() => '<i><b></b></i>').join('')}</div>` +
    `<div class="fm-ctl"><button type="button" class="glass-btn" data-fm-chat>${ic('chat')}Talk about it</button>` +
    `<button type="button" class="cam-ic" data-fm-pause aria-label="Pause">${ic('pause')}</button></div>` +
    // 片尾
    `<section class="fm-end"><h2>Your film</h2><p>${plural(moments.length - 1, 'moment')} · ${filmLen(moments.length - 1)}</p>` +
    `<div class="fm-cast">${who.map((x) => `<span><i class="av" style="--mc:${x.col}">${x.name[0]}</i>${x.me ? 'You' : x.name}</span>`).join('')}</div>` +
    // 看完最自然的下一步：去聊天
    `<button type="button" class="set-btn primary fm-chat" data-fm-chat>${ic('chat')}Talk about it in Chat</button>` +
    `<div class="fm-acts"><button type="button" class="glass-btn" data-fm-replay>${ic('replay')}Replay</button>` +
    `<button type="button" class="glass-btn" data-fm-save="film">${ic('save')}Save film</button></div>` +
    `<button type="button" class="fm-link" data-fm-save="mine">Save your own moments</button>` +
    `<p class="fm-note">It stays in Archive.</p></section>`
  );
}

/* ---------- 画一台“子画面”手机 ---------- */
function subScreen(kind, id, o = {}) {
  // 底栏的三页：按 o.home 的状态画一台完整的手机（画面页用）
  if (['home', 'chat', 'archive'].includes(kind)) {
    const c = concepts.find((x) => x.id === id);
    return withHome(o.home || 'collect', () => screen(c, dataFor(id), kind, o));
  }
  // 其他画面指定了首页状态（画面页用）：在那个状态下画
  if (o.home) return withHome(o.home, () => subScreen(kind, id, { ...o, home: undefined }));
  const d = dataFor(id);
  const step =
    o.step ||
    { signin: 'welcome', settings: 'main', mine: 'list', camera: 'view', film: 'play' }[kind];
  const mode = o.mode || 'video';
  const body = {
    signin: () => signinHTML(step),
    settings: () => {
      if (!o.own) return settingsHTML(d, step, o);
      const keep = SET.time;
      SET.time = '7:30 PM';
      try {
        return settingsHTML(d, step, o);
      } finally {
        SET.time = keep;
      }
    },
    mine: () => mineHTML(d, step, id),
    camera: () => cameraHTML(d, mode, step, o),
    film: () => filmHTML(d, o),
  }[kind]();
  const dark = kind === 'camera' || kind === 'film';
  return (
    `<div class="device"><div class="screen ${id} sub sub-${kind}${dark ? ' dark' : ''}" data-kind="${kind}" data-step="${step}" data-mode="${mode}" data-t="${o.t ?? 0}">` +
    `${statusBar()}${body}<span class="home-ind" aria-hidden="true"></span></div></div>`
  );
}

// 在这台手机原来的首页状态下画子画面（状态页里那台“额度用完”点进“你的片段”，看到的也是用完）
const subIn = (wrap, kind, id, o) =>
  withHome(wrap.dataset.home || NAV.home, () =>
    pureIf(!!wrap.closest('#states-view'), () => subScreen(kind, id, o)),
  );
// 从首页那台手机进入：记下是从首页来的，返回时重画首页
function openSub(scr, kind, o = {}) {
  const wrap = scr.closest('.phone-wrap');
  const id = scr.classList[1];
  if (!wrap) return;
  stopTimers(scr);
  wrap.dataset.from = 'home';
  if (scr.dataset.tab) {
    wrap.dataset.tab = scr.dataset.tab;
    wrap.dataset.home = scr.dataset.home;
  }
  wrap.innerHTML = subIn(wrap, kind, id, o);
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
  wrap.innerHTML = subIn(wrap, kind, scr.classList[1], o);
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
  return ns;
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
  const left = Number(scr.querySelector('.cam-pill').dataset.sec);
  if (scr.dataset.mode === 'photo') {
    // 照片占 3 秒，本周不够 3 秒就拍不了
    if (left < PHOTO_SECS) return rvToast(t('scr.toast.photoSecs').replace('{n}', left));
    fx(scr.querySelector('.cam-flashfx'), 'go', 500);
    return later(scr, reduceMotion() ? 0 : 180, () => goStep(scr, 'review'));
  }
  if (scr.dataset.step === 'rec' && TIMERS_SUB.has(scr)) return stopRec(scr);
  // 最长 15 秒，也不能超过本周剩下的秒数
  const max = Math.min(15, left);
  const t0 = Date.now() - (scr._t || Number(scr.dataset.t) || 0) * 1000;
  goStep(scr, 'rec');
  scr.querySelector('.cam-shut').setAttribute('aria-label', 'Stop recording');
  every(scr, 100, () => {
    const tt = Math.min(max, (Date.now() - t0) / 1000);
    scr._t = tt;
    scr.querySelector('.cam-time span').textContent = tm(tt);
    scr.querySelector('.cam-shut .ring').outerHTML = arcRing(Math.max(0.001, tt / 15));
    if (tt >= max) stopRec(scr);
  });
}
function stopRec(scr) {
  // 画面页里停在录制中的那台没有计时器，按它显示的秒数算
  const len = Math.max(1, scr._t || Number(scr.dataset.t) || 0);
  redraw(scr, 'camera', { mode: 'video', step: 'review', len });
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
    const me = myRec(scr.classList[1]);
    const photo = scr.dataset.mode === 'photo';
    const len = photo
      ? PHOTO_SECS
      : Math.round(Number(scr.querySelector('.trim')?.dataset.len) || 5);
    if (clipsOf(me).length < 5) addClip(me, photo ? 'photo' : 'video', len);
    goStep(scr, 'sealed');
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
// 登录后回到首页（画面页里的手机回到这一步开头）
function signedIn(scr, idx, demo, name) {
  Object.assign(SET, { me: idx, demo });
  sampleAccount();
  rvToast(t(demo ? 'scr.toast.as' : 'scr.toast.signedIn').replace('{name}', name));
  closeSub(scr);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest(
    '[data-sub-back],[data-set-gojoined],[data-mine-retry],[data-cam-tell],[data-cam-done],[data-cam-shoot],[data-cam-mode],[data-cam-allow],[data-cam-retake],[data-cam-seal],[data-cam-cancel],[data-cam-mine],[data-look],' +
      '[data-set-go],[data-set-toast],[data-set-test],[data-set-out],[data-set-snooze],[data-set-join],[data-set-create],[data-set-rename],[data-set-prompt],[data-set-group],[data-set-me],[data-set-reset],' +
      '[data-si-go],[data-si-sheet],[data-si-as],[data-si-submit],[data-si-forgot],[data-up-via],[data-up-send],[data-up-resend],[data-up-verify],[data-up-create],[data-mine-pick],[data-mine-keep],[data-mine-del],[data-mine-retake],' +
      '[data-fm-pause],[data-fm-replay],[data-fm-save],[data-fm-chat]',
  );
  if (!b || b.disabled) return;
  const scr = b.closest('.screen');
  const d = b.dataset;
  if ('subBack' in d) return closeSub(scr);
  // 相机
  if ('camShoot' in d) return shoot(scr);
  if (d.camMode) {
    if (scr.dataset.step === 'rec' || d.camMode === scr.dataset.mode) return;
    return redraw(scr, 'camera', { mode: d.camMode });
  }
  if ('camAllow' in d) return goStep(scr, 'view');
  if ('camRetake' in d) {
    scr._t = 0;
    return redraw(scr, 'camera', { mode: scr.dataset.mode });
  }
  if ('camSeal' in d) return upload(scr);
  if ('camDone' in d) return closeSub(scr, true);
  // 去聊天：带一句草稿，可以改成“刚拍了午饭”之类
  if ('camTell' in d) {
    const kind = scr.dataset.mode === 'photo' ? 'photo' : 'video';
    const wrap = scr.closest('.phone-wrap');
    wrap.dataset.tab = 'chat';
    wrap.dataset.from = 'home';
    if (isSample()) SEEN.chat = true;
    const cs = goTab(closeSub(scr), 'chat', { draft: `Just sealed a ${kind} 🤫 ` });
    const box = cs.querySelector('[data-chat-input]');
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    return;
  }
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
  if ('setGojoined' in d) {
    SET.gi = SET.joined ?? SET.gi;
    rvToast(t('scr.toast.switched').replace('{name}', groupName()));
    return closeSub(scr);
  }
  if (d.setGroup) {
    SET.gi = Number(d.setGroup);
    redraw(scr, 'settings', { step: 'main' });
    return rvToast(t('scr.toast.switched').replace('{name}', groupName()));
  }
  if (d.setMe) {
    SET.me = Number(d.setMe);
    return redraw(scr, 'settings', { step: 'member' });
  }
  if ('setReset' in d) {
    return busy(b, 700, () => {
      Object.assign(SET, { me: 0, demo: false, prompt: 0 });
      sampleAccount();
      redraw(scr, 'signin', {});
      rvToast(t('scr.toast.reset'));
    });
  }
  if ('setJoin' in d) {
    const code = normCode(scr.querySelector('[data-set-code]').value);
    if (!/^(?:[A-Z0-9]{8}|[A-Z]{6})$/.test(code))
      return err(scr, 'Enter the eight-character invite code using letters and numbers.');
    return busy(b, 700, () => {
      const inv = INVITES[code];
      if (!inv) return err(scr, JOIN_ERR.none);
      if (typeof inv === 'string') return err(scr, JOIN_ERR[inv]);
      if (SET.list.some((g) => g.id === inv.id)) return err(scr, `You’re already in ${inv.name}.`);
      SET.list.push(JSON.parse(JSON.stringify(inv)));
      SET.joined = SET.list.length - 1;
      redraw(scr, 'settings', { step: 'joined' });
    });
  }
  if ('setCreate' in d) {
    const name = scr.querySelector('[data-set-name]').value.trim();
    if (!name) return err(scr, 'Enter a group name.');
    if (pickedPrompt(scr) === null) return err(scr, 'Write a prompt, or pick one above.');
    return busy(b, 800, () => {
      // 新建的小组：你是组长，第 1 期第 1 周从今天开始
      const p = pickedPrompt(scr);
      SET.list.push({
        id: 'c' + SET.list.length + Date.now(),
        name,
        owner: true,
        n: 1,
        no: 1,
        cyc: { week: 1, days: 28, reset: 7 },
        ...(typeof p === 'number' ? { prompt: p } : { prompt: 'custom', custom: p.custom }),
        clips: [],
      });
      SET.gi = SET.list.length - 1;
      rvToast(t('scr.toast.created').replace('{name}', name));
      if ('close' in d) return closeSub(scr);
      redraw(scr, 'settings', { step: 'main' });
    });
  }
  if ('setRename' in d) {
    const name = scr.querySelector('[data-set-name]').value.trim();
    if (!name) return err(scr, 'Enter a group name.');
    return busy(b, 600, () => {
      grp().name = name;
      redraw(scr, 'settings', { step: 'main' });
      rvToast(t('scr.toast.saved'));
    });
  }
  if ('setPrompt' in d) {
    const p = pickedPrompt(scr);
    if (p === null) return err(scr, 'Write a prompt, or pick one above.');
    return busy(b, 600, () => {
      if (typeof p === 'number') promptOf().prompt = p;
      else Object.assign(promptOf(), { prompt: 'custom', custom: p.custom });
      redraw(scr, 'settings', { step: 'main' });
      rvToast(t('scr.toast.saved'));
    });
  }
  // 欢迎和登录
  if (d.siGo) return redraw(scr, 'signin', { step: d.siGo });
  if ('siForgot' in d) return rvToast(t('scr.toast.forgot'));
  // 注册
  if (d.upVia) {
    UP.via = d.upVia;
    return redraw(scr, 'signin', { step: 'up' }).querySelector('[data-up-to]').focus();
  }
  if ('upSend' in d) {
    const v = scr.querySelector('[data-up-to]').value.trim();
    const email = UP.via === 'email';
    if (!v) return err(scr, email ? 'Enter your email.' : 'Enter your phone number.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
      return err(scr, 'That doesn’t look like an email address.');
    if (!email && v.replace(/\D/g, '').length < 7) return err(scr, 'Enter the full phone number.');
    return busy(b, 700, () => {
      if (email && /^alex@/i.test(v))
        return (scr.querySelector('.set-err').innerHTML =
          'An account already uses this email. <button type="button" class="up-link" data-si-go="form">Sign in instead</button>');
      UP.to = v;
      if (!email) UP.cc = scr.querySelector('[data-up-cc]').value;
      const ns = redraw(scr, 'signin', { step: 'upcode' });
      ns.querySelector('[data-up-code]').focus();
      resendTimer(ns);
    });
  }
  if ('upResend' in d) {
    rvToast(t('scr.toast.resent'));
    return resendTimer(scr);
  }
  if ('upVerify' in d) {
    const code = scr.querySelector('[data-up-code]').value;
    if (code.length < 6) return err(scr, 'Enter all 6 digits.');
    return busy(b, 600, () => {
      if (code !== '123456')
        return err(scr, 'That code doesn’t match. Check it, or send a new one.');
      redraw(scr, 'signin', { step: 'upname' }).querySelector('[data-up-name]').focus();
    });
  }
  if ('upCreate' in d) {
    const name = scr.querySelector('[data-up-name]').value.trim();
    const pass = scr.querySelector('[data-up-pass]').value;
    if (!name) return err(scr, 'Enter your name.');
    if (pass.length < 8) return err(scr, 'Use at least 8 characters for the password.');
    return busy(b, 800, () => {
      UP.name = name;
      const handle = UP.via === 'email' ? UP.to : `${UP.cc} ${UP.to}`;
      Object.assign(SET, {
        me: 0,
        demo: false,
        who: { name, col: '#4FA69C', handle },
        list: [],
        gi: 0,
      });
      rvToast(t('scr.toast.signedIn').replace('{name}', name));
      closeSub(scr);
    });
  }
  if ('siSheet' in d) {
    const open = scr.querySelector('.si-sheet').classList.toggle('open');
    b.setAttribute('aria-expanded', String(open));
    goStep(scr, open ? 'demo' : 'welcome');
    return;
  }
  if (d.siAs) return signedIn(scr, Number(d.siAs), true, POOL[Number(d.siAs)].name);
  if ('siSubmit' in d) {
    const user = scr.querySelector('[data-si-user]').value.trim();
    const pass = scr.querySelector('[data-si-pass]').value;
    if (!user || !pass) return err(scr, 'Enter your username and password.');
    return busy(b, 700, () => {
      // 原型里：密码是 rewind；用户名是样例成员的名字就用那个人，其他都当作 Alex
      if (pass !== 'rewind') return err(scr, 'Wrong username or password.');
      const i = Math.max(
        0,
        POOL.slice(0, 5).findIndex((x) => x.name.toLowerCase() === user.toLowerCase()),
      );
      signedIn(scr, i, false, POOL[i].name);
    });
  }
  // 你的片段
  if ('mineRetry' in d) {
    return busy(b, 700, () => {
      scr.closest('.phone-wrap').dataset.home = 'collect';
      redraw(scr, 'mine', { step: 'list' });
      rvToast(t('scr.toast.retried'));
    });
  }
  if (d.minePick) {
    MINE.bad = 'mineBad' in d;
    MINE.pick = Number(d.minePick);
    return redraw(scr, 'mine', { step: 'confirm' });
  }
  if ('mineKeep' in d) return redraw(scr, 'mine', { step: 'list' });
  if ('mineDel' in d) {
    return busy(b, 600, () => {
      const wrap = scr.closest('.phone-wrap');
      const id = scr.classList[1];
      const rec = myRec(id);
      const i = MINE.pick ?? 0;
      // 删的是首页当前显示的那一份：额度用完、处理失败的状态删完回到能拍
      if (NEW_CYCLE.includes(wrap.dataset.home) && !snap()) dropClip(rec, POOL[0].c + i);
      else {
        const list = withHome(wrap.dataset.home || NAV.home, () => homeClips(id, dataFor(id)));
        rec.clips = list.filter((_, k) => k !== i);
        rec.c = rec.clips.length;
        if (['quota', 'secs', 'failed'].includes(wrap.dataset.home)) wrap.dataset.home = 'collect';
      }
      // 没传完的那段不算这周的删除次数
      if (!MINE.bad) MINE.deleted[grp()?.id] = true;
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
  if ('fmChat' in d) {
    const wrap = scr.closest('.phone-wrap');
    wrap.dataset.tab = 'chat';
    wrap.dataset.from = 'home';
    if (isSample()) SEEN.chat = true;
    return closeSub(scr);
  }
});

// Try Demo 的面板也可以往上拖开、往下拖收起
document.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('[data-si-sheet]');
  if (!g) return;
  const y0 = e.clientY;
  const up = (ev) => {
    removeEventListener('pointerup', up);
    const dy = ev.clientY - y0;
    if (Math.abs(dy) < 24) return;
    const sheet = g.closest('.screen').querySelector('.si-sheet');
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
  if (el.matches('[data-set-time-own]')) {
    const tm = el.closest('.set-prompts').querySelector('.set-tm');
    tm.hidden = false;
    SET.time = to12(tm.querySelector('input').value);
    tm.querySelector('input').focus();
    return rvToast(t('scr.toast.time').replace('{time}', SET.time));
  }
  if (el.matches('[data-set-time-at]')) {
    if (!el.value) return;
    SET.time = to12(el.value);
    return rvToast(t('scr.toast.time').replace('{time}', SET.time));
  }
  if (el.matches('[data-set-time]')) {
    el.closest('.set-prompts').querySelector('.set-tm').hidden = true;
    SET.time = el.value;
    return rvToast(t('scr.toast.time').replace('{time}', SET.time));
  }
  // 选了“自己写”才出现输入框
  if (el.matches('.set-opt input')) {
    const ta = el.closest('.set-prompts').querySelector('.set-custom');
    if (!ta) return;
    ta.hidden = !el.matches('[data-set-custom]');
    if (!ta.hidden) ta.focus();
  }
});
document.addEventListener('input', (e) => {
  const scroll = e.target.closest('.scroll');
  const errEl = scroll?.querySelector('.set-err');
  // 重新输入时先清掉上一次的错误
  if (e.target.matches('input, textarea') && errEl) errEl.textContent = '';
  if (e.target.matches('[data-up-code]'))
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
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
      ['welcome', {}],
      ['form', { step: 'form' }],
      ['wrong', { step: 'wrong' }],
      ['offline', { step: 'offline' }],
      ['expired', { step: 'expired' }],
      ['demo', { step: 'demo' }],
      ['up', { step: 'up' }],
      ['upbad', { step: 'upbad' }],
      ['upcode', { step: 'upcode' }],
      ['upcodebad', { step: 'upcodebad' }],
      ['upname', { step: 'upname' }],
    ],
  ],
  [
    'set',
    'settings',
    [
      ['main', {}],
      ['groups', { step: 'groups' }],
      ['time', { step: 'time' }],
      ['timeown', { step: 'time', own: true }],
      ['invite', { step: 'invite' }],
      ['join', { step: 'join' }],
      ['joinbad', { step: 'join', joinErr: 'expired' }],
      ['create', { step: 'create' }],
      ['prompt', { step: 'prompt' }],
    ],
  ],
  [
    'group',
    'home',
    [
      ['menu', { menu: true }],
      ['denied', { home: 'denied', menu: true }],
      ['nogroup', { home: 'nogroup' }],
    ],
  ],
  [
    'mine',
    'mine',
    [
      ['list', {}],
      ['failed', { home: 'failed' }],
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
    'photo',
    'camera',
    [
      ['view', { mode: 'photo' }],
      ['review', { mode: 'photo', step: 'review' }],
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
  [
    'chat',
    'chat',
    [
      ['ready', { fresh: true }],
      ['react', { acts: 'm6' }],
      ['reply', { reply: 'm6', draft: 'Me! Bring snacks' }],
      ['empty', { empty: true }],
      ['reconnecting', { conn: 'reconnecting' }],
      ['offline', { conn: 'offline', draft: 'See you Saturday' }],
      ['failed', { failed: true }],
      ['error', { conn: 'error' }],
      ['film', { home: 'released' }],
    ],
  ],
  [
    'arc',
    'archive',
    [
      ['collect', {}],
      ['released', { home: 'released' }],
      ['developing', { home: 'developing' }],
      ['watch', { play: 3, still: true, at: 4 }],
      ['first', { first: true }],
      ['error', { home: 'error' }],
    ],
  ],
];

// 展开过的流程（只是这位看的人自己的偏好，存不了也没关系）
const OPEN_KEY = 'rewind-screens-open';
function openFlows() {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveOpenFlows() {
  const open = [...document.querySelectorAll('#screens-view .scr-flow[open]')].map(
    (x) => x.dataset.flow,
  );
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open));
  } catch {
    /* 存不了就算了 */
  }
}
// 一个流程里的手机：展开时才画
function fillFlow(sec) {
  if (sec.dataset.drawn) return;
  const [k, kind, steps] = FLOWS.find((f) => f[0] === sec.dataset.flow);
  const id = concepts[0].id;
  sec.querySelector('.sv-grid').innerHTML = steps
    .map(
      ([s, o]) =>
        `<figure class="sv-ph" data-sub="${kind}" data-opts='${JSON.stringify(o)}'><div class="card sv-card" data-id="${id}"><div class="phone-wrap">${subScreen(kind, id, o)}</div></div>` +
        `<figcaption><b>${t(`scr.${k}.${s}`)}</b></figcaption></figure>`,
    )
    .join('');
  sec.dataset.drawn = '1';
  holdFilms(sec);
}

function renderScreensView() {
  const root = $('screens-view');
  if (!root) return;
  const open = openFlows();
  root.innerHTML =
    `<header class="main-h"><p class="k">${t('scr.k')}</p><h1>${t('scr.h1')}</h1><p>${t('scr.p')}</p></header>` +
    `<div class="sv-ev scr-all" role="group"><button type="button" data-flows="open">${t('scr.all.open')}</button><button type="button" data-flows="close">${t('scr.all.close')}</button></div>` +
    FLOWS.map(
      ([k, , steps]) =>
        `<details class="scr-flow" data-flow="${k}"${open.has(k) ? ' open' : ''}><summary><b>${t('scr.' + k)}</b><span>${t('scr.n', { n: steps.length })}</span>${ic('chev')}</summary>` +
        `<p class="hint">${t('scr.' + k + '.p')}</p><div class="sv-grid"></div></details>`,
    ).join('');
  root.querySelectorAll('.scr-flow[open]').forEach(fillFlow);
  try {
    if (document.body.classList.contains('view-screens'))
      history.replaceState(null, '', '#screens');
  } catch {
    /* 受限的框架里改不了地址栏也没关系 */
  }
}
// 展开 / 收起（toggle 不冒泡，在捕获阶段听）
document.addEventListener(
  'toggle',
  (e) => {
    const sec = e.target;
    if (!sec.matches?.('#screens-view .scr-flow')) return;
    if (sec.open) fillFlow(sec);
    saveOpenFlows();
  },
  true,
);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-flows]');
  if (!b) return;
  const open = b.dataset.flows === 'open';
  document.querySelectorAll('#screens-view .scr-flow').forEach((x) => {
    x.open = open;
    if (open) fillFlow(x);
  });
  saveOpenFlows();
});

// 放映中的几台停在某一格，点播放键接着放
function holdFilms(root) {
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
}

const openScreensFromHash = () => {
  if (/^#screens$/.test(location.hash)) setView('screens');
};
openScreensFromHash();
addEventListener('load', openScreensFromHash);
addEventListener('hashchange', openScreensFromHash);
