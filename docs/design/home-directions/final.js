'use strict';

/* ---------- Final tab: every screen the user can reach, how they get there and where each action goes ----------
   The build spec. Each screen has a code (A1, H1…): the diagram, the phones and the action links use it.
   Phones are the same live renderers as the other tabs (subScreen in screens.js); two screens that only
   exist here (launch, lock screen) are drawn below. */

// One flow per row. A step: [code, kind, opts, title, via, actions, notes]
// via: what the user did to land here. actions: [what they do, code it goes to (or '' for staying put)].
const FINAL = [
  {
    k: 'A',
    title: 'Open the app',
    p: 'Level 0 and 1: the first thing anyone sees, signed out or in.',
    steps: [
      [
        'A1',
        'splash',
        {},
        'Launch',
        'Tap the Rewind icon',
        [
          ['Saved session, has a group', 'H1'],
          ['Saved session, no group yet', 'D1'],
          ['No session on this device', 'A2'],
          ['Session expired', 'A3'],
          ['Opened from an invite link', 'A4'],
        ],
        [
          'Only the app icon and the name on cream. No buttons, no spinner at first.',
          'Shows while the saved session is checked: at least 0.6 s so it never flashes, then fades out (0.5 s, scales to 1.04) into the next screen.',
          'Still checking after 2 s: a small “Opening…” line fades in under the name.',
          'Offline with a saved session: go to Home from the cache and show the Offline pill. Never block on the network.',
          'Never creates a Demo session by itself.',
        ],
      ],
      [
        'A2',
        'signin',
        {},
        'Welcome',
        'No session',
        [
          ['Sign in', 'B1'],
          ['Create an account', 'C1'],
          ['Pull up Try Demo', 'A5'],
        ],
        [
          'The icon and name sit where the launch screen had them, so the fade feels like one screen.',
          'Try Demo is a separate bottom sheet, never mixed into the real sign-in.',
          'This is the root when signed out: no Back, swipe-back does nothing.',
        ],
      ],
      [
        'A3',
        'signin',
        { step: 'expired' },
        'Signed out',
        'The server rejects the saved session',
        [['Sign in', 'B1']],
        [
          'The banner says why. After signing in, return to the group and tab they were on.',
          'Unsent chat text is kept on the device and put back.',
        ],
      ],
      [
        'A4',
        'signin',
        { step: 'invite' },
        'Invite link',
        'Open an invite link while signed out',
        [
          ['Sign in to join', 'B1'],
          ['Create an account to join', 'C1'],
          ['After either one', 'D4'],
        ],
        [
          'The invite is stored before sign-in and used right after, so it survives both sign-in and sign-up.',
          'Invite expired, used or the group is full: the card says so and has no join; after sign-in they land on their own Home.',
          'Already signed in: the link skips this and opens D4 (or the error on D3).',
          'No Try Demo sheet here.',
        ],
      ],
      [
        'A5',
        'signin',
        { step: 'demo' },
        'Try Demo',
        'Pull up the sheet on Welcome',
        [
          ['Pick a member', 'H1'],
          ['Drag the sheet down', 'A2'],
        ],
        [
          'Members are labelled synthetic. Demo data stays on this device.',
          'In a Demo session, Settings adds a Demo section (S13, S14).',
        ],
      ],
    ],
  },
  {
    k: 'B',
    title: 'Sign in',
    p: 'Email, phone or username, and a password.',
    steps: [
      [
        'B1',
        'signin',
        { step: 'form' },
        'Sign in',
        'Sign in on Welcome',
        [
          ['Correct, has a group', 'H1'],
          ['Correct, no group', 'D1'],
          ['Wrong details', 'B2'],
          ['No connection', 'B3'],
          ['Reset it', 'B4'],
          ['Create an account', 'C1'],
          ['Back', 'A2'],
        ],
        [
          'The first field is focused. Return moves to the password, Return again signs in.',
          'While waiting the button reads “Signing in…” and the form is locked.',
          'Coming from an invite (A4): after signing in go to D4, not Home.',
        ],
      ],
      [
        'B2',
        'signin',
        { step: 'wrong' },
        'Wrong details',
        'The server says no',
        [['Fix and sign in again', 'B1']],
        [
          'One message for both fields: never say which one was wrong.',
          'The password is cleared, the username kept.',
          'Too many tries: “Too many tries. Wait a minute and try again.”',
        ],
      ],
      [
        'B3',
        'signin',
        { step: 'offline' },
        'Offline',
        'No connection when signing in',
        [['Sign in again once connected', 'B1']],
        ['Nothing is sent. The button works again as soon as the connection is back.'],
      ],
      [
        'B4',
        'signin',
        { step: 'forgot' },
        'Reset password',
        'Reset it, under the form',
        [
          ['Send code', 'C3'],
          ['Cancel, or tap outside', 'B1'],
        ],
        [
          'A dialog over the form.',
          'Always says a code was sent, even when no account matches, so it never reveals who has an account.',
          'After the code: a New password screen like C5 without the name, then H1.',
        ],
      ],
    ],
  },
  {
    k: 'C',
    title: 'Create an account',
    p: 'Email or phone, a 6-digit code, then a name and password.',
    steps: [
      [
        'C1',
        'signin',
        { step: 'up' },
        'Create account',
        'Create an account',
        [
          ['Send code', 'C3'],
          ['Email already used', 'C2'],
          ['Sign in instead', 'B1'],
          ['Back', 'A2'],
        ],
        [
          'Email or Phone tab. Phone has a country code (default +65).',
          'The format is checked before sending.',
        ],
      ],
      [
        'C2',
        'signin',
        { step: 'upbad' },
        'Already used',
        'The email or phone has an account',
        [['Sign in instead', 'B1']],
        ['Sign in instead carries the email over into B1.'],
      ],
      [
        'C3',
        'signin',
        { step: 'upcode' },
        'Enter the code',
        'Send code',
        [
          ['Right code', 'C5'],
          ['Wrong code', 'C4'],
          ['Send a new code (after 0:30)', ''],
          ['Back', 'C1'],
        ],
        [
          'Continues by itself when the 6th digit is typed; iOS offers the code from Messages or Mail.',
          'A code lasts 10 minutes. Send a new code unlocks after 30 s.',
        ],
      ],
      [
        'C4',
        'signin',
        { step: 'upcodebad' },
        'Wrong code',
        'The code doesn’t match',
        [
          ['Type it again', 'C3'],
          ['Send a new code', 'C3'],
        ],
        ['The field is kept so they can fix one digit.'],
      ],
      [
        'C5',
        'signin',
        { step: 'upname' },
        'About you',
        'Right code',
        [
          ['Create account', 'D1'],
          ['Create account, from an invite', 'D4'],
        ],
        [
          'The group sees the name (up to 40 characters).',
          'Password at least 8 characters; too short says so under the field.',
        ],
      ],
    ],
  },
  {
    k: 'D',
    title: 'Get into a group',
    p: 'Everything in Rewind belongs to a group. Without one there is only this.',
    steps: [
      [
        'D1',
        'home',
        { home: 'nogroup' },
        'No group yet',
        'Signed in without a group',
        [
          ['Join with a code', 'D2'],
          ['Create a group', 'D5'],
          ['Avatar', 'S1'],
        ],
        [
          'No dock: Chat, Archive and the shutter all belong to a group.',
          'The header says Rewind instead of a group name.',
        ],
      ],
      [
        'D2',
        'settings',
        { step: 'join', back: 'close' },
        'Have an invite?',
        'Join with a code',
        [
          ['Accept invitation', 'D4'],
          ['Code doesn’t work', 'D3'],
          ['Back', 'D1'],
        ],
        [
          '8 characters; spaces and case don’t matter, shown as XXXX XXXX.',
          'Pasting the whole invite link works too.',
        ],
      ],
      [
        'D3',
        'settings',
        { step: 'join', back: 'close', joinErr: 'expired' },
        'Code doesn’t work',
        'Unknown, expired, used or full',
        [['Fix the code', 'D2']],
        ['Four messages: unknown, expired, already used, group full. Each says what to do next.'],
      ],
      [
        'D4',
        'settings',
        { step: 'joined' },
        'Joined',
        'The code worked',
        [['Go to the group', 'H1']],
        [
          'Joining mid-cycle: Home shows the current week, and their own allowance starts at 5.',
          'The code is now used up.',
        ],
      ],
      [
        'D5',
        'settings',
        { step: 'create', back: 'close' },
        'New group',
        'Create a group',
        [
          ['Create group', 'H1'],
          ['Back', 'D1'],
        ],
        [
          'Name is required (up to 80). Pick a prompt or write one (up to 160).',
          'You are the owner; week 1 starts today. Next step for an owner: invite friends (S4).',
        ],
      ],
    ],
  },
  {
    k: 'H',
    title: 'Home',
    p: 'The hub. Every state of it, and what the dock does in each.',
    steps: [
      [
        'H1',
        'home',
        {},
        'Home',
        'Signed in with a group',
        [
          ['Shutter', 'V1'],
          ['Your allowance row', 'M1'],
          ['Group name', 'G1'],
          ['Avatar', 'S1'],
          ['Chat tab', 'T1'],
          ['Archive tab', 'R1'],
        ],
        [
          'Days until the film, week of 4, the prompt, your allowance (5 moments, 30 s) and this week’s moments as metadata only.',
          'Only your own moments: no group totals and no one else’s progress.',
          'Refreshes on pull-down and whenever the app comes back to the front.',
          'After sealing: the allowance row rolls (0.7 s) and the shutter shows “Sealed” for 1.9 s.',
        ],
      ],
      [
        'H2',
        'home',
        { home: 'quota' },
        '5 moments used',
        'The 5th moment is sealed',
        [
          ['Grey shutter', ''],
          ['Your allowance row', 'M1'],
        ],
        [
          'The shutter is grey with a full ring. Tapping it shakes it and shows “All 5 used · resets in 3 days”.',
          'Your moments still opens: deleting one (once a week) frees a slot.',
        ],
      ],
      [
        'H3',
        'home',
        { home: 'secs' },
        '30 seconds used',
        'The seconds ran out first',
        [['Grey shutter', '']],
        ['As H2, with a note about the seconds. With under 3 s left, Photo is off in the camera.'],
      ],
      [
        'H4',
        'home',
        { home: 'failed' },
        'A moment didn’t finish',
        'An upload failed after the camera closed',
        [
          ['Retry', 'H1'],
          ['Your allowance row', 'M2'],
        ],
        [
          'The card stays until it is retried or deleted. The moment is pending, not sealed.',
          'Retrying happens in the background; the card goes away when it is sealed.',
        ],
      ],
      [
        'H5',
        'home',
        { home: 'developing' },
        'Film developing',
        'The 4 weeks ended',
        [['Shutter', 'V1']],
        [
          'The next cycle has already started (week 1) and the shutter works.',
          'The card shows the film is being made.',
        ],
      ],
      [
        'H6',
        'home',
        { home: 'delayed' },
        'Taking longer',
        'The film isn’t ready 2 hours after the cycle ended',
        [['Shutter', 'V1']],
        ['Everyone gets a notification when it’s ready (N1).'],
      ],
      [
        'H7',
        'home',
        { home: 'released' },
        'Premiere',
        'The film is ready',
        [
          ['Watch', 'F1'],
          ['Archive tab (has a dot)', 'R2'],
          ['Chat tab', 'T10'],
        ],
        [
          'The premiere lasts 24 hours; the card counts down. Archive has a dot until opened.',
          'After 24 hours the card goes away and the film stays in Archive.',
        ],
      ],
      [
        'H8',
        'home',
        { home: 'empty' },
        'No capsule · owner',
        'The group has no running cycle',
        [['Start a capsule', 'H1']],
        ['No shutter. Starting begins week 1 today for everyone.'],
      ],
      [
        'H9',
        'home',
        { home: 'waiting' },
        'No capsule · member',
        'The group has no running cycle',
        [['Group name', 'G1']],
        ['Members can only wait for the owner. No shutter.'],
      ],
      [
        'H10',
        'home',
        { home: 'error' },
        'Couldn’t load',
        'The summary failed to load',
        [['Try again', 'H1']],
        ['No shutter until it loads. Chat and Archive tabs still work.'],
      ],
      [
        'H11',
        'home',
        { home: 'denied' },
        'Not in this group',
        'Removed, or the group is gone',
        [['Choose another group', 'G2']],
        ['No dock at all. If they have no other group, choosing leads to D1.'],
      ],
    ],
  },
  {
    k: 'V',
    title: 'Add a moment · video',
    p: 'Shutter → record up to 15 s → trim and pick a look → seal.',
    steps: [
      [
        'V1',
        'camera',
        { step: 'perm' },
        'Allow camera and mic',
        'Shutter, the first time',
        [
          ['Allow → the system prompt says yes', 'V3'],
          ['The system prompt says no', 'V2'],
          ['Close', 'H1'],
        ],
        ['Ask only when the camera is first opened, never at sign-up.'],
      ],
      [
        'V2',
        'camera',
        { step: 'denied' },
        'Camera is off',
        'Permission blocked',
        [
          ['Try again', 'V3'],
          ['Not now', 'H1'],
        ],
        [
          'Browsers can’t show the prompt again once blocked, so say where the switch is.',
          'Try again checks once more and stays here if it is still off.',
        ],
      ],
      [
        'V3',
        'camera',
        {},
        'Viewfinder',
        'Shutter, with permission',
        [
          ['Shutter', 'V4'],
          ['Photo', 'P1'],
          ['Lock count', 'M1'],
          ['Close', 'H1'],
        ],
        [
          'The pill shows moments and seconds left this week. Longest video = 15 s or the seconds left, whichever is less.',
          'Remembers Video or Photo from last time.',
        ],
      ],
      [
        'V4',
        'camera',
        { step: 'rec', t: 6 },
        'Recording',
        'Shutter',
        [['Tap again, or reach the limit', 'V5']],
        [
          'The ring fills over 15 s and stops by itself at the limit.',
          'Leaving the app stops recording and keeps what was taken.',
          'Under 1 s is thrown away: “Hold a little longer.”',
        ],
      ],
      [
        'V5',
        'camera',
        { step: 'review' },
        'Review · trim · look',
        'Recording stops',
        [
          ['Seal', 'V6'],
          ['Retake', 'V3'],
        ],
        [
          'Plays on a loop, muted until tapped. Trim handles, 1 s minimum.',
          'Looks: Original, Soft focus, High contrast.',
          'Closing here asks “Discard this video?”.',
        ],
      ],
      [
        'V6',
        'camera',
        { step: 'upload', pct: 42 },
        'Uploading',
        'Seal',
        [
          ['Upload finishes', 'V8'],
          ['Upload fails', 'V7'],
          ['Cancel', 'V5'],
        ],
        ['Cancel keeps the moment in review; it isn’t counted until sealed.'],
      ],
      [
        'V7',
        'camera',
        { step: 'upfail', pct: 64 },
        'Upload failed',
        'No connection mid-upload',
        [
          ['Retry', 'V6'],
          ['Back to review', 'V5'],
          ['Close', 'H4'],
        ],
        ['Closing the camera now leaves the moment pending: Home shows H4.'],
      ],
      [
        'V8',
        'camera',
        { step: 'sealed' },
        'Sealed',
        'Upload finishes',
        [
          ['Tell the group', 'T7'],
          ['Done', 'H1'],
        ],
        [
          'From now on nobody sees it before the film, not even you.',
          'Tell the group sends only words; the moment stays sealed.',
        ],
      ],
    ],
  },
  {
    k: 'P',
    title: 'Add a moment · photo',
    p: 'A photo counts as one moment and 3 s of the film. After Seal it uses the same upload and sealed screens.',
    steps: [
      [
        'P1',
        'camera',
        { mode: 'photo' },
        'Photo',
        'Photo, in the viewfinder',
        [
          ['Shutter', 'P2'],
          ['Video', 'V3'],
        ],
        ['Off when under 3 s are left this week, with the reason under the shutter.'],
      ],
      [
        'P2',
        'camera',
        { mode: 'photo', step: 'review' },
        'Photo review',
        'Shutter',
        [
          ['Seal', 'V6'],
          ['Retake', 'P1'],
        ],
        ['No trim or look for photos.'],
      ],
    ],
  },
  {
    k: 'M',
    title: 'Your moments',
    p: 'Metadata only. Delete one and retake it, once a week.',
    steps: [
      [
        'M1',
        'mine',
        {},
        'Your moments',
        'Allowance row on Home, or the lock count in the camera',
        [
          ['Tap a moment', 'M3'],
          ['Back', 'H1'],
        ],
        ['Type, day and length only. Always the same numbers as Home.'],
      ],
      [
        'M2',
        'mine',
        { home: 'failed' },
        'One didn’t finish',
        'An upload failed',
        [
          ['Retry', 'M1'],
          ['Delete', 'M3'],
        ],
        ['Deleting an unfinished moment doesn’t use the weekly delete.'],
      ],
      [
        'M3',
        'mine',
        { step: 'confirm' },
        'Delete?',
        'Tap a moment',
        [
          ['Delete', 'M4'],
          ['Keep it, or tap outside', 'M1'],
        ],
        ['Its seconds go back to the week.'],
      ],
      [
        'M4',
        'mine',
        { step: 'done' },
        'Deleted',
        'Delete',
        [
          ['Retake now', 'V3'],
          ['Back', 'H1'],
        ],
        ['The other rows are locked until the weekly reset.'],
      ],
    ],
  },
  {
    k: 'G',
    title: 'Switch group',
    p: 'The menu under the group name, on Home, Chat and Archive.',
    steps: [
      [
        'G1',
        'home',
        { menu: true },
        'Group menu',
        'Group name',
        [
          ['Another group', 'H1'],
          ['Have an invite?', 'D2'],
          ['Create a group', 'D5'],
          ['Tap outside', 'H1'],
        ],
        [
          'Drops from the group name (0.22 s). Other groups show their unread count.',
          'Switching keeps the tab you were on and loads that group’s cycle, chat and archive.',
        ],
      ],
      [
        'G2',
        'home',
        { home: 'denied', menu: true },
        'Menu, not in the group',
        'Choose another group',
        [['Another group', 'H1']],
        ['The group you were removed from is gone from the list.'],
      ],
    ],
  },
  {
    k: 'S',
    title: 'Settings',
    p: 'From the avatar on any tab. The owner manages the group; everyone manages their reminder and account.',
    steps: [
      [
        'S1',
        'settings',
        {},
        'Settings',
        'Avatar',
        [
          ['Group name', 'S2'],
          ['Prompt', 'S3'],
          ['Invite friends', 'S4'],
          ['Switch group', 'S7'],
          ['Turn the reminder on', 'S10'],
          ['Time', 'S8'],
          ['Sign out', 'S12'],
          ['Back', 'H1'],
        ],
        [
          'Back returns to the tab the avatar was tapped on.',
          'Snooze this week and Send a test reminder act in place with a toast.',
        ],
      ],
      [
        'S2',
        'settings',
        { step: 'rename' },
        'Group name',
        'Owner taps Group name',
        [['Save', 'S1']],
        ['Required, up to 80 characters. Everyone sees the new name at once.'],
      ],
      [
        'S3',
        'settings',
        { step: 'prompt' },
        'Prompt',
        'Owner taps Prompt',
        [['Save', 'S1']],
        ['Applies to this cycle for everyone, on Home.'],
      ],
      [
        'S4',
        'settings',
        { step: 'invite' },
        'Invite friends',
        'Owner taps Invite friends',
        [
          ['Share invite link', ''],
          ['Copy link or code', ''],
        ],
        [
          'Share opens the system share sheet. A code works once and expires in 24 hours.',
          'The link opens A4 for someone signed out, D4 for someone signed in.',
        ],
      ],
      [
        'S5',
        'settings',
        { size: 10 },
        'Group is full',
        '10 of 10 members',
        [['Invite friends is off', '']],
        ['The row stays visible but greyed, with “The group is full · 10 of 10”.'],
      ],
      [
        'S6',
        'settings',
        { asMember: true },
        'As a member',
        'Not the owner',
        [['Switch group', 'S7']],
        ['The prompt is read-only. No name, prompt or invite controls.'],
      ],
      [
        'S7',
        'settings',
        { step: 'groups' },
        'Switch group',
        'Switch group',
        [
          ['Another group', 'S1'],
          ['Have an invite?', 'D2'],
          ['Create a group', 'D5'],
        ],
        ['Same list as the group menu (G1).'],
      ],
      [
        'S8',
        'settings',
        { step: 'time' },
        'Reminder time',
        'Time',
        [['Pick a time', 'S1']],
        ['Four presets. Saved as soon as one is picked, with a toast.'],
      ],
      [
        'S9',
        'settings',
        { step: 'time', own: true },
        'Custom time',
        'Custom time',
        [['Pick a time', 'S1']],
        ['5-minute steps. Sundays, in the group’s time zone.'],
      ],
      [
        'S10',
        'settings',
        { step: 'notify' },
        'Allow notifications',
        'Turn the reminder on, the first time',
        [
          ['Continue → browser prompt', 'S1'],
          ['Not now', 'S1'],
          ['On iPhone', 'S11'],
        ],
        [
          'Explains before the browser asks, so the one real prompt is not wasted.',
          'If the browser blocks it, the switch turns back off with “Notifications are off in your browser settings”.',
        ],
      ],
      [
        'S11',
        'settings',
        { step: 'install' },
        'Add to Home Screen',
        'On iPhone in Safari',
        [['Got it', 'S1']],
        ['Safari on iPhone only delivers web push to the Home Screen app, so this comes first.'],
      ],
      [
        'S12',
        'settings',
        { step: 'signout' },
        'Sign out?',
        'Sign out',
        [
          ['Sign out', 'A2'],
          ['Stay signed in', 'S1'],
        ],
        ['Sealed moments stay with the group. Clears this device’s session and reminders.'],
      ],
      [
        'S13',
        'settings',
        { step: 'member' },
        'Switch demo member',
        'Demo session only',
        [['Pick a member', 'S1']],
        ['Acts as another synthetic member on this device.'],
      ],
      [
        'S14',
        'settings',
        { step: 'reset', demo: true },
        'Reset Demo data',
        'Demo session only',
        [
          ['Reset', 'A2'],
          ['Keep local data', 'S1'],
        ],
        ['Says exactly what is cleared. Real accounts are never touched.'],
      ],
    ],
  },
  {
    k: 'T',
    title: 'Chat',
    p: 'One chat per group: text, replies and ✨. No attachments, edits, deletes or read receipts.',
    steps: [
      [
        'T1',
        'chat',
        { fresh: true },
        'Chat',
        'Chat tab',
        [
          ['Tap a message', 'T2'],
          ['Send', ''],
          ['Home tab', 'H1'],
        ],
        [
          'Opens at the bottom. With unread messages, a “3 new messages” line sits above the first new one.',
          'Opening clears the dock badge.',
          'Up to 2,000 characters; the counter shows from 1,800.',
        ],
      ],
      [
        'T2',
        'chat',
        { acts: 'm6' },
        'Message actions',
        'Tap a message',
        [
          ['✨', 'T1'],
          ['Reply', 'T3'],
          ['Tap outside', 'T1'],
        ],
        ['One ✨ per person per message; tapping again removes it.'],
      ],
      [
        'T3',
        'chat',
        { reply: 'm6', draft: 'Me! Bring snacks' },
        'Replying',
        'Reply',
        [
          ['Send', 'T1'],
          ['× on the quote', 'T1'],
        ],
        [
          'The quoted message shows above the box. Tapping a quote in the chat scrolls to the original.',
        ],
      ],
      [
        'T4',
        'chat',
        { empty: true },
        'No messages yet',
        'A new group',
        [['Send', 'T1']],
        ['A short line invites the first message.'],
      ],
      [
        'T5',
        'chat',
        { conn: 'reconnecting' },
        'Reconnecting',
        'The live connection dropped',
        [['Comes back by itself', 'T1']],
        ['A small pill under the header. Sending still works and is queued.'],
      ],
      [
        'T6',
        'chat',
        { conn: 'offline', draft: 'See you Saturday' },
        'Offline',
        'No connection',
        [['Back online', 'T1']],
        ['The draft is kept. Send is off until the connection is back.'],
      ],
      [
        'T7',
        'chat',
        { draft: 'Just sealed a video 🤫 ' },
        'Draft from the camera',
        'Tell the group, after sealing',
        [['Send', 'T1']],
        ['An editable draft with the cursor at the end. Only the words are sent.'],
      ],
      [
        'T8',
        'chat',
        { failed: true },
        'Not sent',
        'A message failed to send',
        [['Retry', 'T1']],
        ['Stays in place marked “Not sent · Retry”. Nothing else is blocked.'],
      ],
      [
        'T9',
        'chat',
        { conn: 'error' },
        'Couldn’t load',
        'The chat failed to load',
        [['Try again', 'T1']],
        ['The box stays usable once the chat loads.'],
      ],
      [
        'T10',
        'chat',
        { home: 'released' },
        'During the premiere',
        'Chat tab while the film premieres',
        [['Watch', 'F1']],
        ['A banner on top links to the film.'],
      ],
    ],
  },
  {
    k: 'R',
    title: 'Archive',
    p: 'This cycle’s step on top, then every released film, played right in its card.',
    steps: [
      [
        'R1',
        'archive',
        {},
        'Collecting',
        'Archive tab',
        [
          ['Play an earlier film', 'R4'],
          ['Show older films', ''],
        ],
        ['A cycle that never got a film keeps only its prompt and dates.'],
      ],
      [
        'R2',
        'archive',
        { home: 'released' },
        'Premiere',
        'Archive tab during the premiere',
        [['Play', 'F1']],
        ['Opening clears the dot on the dock.'],
      ],
      [
        'R3',
        'archive',
        { home: 'developing' },
        'Developing',
        'Archive tab after the cycle ends',
        [['Play an earlier film', 'R4']],
        ['The top card shows the film is being made.'],
      ],
      [
        'R4',
        'archive',
        { play: 3, still: true, at: 4 },
        'Playing in the card',
        'Play on a film',
        [
          ['Pause', ''],
          ['Full screen', 'F1'],
        ],
        [
          'One film plays at a time; starting another pauses the first. Streamed, nothing to download here.',
        ],
      ],
      [
        'R5',
        'archive',
        { first: true },
        'First cycle',
        'A new group',
        [['Home tab', 'H1']],
        ['Explains that the first film arrives when the 4 weeks end.'],
      ],
      [
        'R6',
        'archive',
        { home: 'error' },
        'Couldn’t load',
        'The archive failed to load',
        [['Try again', 'R1']],
        [],
      ],
    ],
  },
  {
    k: 'F',
    title: 'The film',
    p: 'Plays straight away, full screen. Everyone watches when they like during the 24-hour premiere.',
    steps: [
      [
        'F1',
        'film',
        { step: 'play' },
        'Playing',
        'Watch on Home, Play in Archive, or the premiere notification',
        [
          ['Pause', ''],
          ['Talk about it', 'T1'],
          ['Close', 'H1'],
          ['It ends', 'F3'],
        ],
        [
          'Segments across the top, one per moment. Tap the right side to skip, the left to go back.',
          'Starts with sound on unless the phone is on silent.',
        ],
      ],
      [
        'F2',
        'film',
        { step: 'play', at: 2 },
        'From the archive',
        'A short film uses an older moment',
        [['Keeps playing', 'F3']],
        ['The corner label shows only while that moment plays.'],
      ],
      [
        'F3',
        'film',
        { step: 'end' },
        'The end',
        'The film ends',
        [
          ['Talk about it in Chat', 'T1'],
          ['Replay', 'F1'],
          ['Save film', ''],
          ['Save your own moments', ''],
          ['Close', 'H1'],
        ],
        [
          'The cast shows everyone who added a moment.',
          'Save opens the system share sheet; only released media can be saved.',
        ],
      ],
    ],
  },
  {
    k: 'N',
    title: 'Outside the app',
    p: 'Web push, to the browser or the installed Home Screen app.',
    steps: [
      [
        'N1',
        'notif',
        {},
        'Notifications',
        'Sunday at the reminder time, or the film is ready',
        [
          ['Tap the reminder', 'H1'],
          ['Tap the premiere one', 'F1'],
        ],
        [
          'The reminder goes only to members with moments left this week; snoozed weeks are skipped.',
          'Tapping a notification for another group switches to that group first.',
        ],
      ],
    ],
  },
];

