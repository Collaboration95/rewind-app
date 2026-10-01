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
  'rv.is.live': ['Issue {n} · reviews sent: {p}.', 'Issue {n} · 已有 {p} 人发送评审。'],
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

// 第一轮评审后：6 个方向列为废案
Object.assign(I18N, {
  'main.k': ['HOME · SHORTLIST · FOR REVIEW', 'HOME · 保留方向 · 评审稿'],
  'main.h1': ['Four directions still in review', '4 个方向继续评审'],
  'main.p': [
    'Every direction shares one information order (prompt → action → status) and one glass dock with a shutter. Settings sits behind the avatar for now; that is a draft and could become a full Settings page. After the first review, seven directions were archived (01–05, 08 and 11); they are folded at the bottom of the page.',
    '所有方向共用同一信息架构（题目 → 行动 → 状态）和同一种玻璃底栏 + 快门。设置目前放在头像里，这是暂定效果，之后可以改成独立的 Settings 页。第一轮评审后，有 7 个方向列为废案（01–05、08、11），收在页面最下面。',
  ],
  'asks.4': [
    'Should the reveal be a shared “watch at the same time” premiere? (Affects 07 and 10.)',
    '揭晓要不要做成“同一时刻一起看”的首映？（影响 07、10）',
  ],
  'group.keep': ['Still in review', '保留方向'],
  'group.arch': ['Archived', '废案'],
  'arch.show': ['Show', '展开'],
  'arch.hide': ['Hide', '收起'],
  'arch.tag': ['Archived', '废案'],
  'arch.toggle': ['Show the 7 archived directions', '显示 7 个废案'],
  'rv.archNote': [
    'Archived after the first review. Votes and notes already given are shown here, read-only.',
    '第一轮评审后列为废案。已有的投票和优缺点只读显示，不能再添加。',
  ],
  'rv.archShow': ['Show review', '查看已有评审'],
  'rv.archHide': ['Hide review', '收起评审'],
  'rv.favArch.h': ['Your ❤️ is on an archived direction', '你的 ❤️ 投给了一个废案'],
  'rv.favArch.p': [
    '{name} was archived after the first review. Move your top pick to a direction still in review?',
    '{name} 在第一轮评审后列为废案。要把 ❤️ 改投给一个保留方向吗？',
  ],
  'rv.favArch.go': ['Move my ❤️', '去改投'],
  'rv.favArch.skip': ['Send as it is', '照样发送'],
});

