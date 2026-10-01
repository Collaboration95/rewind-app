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
  'state.label': ['Home', '首页'],
  'state.collect': ['Collecting', '收集中'],
  'state.empty': ['No capsule · owner', '没有这一期 · 组长'],
  'state.error': ['Failed to load', '加载失败'],
  'state.released': ['Premiere (24 hours)', '首映（24 小时）'],
  'state.quota': ['5 moments used', '5 段用完'],
  'state.hint': [
    'The states follow the Home on dev. The copy is a draft. Play returns to collecting.',
    '状态与 dev 上的首页对应，文案是草稿。点“播放”会回到收集中。',
  ],
  'zoom.label': ['Zoom', '缩放'],
  play: ['Play', '播放'],
  'play.title': ['Reset this phone and play from the start', '重置这台手机并从头播放'],
  'step.1': ['① You add a moment', '① 你按快门，封存一段'],
  'step.2': ['② The 4 weeks end · the film premieres', '② 4 周结束，影片首映'],
  'step.done': ['Done · press Play to run it again', '播放完毕 · 再点“播放”重新开始'],
  'shutter.label': ['Shutter', '快门'],
  'shutter.collect': ['Collecting', '收集中'],
  'shutter.quota': ['Allowance used up', '额度用完'],
  'shutter.upload': ['Uploading', '上传中'],
  'shutter.sealed': ['Just sealed', '刚封存'],
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
    '<b>Play</b>, above the phone: add a moment, then the film premieres',
    '手机上方的<b>播放</b>：封存一段，然后影片首映',
  ],
  'tap.shutter': ['<b>Shutter</b>: record a moment', '<b>快门</b>：录一段视频'],
  'tap.avatar': ['<b>Avatar</b>: settings', '<b>头像</b>：设置'],
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
    'Every state of the Home in one place. They follow dev; the copy is a draft. The buttons play events on the Collecting phone; the sidebar switch still sets the state on the Home tab.',
    '首页的所有状态放在一起看，和 dev 对应，文案是草稿。上面的按钮作用在“收集中”那台手机上；侧栏里的状态切换仍然作用于首页标签。',
  ],
  'sts.shut': ['Dock', '底栏'],
  'sts.ev': ['Try:', '试一下：'],
  'sts.ev.seal': ['You add a moment', '你封存一段'],
  'sts.ev.reveal': ['The 4 weeks end', '4 周结束'],
  'sts.ev.reset': ['Reset', '重置'],
  'sts.retryToast': ['In the app, this reloads the capsule.', '在 App 里，这会重新读取这一期。'],
  'sts.when.collect': [
    'A cycle is open and you still have moments left this week.',
    '这一期正在收集，你本周还有额度。',
  ],
  'sts.when.empty': [
    'The group has no current cycle (NotFound), seen by the owner.',
    '小组目前没有进行中的这一期（NotFound），组长看到的样子。',
  ],
  'sts.when.error': [
    'The cycle could not be loaded (RecoverableFailure); try again.',
    '这一期读取失败（RecoverableFailure），可以重试。',
  ],
  'sts.when.denied': [
    'You are no longer in the group (MembershipDenied).',
    '你已经不在这个小组了（MembershipDenied）。',
  ],
  'sts.when.quota': ['You have used all 5 moments this week.', '本周 5 段已经用完。'],
  'sts.when.developing': [
    'The 4 weeks have ended and the film is being put together; the next cycle has already started.',
    '4 周结束，影片正在合成；下一期已经开始。',
  ],
  'sts.when.delayed': [
    'Putting the film together is taking longer than usual (delayed).',
    '影片合成比平时慢（delayed）。',
  ],
  'sts.when.released': [
    'The film premieres for 24 hours; everyone watches it when they like. The next cycle has started.',
    '影片首映 24 小时，大家各自找时间看；下一期已经开始。',
  ],
  'sts.shut.collect': [
    'Three tabs and the shutter; its ring shows this week’s moments.',
    '三个页签和快门；快门外圈显示本周已用的段数。',
  ],
  'sts.shut.empty': ['Tabs only; the owner can start a cycle.', '只有页签；组长可以开始这一期。'],
  'sts.shut.error': ['Tabs only; Try again is on the page.', '只有页签，重试按钮在页面里。'],
  'sts.shut.denied': [
    'No dock: chat and archive belong to the group too.',
    '不显示底栏：聊天和档案也属于这个小组。',
  ],
  'sts.shut.quota': [
    'The shutter is grey with a full ring; tapping it shakes it and says when it resets.',
    '快门变灰、外圈满格；点一下会轻晃，并提示几天后重置。',
  ],
  'sts.shut.developing': ['As usual: the new cycle is open.', '照常：新一期已经开放。'],
  'sts.shut.delayed': ['As usual: the new cycle is open.', '照常：新一期已经开放。'],
  'sts.shut.released': [
    'As usual: the new cycle is open. Archive gets a dot.',
    '照常：新一期已经开放；档案页签出现小红点。',
  ],
  'tab.dock': ['Dock icons', '底栏图标'],
  'dv.k': ['DOCK · ICONS', '底栏 · 图标'],
  'dv.h1': ['Try icons in the dock', '试试底栏图标'],
  'dv.p': ['Pick a set below; the phone updates.', '选下面的一套，手机里的底栏会跟着换。'],
  'dv.zoom': ['Close-up', '特写'],
  'tab.screens': ['Screens', '画面'],
  'scr.k': ['BEYOND HOME', '首页以外'],
  'scr.h1': ['Sign in, settings, capture and the film', '登录、设置、拍摄和影片'],
  'scr.p': [
    'Each flow follows the dev docs. Every phone can be tapped through; on the Home tab, the avatar, the shutter, your allowance and the premiere card open these too.',
    '每个流程都对应 dev 的文档，每台手机都能接着点。在首页标签里点头像、快门、额度那一行或首映卡片，也会进到这些画面。',
  ],
  'scr.set': ['Settings', '设置'],
  'scr.set.p': [
    'From the avatar. Only the owner renames the group, picks the prompt and invites; a full group (10 of 10) can’t invite.',
    '点头像进入。只有组长能改组名、选题目、发邀请；满 10 人时不能邀请。',
  ],
  'scr.set.main': ['Settings · owner', '设置 · 组长'],
  'scr.set.invite': ['Invite a friend', '邀请朋友'],
  'scr.video': ['Record a moment', '录一段'],
  'scr.video.p': [
    'Video only, up to 15 seconds, within 5 moments and 30 seconds a week. Trim it, then seal; the upload can be cancelled.',
    '只录视频，单段最长 15 秒，一周 5 段、共 30 秒。剪一下再封存，上传时可以取消。',
  ],
  'scr.video.view': ['Viewfinder', '取景'],
  'scr.video.rec': ['Recording', '录制中'],
  'scr.video.review': ['Trim and pick a look', '剪辑、选效果'],
  'scr.video.sealed': ['Sealed', '封存好了'],
  'scr.film': ['The film', '影片'],
  'scr.film.p': [
    'From the premiere card. It plays straight away and premieres for 24 hours; everyone watches when they like. Gaps may be filled from the archive.',
    '点首映卡片进入。直接开始播放，首映 24 小时，大家各自找时间看；片子太短时会用旧片段补位。',
  ],
  'scr.film.play': ['Playing', '播放中'],
  'scr.film.end': ['The end', '片尾'],
  'scr.set.join': ['Join with a code', '输入邀请码加入'],
  'scr.set.create': ['New group', '新建小组'],
  'scr.toast.share': [
    'In the app, this opens the share sheet with the invite link.',
    '在 App 里，这会打开系统分享，发出邀请链接。',
  ],
  'scr.toast.link': ['Invitation link copied.', '邀请链接已复制。'],
  'scr.toast.code': ['Invitation code copied.', '邀请码已复制。'],
  'scr.toast.out': [
    'In the app, this ends Demo access and returns to the start.',
    '在 App 里，这会结束演示并回到开始页。',
  ],
  'scr.toast.created': ['Created “{name}”.', '已创建“{name}”。'],
  'scr.toast.remOn': [
    'Sunday 7 PM reminders are on for this device.',
    '这台设备的周日晚 7 点提醒已打开。',
  ],
  'scr.toast.remOff': ['Sunday 7 PM reminders are off.', '周日晚 7 点提醒已关闭。'],
  'state.secs': ['30 seconds used', '30 秒用完'],
  'state.failed': ['A moment failed', '有一段没处理好'],
  'state.waiting': ['No capsule · member', '没有这一期 · 组员'],
  'tap.mine': [
    '<b>Your allowance</b>, in the prompt card: your moments',
    '题目卡片里的<b>额度</b>：你的片段',
  ],
  'sts.when.secs': [
    'You have used all 30 seconds this week, with moments still left.',
    '本周 30 秒已经用完，段数还没用完。',
  ],
  'sts.when.failed': ['One of your moments could not be processed.', '你的某一段没有处理成功。'],
  'sts.when.waiting': ['The same, seen by a member.', '同样的情况，组员看到的样子。'],
  'sts.shut.secs': [
    'Same as 5 moments used, with a note about the seconds.',
    '和 5 段用完一样，提示改成秒数用完。',
  ],
  'sts.shut.failed': ['As usual; Retry is on the card.', '照常；重试在卡片里。'],
  'sts.shut.waiting': ['Tabs only.', '只有页签。'],
  'scr.signin': ['Sign in', '登录'],
  'scr.signin.p': [
    'One Sign in button for the Rewind account (OIDC). Pull up for test users during the demo.',
    '一个“Sign in”按钮，用 Rewind 账号（OIDC）登录。演示时上拉可以选测试用户。',
  ],
  'scr.signin.main': ['Sign in', '登录'],
  'scr.signin.users': ['Test users', '测试用户'],
  'scr.set.prompt': ['Prompt (owner)', '题目（组长）'],
  'scr.mine': ['Your moments', '你的片段'],
  'scr.mine.p': [
    'From the allowance in the prompt card. Only when and how long; once a week you can delete one and retake it.',
    '点题目卡片里的额度进入。只看得到时间和长度；每周可以删一段重拍。',
  ],
  'scr.mine.list': ['This week', '本周'],
  'scr.mine.confirm': ['Delete and retake', '删除并重拍'],
  'scr.video.perm': ['Camera and mic', '相机和麦克风'],
  'scr.video.upload': ['Uploading', '上传中'],
  'scr.film.filler': ['From the archive', '旧片段补位'],
  'scr.toast.cancel': [
    'Upload cancelled. Your moment is still here to seal.',
    '已取消上传，这一段还在，可以再封存。',
  ],
  'scr.toast.oidc': [
    'In the app, this opens Rewind sign-in.',
    '在 App 里，这会打开 Rewind 登录页。',
  ],
  'scr.toast.as': ['Signed in as {name} (test user).', '已用测试用户 {name} 登录。'],
  'scr.toast.saved': ['Saved.', '已保存。'],
  'scr.toast.snoozed': ['Snoozed until next Sunday.', '已推迟到下周日。'],
  'scr.toast.unsnoozed': ['Reminder is back on for this Sunday.', '本周日的提醒恢复了。'],
  'scr.toast.deleted': [
    'Deleted. Its seconds are back for this week.',
    '已删除，这段的秒数退回本周额度。',
  ],
  'scr.toast.save.film': [
    'In the app, this saves the film to your phone.',
    '在 App 里，这会把影片存到手机。',
  ],
  'scr.toast.save.mine': [
    'In the app, this saves your own processed moments.',
    '在 App 里，这会保存你自己处理后的片段。',
  ],
  'scr.toast.chat': ['In the app, this opens Chat.', '在 App 里，这会打开聊天。'],
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