// The app-wide rules for moving between screens
const FIN_RULES = [
  [
    'Push',
    'Settings, Your moments, sign-in steps',
    'Slides in from the right 28 px with a fade, 0.35 s, cubic-bezier(0.2, 0.8, 0.2, 1). Back and swipe-from-left reverse it.',
  ],
  [
    'Full screen',
    'Camera, film',
    'Same entrance on the dark background; the dock is hidden. Close (×) top left returns to where it opened.',
  ],
  [
    'Tabs',
    'Home, Chat, Archive',
    'Swap in place with no slide. The dock and header stay put. Opening a tab clears its badge.',
  ],
  [
    'Menu',
    'Group menu',
    'Drops from the group name, 0.22 s, scale 0.95 → 1. Tap outside or pick to close.',
  ],
  [
    'Dialog',
    'Delete, sign out, reset, permissions',
    'Dims and blurs the screen (3 px), the card sits at the bottom. Tapping the dim cancels.',
  ],
  [
    'Feedback',
    'Toast, shutter tip',
    'Toasts at the bottom for 2.6 s. A disabled shutter shakes and shows its reason for 1.9 s.',
  ],
  ['Launch', 'A1 → next', 'The launch screen fades out over 0.5 s while scaling to 1.04.'],
  [
    'Reduce Motion',
    'Everything',
    'All of the above become cuts; rings and progress bars still update.',
  ],
];