// App icon 搭配页
Object.assign(I18N, {
  'tab.aria': ['Page', '页面'],
  'tab.review': ['Home directions', 'Home 方向评审'],
  'tab.mix': ['App icon · mix and match', 'App icon 搭配'],
  'mix.k': ['APP ICON · MIX AND MATCH', 'APP ICON · 自由搭配'],
  'mix.h1': ['Pick a Home and an icon', '选一个首页，配一个图标'],
  'mix.p': [
    'See them together where people will meet them: the home screen, the launch screen that opens into this Home, a notification and the colours side by side. No voting here yet; copy the link to share a pairing.',
    '把它们放进用户真正会遇到的地方一起看：手机桌面、打开 App 后从启动页过渡到这个首页、通知横幅，以及配色对照。这里暂时不投票，复制链接就能把搭配分享出去。',
  ],
  'mix.dir': ['Home', '首页方向'],
  'mix.sp': ['Scratchpad skin', '草稿本皮肤'],
  'mix.archHint': [
    'Archived directions are hidden; turn on “Show the {n} archived directions” in the sidebar to add them.',
    '废案已隐藏；在侧栏勾选“显示 {n} 个废案”后可以一起搭配。',
  ],
  'mix.family': ['Scratchpad “Re” family', '草稿本 “Re” 字标'],
  'mix.pair': ['This direction’s own icon', '这个方向配套的图标'],
  'mix.pairOf': ['Icon of', '配套图标 ·'],
  'mix.refs': ['For reference', '参考'],
  'mix.new': ['new', '新'],
  'mix.tint': ['Dot follows the Home accent', '圆点跟随首页强调色'],
  'mix.tintHint': [
    'Only the accent in the icon changes (the dot, the small e or the square); the rest stays black and white.',
    '只换图标里的强调色（圆点、小 e 或方块），其余保持黑白。',
  ],
  'mix.tintNone': ['This icon has no accent colour to follow.', '这个图标没有可以跟随的强调色。'],
  'mix.share': ['Copy a link to this pairing', '复制这个搭配的链接'],
  'mix.copied': ['Link copied', '链接已复制'],
  'mix.launch': ['Launch → Home', '启动页 → 首页'],
  'mix.replay': ['Replay the launch', '重播启动'],
  'mix.homeScreen': ['On the home screen', '手机桌面'],
  'mix.wall': ['Wallpaper', '壁纸'],
  'mix.wall.light': ['Light wallpaper', '浅色壁纸'],
  'mix.wall.dark': ['Dark wallpaper', '深色壁纸'],
  'mix.sizes': ['Sizes', '各种尺寸'],
  'mix.size.120': ['App Store', 'App Store'],
  'mix.size.60': ['home screen', '桌面'],
  'mix.size.40': ['Spotlight', '搜索'],
  'mix.size.29': ['Settings, notifications', '设置、通知'],
  'mix.notif': ['Notification', '通知'],
  'mix.notifText': ['This week’s film premieres Sunday at 8 PM', '本周影片周日晚 8 点首映'],
  'mix.now': ['now', '刚刚'],
  'mix.pal': ['Colours side by side', '配色对照'],
  'mix.palDir': ['Home', '首页'],
  'mix.palIcon': ['Icon', '图标'],
  'mix.bg': ['Background', '底色'],
  'mix.ink': ['Ink', '墨色'],
  'mix.acc': ['Accent', '强调色'],
  'mix.hintFlip': [
    'One is light and the other dark, so opening the app flips brightness. Try a dark icon (A′ or L) or a light Home.',
    '图标和首页一深一浅，打开 App 时亮度会反转。可以试试深色图标（A′ 或 L），或换一个浅色首页。',
  ],
  'mix.hintSame': [
    'Icon and Home share the same brightness, so the launch flows smoothly into the Home.',
    '图标和首页明暗一致，从启动页过渡到首页会比较顺。',
  ],
  'mix.famH': ['All scratchpad icons', '全部草稿本图标'],
  'mix.cat.word': ['Letters', '字母类'],
  'mix.bgLabel': ['Icon background', '图标底色'],
  'mix.bg.white': ['White', '白'],
  'mix.bg.cream': ['Cream', '奶油'],
  'mix.bg.black': ['Black', '黑'],
  'mix.bg.home': ['Home colour', '跟随首页'],
  'mix.bgNone': [
    'This icon has its own background; the background options apply to the white scratchpad icons.',
    '这个图标自带底色；底色只对白底的草稿本图标生效。',
  ],
  'mix.cat.mark': ['Symbols', '图形类'],
  'mix.famP': [
    'Handwriting is Shantell Sans, the font tldraw uses for its draw style. Letters (1–15) spell Re; symbols (16–20) draw one idea without letters. The ones marked new come from this round, and 11, 12 and 16 grow out of the two-dot icon tried locally. Tap one to pair it. Final files would outline the letters to paths.',
    '手写字体是 Shantell Sans，也就是 tldraw 手绘风格用的字体。字母类（1–15）写的是 Re；图形类（16–20）不写字母，只画一个意思。标“新”的是这一轮加的，其中 11、12、16 由本地试过的“两个点”图标发展而来。点一下就能拿去搭配。最终交付时字母会转成路径。',
  ],
  'mix.animNote': [
    'Placeholder: a plain fade for now. To explore later: the icon zooming open into the Home (as iOS does), a quick rewind of the week’s frames, or an opening that fits each direction, such as fireflies leaving the icon or the projector light switching on.',
    '现在只是占位的淡出效果，之后再讨论怎么优化。可以考虑：图标放大展开成首页（类似 iOS 打开 App）；快速倒放一遍这周的画面；或者按方向定制开场，比如萤火虫从图标里飞出来、放映机的灯亮起。',
  ],
  'mix.app.gmail': ['Gmail', 'Gmail'],
  'mix.app.maps': ['Google Maps', 'Google 地图'],
  'mix.app.chrome': ['Chrome', 'Chrome'],
  'mix.app.youtube': ['YouTube', 'YouTube'],
  'mix.app.whatsapp': ['WhatsApp', 'WhatsApp'],
  'mix.app.instagram': ['Instagram', 'Instagram'],
  'mix.app.spotify': ['Spotify', 'Spotify'],
  'mix.app.settings': ['Settings', '设置'],
  'mix.app.camera': ['Camera', '相机'],
  'mix.app.photos': ['Photos', '照片'],
  'mix.app.maps': ['Maps', '地图'],
  'mix.app.calendar': ['Calendar', '日历'],
});

// 首页状态
Object.assign(I18N, {
  'state.collect': ['Collecting', '收集中'],
  'state.loading': ['Loading', '加载中'],
  'state.empty': ['No capsule yet', '这一期还没开始'],
  'state.error': ['Failed to load', '加载失败'],
  'state.denied': ['No access', '没有权限'],
  'state.quota': ['Allowance used up', '额度用完'],
  'state.developing': ['Film developing', '影片制作中'],
  'state.delayed': ['Taking longer', '比平时慢'],
  'state.released': ['Film released', '影片已上映'],
  'state.hint': [
    'The states follow the Home on dev: loading, no capsule, failed to load, no access, the allowance and the reveal. The copy is a draft. Play returns to collecting.',
    '状态与 dev 上的首页一一对应：加载中、这一期还没开始、加载失败、没有权限、额度、揭晓。文案是草稿。点“播放”会回到收集中。',
  ],
});

