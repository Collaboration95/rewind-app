'use strict';

// 界面文案：每条是 [英文, 中文]
const I18N = {
  'doc.title': ['Rewind Home · Warm Glass', 'Rewind 首页 · 暖光玻璃'],
  'tab.home': ['Home', '首页'],
  'dv.phone': ['On the Home', '首页里'],
  'side.aria': ['Design controls', '设计控制'],
  'brand.sub': ['Home · Warm Glass', '首页 · 暖光玻璃'],
  'lang.aria': ['Language', '语言'],
  'members.label': ['People in the group', '小组人数'],
  'members.unit': ['{n} people', '{n} 人'],
  shuffle: ['Shuffle', '随机贡献'],
  restore: ['Reset sample', '恢复示例'],
  'members.hint': [
    'Home shows only who is in, never how many moments someone else added. “Empty spot” follows Reveal, so nobody gets called out. The demo has 5 people.',
    '首页只显示谁参与了，不显示别人各发了几条。“显示为空位”借鉴 Reveal，不点名、不给人压力。演示默认 5 人。',
  ],
  'anon.label': ['Friends who haven’t added a moment yet', '还没发片段的朋友'],
  'anon.hide': ['Empty spot', '显示为空位'],
  'anon.show': ['Show names', '显示名字'],
  'state.label': ['Home', '首页'],
  'state.collect': ['Collecting', '收集中'],
  'state.empty': ['No capsule yet', '这一期还没开始'],
  'state.error': ['Failed to load', '加载失败'],
  'state.released': ['Film released', '影片已上映'],
  'state.quota': ['Allowance used up', '额度用完'],
  'state.hint': [
    'The states follow the Home on dev: no capsule, failed to load, no access, the allowance and the reveal. The copy is a draft. Play returns to collecting.',
    '状态与 dev 上的首页一一对应：这一期还没开始、加载失败、没有权限、额度、揭晓。文案是草稿。点“播放”会回到收集中。',
  ],
  'zoom.label': ['Zoom', '缩放'],
  play: ['Play', '播放'],
  'play.title': ['Reset this phone and play from the start', '重置这台手机并从头播放'],
  'step.1': ['① A friend joins', '① 朋友加入'],
  'step.2': ['② You seal a moment', '② 你按快门，封存'],
  'step.3': ['③ Sunday 8 PM · everyone opens it', '③ 周日 8 点，一起揭晓'],
  'step.done': ['Done · press Play to run it again', '播放完毕 · 再点“播放”重新开始'],
  'shutter.label': ['Shutter', '快门'],
  'shutter.collect': ['Collecting', '收集中'],
  'shutter.quota': ['Allowance used up', '额度用完'],
  'shutter.upload': ['Sealing', '封存中'],
  'shutter.sealed': ['Just sealed', '刚封存'],
  'shutter.premiere': ['Premiere (24 hours)', '首映期（24 小时）'],
  unread: ['Chat has 3 unread', '聊天有 3 条未读'],
  'try.label': ['Things you can tap', '可以点的地方'],
  foot: [
    'Design simulation · abstract textures and generated photos only, no unrevealed media',
    '设计模拟 · 画面均为抽象纹理和生成图，不含任何未揭晓媒体',
  ],
  'main.k': ['HOME · FINAL DIRECTION', 'HOME · 定稿方向'],
  'main.h1': ['Warm Glass', '暖光玻璃'],
  'main.p': [
    'The Home screen and how it behaves. Tap around the phone.',
    '首页的设计和交互，可以直接在手机上点点看。',
  ],
  fonts: ['Type', '字体'],
  'group.label': ['The group', '小组'],
  'sim.label': ['Simulate', '模拟状态'],
  'hints.toggle': ['Show tap hints on the phones', '在手机上标出可以点的地方'],
  'tap.play': [
    '<b>Play</b>, above the phone: watch a whole cycle',
    '手机上方的<b>播放</b>：看完整的一期',
  ],
  'tap.shutter': ['<b>Shutter</b>: seal a moment', '<b>快门</b>：封存一个片段'],
  'tap.avatar': [
    '<b>Avatar</b>: profile and settings. A draft; it could become a full Settings page.',
    '<b>头像</b>：个人与设置。这是暂定效果，之后可以改成独立的 Settings 页。',
  ],
  'tap.dock': ['<b>Dock</b>: switch tabs', '<b>底栏</b>：切换页签'],
  'rv.copyFail': [
    'Couldn’t copy. Select the text and press Ctrl+C.',
    '复制失败，请选中文字按 Ctrl+C。',
  ],
  'tab.aria': ['Page', '页面'],
  'tab.mix': ['App icon · mix and match', 'App icon 搭配'],
  'mix.k': ['APP ICON · MIX AND MATCH', 'APP ICON · 自由搭配'],
  'mix.h1': ['Pick a Home and an icon', '选一个首页，配一个图标'],
  'mix.p': [
    'See them together where people will meet them: the home screen, the launch screen that opens into this Home, a notification and the colours side by side. Copy the link to share a pairing.',
    '把它们放进用户真正会遇到的地方一起看：手机桌面、打开 App 后从启动页过渡到这个首页、通知横幅，以及配色对照。复制链接就能把搭配分享出去。',
  ],
  'mix.dir': ['Home', '首页方向'],
  'mix.sp': ['Scratchpad skin', '草稿本皮肤'],
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
    'Placeholder: a plain fade for now. To explore later: the icon zooming open into the Home (as iOS does), or a quick rewind of the week’s frames.',
    '现在只是占位的淡出效果，之后再讨论怎么优化。可以考虑：图标放大展开成首页（类似 iOS 打开 App），或者快速倒放一遍这周的画面。',
  ],
  'mix.app.gmail': ['Gmail', 'Gmail'],
  'mix.app.maps': ['Maps', '地图'],
  'mix.app.chrome': ['Chrome', 'Chrome'],
  'mix.app.youtube': ['YouTube', 'YouTube'],
  'mix.app.whatsapp': ['WhatsApp', 'WhatsApp'],
  'mix.app.instagram': ['Instagram', 'Instagram'],
  'mix.app.spotify': ['Spotify', 'Spotify'],
  'mix.app.settings': ['Settings', '设置'],
  'mix.app.camera': ['Camera', '相机'],
  'mix.app.photos': ['Photos', '照片'],
  'mix.app.calendar': ['Calendar', '日历'],
  'state.denied': ['No access', '没有权限'],
  'state.developing': ['Film developing', '影片制作中'],
  'state.delayed': ['Taking longer', '比平时慢'],
  'tab.states': ['States', '状态'],
  'sts.k': ['HOME · STATES', 'HOME · 状态'],
  'sts.h1': ['Every Home state', '首页的各个状态'],
  'sts.p': [
    'Every state of the Home in one place. They follow the Home on dev; the copy is a draft. The buttons play events on the Collecting phone; the sidebar switch still sets the state on the Home tab.',
    '首页的所有状态放在一起看。状态与 dev 上的首页对应，文案是草稿。上面的按钮作用在“收集中”那台手机上；侧栏里的状态切换仍然作用于首页标签。',
  ],
  'sts.shut': ['Dock', '底栏'],
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
    'Three tabs and the shutter; its ring shows this week’s moments.',
    '三个页签和快门；快门外圈显示本周已用的条数。',
  ],
  'sts.shut.empty': ['Tabs only; there is nothing to add to.', '只有页签，没有可以添加的这一期。'],
  'sts.shut.error': ['Tabs only; Try again is on the page.', '只有页签，重试按钮在页面里。'],
  'sts.shut.denied': [
    'No dock: chat and archive belong to the group too.',
    '不显示底栏：聊天和档案也属于这个小组。',
  ],
  'sts.shut.quota': [
    'The shutter is grey with a full ring. Tapping it gives a small shake and a short note: “All 5 used · resets Sun”.',
    '快门变灰、外圈满格；点一下会左右轻晃，并短暂提示“All 5 used · resets Sun”。',
  ],
  'sts.shut.developing': [
    'Tabs only; no shutter while the film develops.',
    '只有页签，影片制作期间没有快门。',
  ],
  'sts.shut.delayed': [
    'Tabs only; no shutter while the film develops.',
    '只有页签，影片制作期间没有快门。',
  ],
  'sts.shut.released': [
    'No shutter: Watch together is on the page. Archive gets a dot.',
    '没有快门，“一起看”在正文里；档案页签出现小红点。',
  ],
  'tab.dock': ['Dock icons', '底栏图标'],
  'dv.k': ['DOCK · ICONS', '底栏 · 图标'],
  'dv.h1': ['Try icons in the dock', '试试底栏图标'],
  'dv.p': ['Pick a set below; the phone updates.', '选下面的一套，手机里的底栏会跟着换。'],
  'dv.zoom': ['Close-up', '特写'],
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