// The diagram: one node per screen group (the codes in brackets are its variants, in the rows below)
const FIN_DIAGRAM = `flowchart LR
  A1([A1 Launch]) --> |no session| A2[A2 Welcome]
  A1 --> |expired| A3[A3 Signed out]
  A1 --> |invite link| A4[A4 Invite link]
  A1 ==> |session| H1
  A2 --> |Sign in| B1[B1 Sign in<br/><small>B2–B4</small>]
  A2 --> |Create an account| C1[C1 Create account<br/><small>C2–C5</small>]
  A2 --> |Try Demo| A5[A5 Demo member]
  A3 --> B1
  A4 --> B1 & C1
  B1 --> |no group| D1[D1 No group yet]
  C1 --> D1
  B1 -.-> |from an invite| D4[D4 Joined]
  C1 -.-> |from an invite| D4
  D1 --> |Join| D2[D2 Invite code<br/><small>D3</small>]
  D1 --> |Create| D5[D5 New group]
  D2 --> D4
  B1 ==> |has a group| H1
  A5 --> H1
  D4 & D5 --> H1
  H1{{H1 Home<br/><small>H2–H11 states</small>}}
  H1 --> |Shutter| V1[V1–V8 Camera<br/><small>P1–P2 photo</small>]
  H1 --> |Allowance| M1[M1–M4 Your moments]
  H1 --> |Group name| G1[G1–G2 Group menu]
  H1 --> |Avatar| S1[S1–S14 Settings]
  H1 --> |Chat tab| T1[T1–T10 Chat]
  H1 --> |Archive tab| R1[R1–R6 Archive]
  H1 --> |Watch| F1[F1–F3 Film]
  V1 --> |Tell the group| T1
  M1 --> |Retake| V1
  R1 --> |Play| F1
  F1 --> |Talk about it| T1
  G1 --> |Join or create| D2
  S1 --> |Sign out| A2
  N1>N1 Notification] --> H1 & F1
  classDef hub fill:#ffd9b8,stroke:#e08a5c,stroke-width:2px,color:#3a2a22,font-weight:600
  class H1 hub`;

