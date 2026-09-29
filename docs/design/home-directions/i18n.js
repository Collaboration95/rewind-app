'use strict';

// 评审页双语（默认英文）。手机里的界面本来就是英文，不在这里翻译。
// 每一项是 [英文, 中文]；页面里带 data-i18n / data-i18n-aria 的元素会自动替换。
const I18N = {
  'doc.title': ['Rewind Home directions', 'Rewind 首页方向'],
  'side.aria': ['Design controls', '设计控制'],
  'brand.sub': ['Home direction study', 'Home 方向探索'],
  'lang.aria': ['Language', '语言'],

  'pick.label': ['Directions', '方案'],
  'pick.aria': ['Choose a direction', '选择方案'],
  'pick.all': ['Compare all', '全部对比'],
  'group.r3': ['Round 3 · from the product scan', '第三轮 · 借鉴竞品的新方向'],
  'group.r2': ['Round 2 · warmer directions', '第二轮 · 温馨方向'],
  'group.r1': ['Round 1', '第一轮'],

  'members.label': ['Group size', '小组人数'],
  'members.unit': ['{n} people', '{n} 人'],
  shuffle: ['Shuffle', '随机贡献'],
  restore: ['Reset sample', '恢复示例'],
  'members.hint': [
    'Data scope (proposal A): shows who is in (yes or no), never how many moments someone else added. Your own count comes from your ledger and the group total from the cycle summary. The demo uses 5 people.',
    '数据口径（提案 A）：只显示谁参与了（是 / 否），不显示别人各贡献了几条；你自己的条数来自你的台账，全组总数来自周期汇总。演示默认 5 人。',
  ],

  'anon.label': ['Members not in yet', '还没贡献的成员'],
  'anon.aria': ['How members who are not in yet are shown', '还没贡献的成员如何显示'],
  'anon.hide': ['Not named', '不点名'],
  'anon.show': ['Named', '显示名字'],
  'anon.hint': [
    'Not named by default (from Reveal): an empty seat or stamp. Switch to compare.',
    '默认不点名（借鉴 Reveal），显示为空位 / 空邮票；可切换对比。',
  ],

  'state.label': ['State · simulated', '状态 · 模拟'],
  'state.collect': ['Collecting', '正常收集中'],
  'state.loading': ['Loading · later', '加载中 · 稍后'],
  'state.empty': ['No cycle · later', '尚无周期 · 稍后'],
  'state.error': ['Failed to load · later', '加载失败 · 稍后'],
  'state.processing': ['Film processing · later', '影片处理中 · 稍后'],
  'state.released': ['Film released · later', '影片已发布 · 稍后'],
  'state.quota': ['Allowance used · later', '额度用尽 · 稍后'],
  'state.hint': [
    'Other states come later, once a visual direction is chosen.',
    '其他状态稍后接入，先确认视觉方向。',
  ],
  'zoom.label': ['Zoom', '缩放'],

  'motion.label': ['Motion', '动效'],
  'motion.replay': ['Replay entrance', '重播入场动效'],
  'motion.hint': [
    'Entrance: the Darkroom film slides in and keeps running, and the Premiere ticket drifts down. Play, beside each phone, runs ① a friend joins → ② you seal a moment → ③ everyone opens it at 8 PM on Sunday. Play always resets that phone first.',
    '入场：暗房胶片斜向滑入并持续走片，首映票根从上方飘落。每台手机旁的“播放”会依次演示：①朋友加入 → ②你按快门封存 → ③周日 8 点一起揭晓；每次点“播放”都会先把这台手机重置，再从头开始。',
  ],
  play: ['Play', '播放'],
  'play.title': ['Reset this phone and play from the start', '重置这台手机并从头播放'],
  'step.1': ['① A friend joins', '① 朋友加入'],
  'step.2': ['② You seal a moment', '② 你按快门，封存'],
  'step.3': ['③ Sunday 8 PM · everyone opens it', '③ 周日 8 点，一起揭晓'],
  'step.done': ['Done · press Play to run it again', '播放完毕 · 再点“播放”重新开始'],

  'nav.label': ['Dock variant', '底栏变体'],
  'nav.aria': ['Dock variant', '底栏变体'],
  'nav.a': ['Active label', '选中展开'],
  'nav.b': ['Labels always', '始终有字'],
  'nav.c': ['Shrinks on scroll', '滚动缩小'],
  'nav.d': ['Centre shutter', '中置快门'],
  'nav.e': ['Shutter only', '只有快门'],
  'nav.f': ['Timeline', '时间轴'],
  'nav.g': ['Live pill', '实时胶囊'],
  'nav.struct': [
    'A–C: three tabs and a separate shutter. D–G: other structures.',
    'A–C：三栏 + 独立快门；D–G：其他结构。',
  ],
  'shutter.label': ['Shutter state', '快门状态'],
  'shutter.collect': ['Collecting', '收集中'],
  'shutter.quota': ['Allowance used up', '额度用完'],
  'shutter.upload': ['Sealing', '封存中'],
  'shutter.sealed': ['Just sealed', '刚封存'],
  'shutter.premiere': ['Premiere (24 hours)', '首映期（24 小时）'],
  unread: ['Chat has 3 unread', '聊天有 3 条未读'],
  'nav.hint': [
    'Every direction uses the same glass dock, tinted by its theme; Settings lives in the avatar. This switches only the dock; Home states come later.',
    '11 个方向统一用玻璃底栏，只随主题换色；设置并入左上角头像。这里只切换底栏，首页内容的状态稍后做。',
  ],
  'nav.votes': ['Dock variant votes', '底栏变体投票'],

  'try.label': ['Try', '可以试试'],
  'try.1': ['Tap the avatar: profile and settings', '点头像：打开个人与设置'],
  'try.2': ['Tap the dock: switch the active tab', '点底栏：切换选中态'],
  'try.3': [
    'Press the shutter: seal a moment (not when the allowance is used up)',
    '按快门：封存一个片段（额度用完时不可按）',
  ],
  'try.4': [
    'C shrinks while you scroll; tap the small pill to expand. G: tap the live pill to show the tabs.',
    '“滚动缩小”：往下滚缩小，点小胶囊展开；“实时胶囊”：点胶囊展开三个页签。',
  ],
  foot: [
    'Design simulation · abstract textures and generated photos only, no unrevealed media',
    '设计模拟 · 画面均为抽象纹理和生成图，不含任何未揭晓媒体',
  ],

  'main.k': ['HOME · ROUND 3 · FOR REVIEW', 'HOME · 第三轮 · 评审稿'],
  'main.h1': ['Eleven directions to review together', '11 个方向，一起评审'],
  'main.p': [
    'Every direction shares one information order (prompt → action → status) and one navigation (a glass dock with a shutter; Settings in the avatar). This round applies the product scan to all of them and adds 09–11.',
    '同一信息架构（题目 → 行动 → 状态）与同一导航（玻璃底栏 + 快门，设置并入头像）。本轮根据竞品调研统一调整了全部方案，并新增 09–11。',
  ],
  'learn.aria': ['Changes applied from the product scan', '本轮依据竞品的统一调整'],
  'learn.1b': ['Nobody is named', '不点名'],
  'learn.1s': [
    'Members not in yet are an empty seat, with “Waiting on one more”',
    '还没贡献的人显示为空位，文案 “Waiting on one more”',
  ],
  'learn.2b': ['A colour per member', '成员专属色'],
  'learn.2s': [
    'Avatars, rings, seats and stamps use each member’s own colour',
    '头像、额度环、座位、邮票都用每人自己的颜色',
  ],
  'learn.3b': ['Not even you', '连你也看不到'],
  'learn.3s': [
    'Sealed copy always says “not even you can peek”',
    '封存提示统一为 “not even you can peek”',
  ],
  'learn.4b': ['Everyone at once', '一起揭晓'],
  'learn.4s': [
    'The countdown stresses that everyone opens it together, like a premiere',
    '倒计时强调“所有人同时打开”，把揭晓当首映',
  ],
  'learn.5b': ['Count, who is in, countdown', '数量 + 谁参与 + 倒计时'],
  'learn.5s': [
    'Before the reveal, show only these; never any content',
    '揭晓前只给这三类信息，不给任何内容',
  ],

  'review.title': ['Review table', '评审对照表'],
  'review.hint': [
    'Metaphor, cost and risk are the author’s draft, not review feedback. The review is everyone’s own votes and comments in the issue.',
    '“核心隐喻 / 实现成本 / 主要风险”为作者草拟，不是评审意见；评审以 Issue 里每个人自己的投票和评论为准。',
  ],
  'th.dir': ['Direction', '方案'],
  'th.meta': ['Metaphor', '核心隐喻'],
  'th.cost': ['Expo build cost (estimate)', 'Expo 实现成本（估计）'],
  'th.risk': ['Main risk', '主要风险'],
  'th.vote': ['Issue votes', 'Issue 投票'],
  'asks.h': ['Questions for the review', '建议评审时回答'],
  'asks.1': [
    'Which two or three directions feel most like a private time capsule with close friends?',
    '哪 2–3 个方向最像“和亲密朋友的私密时间胶囊”？',
  ],
  'asks.2': ['Members not in yet: not named, or named?', '还没贡献的人：不点名还是显示名字？'],
  'asks.3': [
    'Showing who is in, but never how many moments each person added: is that the right amount? (It needs a small new API.)',
    '只显示“谁参与了”、不显示别人各贡献了几条，这个程度合适吗？（需要新增一个小接口）',
  ],
  'asks.4': [
    'Should the reveal be a shared “watch at the same time” premiere? (Affects 04, 07 and 10.)',
    '揭晓要不要做成“同一时刻一起看”的首映？（影响 04、07、10）',
  ],
  'asks.5': [
    'Which dock: three tabs and a shutter (A–C), or one of the other structures (D–G)?',
    '底栏选哪种：三栏 + 快门（A–C），还是其他结构（D–G）？',
  ],
  fonts: ['Type', '字体'],
};

