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

  'vote.label': ['Vote', '投票'],
  'vote.rules': [
    'Vote on GitHub: 👍 up to three directions and ❤️ one favourite. To comment, quote-reply a direction’s comment or start with its number (for example “07:”); the page files it under that direction.',
    '在 GitHub 上投票：每人最多给 3 个方向 👍，给最喜欢的 1 个 ❤️。评论请引用回复对应方向的评论，或以编号开头（如 “07:”），这里会自动归到那个方向下。',
  ],
  'vote.sample': ['Preview the vote bar (sample data)', '预览投票区样式（示例数据）'],
  'vote.loading': ['Loading the review issue…', '正在读取投票 Issue…'],
  'vote.none': [
    'The review issue is not published yet, so the vote bars are empty.',
    '评审 Issue 尚未发布，投票栏暂时为空。',
  ],
  'vote.live': [
    'Votes and comments live in {n}; they are read when the page opens.',
    '投票与评论在 {n}，打开页面时读取。',
  ],
  'vote.fail': [
    ' Could not read the votes (the public GitHub API allows 60 requests an hour). Open the issue directly.',
    ' 票数暂时读取失败（GitHub 公共接口每小时限 60 次），请直接打开 Issue 查看。',
  ],
  'vb.off': [
    'Once the review issue is published, this shows the votes and latest comments, with a link to vote or comment on GitHub.',
    '评审 Issue 发布后，这里显示票数和最新评论，并可一键去 GitHub 投票、评论。',
  ],
  'vb.empty': [
    'No comment for this direction in the issue yet.',
    '这个方向在 Issue 里还没有对应的评论。',
  ],
  'vb.go': ['Vote / comment ↗', '去投票 / 评论 ↗'],
  'vb.sample': ['Sample data', '示例数据'],
  'vb.sampleWho': ['Sample', '示例'],
  'vb.sampleText': [
    'The latest quote reply, or comment starting with this number, appears here.',
    '组员引用回复这个方向、或以编号开头的评论，最新的会显示在这里。',
  ],

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
    'Metaphor, cost and risk are the author’s draft (AI-assisted), not review feedback. The review is everyone’s own votes and comments in the issue.',
    '“核心隐喻 / 实现成本 / 主要风险”为作者草拟（AI 辅助），不是评审意见；评审以 Issue 里每个人自己的投票和评论为准。',
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