const finAll = () => FINAL.flatMap((f) => f.steps);
const finStep = (code) => finAll().find((s) => s[0] === code);

/* ---------- Two screens that only exist here ---------- */
const finDevice = (cls, body) =>
  `<div class="device"><div class="screen c6 sub ${cls}">${statusBar()}${body}<span class="home-ind" aria-hidden="true"></span></div></div>`;
const splashPhone = () => finDevice('sub-splash', splashHTML(150));
function notifPhone() {
  const card = (title, text, when) =>
    `<div class="fn-push glass">${iconHTML(mix.icon, 34)}<div><b>${title}</b><span>${text}</span></div><em>${when}</em></div>`;
  return finDevice(
    'sub-lock dark',
    `<div class="fn-lock"><p class="fn-date">Sunday 11 October</p><p class="fn-clock">7:00</p>` +
      card('Rewind · Group name', '2 moments left this week. Add one before it resets.', 'now') +
      card('Rewind · Group name', 'Your film is here. It premieres for 24 hours.', '28 Sep') +
      `</div>`,
  );
}

// Some screens need the account in a certain shape (a full group, a member, a Demo session)
function withFlags(o, fn) {
  const keep = { size, me: SET.me, demo: SET.demo };
  if (o.size) size = o.size;
  if (o.asMember) SET.me = 1;
  if (o.demo) SET.demo = true;
  try {
    return fn();
  } finally {
    size = keep.size;
    Object.assign(SET, { me: keep.me, demo: keep.demo });
  }
}