// 侧栏重排后的文案（覆盖上面的同名项）
Object.assign(I18N, {
  'group.base': ['Baseline', '对照组'],
  'nav.label': ['Dock', '底栏'],
  'nav.struct': [
    'A keeps three tabs and a separate shutter; D, E and G change the structure. Every direction uses the same glass dock, tinted by its theme.',
    'A 是三栏 + 独立快门；D、E、G 是其他结构。所有方向共用同一种玻璃底栏，只随主题换色。',
  ],
  'nav.votes': ['Dock votes', '底栏投票'],
  'group.label': ['The group', '小组'],
  'members.label': ['People in the group', '小组人数'],
  'anon.label': ['Friends who haven’t added a moment yet', '还没发片段的朋友'],
  'anon.hide': ['Empty spot', '显示为空位'],
  'anon.show': ['Show names', '显示名字'],
  'members.hint': [
    'Home shows only who is in, never how many moments someone else added. “Empty spot” follows Reveal, so nobody gets called out. The demo has 5 people.',
    '首页只显示谁参与了，不显示别人各发了几条。“显示为空位”借鉴 Reveal，不点名、不给人压力。演示默认 5 人。',
  ],
  'sim.label': ['Simulate', '模拟状态'],
  'shutter.label': ['Shutter', '快门'],
  'state.label': ['Home', '首页'],
  'state.hint': [
    'Other Home states come after we pick a direction.',
    '首页的其他状态等选定方向后再做。',
  ],
  'try.label': ['Things you can tap', '可以点的地方'],
  'hints.toggle': ['Show tap hints on the phones', '在手机上标出可以点的地方'],
  'tap.play': [
    '<b>Play</b>, next to each phone: watch a whole cycle',
    '手机旁的<b>播放</b>：看完整的一期',
  ],
  'tap.shutter': ['<b>Shutter</b>: seal a moment', '<b>快门</b>：封存一个片段'],
  'tap.avatar': [
    '<b>Avatar</b>: profile and settings. A draft; it could become a full Settings page.',
    '<b>头像</b>：个人与设置。这是暂定效果，之后可以改成独立的 Settings 页。',
  ],
  'tap.dock': [
    '<b>Dock</b>: switch tabs. In G, tap the pill to open the tabs.',
    '<b>底栏</b>：切换页签；G 方案点胶囊展开页签。',
  ],
  'ask.title': ['Please leave the pros and cons of each direction', '请大家留下每个方向的优缺点'],
  'ask.body': [
    'Comment in the review issue: quote-reply a direction, or start with its number (for example “07:”). We will combine everyone’s notes and pick one direction together.',
    '在评审 Issue 里评论：引用回复对应的方向，或以编号开头（如 “07:”）。我们会汇总大家的意见，一起挑出一个方向。',
  ],
  'main.p': [
    'Every direction shares one information order (prompt → action → status) and one glass dock with a shutter. Settings sits behind the avatar for now; that is a draft and could become a full Settings page. This round applies the product scan to all of them and adds 09–11.',
    '所有方向共用同一信息架构（题目 → 行动 → 状态）和同一种玻璃底栏 + 快门。设置目前放在头像里，这是暂定效果，之后可以改成独立的 Settings 页。本轮根据竞品调研统一调整了全部方案，并新增 09–11。',
  ],
  'asks.2': [
    'Friends who haven’t added yet: an empty spot, or their name?',
    '还没发片段的朋友：显示为空位，还是显示名字？',
  ],
  'asks.5': ['Which dock: A, D, E or G?', '底栏选 A、D、E、G 中的哪一个？'],
});