// 状态页
Object.assign(I18N, {
  'tab.states': ['States', '状态'],
  'sts.k': ['HOME · STATES', 'HOME · 状态'],
  'sts.h1': ['Every Home state', '首页的各个状态'],
  'sts.p': [
    'Pick a state to compare the directions side by side, or pick a direction to see all of its states. They follow the Home on dev; the copy is a draft. The sidebar switch still sets the state on the other tabs.',
    '选一个状态，把各个方向放在一起比；或选一个方向，看它的全部状态。状态与 dev 上的首页对应，文案是草稿。侧栏里的状态切换仍然作用于其他页。',
  ],
  'sts.by.state': ['By state', '按状态看'],
  'sts.by.dir': ['By direction', '按方向看'],
  'sts.when': ['When it shows', '什么时候出现'],
  'sts.shut': ['Dock', '底栏'],
  'sts.arch': ['Include the {n} archived directions', '包含 {n} 个废案'],
  'sts.ev': ['Try:', '试一下：'],
  'sts.ev.join': ['A friend joins', '朋友加入'],
  'sts.ev.seal': ['You tap the shutter', '你按快门'],
  'sts.ev.reveal': ['Sunday 8 PM', '周日 8 点揭晓'],
  'sts.ev.reset': ['Reset', '重置'],
  'sts.retryToast': ['In the app, this reloads the capsule.', '在 App 里，这会重新读取这一期。'],
  'sts.when.collect': [
    'A capsule is open and you still have moments left this week.',
    '这一期正在收集，你本周还有额度。',
  ],
  'sts.when.loading': [
    'While the app fetches the current capsule for this group.',
    '正在读取这个小组当前这一期的时候。',
  ],
  'sts.when.empty': [
    'The group has no current capsule (the server returns NotFound).',
    '小组目前没有进行中的这一期（服务端返回 NotFound）。',
  ],
  'sts.when.error': [
    'The capsule could not be loaded (RecoverableFailure); the member can try again.',
    '这一期读取失败（RecoverableFailure），可以重试。',
  ],
  'sts.when.denied': [
    'The member is no longer in the group (MembershipDenied).',
    '成员已经不在这个小组了（MembershipDenied）。',
  ],
  'sts.when.quota': [
    'The member has used all 5 moments or 30 seconds this week.',
    '本周 5 个片段或 30 秒已经用完。',
  ],
  'sts.when.developing': [
    'The capsule has closed and the film is being put together (compiling).',
    '这一期已经结束，影片正在合成（compiling）。',
  ],
  'sts.when.delayed': [
    'Putting the film together is taking longer than usual (delayed).',
    '影片合成比平时慢（delayed）。',
  ],
  'sts.when.released': [
    'The film is published; everyone can watch it together for 24 hours.',
    '影片已经发布，所有人可以在 24 小时内一起看。',
  ],
  'sts.shut.collect': [
    'Pill: time left and moments left. The shutter adds a moment.',
    '胶囊：剩余时间和剩余条数；快门添加片段。',
  ],
  'sts.shut.loading': [
    'Pill only; the shutter appears once it loads.',
    '只有胶囊，读取完才出现快门。',
  ],
  'sts.shut.empty': ['Pill only; there is nothing to add to.', '只有胶囊，没有可以添加的这一期。'],
  'sts.shut.error': ['Pill only; Try again is on the page.', '只有胶囊，重试按钮在页面里。'],
  'sts.shut.denied': [
    'No dock: chat and archive belong to the group too.',
    '不显示底栏：聊天和档案也属于这个小组。',
  ],
  'sts.shut.quota': [
    'The pill turns warm and says “All 5 used · resets Sunday” for a few seconds, then settles on “resets Sun”. The shutter is grey with a full ring; tapping it gives a small shake and the pill says it again.',
    '胶囊变暖色，显示“All 5 used · resets Sunday”几秒，再收回成“resets Sun”。快门变灰、外圈满格，点一下会左右轻晃，胶囊再提示一次。',
  ],
  'sts.shut.developing': ['Pill says developing; no shutter.', '胶囊显示 developing，没有快门。'],
  'sts.shut.delayed': ['Pill says developing; no shutter.', '胶囊显示 developing，没有快门。'],
  'sts.shut.released': [
    'The shutter becomes “watch together”; the pill shows the time left; Archive gets a dot.',
    '快门变成“一起看”，胶囊显示剩余时间，档案页签出现小红点。',
  ],
});

// 定稿：Warm Glass
Object.assign(I18N, {
  'main.k': ['HOME · FINAL DIRECTION', 'HOME · 定稿方向'],
  'main.h1': ['Warm Glass', '暖光玻璃'],
  'main.p': [
    'Chosen after the reviews. The other ten directions are archived at the bottom.',
    '评审后选定。其余 10 个方向收在页面最下面。',
  ],
  'group.keep': ['Chosen', '选定方向'],
  'arch.toggle': ['Show the 10 archived directions', '显示 10 个废案'],
});

// 底栏图标页
Object.assign(I18N, {
  'tab.dock': ['Dock icons', '底栏图标'],
  'dv.k': ['DOCK · ICONS', '底栏 · 图标'],
  'dv.h1': ['Try icons in the dock', '试试底栏图标'],
  'dv.p': ['Pick a set below; the phones update.', '选下面的一套，手机里的底栏会跟着换。'],
  'dv.closed': ['Collapsed', '收起'],
  'dv.open': ['Expanded', '展开'],
  'dv.zoom': ['Close-up', '特写'],
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