function finPhone([code, kind, o]) {
  if (kind === 'splash') return splashPhone();
  if (kind === 'notif') return notifPhone();
  return withFlags(o, () => subScreen(kind, concepts[0].id, o));
}

function finFigure(st) {
  const [code, kind, o, title, via, acts, notes] = st;
  const live = kind !== 'splash' && kind !== 'notif';
  const act = ([label, to]) => {
    const tgt = to && finStep(to);
    return tgt
      ? `<li><button type="button" data-fin-go="${to}">${label}<span>→ ${to} ${tgt[3]}</span></button></li>`
      : `<li><span class="fn-stay">${label}<span>stays here</span></span></li>`;
  };
  return (
    `<figure class="fn-ph" id="fin-${code}"${live ? ` data-sub="${kind}" data-opts='${JSON.stringify(o)}'` : ''}>` +
    `<div class="card sv-card" data-id="${concepts[0].id}"><div class="phone-wrap"></div></div>` +
    `<figcaption><p class="fn-t"><code>${code}</code>${title}</p><p class="fn-via">${via}</p>` +
    `<p class="fn-k">Actions</p><ul class="fn-acts">${acts.map(act).join('')}</ul>` +
    (notes.length
      ? `<p class="fn-k">Behaviour</p><ul class="fn-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>`
      : '') +
    `</figcaption></figure>`
  );
}

