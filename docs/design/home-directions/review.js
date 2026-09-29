'use strict';

/* ---------- 页面内评审 ----------
   写：每个人的 👍 / ❤️ / 底栏选择和优缺点先存在自己的浏览器里（localStorage）。
       评价完后点“一键复制，发到 Issue”：页面把全部内容整理成一条固定格式的评论，
       复制到剪贴板并打开评审 Issue，由本人粘贴、点 Comment。页面不登录，也不保存任何 token。
   读：通过 GitHub 公共接口读取 Issue 评论（不需要登录，每小时 60 次），
       按方向拆开显示在每台手机下面；同一个人以最新一条为准。 */
const REPO = 'Collaboration95/rewind-app';
const RV_KEY = 'rewind-review-v1';
const LIKE_MAX = 3;
const DOCKS = ['a', 'd', 'e', 'g'];

// 评论内容来自 GitHub，显示前一律转义
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
const ghUrl = (u) => (typeof u === 'string' && u.startsWith('https://github.com/') ? u : '');
const issueNo = () => Number(window.REVIEW_ISSUE) || 0;
const issueUrl = () => `https://github.com/${REPO}/issues/${issueNo()}`;

/* ---------- 评审对象：11 个方向 + 4 种底栏，顺序与页面一致 ---------- */
const isDir = (id) => concepts.some((c) => c.id === id);
const isDock = (id) => /^nav-[adeg]$/.test(id);
const TARGETS = () => [...concepts.map((c) => c.id), ...DOCKS.map((v) => 'nav-' + v)];
function target(id) {
  if (isDock(id)) {
    const v = id.slice(4);
    return { id, dock: true, no: v.toUpperCase(), name: t('nav.' + v) };
  }
  const c = concepts.find((x) => x.id === id);
  return { id, no: c.no, name: nameOf(c) };
}