// 页面内评审（本地草稿 → 一键复制发到 Issue）
Object.assign(I18N, {
  'vote.sample': ['Preview with sample data', '用示例数据预览'],
  'th.vote': ['Votes and notes', '投票与优缺点'],
  'ask.body': [
    'Write them right under each phone: 👍 every direction you like, ❤️ your favourite, and pros and cons. Everything stays in your browser. When you have reviewed them all, press <b>Copy, then comment in the issue</b> at the bottom: it copies one comment and opens the issue; paste it and click Comment. We will combine everyone’s notes and pick one direction together.',
    '直接写在每台手机下面：给你喜欢的方向点 👍（不限个数），给最喜欢的 1 个 ❤️，再写优点和缺点。内容先存在你的浏览器里；全部评价完后，点页面底部的<b>一键复制，跳转到 Issue 发布评论</b>，它会复制整理好的一条评论并打开 Issue，粘贴后点 Comment 就行。我们会汇总大家的意见，一起挑出一个方向。',
  ],
  'review.hint': [
    'Metaphor, cost and risk are the author’s draft, not review feedback. The review is everyone’s own votes and notes, sent to the review issue.',
    '“核心隐喻 / 实现成本 / 主要风险”为作者草拟，不是评审意见；评审以每个人自己发到评审 Issue 的投票和优缺点为准。',
  ],
  'rv.label': ['Your review', '我的评审'],
  'rv.how': [
    'Write right under each phone and each dock. Nothing leaves this browser until you send it. Changed your mind? Edit and send again; your latest comment counts.',
    '直接在每台手机和每种底栏下面写。发送之前，内容不会离开这个浏览器。改主意了就改完再发一次，以你最新的一条为准。',
  ],
  'rv.cta': ['Reviewed them all? Click here', '评价完所有方向后，点这里'],
  'rv.send': ['Copy, then comment in the issue ↗', '一键复制，跳转到 Issue 发布评论'],
  'rv.again': ['Copy again, then comment in the issue ↗', '重新复制，跳转到 Issue 发布评论'],
  'rv.sent': ['Sent ✓', '已发送 ✓'],
  'rv.prog': ['Reviewed {done} / {total}', '已评价 {done} / {total}'],
  'rv.st.empty': [
    'Nothing yet. Under any phone, tap 👍 or ❤️, or add a pro or con.',
    '还没写。在任意一台手机下面点 👍、❤️，或写一条优缺点。',
  ],
  'rv.st.unsent': ['Saved in this browser, not sent yet.', '已存在这个浏览器里，还没发送。'],
  'rv.st.copied': [
    'Copied. Paste it in the issue and click Comment.',
    '已复制。去 Issue 里粘贴，点 Comment。',
  ],
  'rv.st.sent': ['Your latest version is in the issue.', 'Issue 里已经是你的最新版本。'],
  'rv.clear': ['Clear my draft', '清空我的草稿'],
  'rv.clearQ': [
    'Clear your 👍, ❤️ and notes in this browser? Anything already sent stays in the issue.',
    '清空这个浏览器里你的 👍、❤️ 和优缺点？已经发到 Issue 的不受影响。',
  ],
  'rv.is.none': [
    'The review issue isn’t open yet. You can already write; sending works once it’s open.',
    '评审 Issue 还没开。现在就可以写，Issue 开了之后就能发送。',
  ],
  'rv.is.loading': ['Reading issue {n}…', '正在读取 Issue {n}…'],
  'rv.is.live': ['Issue {n} · {p} people have sent a review.', 'Issue {n} · 已有 {p} 人发送评审。'],
  'rv.is.fail': [
    'Couldn’t read issue {n} (GitHub allows 60 reads an hour). Your draft is safe.',
    '暂时读不到 Issue {n}（GitHub 每小时限 60 次），你的草稿不受影响。',
  ],
  'rv.is.sample': ['Showing sample data.', '正在显示示例数据。'],
  'rv.refresh': ['Refresh', '刷新'],
  'rv.likeT': ['Worth taking forward', '值得继续'],
  'rv.likeDockT': ['My dock (up to two)', '我选这个底栏（最多 2 个）'],
  'rv.dockMax': ['Up to {n} docks. Remove one first.', '底栏最多选 {n} 个，先取消一个。'],
  'rv.noDock.h': ['You haven’t picked a dock yet', '你还没选底栏'],
  'rv.noDock.p': [
    'Below the phones, 👍 one or two docks you prefer (A, D, E or G) before sending.',
    '发送前，请在手机下方的“底栏”里给 1–2 个你喜欢的底栏点 👍（A、D、E、G）。',
  ],
  'rv.noDock.go': ['Pick a dock', '去选底栏'],
  'rv.noDock.skip': ['Send without one', '不选，直接发送'],
  'rv.favT': ['My top pick (pick one)', '最喜欢（只能选一个）'],
  'rv.v.like': ['Shortlist', '值得继续'],
  'dock.h': ['Dock · pick up to two', '底栏 · 最多选 2 个'],
  'dock.hint': [
    'Every direction uses the same dock. Try them on all the phones, then 👍 one or two you prefer and write pros and cons here.',
    '所有方向共用同一种底栏。先在所有手机上试一下，再给喜欢的 1–2 个点 👍，并在这里写优缺点。',
  ],
  'dock.try': ['Show it on all phones ↑', '在所有手机上试试 ↑'],
  'dock.desc.a': [
    'Home, Chat and Archive, plus a separate shutter; the active tab shows its label.',
    'Home、Chat、Archive 三栏加独立快门，选中的页签展开文字。',
  ],
  'dock.desc.d': [
    'Home · shutter · Archive, with the shutter in the middle; Chat moves to the top right.',
    'Home · 快门 · Archive，快门居中；Chat 移到右上角。',
  ],
  'dock.desc.e': [
    'Only the shutter at the bottom; Archive and Chat sit at the top right, like Locket or BeReal.',
    '底部只有快门；Archive 和 Chat 放在右上角，类似 Locket、BeReal。',
  ],
  'dock.desc.g': [
    'A live pill that shows “2d 14h · 3 left”; tap it to open the tabs.',
    '一颗实时胶囊，显示 “2d 14h · 3 left”，点开才是页签。',
  ],
  'rv.v.fav': ['Top pick', '最喜欢'],
  'rv.v.dock': ['My dock', '我选这个'],
  'rv.dock': ['Dock', '底栏'],
  'rv.pros': ['Pros', '优点'],
  'rv.cons': ['Cons', '缺点'],
  'rv.other': ['Other comments', '其他评论'],
  'rv.none': ['None yet', '还没有'],
  'rv.you': ['You', '你'],
  'rv.add': ['Add', '添加'],
  'rv.edit': ['Edit', '改'],
  'rv.del': ['Delete', '删'],
  'rv.ph.pro': ['+ Add a pro, press Enter', '+ 写一条优点，回车添加'],
  'rv.ph.con': ['− Add a con, press Enter', '− 写一条缺点，回车添加'],
  'rv.barAria': ['Send your review', '发送评审'],
  'rv.md.votes': ['Votes', '投票'],
  'rv.md.foot': ['Sent from the Home directions review page', '来自 Home 方向评审页'],
  'rv.dlg.h': ['Send your review', '发送评审'],
  'rv.dlg.copied': ['Copied to the clipboard ✓', '已复制到剪贴板 ✓'],
  'rv.dlg.copyManual': [
    'Copy the text below (Ctrl+C / ⌘C). The browser didn’t allow automatic copying.',
    '浏览器不允许自动复制，请手动复制下面的文字（Ctrl+C / ⌘C）。',
  ],
  'rv.dlg.paste': [
    'In the issue tab that just opened, paste it into the comment box at the bottom (Ctrl+V / ⌘V).',
    '在刚打开的 Issue 标签页里，粘贴到最下面的评论框（Ctrl+V / ⌘V）。',
  ],
  'rv.dlg.blocked': [
    'Press the orange button below to open the issue, then paste into the comment box at the bottom (Ctrl+V / ⌘V).',
    '点下面的橙色按钮打开 Issue，粘贴到最下面的评论框（Ctrl+V / ⌘V）。',
  ],
  'rv.dlg.noIssue': [
    'The review issue isn’t open yet. Your draft stays here; send it once the issue is up.',
    '评审 Issue 还没开。草稿会留在这里，Issue 开了之后再发送。',
  ],
  'rv.dlg.comment': [
    'Click “Comment”, then come back and press “I’ve posted it”.',
    '点 “Comment”，然后回到这里点“我发好了”。',
  ],
  'rv.dlg.text': ['Comment to paste', '要粘贴的评论'],
  'rv.dlg.go': ['Copy, then comment in issue {n} ↗', '一键复制，跳转到 Issue {n} 发布评论'],
  'rv.dlg.copy': ['Copy the text', '复制文字'],
  'rv.dlg.posted': ['I’ve posted it', '我发好了'],
  'rv.dlg.close': ['Close', '关闭'],
  'rv.found': ['Found it in the issue ✓', '在 Issue 里找到了 ✓'],
  'rv.notYet': [
    'Not in the issue yet. GitHub can take a minute; try again shortly.',
    'Issue 里还没读到。GitHub 可能有一分钟延迟，稍后再点一次。',
  ],
  'rv.copiedToast': ['Copied', '已复制'],
  'rv.copyFail': [
    'Couldn’t copy. Select the text and press Ctrl+C.',
    '复制失败，请选中文字按 Ctrl+C。',
  ],
  'rv.sampleWho': ['Sample {n}', '示例 {n}'],
  'rv.samplePro': ['(sample) A pro appears here', '（示例）这里显示一条优点'],
  'rv.sampleCon': ['(sample) A con appears here', '（示例）这里显示一条缺点'],
});

let LANG = 'en';
try {
  const q = new URLSearchParams(location.search).get('lang');
  LANG = q === 'zh' || q === 'en' ? q : localStorage.getItem('rewind-lang') === 'zh' ? 'zh' : 'en';
} catch {
  LANG = 'en';
}

// 取当前语言的文案；vars 用于替换 {n} 这类占位
function t(key, vars) {
  const pair = I18N[key];
  let s = pair ? pair[LANG === 'zh' ? 1 : 0] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
// 双语数据对 [英文, 中文]
const L = (pair) => (Array.isArray(pair) ? pair[LANG === 'zh' ? 1 : 0] : pair);

function applyI18n() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.title = t('doc.title');
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.innerHTML = t(el.dataset.i18n)));
  document
    .querySelectorAll('[data-i18n-aria]')
    .forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  document
    .querySelectorAll('[data-lang]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === LANG)));
}