// A row's phones are drawn when it comes near the screen
function fillLane(lane) {
  if (lane.dataset.drawn) return;
  lane.dataset.drawn = '1';
  lane.querySelectorAll('.fn-ph').forEach((fig) => {
    fig.querySelector('.phone-wrap').innerHTML = finPhone(finStep(fig.id.slice(4)));
  });
  holdFilms(lane);
}
let finObs;
function watchLanes(root) {
  finObs?.disconnect();
  finObs = new IntersectionObserver(
    (es) => es.forEach((e) => e.isIntersecting && fillLane(e.target)),
    { rootMargin: '800px 0px' },
  );
  root.querySelectorAll('.fn-lane').forEach((l) => finObs.observe(l));
}

// The diagram uses Mermaid from a CDN; without it the index below still links every screen
let mermaidP;
async function drawDiagram() {
  const box = document.querySelector('#final-view .fn-diagram');
  if (!box || box.dataset.drawn) return;
  try {
    mermaidP ||= import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(
      (m) => {
        m.default.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: 'base',
          flowchart: { curve: 'basis', padding: 12 },
          themeVariables: {
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: '13px',
            primaryColor: '#fff8f0',
            primaryBorderColor: '#e6b896',
            primaryTextColor: '#3a2a22',
            lineColor: '#c4906f',
            clusterBkg: 'rgba(255, 255, 255, 0.5)',
            clusterBorder: '#e8d6c4',
            edgeLabelBackground: '#fff3e2',
          },
        });
        return m.default;
      },
    );
    const mermaid = await mermaidP;
    const clicks = finAll()
      .map((s) => s[0])
      .filter((c) => new RegExp(`\\b${c}\\b`).test(FIN_DIAGRAM))
      .map((c) => `  click ${c} call finGo("${c}")`)
      .join('\n');
    const { svg, bindFunctions } = await mermaid.render('fin-graph', FIN_DIAGRAM + '\n' + clicks);
    box.innerHTML = svg;
    // Natural size: the box scrolls instead of shrinking the labels
    const el = box.querySelector('svg');
    el.style.width = el.viewBox.baseVal.width + 'px';
    bindFunctions?.(box);
    box.dataset.drawn = '1';
  } catch {
    box.innerHTML = `<p class="hint">The diagram needs a connection to load. Every screen is linked in the index below.</p>`;
  }
}