/* ---------- 我的草稿 ---------- */
const blank = () => ({ like: [], fav: null, dock: null, notes: {} });
// 只保留合法内容：👍 最多 3 个方向、❤️ 1 个方向、底栏 1 个，每条最多 500 字；键的顺序固定，便于比对
function tidy(r) {
  const like = [...new Set(Array.isArray(r?.like) ? r.like : [])].filter(isDir).slice(0, LIKE_MAX);
  const notes = {};
  for (const id of TARGETS()) {
    const list = (Array.isArray(r?.notes?.[id]) ? r.notes[id] : [])
      .filter((n) => n && ['+', '-', '?'].includes(n.k) && typeof n.t === 'string')
      .map((n) => ({
        k: n.k,
        t: n.t
          .replace(/<!--|-->/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500),
      }))
      .filter((n) => n.t);
    if (list.length) notes[id] = list;
  }
  return {
    like,
    fav: isDir(r?.fav) ? r.fav : null,
    dock: DOCKS.includes(r?.dock) ? r.dock : null,
    notes,
  };
}
const filled = (r) => Boolean(r.like.length || r.fav || r.dock || Object.keys(r.notes).length);
function hashOf(r) {
  const s = JSON.stringify(tidy(r));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

let mine = blank();
// copied：最近一次复制的内容指纹；me：在 Issue 里认出的自己的 GitHub 账号
let meta = { copied: '', me: '' };
function loadMine() {
  try {
    const d = JSON.parse(localStorage.getItem(RV_KEY) || 'null');
    if (d) {
      mine = tidy(d);
      meta = { copied: String(d.copied || ''), me: String(d.me || '') };
    }
  } catch {
    /* 读不到（例如隐私模式）就从空白开始 */
  }
}
function saveMine() {
  try {
    localStorage.setItem(RV_KEY, JSON.stringify({ ...mine, ...meta }));
  } catch {
    /* 存不了时只在当前页面有效 */
  }
}
function changed() {
  mine = tidy(mine);
  saveMine();
  paintReview();
}
const touched = (id) =>
  Boolean(
    mine.notes[id] ||
    mine.like.includes(id) ||
    mine.fav === id ||
    (isDock(id) && mine.dock === id.slice(4)),
  );
function progress() {
  const all = TARGETS();
  return { done: all.filter(touched).length, total: all.length };
}

/* ---------- 读 Issue ---------- */
const pub = { state: 'none', by: {}, free: [] }; // state：none | loading | live | fail | sample

// 页面生成的评论：第一行是隐藏标记（投票），后面按方向分节，“优点 / 缺点”下各列一行
const MARK = /<!--\s*rewind-review v1\b([^>]*)-->/;
function parseReview(body) {
  const m = MARK.exec(body);
  if (!m) return null;
  const attr = (k) => (new RegExp(`\\b${k}=([\\w,-]*)`).exec(m[1]) || [])[1] || '';
  const r = { like: attr('like').split(','), fav: attr('fav'), dock: attr('dock'), notes: {} };
  let id = '',
    k = '?',
    x;
  for (const raw of body.slice(m.index + m[0].length).split('\n')) {
    const s = raw.trim();
    if ((x = /^#{2,6}\s*(\d{1,2})\b/.exec(s))) [id, k] = ['c' + Number(x[1]), '?'];
    else if ((x = /^#{2,6}\s*(?:dock|底栏)\s*([a-g])\b/i.exec(s)))
      [id, k] = ['nav-' + x[1].toLowerCase(), '?'];
    else if (/^#{1,6}\s/.test(s)) id = '';
    else if (/^\*\*\s*(pros?|优点)\s*\*\*/i.test(s)) k = '+';
    else if (/^\*\*\s*(cons?|缺点)\s*\*\*/i.test(s)) k = '-';
    else if (id && (x = /^[-*+]\s+(.+)/.exec(s))) (r.notes[id] ||= []).push({ k, t: x[1] });
  }
  return { h: attr('h'), ...tidy(r) };
}
// 手写的评论：以编号开头（如 “07:” 或 “Dock D:”）的归到那个方向，列在“其他评论”
const plain = (md) =>
  md
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join(' ')
    .replace(/<!--[\s\S]*?-->|<[^>]+>/g, '')
    .replace(/[#*_`[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
function parseFree(body) {
  const s = plain(body);
  let x = /^(\d{2})\s*[:：·.]\s*/.exec(s);
  if (x && isDir('c' + Number(x[1])))
    return { id: 'c' + Number(x[1]), t: s.slice(x[0].length).slice(0, 500) };
  x = /^(?:dock|底栏)\s*([adeg])\s*[:：·.]\s*/i.exec(s);
  if (x) return { id: 'nav-' + x[1].toLowerCase(), t: s.slice(x[0].length).slice(0, 500) };
  return null;
}

async function loadIssue(fresh) {
  if (pub.state === 'sample') return;
  const n = issueNo();
  if (!n) {
    pub.state = 'none';
    return paintReview();
  }
  pub.state = 'loading';
  paintStatus();
  try {
    let all = [];
    for (let page = 1; page < 5; page++) {
      const r = await fetch(
        `https://api.github.com/repos/${REPO}/issues/${n}/comments?per_page=100&page=${page}` +
          (fresh ? `&t=${Date.now()}` : ''),
        {
          headers: { Accept: 'application/vnd.github+json' },
          cache: fresh ? 'no-store' : 'default',
        },
      );
      if (!r.ok) throw new Error(String(r.status));
      const list = await r.json();
      all = all.concat(list);
      if (list.length < 100) break;
    }
    const by = {},
      free = [],
      h = hashOf(mine);
    for (const c of all) {
      const who = c.user?.login;
      if (!who) continue;
      const body = String(c.body || '');
      const r = parseReview(body);
      if (r) {
        // 评论按时间先后返回，后发的覆盖先发的
        by[who] = { ...r, url: ghUrl(c.html_url) };
        if (r.h && (r.h === h || r.h === meta.copied)) meta.me = who;
      } else {
        const f = parseFree(body);
        if (f?.t) free.push({ ...f, who, url: ghUrl(c.html_url) });
      }
    }
    Object.assign(pub, { state: 'live', by, free });
    saveMine();
  } catch {
    pub.state = 'fail';
  }
  paintReview();
}

// 样式预览：示例人名和占位文字，不编造任何组员意见
function sample(on) {
  if (!on) {
    Object.assign(pub, { state: 'none', by: {}, free: [] });
    return loadIssue();
  }
  const ids = concepts.map((c) => c.id);
  const by = {};
  for (let i = 0; i < 4; i++) {
    const a = ids[i],
      b = ids[(i + 4) % ids.length],
      d = DOCKS[i % 4];
    by[t('rv.sampleWho', { n: i + 1 })] = {
      like: [a, b, ids[(i + 7) % ids.length]],
      fav: ids[(i * 3) % ids.length],
      dock: d,
      notes: {
        [a]: [{ k: '+', t: t('rv.samplePro') }],
        [b]: [{ k: '-', t: t('rv.sampleCon') }],
        ['nav-' + d]: [{ k: '+', t: t('rv.samplePro') }],
      },
      url: '',
    };
  }
  Object.assign(pub, { state: 'sample', by, free: [] });
  paintReview();
}

/* ---------- 汇总：别人已发送的 + 我当前的草稿 ---------- */
function everyone() {
  const own = filled(mine);
  const list = Object.entries(pub.by)
    .filter(([who]) => !(own && who === meta.me))
    .map(([who, r]) => ({ who, url: r.url, r }));
  if (own) list.push({ who: '', mine: true, r: mine });
  return list;
}
function tally(id) {
  const s = { like: 0, fav: 0, pros: [], cons: [], other: [] };
  for (const p of everyone()) {
    if (isDock(id) ? p.r.dock === id.slice(4) : p.r.like.includes(id)) s.like++;
    if (p.r.fav === id) s.fav++;
    (p.r.notes[id] || []).forEach((n, i) =>
      s[n.k === '+' ? 'pros' : n.k === '-' ? 'cons' : 'other'].push({
        who: p.who,
        url: p.url,
        mine: p.mine,
        t: n.t,
        i,
      }),
    );
  }
  pub.free
    .filter((f) => f.id === id)
    .forEach((f) => s.other.push({ who: f.who, url: f.url, t: f.t }));
  return s;
}
function status() {
  if (!filled(mine)) return 'empty';
  const h = hashOf(mine);
  if (meta.me && pub.by[meta.me]?.h === h) return 'sent';
  return meta.copied === h ? 'copied' : 'unsent';
}

/* ---------- 生成要发送的评论 ---------- */
function toMarkdown() {
  const r = tidy(mine);
  const label = (id) => {
    const x = target(id);
    return `${x.no} ${x.name}`;
  };
  const votes = [];
  if (r.like.length) votes.push('👍 ' + r.like.map(label).join(', '));
  if (r.fav) votes.push('❤️ ' + label(r.fav));
  if (r.dock) votes.push(`${t('rv.dock')} ${r.dock.toUpperCase()}`);
  const lines = [
    `<!-- rewind-review v1 h=${hashOf(r)} like=${r.like.join(',')} fav=${r.fav || ''} dock=${r.dock || ''} -->`,
    `**${t('rv.md.votes')}** · ${votes.join(' · ') || '—'}`,
  ];
  for (const id of TARGETS()) {
    const list = r.notes[id];
    if (!list) continue;
    const x = target(id);
    lines.push('', `#### ${x.dock ? t('rv.dock') + ' ' : ''}${x.no} · ${x.name}`);
    for (const [k, key] of [
      ['+', 'rv.pros'],
      ['-', 'rv.cons'],
    ]) {
      const items = list.filter((n) => n.k === k);
      if (items.length) lines.push('', `**${t(key)}**`, '', ...items.map((n) => '- ' + n.t));
    }
  }
  lines.push('', `<sub>${t('rv.md.foot')}</sub>`);
  return lines.join('\n');
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

let lastMd = '';
async function send() {
  if (!filled(mine)) return;
  lastMd = toMarkdown();
  // 先复制（需要页面仍在前台），再打开 Issue
  const copied = await copyText(lastMd);
  let opened = false;
  if (issueNo()) {
    const w = window.open(issueUrl() + '#new_comment_field', '_blank');
    if (w) {
      w.opener = null;
      opened = true;
    }
  }
  meta.copied = hashOf(mine);
  saveMine();
  paintReview();
  openDialog(copied, opened);
}

function openDialog(copied, opened) {
  const d = $('rv-dlg');
  const n = issueNo();
  const steps = [
    `<li class="${copied ? 'ok' : ''}">${t(copied ? 'rv.dlg.copied' : 'rv.dlg.copyManual')}</li>`,
    `<li>${n ? t(opened ? 'rv.dlg.paste' : 'rv.dlg.blocked') : t('rv.dlg.noIssue')}</li>`,
    n ? `<li>${t('rv.dlg.comment')}</li>` : '',
  ];
  d.innerHTML =
    `<h3 id="rv-dlg-h">${t('rv.dlg.h')}</h3><ol class="rv-steps">${steps.join('')}</ol>` +
    `<textarea class="rv-md" readonly rows="9" aria-label="${t('rv.dlg.text')}">${esc(lastMd)}</textarea>` +
    `<div class="rv-dlg-b"><button type="button" class="ghost" data-rv-dlg-close>${t('rv.dlg.close')}</button>` +
    (n
      ? `<button type="button" class="ghost" data-rv-posted>${t('rv.dlg.posted')}</button>` +
        `<button type="button" class="rv-send" data-rv-go-issue>${t('rv.dlg.go', { n: '#' + n })}</button>`
      : `<button type="button" class="rv-send" data-rv-copy>${t('rv.dlg.copy')}</button>`) +
    `</div>`;
  if (!d.open) {
    if (d.showModal) d.showModal();
    else d.setAttribute('open', '');
  }
  if (!copied) d.querySelector('textarea').select();
}

async function checkPosted(btn) {
  btn.disabled = true;
  await loadIssue(true);
  btn.disabled = false;
  if (status() === 'sent') {
    $('rv-dlg').close();
    rvToast(t('rv.found'));
  } else rvToast(t('rv.notYet'));
}

let toastTimer;
function rvToast(text) {
  const el = $('rv-toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

/* ---------- 绘制：评价直接写在每个方向下面 ---------- */
const whoHTML = (it) =>
  it.mine
    ? `<em class="me">${t('rv.you')}</em>`
    : it.url
      ? `<a href="${esc(it.url)}" target="_blank" rel="noreferrer">@${esc(it.who)}</a>`
      : `<em>${esc(it.who)}</em>`;

const typing = {}; // 输入框里还没添加的文字（只在内存里），重绘时放回去

// 一个方向（或一种底栏）下面的整块：👍 ❤️，优点、缺点各一列，每列下面一个输入框
function blockHTML(id) {
  const s = tally(id),
    dock = isDock(id);
  const likeOn = dock ? mine.dock === id.slice(4) : mine.like.includes(id);
  const item = (it) =>
    `<li class="${it.mine ? 'mine' : ''}"><span class="rv-t">${esc(it.t)}</span><span class="rv-who">${whoHTML(it)}` +
    (it.mine
      ? `<button type="button" data-rv-edit="${id}|${it.i}">${t('rv.edit')}</button><button type="button" data-rv-del="${id}|${it.i}">${t('rv.del')}</button>`
      : '') +
    `</span></li>`;
  const col = (k, cls, key, items) =>
    `<div class="rv-col ${cls}"><p class="rv-h">${t(key)} <b>${items.length}</b></p>` +
    (items.length ? `<ul>${items.map(item).join('')}</ul>` : '') +
    `<input type="text" class="rv-in" data-rv-add="${id}" data-k="${k}" maxlength="500" enterkeyhint="done"` +
    ` placeholder="${t(k === '+' ? 'rv.ph.pro' : 'rv.ph.con')}" aria-label="${t(k === '+' ? 'rv.ph.pro' : 'rv.ph.con')}" value="${esc(typing[id + k] || '')}"></div>`;
  return (
    `<div class="rv-row"><button type="button" class="rv-b" data-rv-like="${id}" aria-pressed="${likeOn}" title="${t(dock ? 'rv.likeDockT' : 'rv.likeT')}">👍 <span>${t(dock ? 'rv.v.dock' : 'rv.v.like')}</span><b>${s.like}</b></button>` +
    (dock
      ? ''
      : `<button type="button" class="rv-b" data-rv-fav="${id}" aria-pressed="${mine.fav === id}" title="${t('rv.favT')}">❤️ <span>${t('rv.v.fav')}</span><b>${s.fav}</b></button>`) +
    `</div>` +
    col('+', 'pro', 'rv.pros', s.pros) +
    col('-', 'con', 'rv.cons', s.cons) +
    (s.other.length
      ? `<div class="rv-col other"><p class="rv-h">${t('rv.other')} <b>${s.other.length}</b></p><ul>${s.other.map(item).join('')}</ul></div>`
      : '')
  );
}
// 评审表和侧栏底栏用的紧凑版：点一下跳到那个方向下面去写
function chipHTML(id, label = '') {
  const s = tally(id);
  return (
    `<button type="button" class="rv-chip${touched(id) ? ' done' : ''}" data-rv-go="${id}">${label}<span>👍 ${s.like}</span>` +
    (isDock(id) ? '' : `<span>❤️ ${s.fav}</span>`) +
    `<span>+${s.pros.length} −${s.cons.length}</span></button>`
  );
}
function sendHTML() {
  const st = status(),
    p = progress();
  return (
    `<div class="rv-send-t"><b>${t('rv.cta')}</b><span>${t('rv.prog', p)} · 👍 ${mine.like.length}/${LIKE_MAX} · ❤️ ${mine.fav ? 1 : 0}/1 · ${t('rv.dock')} ${mine.dock ? mine.dock.toUpperCase() : '—'}</span>` +
    `<span class="rv-st ${st}">${t('rv.st.' + st)}</span></div>` +
    `<button type="button" class="rv-send${st === 'sent' ? ' is-sent' : ''}" data-rv-send${st === 'empty' || st === 'sent' ? ' disabled' : ''}>${t(st === 'sent' ? 'rv.sent' : st === 'copied' ? 'rv.again' : 'rv.send')}</button>`
  );
}

function paintStatus() {
  const el = $('vote-status');
  const n = issueNo();
  document.body.classList.toggle('live-issue', Boolean(n));
  if (!el) return;
  const a = n ? `<a href="${issueUrl()}" target="_blank" rel="noreferrer">#${n}</a>` : '';
  el.innerHTML =
    t('rv.is.' + pub.state, { n: a, p: Object.keys(pub.by).length }) +
    (n && pub.state !== 'loading'
      ? ` <button type="button" class="rv-link" data-rv-refresh>${t('rv.refresh')}</button>`
      : '');
}

// 底栏单独一块：说明 + 在所有手机上试一下 + 同样的评价区
function dockCardsHTML() {
  return DOCKS.map(
    (v) =>
      `<article class="dock-card" data-id="nav-${v}"><header><span class="no">${v.toUpperCase()}</span><div><h3>${t('nav.' + v)}</h3><p>${t('dock.desc.' + v)}</p></div></header>` +
      `<button type="button" class="ghost dock-try" data-rv-try="${v}">${t('dock.try')}</button>` +
      `<div class="rv" data-rv="nav-${v}"></div></article>`,
  ).join('');
}

function paintReview() {
  if (!$('rv-bar')) return; // 外壳还没建好
  // 重绘会重建输入框：记下正在输入的那个，画完再把光标放回去
  const act = document.activeElement;
  const keep = act?.dataset?.rvAdd
    ? { id: act.dataset.rvAdd, k: act.dataset.k, pos: act.selectionStart }
    : null;
  const dc = $('dock-cards');
  if (dc && !dc.firstChild) dc.innerHTML = dockCardsHTML();
  document.querySelectorAll('[data-rv]').forEach((el) => (el.innerHTML = blockHTML(el.dataset.rv)));
  document
    .querySelectorAll('[data-rvchip]')
    .forEach((el) => (el.innerHTML = chipHTML(el.dataset.rvchip)));
  const dk = $('rv-docks');
  if (dk)
    dk.innerHTML = DOCKS.map((v) => chipHTML('nav-' + v, `<b>${v.toUpperCase()}</b>`)).join('');
  const p = progress();
  $('rv-bar').innerHTML =
    `<i class="rv-prog" style="width:${Math.round((p.done / p.total) * 100)}%"></i>` +
    `<div class="rv-bar-in">${sendHTML()}</div>`;
  const side = $('rv-mine');
  if (side)
    side.innerHTML =
      sendHTML() +
      (filled(mine)
        ? `<button type="button" class="rv-link" data-rv-clear>${t('rv.clear')}</button>`
        : '');
  paintStatus();
  if (keep) {
    const el = document.querySelector(`[data-rv-add="${keep.id}"][data-k="${keep.k}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(keep.pos, keep.pos);
    }
  }
}

// 发送栏、发送说明和提示条：页面加载时建一次；底栏评价区的文字随语言重建
function buildShell() {
  const make = (tag, id, cls) => {
    let el = $(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      el.className = cls;
      document.body.appendChild(el);
    }
    return el;
  };
  make('div', 'rv-bar', 'rv-bar').setAttribute('aria-label', t('rv.barAria'));
  make('dialog', 'rv-dlg', 'rv-dlg').setAttribute('aria-labelledby', 'rv-dlg-h');
  const toast = make('div', 'rv-toast', 'rv-toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const dc = $('dock-cards');
  if (dc) dc.innerHTML = dockCardsHTML();
}

// 从评审表或侧栏跳到某个方向下面，光标放进“优点”输入框
function goTo(id) {
  if (isDir(id) && current !== 'all' && current !== id) pick(id);
  const box = document.querySelector(`.card[data-id="${id}"], .dock-card[data-id="${id}"]`);
  if (!box?.offsetParent) return;
  box.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  box.classList.remove('rv-flash');
  void box.offsetWidth;
  box.classList.add('rv-flash');
  box.querySelector('.rv-in')?.focus({ preventScroll: true });
}

function toggleLike(id, btn) {
  if (isDock(id)) mine.dock = mine.dock === id.slice(4) ? null : id.slice(4);
  else if (mine.like.includes(id)) mine.like = mine.like.filter((x) => x !== id);
  else if (mine.like.length >= LIKE_MAX) {
    btn.classList.remove('rv-no');
    void btn.offsetWidth;
    btn.classList.add('rv-no');
    return rvToast(t('rv.max', { n: LIKE_MAX }));
  } else mine.like.push(id);
  changed();
}

function addNote(input) {
  const id = input.dataset.rvAdd,
    k = input.dataset.k;
  const text = input.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  (mine.notes[id] ||= []).push({ k, t: text.slice(0, 500) });
  input.value = '';
  typing[id + k] = '';
  changed();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest(
    '[data-rv-like],[data-rv-fav],[data-rv-go],[data-rv-try],[data-rv-del],[data-rv-edit],[data-rv-send],[data-rv-copy],[data-rv-go-issue],[data-rv-posted],[data-rv-dlg-close],[data-rv-clear],[data-rv-refresh]',
  );
  if (!b) return;
  const d = b.dataset;
  if (d.rvLike) return toggleLike(d.rvLike, b);
  if (d.rvFav) {
    mine.fav = mine.fav === d.rvFav ? null : d.rvFav;
    return changed();
  }
  if (d.rvGo) return goTo(d.rvGo);
  if (d.rvTry) {
    // 用侧栏的底栏切换，所有手机一起换上这个底栏
    document.querySelector(`.navpick [data-nav="${d.rvTry}"]`)?.click();
    return $('gallery').scrollIntoView({
      block: 'start',
      behavior: reduceMotion() ? 'auto' : 'smooth',
    });
  }
  if (d.rvDel || d.rvEdit) {
    const [id, i] = (d.rvDel || d.rvEdit).split('|');
    const list = mine.notes[id];
    const n = list?.[Number(i)];
    if (!n) return;
    list.splice(Number(i), 1);
    // “改”：把这条放回对应的输入框，改完回车重新添加
    if (d.rvEdit) typing[id + n.k] = n.t;
    changed();
    if (d.rvEdit) document.querySelector(`[data-rv-add="${id}"][data-k="${n.k}"]`)?.focus();
    return;
  }
  if ('rvSend' in d || 'rvGoIssue' in d) return send();
  if ('rvCopy' in d)
    return copyText(lastMd).then((ok) => rvToast(t(ok ? 'rv.copiedToast' : 'rv.copyFail')));
  if ('rvPosted' in d) return checkPosted(b);
  if ('rvDlgClose' in d) return $('rv-dlg').close();
  if ('rvClear' in d) {
    if (!confirm(t('rv.clearQ'))) return;
    mine = blank();
    meta.copied = '';
    return changed();
  }
  if ('rvRefresh' in d) return loadIssue(true);
});
document.addEventListener('input', (e) => {
  const d = e.target.dataset;
  if (d?.rvAdd) typing[d.rvAdd + d.k] = e.target.value;
});
document.addEventListener('keydown', (e) => {
  // 回车添加；输入法选字时的回车不算
  if (!e.target.dataset?.rvAdd || e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  addNote(e.target);
});
$('vote-sample')?.addEventListener('change', (e) => sample(e.target.checked));

// 切换语言：重建文字；示例数据也换成对应语言
function relangReview() {
  buildShell();
  if (pub.state === 'sample') sample(true);
  else paintReview();
}

loadMine();
buildShell();
paintReview();
loadIssue();
