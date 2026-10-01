'use strict';

/* ---------- 底栏的另外两页：聊天、档案；页头的组名菜单 ----------
   按 dev 的 ChatScreen / ArchiveScreen 和文档（proposal-rewind、Sprint 2 用户流程）：
   · 聊天：一个小组一个群聊，只有文字，可以回复、加 ✨；最长 2000 字。
     没有附件、已读、正在输入、编辑和删除（proposal 里明确不做）。
     重新连接、离线、读取失败、发送失败、还没有消息，都有自己的样子。
   · 档案：最上面是这一期（还在收集 / 制作中 / 比平时慢 / 首映中），下面是以前每一期的影片：
     能播放、保存影片，也能保存自己在那一期的片段；没有影片的一期只剩题目和日期。
   · 聊天、档案、首页都只属于当前小组；点组名切换小组，整台手机换成那个小组。
   画面里没有真实媒体：影片封面是抽象的暖色光斑。 */

Object.assign(I, { expand: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>' });

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );

/* ---------- 组名菜单 ---------- */
// home：这台手机的状态；不在这个小组时，这一行不能选，写明已经不在
function groupMenu(home = NAV.home) {
  const out = home === 'denied';
  return (
    `<div class="gm-dim" data-gm-close></div>` +
    `<section class="glass gm" role="menu" aria-label="Switch group"><p class="gm-k">Your groups</p>` +
    SET.groups
      .map((g, i) =>
        out && i === SET.gi
          ? `<div class="gm-row off" role="menuitem" aria-disabled="true">${ic('users')}<span>${esc(g)}<small>You’re no longer in this group</small></span></div>`
          : `<button type="button" class="gm-row" role="menuitemradio" aria-checked="${i === SET.gi}" data-gm-group="${i}">${ic('users')}<span>${esc(g)}</span>${i === SET.gi ? ic('check', 'sel') : ''}</button>`,
      )
      .join('') +
    `<hr />` +
    `<button type="button" class="gm-row" role="menuitem" data-gm-go="join">${ic('key')}<span>Have an invite?</span></button>` +
    `<button type="button" class="gm-row" role="menuitem" data-gm-go="create">${ic('plus')}<span>Create a group</span></button></section>`
  );
}
function toggleMenu(scr, open) {
  const on = !!scr.querySelector('.gm');
  if (open === on) return;
  scr.querySelectorAll('.gm, .gm-dim').forEach((x) => x.remove());
  scr.querySelector('.grp')?.setAttribute('aria-expanded', String(!on));
  if (!on) {
    scr.querySelector('.home-ind').insertAdjacentHTML('beforebegin', groupMenu(scr.dataset.home));
    scr
      .querySelector('.gm-row[aria-checked="true"], button.gm-row')
      ?.focus({ preventScroll: true });
  }
}

/* ---------- 聊天 ---------- */
// 发出去的消息、你加的 ✨，按小组记；第一个小组有一段样例对话
const CHAT = { sent: {}, mine: {}, older: false, n: 0 };
// 封存后谁都看不到画面：大家聊的是“拍了什么，不剧透”
const SEED_OLD = [
  { id: 'o1', who: 2, day: 'Sunday', at: '7:04 PM', text: 'New prompt is up 👀' },
  { id: 'o2', who: 4, day: 'Sunday', at: '7:10 PM', text: 'Already have an idea for this one' },
];
const SEED = [
  {
    id: 'm1',
    who: 1,
    day: 'Yesterday',
    at: '8:12 PM',
    text: 'Sealed my third one. No spoilers 🤐',
    sp: 2,
  },
  {
    id: 'm2',
    who: 2,
    day: 'Yesterday',
    at: '8:20 PM',
    text: 'Mine are all from the night market so far',
  },
  {
    id: 'm3',
    who: 0,
    day: 'Yesterday',
    at: '8:31 PM',
    text: 'Saving one for Saturday dinner',
    sp: 1,
  },
  { id: 'm4', who: 4, day: 'Today', at: '9:02 AM', text: 'Two weeks until the film!' },
  {
    id: 'm5',
    who: 1,
    day: 'Today',
    at: '9:15 AM',
    text: 'Then I’m bringing dessert 🍰',
    re: 'm3',
    sp: 1,
  },
  { id: 'm6', who: 2, day: 'Today', at: '9:30 AM', text: 'Who’s hosting this time?' },
];
// 首映那天，大家在聊影片
const SEED_FILM = [
  { id: 'f1', who: 2, day: 'Today', at: '9:20 AM', text: 'Okay, the ending got me 😭', sp: 3 },
  { id: 'f2', who: 1, day: 'Today', at: '9:24 AM', text: 'Whose was the rain at the bus stop??' },
  {
    id: 'f3',
    who: 4,
    day: 'Today',
    at: '9:31 AM',
    text: 'Mine! Watching it again tonight',
    re: 'f2',
    sp: 2,
  },
];
const FAILED_TEXT = 'I’ll bring the speaker';
const CHAT_MAX = 2000;

function chatList(o) {
  const sent = CHAT.sent[SET.gi] || [];
  if (o.empty) return [];
  if (SET.gi !== 0) return sent;
  const seed = NAV.home === 'released' ? [...SEED.slice(0, 3), ...SEED_FILM] : SEED;
  const list = [...(CHAT.older ? SEED_OLD : []), ...seed, ...sent];
  // 画面页“没发出去”那台：最后一条是你的、失败了
  if (o.failed)
    list.push({
      id: 'x1',
      who: SET.me,
      day: 'Today',
      at: '9:41 AM',
      text: FAILED_TEXT,
      st: 'failed',
    });
  return list;
}
const findMsg = (o, id) => chatList(o).find((m) => m.id === id);
const whoName = (who) => (who === SET.me ? 'You' : POOL[who].name);
const sparks = (m) => (m.sp || 0) + (CHAT.mine[m.id] ? 1 : 0);

function bubble(m, prev, o) {
  const mine = m.who === SET.me;
  const first = !prev || prev.who !== m.who || prev.day !== m.day;
  const re = m.re ? chatList(o).find((x) => x.id === m.re) : null;
  const n = sparks(m);
  const p = POOL[m.who];
  return (
    `<div class="msg${mine ? ' own' : ''}${first ? ' first' : ''}${m.st ? ' ' + m.st : ''}${o.acts === m.id ? ' open' : ''}">` +
    (mine
      ? ''
      : first
        ? `<span class="av cav" style="--mc:${p.col}" aria-hidden="true">${p.name[0]}</span>`
        : `<span class="cav sp" aria-hidden="true"></span>`) +
    `<div class="mcol">` +
    (first ? `<p class="mmeta">${mine ? '' : `<b>${p.name}</b>`}${m.at}</p>` : '') +
    `<button type="button" class="bub" data-msg="${m.id}" aria-label="${mine ? 'You' : p.name}: ${esc(m.text)}${re ? `. Reply to ${whoName(re.who)}` : ''}${n ? `. ${n} ✨` : ''}" aria-expanded="${o.acts === m.id}">` +
    (re ? `<span class="bq"><b>${whoName(re.who)}</b>${esc(re.text)}</span>` : '') +
    `${esc(m.text)}</button>` +
    (n
      ? `<button type="button" class="rx${CHAT.mine[m.id] ? ' on' : ''}" data-msg-sp="${m.id}" aria-pressed="${!!CHAT.mine[m.id]}" aria-label="${n} sparkles${CHAT.mine[m.id] ? ', remove yours' : ', add yours'}">✨ ${n}</button>`
      : '') +
    // 点一下消息：加 ✨ 或回复（回复只能回原消息，dev 也是这样）
    (m.st
      ? ''
      : `<div class="macts" role="group" aria-label="Message actions"><button type="button" data-msg-sp="${m.id}" aria-pressed="${!!CHAT.mine[m.id]}">✨ ${CHAT.mine[m.id] ? 'Reacted' : 'React'}</button>` +
        (m.re ? '' : `<button type="button" data-msg-re="${m.id}">Reply</button>`) +
        `</div>`) +
    (m.st === 'sending' ? `<span class="mst" role="status">Sending…</span>` : '') +
    (m.st === 'failed'
      ? `<button type="button" class="mfail" data-msg-retry="${m.id}">Not sent · Retry</button>`
      : '') +
    `</div></div>`
  );
}

function chatBody(d, o) {
  const conn = o.conn || 'ready';
  const list = conn === 'error' ? [] : chatList(o);
  // 带着未读进来：最后 3 条前面一条“新消息”
  const freshAt = o.fresh && SET.gi === 0 && !o.empty ? list.length - 3 - (o.failed ? 1 : 0) : -1;
  let rows = '';
  list.forEach((m, i) => {
    const prev = list[i - 1];
    if (!prev || prev.day !== m.day) rows += `<p class="c-day">${m.day}</p>`;
    if (i === freshAt) rows += `<p class="c-new" role="status">3 new messages</p>`;
    rows += bubble(m, i === freshAt ? null : prev, o);
  });
  const state =
    conn === 'error'
      ? `<section class="c-state" role="alert"><h2>Couldn’t load the chat</h2><p>Check your connection and try again.</p>` +
        `<button type="button" class="set-btn" data-chat-retry data-busy="Trying…">Try again</button></section>`
      : list.length
        ? ''
        : `<section class="c-state"><h2>No messages yet</h2><p>Say hi to ${esc(groupName())}. Moments stay sealed, so no spoilers.</p></section>`;
  const older =
    SET.gi === 0 && !o.empty && !CHAT.older && list.length && conn !== 'error'
      ? `<button type="button" class="c-older" data-chat-older data-busy="Loading…">Load older messages</button>`
      : '';
  const banner = {
    reconnecting: `<p class="c-conn" role="status"><i class="spin"></i>Reconnecting…</p>`,
    offline: `<p class="c-conn off" role="status"><i></i>You’re offline. Send when you’re back.</p>`,
  }[conn];
  const re = o.reply ? findMsg(o, o.reply) : null;
  const off = conn === 'offline';
  const draft = o.draft || '';
  return (
    `<div class="c-bg" aria-hidden="true"><div class="glow"><i></i><i></i><i></i></div></div>` +
    `<div class="scroll"><div class="c-list${banner ? ' conn' : ''}${re ? ' re' : ''}" aria-label="Messages">${older}${rows}${state}</div></div>` +
    `<div class="c-head">${topBar()}${banner || ''}</div>` +
    // 读取失败时先重试，不显示输入框
    (conn === 'error'
      ? ''
      : `<div class="cmp">` +
        (re
          ? `<div class="glass cmp-re"><span><b>Replying to ${whoName(re.who)}</b>${esc(re.text)}</span>` +
            `<button type="button" data-chat-unreply aria-label="Cancel reply">${ic('close')}</button></div>`
          : '') +
        `<span class="cmp-n" aria-live="polite"${draft.length > CHAT_MAX - 200 ? '' : ' hidden'}>${draft.length} / ${CHAT_MAX}</span>` +
        `<div class="glass cmp-row"><textarea data-chat-input rows="1" maxlength="${CHAT_MAX}" placeholder="Message ${esc(groupName())}" aria-label="Message">${esc(draft)}</textarea>` +
        `<button type="button" class="cmp-send" data-chat-send aria-label="Send"${off || !draft.trim() ? ' disabled' : ''}>${ic('send')}</button></div></div>`)
  );
}

// 带着当前的草稿重画聊天
function chatRedraw(scr, patch = {}) {
  const draft = scr.querySelector('[data-chat-input]')?.value || '';
  return goTab(scr, 'chat', { ...optsOf(scr), draft, ...patch });
}
function sendMsg(scr, text, reply) {
  const gi = SET.gi;
  const m = { id: 's' + ++CHAT.n, who: SET.me, day: 'Today', at: '9:41 AM', text, st: 'sending' };
  if (reply) m.re = reply;
  (CHAT.sent[gi] ||= []).push(m);
  const o = {
    ...optsOf(scr),
    draft: '',
    reply: null,
    acts: null,
    failed: false,
    fresh: false,
    empty: false,
  };
  const wrap = scr.closest('.phone-wrap');
  goTab(scr, 'chat', o);
  // 发出去了：去掉“发送中”
  setTimeout(
    () => {
      delete m.st;
      const s = wrap.querySelector('.screen[data-tab="chat"]');
      if (s) chatRedraw(s);
    },
    reduceMotion() ? 100 : 700,
  );
}

/* ---------- 档案 ---------- */
// 以前的几期（第一个小组）；第 1 期没有人加片段，没有影片
const FILMS = [
  {
    n: 3,
    dates: 'Aug 9 – Sep 5',
    prompt: 1,
    m: 17,
    len: '2 min 31 s',
    secs: 151,
    col: ['#7a3a2a', '#ffcf8a', '#6D90C4'],
  },
  {
    n: 2,
    dates: 'Jul 12 – Aug 8',
    prompt: 2,
    m: 12,
    len: '1 min 48 s',
    secs: 108,
    col: ['#5a3b4a', '#ff9f6b', '#7FB08F'],
  },
];
const FILMS_OLD = [{ n: 1, dates: 'Jun 14 – Jul 11', prompt: 0, m: 0 }];
const NOW = { n: 4, dates: 'Sep 6 – Oct 3' };
const ARC = { older: false };
// 影片标题下面的小字（从档案里放以前的一期）
function filmInfo(n) {
  const f = [...FILMS, ...FILMS_OLD].find((x) => x.n === n);
  return f ? `Cycle ${f.n} · ${f.dates}` : 'Premiere · 18 h left';
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
// 卡片里放的格子：和影片一样，每段一格作者色的光
const previewFrames = (d) =>
  d.members.filter((x) => x.c > 0).flatMap((x) => Array.from({ length: x.c }, () => x));

function filmRow(f, d, o) {
  const prompt = PROMPTS[f.prompt];
  const info = `<div class="a-info"><small>Cycle ${f.n} · ${f.dates}</small><b>${prompt}</b><span>${f.m} moments · ${f.len}</span>`;
  // 正在放：卡片撑开成一个播放器，可以暂停、全屏
  if (f.m && o.play === f.n) {
    const fr = previewFrames(d);
    const at = o.at ?? 0;
    return (
      `<li class="glass a-film on"><div class="a-pv${o.still ? ' paused' : ''}" role="region" aria-label="Cycle ${f.n} film" data-secs="${f.secs}">` +
      fr.map((x, i) => frame(x, i).replace('fm-f', `fm-f${i === at ? ' on' : ''}`)).join('') +
      `<span class="a-pvbar" aria-hidden="true">${fr.map((_, i) => `<i${i < at ? ' class="done"' : i === at ? ' class="now"' : ''}><b></b></i>`).join('')}</span>` +
      `<div class="a-pvctl"><button type="button" class="a-pvb" data-arc-pause aria-label="${o.still ? 'Play' : 'Pause'}">${ic(o.still ? 'play' : 'pause')}</button>` +
      `<span class="a-pvt">${mmss((at / fr.length) * f.secs)} / ${mmss(f.secs)}</span>` +
      `<button type="button" class="a-pvb" data-arc-full="${f.n}" aria-label="Full screen">${ic('expand')}</button></div>` +
      `<button type="button" class="a-pvre" data-arc-play="${f.n}">${ic('replay')}Replay</button></div>` +
      `${info}</div></li>`
    );
  }
  if (!f.m)
    return (
      `<li class="glass a-film none"><span class="a-thumb off" aria-hidden="true">${ic('lock')}</span>` +
      `<div class="a-info"><small>Cycle ${f.n} · ${f.dates}</small><b>${prompt}</b><span>No film this time · nobody added a moment</span></div></li>`
    );
  return (
    `<li class="glass a-film"><button type="button" class="a-thumb" data-arc-play="${f.n}" aria-label="Play the cycle ${f.n} film" style="--a:${f.col[0]};--b:${f.col[1]};--c:${f.col[2]}">${ic('play')}</button>` +
    info +
    `<div class="a-row"><button type="button" class="a-pill" data-arc-play="${f.n}">${ic('play')}Watch</button></div></div></li>`
  );
}

// 最上面：这一期在哪一步
function nowCard(d) {
  const k = cyc();
  const h = NAV.home;
  if (h === 'released') {
    const who = d.members.filter((x) => x.c > 0);
    return (
      `<section class="glass a-prem"><button type="button" class="a-poster" data-arc-full="${NOW.n}" aria-label="Play the film">` +
      // 封面：每人一格抽象的光，按片段作者的颜色
      who
        .map(
          (x, i) =>
            `<i class="a-fr" style="--a:${x.col};--b:${['#ffcf8a', '#ff9f6b', '#f7b27a', '#ffd9a6'][i % 4]};--x:${25 + ((i * 37) % 50)}%;--y:${30 + ((i * 53) % 40)}%"></i>`,
        )
        .join('') +
      `<span class="a-play">${ic('play')}</span></button>` +
      `<small>Premiere · 18 h left</small><h2>${promptText()}</h2>` +
      `<p class="a-meta">Cycle ${NOW.n} · ${NOW.dates} · ${plural(d.m, 'moment')} · 2 min 14 s</p>` +
      `<button type="button" class="set-btn primary" data-arc-full="${NOW.n}">${ic('play')}Play</button>` +
      `</section>`
    );
  }
  const row = (icon, title, note, bar) =>
    `<section class="glass a-now" role="status"><span class="a-ico">${ic(icon)}</span><div><b>${title}</b><span>${note}</span>${bar ? `<span class="st-bar" aria-hidden="true"><i></i></span>` : ''}</div></section>`;
  if (h === 'developing')
    return row('clock', `Cycle ${NOW.n} is developing`, 'You can watch it once it’s out.', true);
  if (h === 'delayed')
    return row(
      'clock',
      'Taking a little longer',
      'Nothing to play yet. Everyone hears when it’s ready.',
      true,
    );
  if (h === 'empty' || h === 'waiting')
    return row('lock', 'No capsule running', 'Films from earlier cycles stay here.');
  return row(
    'lock',
    `Cycle ${NOW.n} · collecting`,
    `Opens in ${plural(k.days, 'day')} · sealed until then`,
  );
}

function archiveBody(d, o) {
  const glow = `<div class="glow" aria-hidden="true"><i></i><i></i><i></i></div><div class="glow-low" aria-hidden="true"></div>`;
  const first = SET.gi !== 0 || o.first;
  const films = first ? [] : [...FILMS, ...(ARC.older ? FILMS_OLD : [])];
  const count = films.filter((f) => f.m).length + (NAV.home === 'released' ? 1 : 0);
  const head =
    topBar() +
    `<section class="a-h"><h1>Archive</h1>${NAV.home === 'error' ? '' : `<p>${count ? `${plural(count, 'film')} so far` : 'Nothing here yet.'}</p>`}</section>`;
  // 读不出来（首页也读不出来时）：只给重试
  if (NAV.home === 'error')
    return (
      `<div class="scroll">${glow}${head}<section class="c-state a-state" role="alert"><h2>Couldn’t load the archive</h2><p>Check your connection and try again.</p>` +
      `<button type="button" class="set-btn" data-st-retry>Try again</button></section></div>`
    );
  const list = films.length
    ? `<p class="set-k">Earlier films</p><ul class="a-list">${films.map((f) => filmRow(f, d, o)).join('')}</ul>` +
      (ARC.older
        ? ''
        : `<button type="button" class="set-btn a-older" data-arc-older data-busy="Loading…">Show older films</button>`)
    : NAV.home === 'released'
      ? ''
      : `<section class="a-first"><h2>Your first film</h2><p>It opens when this cycle ends. Every film stays here to watch again.</p></section>`;
  return `<div class="scroll">${glow}${head}${nowCard(d)}${list}</div>`;
}

// 卡片里的播放：一格一格往下走，放完停在最后，给一个重播
function startPreview(scr) {
  const pv = scr.querySelector('.a-pv');
  if (!pv) return;
  stopTimers(scr);
  const frames = [...pv.querySelectorAll('.fm-f')];
  const bars = [...pv.querySelectorAll('.a-pvbar i')];
  const secs = Number(pv.dataset.secs);
  const time = pv.querySelector('.a-pvt');
  const btn = pv.querySelector('[data-arc-pause]');
  btn.innerHTML = ic('pause');
  btn.setAttribute('aria-label', 'Pause');
  pv.classList.remove('ended', 'paused');
  let i = Math.max(
    0,
    frames.findIndex((f) => f.classList.contains('on')),
  );
  const show = () => {
    frames.forEach((f, k) => f.classList.toggle('on', k === i));
    bars.forEach((x, k) => {
      x.classList.toggle('done', k < i);
      x.classList.toggle('now', k === i);
    });
    time.textContent = `${mmss((i / frames.length) * secs)} / ${mmss(secs)}`;
  };
  show();
  every(scr, reduceMotion() ? 600 : 1400, () => {
    if (pv.classList.contains('paused')) return;
    i += 1;
    if (i >= frames.length) {
      stopTimers(scr);
      bars.forEach((x) => x.classList.replace('now', 'done'));
      time.textContent = `${mmss(secs)} / ${mmss(secs)}`;
      return pv.classList.add('ended');
    }
    show();
  });
}

// app.js 的 screen() 调这里
function tabBody(tab, d, o) {
  return tab === 'chat' ? chatBody(d, o) : archiveBody(d, o);
}

/* ---------- 点击 ---------- */
document.addEventListener('click', (e) => {
  const scr = e.target.closest('.screen');
  if (!scr) return;
  const b = e.target.closest('button, [data-gm-close]');
  // 组名菜单
  if (b?.classList.contains('grp') || b?.hasAttribute('data-gm-open')) return toggleMenu(scr);
  if (b?.hasAttribute('data-gm-close')) return toggleMenu(scr, false);
  // 点消息以外的地方：收起消息上的操作
  if (!b?.closest('.msg'))
    scr.querySelectorAll('.msg.open').forEach((m) => m.classList.remove('open'));
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.gmGroup) {
    const i = Number(d.gmGroup);
    if (i === SET.gi) return toggleMenu(scr, false);
    SET.gi = i;
    // 从“不在这个小组”换走：换到的小组是正常的
    if (scr.dataset.home === 'denied') scr.dataset.home = 'collect';
    goTab(scr, scr.dataset.tab, {});
    return rvToast(t('scr.toast.switched').replace('{name}', groupName()));
  }
  if (d.gmGo) return openSub(scr, 'settings', { step: d.gmGo, back: 'close' });
  // 聊天
  if (d.msg) {
    const m = b.closest('.msg');
    const open = !m.classList.contains('open');
    scr.querySelectorAll('.msg.open').forEach((x) => x.classList.remove('open'));
    m.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    return;
  }
  if (d.msgSp) {
    CHAT.mine[d.msgSp] = !CHAT.mine[d.msgSp];
    return chatRedraw(scr, { acts: null });
  }
  if (d.msgRe) {
    const ns = chatRedraw(scr, { reply: d.msgRe, acts: null });
    return ns.querySelector('[data-chat-input]').focus();
  }
  if ('chatUnreply' in d) return chatRedraw(scr, { reply: null });
  if ('chatSend' in d) {
    const text = scr.querySelector('[data-chat-input]').value.trim();
    if (text) sendMsg(scr, text, optsOf(scr).reply);
    return;
  }
  if (d.msgRetry) return sendMsg(scr, FAILED_TEXT);
  if ('chatRetry' in d) return busy(b, 700, () => chatRedraw(scr, { conn: 'ready' }));
  if ('chatOlder' in d)
    return busy(b, 600, () => {
      CHAT.older = true;
      chatRedraw(scr);
    });
  // 档案
  // 以前的影片：在卡片里放；同一时间只放一部
  if (d.arcPlay) return startPreview(goTab(scr, 'archive', { play: Number(d.arcPlay) }));
  if (d.arcFull) {
    const n = Number(d.arcFull);
    return openSub(scr, 'film', n === NOW.n ? {} : { film: n });
  }
  if ('arcPause' in d) {
    const pv = b.closest('.a-pv');
    // 画面页里停着的那台：点一下从这一格接着放
    if (!TIMERS_SUB.has(scr)) {
      pv.classList.remove('paused');
      return startPreview(scr);
    }
    const p = pv.classList.toggle('paused');
    b.innerHTML = ic(p ? 'play' : 'pause');
    b.setAttribute('aria-label', p ? 'Play' : 'Pause');
    return;
  }
  if ('arcOlder' in d)
    return busy(b, 600, () => {
      ARC.older = true;
      goTab(scr, 'archive', { ...optsOf(scr), play: null });
    });
});

// 输入：有字才能发，快到 2000 字时显示字数，输入框跟着长高
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches('[data-chat-input]')) return;
  const scr = el.closest('.screen');
  const off = optsOf(scr).conn === 'offline';
  scr.querySelector('[data-chat-send]').disabled = off || !el.value.trim();
  const n = scr.querySelector('.cmp-n');
  n.hidden = el.value.length <= CHAT_MAX - 200;
  n.textContent = `${el.value.length} / ${CHAT_MAX}`;
  el.style.height = 'auto';
  el.style.height = Math.min(96, el.scrollHeight) + 'px';
});
// 回车发送，Shift + 回车换行
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const scr =
      e.target.closest?.('.screen') || document.querySelector('.screen .gm')?.closest('.screen');
    if (scr?.querySelector('.gm')) {
      toggleMenu(scr, false);
      scr.querySelector('.grp')?.focus();
    }
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey || !e.target.matches?.('[data-chat-input]')) return;
  e.preventDefault();
  const send = e.target.closest('.screen').querySelector('[data-chat-send]');
  if (!send.disabled) send.click();
});