// Jump to a screen: draw its row, scroll it to the middle and flash it
function finGo(code) {
  const fig = document.getElementById('fin-' + code);
  if (!fig) return;
  fillLane(fig.closest('.fn-lane'));
  fig.scrollIntoView({ block: 'center', inline: 'center' });
  fx(fig, 'fn-flash', 1600);
}
window.finGo = finGo;

function renderFinalView() {
  const root = $('final-view');
  if (!root) return;
  const n = finAll().length;
  root.innerHTML =
    `<header class="main-h"><p class="k">FINAL · BUILD SPEC</p><h1>Every screen, and how you get there</h1>` +
    `<p>${n} screens. Each has a code, what leads to it, every action and where it goes, and how it behaves at the edges. The phones are live. Tap a node in the diagram or an action to jump to that screen.</p></header>` +
    `<section class="fn-block"><h2 class="fn-h">State diagram</h2><div class="fn-diagram glass-page"><p class="hint">Drawing the diagram…</p></div></section>` +
    `<section class="fn-block"><h2 class="fn-h">Moving between screens</h2><div class="fn-rules">${FIN_RULES.map(
      ([k, where, how]) => `<div><b>${k}</b><small>${where}</small><p>${how}</p></div>`,
    ).join('')}</div></section>` +
    `<nav class="fn-index" aria-label="All screens">${FINAL.map(
      (f) =>
        `<div><b>${f.k} · ${f.title}</b>${f.steps.map((s) => `<button type="button" data-fin-go="${s[0]}">${s[0]} ${s[3]}</button>`).join('')}</div>`,
    ).join('')}</nav>` +
    FINAL.map(
      (f) =>
        `<section class="fn-flow" id="fin-flow-${f.k}"><h2 class="fn-h"><span>${f.k}</span>${f.title}</h2><p class="hint">${f.p}</p>` +
        `<div class="fn-lane">${f.steps
          .map(
            (s, i) =>
              (i ? `<span class="fn-arrow" aria-hidden="true"><i>${s[4]}</i></span>` : '') +
              finFigure(s),
          )
          .join('')}</div></section>`,
    ).join('');
  watchLanes(root);
  drawDiagram();
}
window.renderFinalView = renderFinalView;

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fin-go]');
  if (b) finGo(b.dataset.finGo);
});

const openFinalFromHash = () => {
  if (/^#final$/.test(location.hash)) setView('final');
};
openFinalFromHash();
addEventListener('load', openFinalFromHash);
addEventListener('hashchange', openFinalFromHash);
