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
          ['Create an account', 'C6'],
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
          ['Create an account', 'C6'],
          ['Back', 'A2'],
        ],
        [
          'The first field is focused. Return moves to the password, Return again signs in.',
          'While waiting the button reads “Signing in…” and the form is locked.',
          'Username and password only; there is no password reset in the app (an administrator resets it).',
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
        'B5',
        'signin',
        { step: 'created' },
        'Account ready',
        'Create account succeeds',
        [['Sign in', 'D1']],
        ['“Your account is ready. Sign in to continue.” above the form.'],
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
    p: 'A username and a password, on one screen. The username is also the name the group sees.',
    steps: [
      [
        'C6',
        'signin',
        { step: 'upuser' },
        'Create account',
        'Create an account on Welcome',
        [
          ['Create account', 'B5'],
          ['Username taken', 'C7'],
          ['Sign in', 'B1'],
          ['Back', 'A2'],
        ],
        [
          'Username 3–32 characters: letters, numbers, dots, dashes, underscores, starting with a letter or number.',
          'Password at least 12 characters, typed twice. Errors show under the fields.',
          'The Terms and Privacy Policy line sits under the button; both open in an in-app browser.',
        ],
      ],
      [
        'C7',
        'signin',
        { step: 'upuserbad' },
        'Username taken',
        'The username is in use',
        [['Try another', 'C6']],
        ['The username stays in the field so it can be changed.'],
      ],
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
          'The Terms and Privacy Policy line sits under the button; both links open in an in-app browser.',
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
          'Six letters, shown as ABC-DEF; case and the dash don’t matter.',
          'A wrong format says “Enter the six-letter invitation code, like ABC-DEF.” before anything is sent.',
        ],
      ],
      [
        'D3',
        'settings',
        { step: 'join', back: 'close', joinErr: 'expired' },
        'Code doesn’t work',
        'Unknown, expired, used or full',
        [['Fix the code', 'D2']],
        [
          'Messages: “Enter a valid invitation code.”, “This invitation has expired.”, “This invitation has already been used.”, “This group has reached its member limit.”',
          'Too many tries: “Too many invitation attempts. Try again later.”',
        ],
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
          'Name is required (up to 80). Pick one of three prompts or write one (up to 160).',
          'Member limit 2–10, including the owner.',
          'You are the owner and the first 4-week cycle starts at once; there is no separate start step.',
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
        ['The card stays until the film is ready; there is no separate notification for it.'],
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
          ['Continue → the system prompt says yes', 'V3'],
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
          ['Open Settings', ''],
          ['Check again', 'V3'],
          ['Close', 'H1'],
        ],
        [
          'iOS never shows the prompt twice, so Open Settings goes straight to Rewind in the Settings app.',
          'Coming back with access on moves on to V3 by itself.',
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
          'Plays on a loop, muted until tapped. Trim handles, 0.5 s minimum.',
          'Looks: Disposable Flash, Compact Digital (picked first), 8mm Home Movie, VHS Camcorder.',
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
        [['Done', 'H1']],
        [
          'From now on nobody sees it before the film, not even you.',
          'Done returns to where the camera opened.',
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
          ['Prompt', 'S3'],
          ['Invite friends', 'S4'],
          ['Members', 'S15'],
          ['Switch group', 'S7'],
          ['Turn the reminder on', 'S10'],
          ['Time zone (owner)', 'S21'],
          ['Help, Privacy Policy, Terms', ''],
          ['Sign out', 'S12'],
          ['Delete account', 'S19'],
          ['Back', 'H1'],
        ],
        [
          'Back returns to the tab the avatar was tapped on.',
          'Snooze for 7 days and End snooze act in place with a toast. The reminder is always Sunday 7 PM in the group’s time zone.',
          'Send a test reminder only exists in a Demo session.',
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
          'A six-letter code like ABC-DEF. Works once and expires in 24 hours. Share opens the system share sheet.',
          'Revoke cancels the code at once. There are no invite links.',
        ],
      ],
      [
        'S5',
        'settings',
        { size: 10 },
        'Group is full',
        'The group reached the owner’s member limit',
        [['Invite friends is off', '']],
        [
          'The row stays visible but greyed, with “The group is full · 10 of 10” (or the limit the owner set).',
        ],
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
          ['Continue → system prompt', 'S1'],
          ['On iPhone, web only', 'S11'],
        ],
        [
          'Explains before the system asks, so the one real prompt is not wasted. Continue is the only button.',
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
      [
        'S15',
        'settings',
        { step: 'members' },
        'Members',
        'Members, in Settings',
        [
          ['Tap a person', 'S16'],
          ['Back', 'S1'],
        ],
        ['Everyone in the group, owner first. Blocked people say so under their name.'],
      ],
      [
        'S16',
        'settings',
        { step: 'person', person: 1 },
        'A member',
        'Tap a person',
        [
          ['Report', 'S17'],
          ['Block or Unblock', 'S15'],
          ['Cancel', 'S15'],
        ],
        [
          'Blocking hides their messages and their moments in your film. They aren’t told and stay in the group.',
        ],
      ],
      [
        'S17',
        'settings',
        { step: 'report', person: 1 },
        'Report a person',
        'Report',
        [
          ['Send report', 'S15'],
          ['Cancel', 'S15'],
        ],
        [
          'One reason, with Also block ticked by default. The same sheet reports a message (T11) and a moment (F4).',
        ],
      ],
      [
        'S18',
        'settings',
        { step: 'leave' },
        'Leave group?',
        'Leave group',
        [
          ['Leave group', 'H1'],
          ['Stay', 'S15'],
        ],
        [
          'Goes to the next group, or D1 if none is left.',
          'An owner who leaves hands the group to the member who joined next.',
        ],
      ],
      [
        'S19',
        'settings',
        { step: 'delete' },
        'Delete account',
        'Delete account',
        [
          ['Delete account', 'S20'],
          ['Back', 'S1'],
        ],
        ['Lists what is deleted. Asks for the password once.'],
      ],
      [
        'S20',
        'settings',
        { step: 'delconf' },
        'Delete for good?',
        'Delete account',
        [
          ['Delete for good', 'A2'],
          ['Keep my account', 'S19'],
        ],
        [
          'S21',
          'settings',
          { step: 'tz' },
          'Time zone',
          'Owner taps Time zone',
          [['Pick a zone', 'S1']],
          ['Sets when the Sunday 7 PM reminder fires for the whole group. Saved when picked.'],
        ],
        ['Signs out everywhere and lands on Welcome with “Your account is deleted.”'],
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
          ['Report (others’ messages)', 'T11'],
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
      [
        'T11',
        'chat',
        { report: 'm6' },
        'Report a message',
        'Report, on someone else’s message',
        [
          ['Send report', 'T1'],
          ['Cancel', 'T1'],
        ],
        ['Ticking Also block hides that person’s messages right away.'],
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
        { step: 'play', at: 2, filler: true },
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
          ['Report a moment', 'F4'],
          ['Close', 'H1'],
        ],
        [
          'The cast shows everyone who added a moment.',
          'Save opens the system share sheet; only released media can be saved.',
        ],
      ],
      [
        'F4',
        'film',
        { step: 'end', report: true },
        'Report a moment',
        'Report a moment',
        [
          ['Send report', 'F3'],
          ['Cancel', 'F3'],
        ],
        ['No name or block option: moments in the film aren’t labelled with who took them.'],
      ],
    ],
  },
  {
    k: 'N',
    title: 'Outside the app',
    p: 'The weekly reminder: APNs in the App Store app, web push in the browser or the Home Screen web app. It is the only notification.',
    steps: [
      [
        'N1',
        'notif',
        {},
        'Notifications',
        'Sunday, 7 PM in the group’s time zone',
        [['Tap the reminder', 'H1']],
        [
          'Goes to members who turned the reminder on; snoozed members are skipped for 7 days.',
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
  A1 ==> |session| H1
  A2 --> |Sign in| B1[B1 Sign in<br/><small>B2–B3</small>]
  A2 --> |Create an account| C6[C6 Create account<br/><small>C7</small>]
  A2 --> |Try Demo| A5[A5 Demo member]
  A3 --> B1
  C6 --> B5[B5 Account ready]
  B5 --> |signs in| D1
  B1 --> |no group| D1[D1 No group yet]
  D1 --> |Join| D2[D2 Invite code<br/><small>D3</small>]
  D1 --> |Create| D5[D5 New group]
  D2 --> D4[D4 Joined]
  B1 ==> |has a group| H1
  A5 --> H1
  D4 & D5 --> H1
  H1{{H1 Home<br/><small>H2–H11 states</small>}}
  H1 --> |Shutter| V1[V1–V8 Camera<br/><small>P1–P2 photo</small>]
  H1 --> |Allowance| M1[M1–M4 Your moments]
  H1 --> |Group name| G1[G1–G2 Group menu]
  H1 --> |Avatar| S1[S1–S21 Settings]
  H1 --> |Chat tab| T1[T1–T11 Chat]
  H1 --> |Archive tab| R1[R1–R6 Archive]
  H1 --> |Watch| F1[F1–F4 Film]
  M1 --> |Retake| V1
  R1 --> |Play| F1
  F1 --> |Talk about it| T1
  G1 --> |Join or create| D2
  S1 --> |Sign out or delete account| A2
  N1>N1 Sunday reminder] --> H1
  classDef hub fill:#ffd9b8,stroke:#e08a5c,stroke-width:2px,color:#3a2a22,font-weight:600
  class H1 hub`;

// App Store (iOS) requirements that touch a screen. Guideline numbers are from the App Store Review Guidelines.
const APPSTORE = {
  A1: [
    'The launch screen comes from the app’s launch storyboard: the icon and name only, no ads, no tips (HIG, Launch screen).',
    'Must not crash or hang offline (2.1).',
  ],
  A2: [
    'App Review needs a working sign-in: add a review account in App Store Connect › App Review Information (2.1). Try Demo also has to work.',
    'Sign in with Apple isn’t required while Rewind only uses its own username accounts with no Google or Facebook sign-in (4.8).',
  ],
  A4: [
    'Invite links open the app as Universal Links (apple-app-site-association on the invite domain); without the app they open the web page.',
  ],
  C6: [
    'Apps with user content must have people agree to terms that forbid objectionable content and abusive users (1.2).',
    'The Privacy Policy is linked here and in Settings, and its URL goes in App Store Connect (5.1.1(i)).',
    'Only the username is collected: declare it as a user ID in the App Privacy labels (5.1.2).',
  ],
  C1: [
    'Email and phone are used only for sign-in: declare them as Contact Info, not tracking, in the App Privacy labels (5.1.2).',
  ],
  C5: [
    'Apps with user content must have people agree to terms that forbid objectionable content and abusive users (1.2).',
    'The Privacy Policy is linked here and in Settings, and its URL goes in App Store Connect (5.1.1(i)).',
  ],
  H1: [
    'The App Store build is a native app (camera, APNs push), not a wrapped website, which Apple rejects (4.2).',
  ],
  V1: [
    'The button says Continue, never Allow, and there is no skip: it always leads to the system prompt (5.1.1(iv)).',
    'Info.plist: NSCameraUsageDescription “Rewind uses the camera to record your moments.” and NSMicrophoneUsageDescription “Rewind records sound with your videos.”',
  ],
  V2: [
    'Open Settings uses UIApplication.openSettingsURLString. Never block the rest of the app because the camera is off (5.1.1(iv)).',
  ],
  V5: [
    'Recording and trimming happen on the device. Nothing uploads before Seal, so no background upload permission is needed beyond a normal background task.',
  ],
  V8: [
    'Uploads that finish in the background use a background URLSession, not a background mode Apple would question (2.5.4).',
  ],
  M1: ['Deleting a moment deletes it on the server too, not just hides it (5.1.1).'],
  G1: [
    'Each group is private and invite-only. Nothing is public, so no public profile or search moderation is needed.',
  ],
  S1: [
    'Delete account, Privacy Policy, Terms of use and a support contact must all be in the app (5.1.1(i), 5.1.1(v), 1.2, 1.5).',
    'Help and support also needs a support URL in App Store Connect.',
  ],
  S4: ['Share uses the system share sheet (UIActivityViewController).'],
  S10: [
    'No Not now and no tap-outside before the system prompt: Continue is the only way on (5.1.1(iv)).',
    'Ask for push here, when the reminder is turned on, never at launch. The app works fully without notifications, and nothing promotional is sent without a separate opt-in (4.5.4).',
  ],
  S11: ['Web only. The App Store build hides this link: native push needs no Home Screen install.'],
  S12: ['Sign out and Delete account are separate. Deactivating is not deleting (5.1.1(v)).'],
  S15: ['Apps with user content need a way to block abusive users (1.2).'],
  S16: [
    'Block, report, and for the owner, remove: the moderation tools 1.2 asks for, inside a private group.',
  ],
  S17: [
    'Reports reach the Rewind team, who act within 24 hours by removing the content and the person who posted it (1.2).',
    'Needs a small moderation inbox for the team (email is enough at launch).',
  ],
  S19: [
    'Deletion is done fully in the app: no email, call or website (5.1.1(v)).',
    'It deletes the account and its data, not just deactivates it. If Sign in with Apple is added later, revoke its token here.',
  ],
  S20: ['A confirmation step is allowed; extra hurdles after it are not (5.1.1(v)).'],
  T1: ['Chat is user content: report and block must be on every message from someone else (1.2).'],
  T2: ['Report sits next to ✨ and Reply on others’ messages (1.2).'],
  T11: ['Same report flow as S17. Blocking hides their messages for you at once (1.2).'],
  F3: [
    'Save film uses Add to Photos: NSPhotoLibraryAddUsageDescription “Rewind saves films you choose to your Photos.”',
    'Every film has Report a moment (1.2).',
  ],
  F4: ['The team can remove a reported moment from the film for everyone (1.2).'],
  N1: [
    'Notifications never show sealed media or what someone recorded.',
    'Reminders use the default interruption level, not time-sensitive or critical, which need a reason.',
  ],
};

// The App Store checklist above the rows: [guideline, what it needs, screens]
const APPSTORE_LIST = [
  [
    '1.2 User content',
    'Terms that forbid objectionable content, report, block, remove members, act on reports within 24 hours, a contact link',
    ['C6', 'T11', 'F4', 'S16', 'S17', 'S1'],
  ],
  [
    '2.1 Completeness',
    'A review account in App Store Connect; Try Demo works with no setup',
    ['A2', 'A5'],
  ],
  [
    '2.3 Metadata',
    'Screenshots of the real app, with abstract or generated images only, never sealed media',
    [],
  ],
  [
    '4.2 Minimum functionality',
    'A native app with the camera and push, not a website in a wrapper. The current plan ships iOS as a PWA, so App Store needs a native shell',
    ['H1'],
  ],
  [
    '4.8 Sign in with Apple',
    'Not needed while there is no third-party sign-in. Required if Google or Facebook sign-in is ever added',
    ['A2'],
  ],
  ['5.1.1(i) Privacy Policy', 'Linked in the app and in App Store Connect', ['C6', 'S1']],
  [
    '5.1.1(iv) Permissions',
    'Ask in context; pre-prompts say Continue and have no skip; purpose strings for camera, microphone and Add to Photos',
    ['V1', 'V2', 'S10', 'F3'],
  ],
  ['5.1.1(v) Account deletion', 'Delete account inside the app, deleting the data', ['S19', 'S20']],
  [
    '5.1.2 App Privacy labels',
    'User ID (username), photos and videos, other user content (chat); no tracking, so no App Tracking Transparency prompt',
    ['C6'],
  ],
  [
    'Age rating',
    'Answer yes to user-generated content and unrestricted chat in the age rating questionnaire',
    ['T1'],
  ],
  ['Export compliance', 'Only standard HTTPS: set ITSAppUsesNonExemptEncryption to NO', []],
  [
    'App icon',
    '1024 × 1024 PNG, square, no transparency and no rounded corners (iOS rounds it)',
    [],
  ],
];

// Screens taken out of the app for now, with why. They keep their codes and stay drawn in the
// Archived section at the bottom; deleting a line here puts the screen back in its flow.
const ARCHIVED = {
  A4: 'Invites are six-letter codes (ABC-DEF). There are no invite links.',
  B4: 'There is no forgot or reset password in the app; an administrator resets passwords.',
  C1: 'Sign-up is a username and password. No email or phone.',
  C2: 'No email or phone, so no “already used” for them. C7 covers a taken username.',
  C3: 'There is no verification code step.',
  C4: 'There is no verification code step.',
  C5: 'There is no separate name step: the username is the name the group sees.',
  H8: 'Creating a group starts its first cycle. There is no “Start a capsule”.',
  H9: 'Creating a group starts its first cycle, so members never wait for one.',
  S2: 'Renaming a group is not built or planned.',
  S8: 'The reminder is fixed: Sunday 7 PM in the group’s time zone.',
  S9: 'The reminder is fixed: Sunday 7 PM in the group’s time zone.',
  S18: 'Leaving a group is not built or planned.',
  T7: 'There is no “Tell the group” after sealing.',
  F2: 'Films don’t fill gaps with older moments.',
};
// Build status against dev. Anything not listed is built on dev.
const STATUS = {
  A1: ['planned', 'Native launch screen, in the Sprint 2 plan'],
  G1: ['design', 'dev lists groups on Home; this header menu replaces that list'],
  G2: ['design', 'dev lists groups on Home; this header menu replaces that list'],
  S1: ['partial', 'Help, Privacy Policy and Terms: #430. Delete account: #428'],
  S10: ['planned', 'Device subscription: #348'],
  S11: ['design', 'Web only'],
  S12: ['design', 'dev signs out without asking'],
  S16: ['planned', 'Block and report: #429 (block has server routes)'],
  S17: ['planned', '#429'],
  S19: ['planned', '#428 (the server route exists)'],
  S20: ['planned', '#428'],
  T1: ['partial', 'No unread badge for real accounts yet'],
  T10: ['design', 'Premiere banner in Chat'],
  T11: ['store', 'Needed for App Store 1.2; #429 covers moments only'],
  F3: ['design', 'End screen and cast. Download film and clips exist in Archive'],
  F4: ['planned', '#429'],
  N1: ['planned', 'Server sends it; device subscription: #348'],
};
const ST_LABEL = {
  built: 'Built',
  planned: 'Planned',
  partial: 'Partly built',
  design: 'Design only',
  store: 'App Store need',
};
const isArchived = (code) => code in ARCHIVED;
const finAll = () => FINAL.flatMap((f) => f.steps);
// The main flows, and the archived screens grouped by the flow they came from
const finLanes = () =>
  FINAL.map((f) => ({ ...f, steps: f.steps.filter((x) => !isArchived(x[0])) })).filter(
    (f) => f.steps.length,
  );
const archLanes = () =>
  FINAL.map((f) => ({ ...f, steps: f.steps.filter((x) => isArchived(x[0])) })).filter(
    (f) => f.steps.length,
  );
const finStep = (code) => finAll().find((s) => s[0] === code);

/* ---------- Two screens that only exist here ---------- */
const finDevice = (cls, body) =>
  `<div class="device"><div class="screen c6 sub ${cls}">${statusBar()}${body}<span class="home-ind" aria-hidden="true"></span></div></div>`;
const splashPhone = () => finDevice('sub-splash', splashHTML(150));
function notifPhone() {
  const card = (title, text, when) =>
    `<div class="fn-push glass">${iconHTML(34)}<div><b>${title}</b><span>${text}</span></div><em>${when}</em></div>`;
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
    `<figcaption><p class="fn-t"><code>${code}</code>${title}</p>` +
    (isArchived(code)
      ? `<p class="fn-arch"><b>Archived</b> ${ARCHIVED[code]}</p>`
      : (() => {
          const [k, note] = STATUS[code] || ['built', ''];
          return `<p class="fn-st st-${k}"><b>${ST_LABEL[k]}</b>${note ? ` ${note}` : ''}</p>`;
        })()) +
    `<p class="fn-via">${via}</p>` +
    `<p class="fn-k">Actions</p><ul class="fn-acts">${acts.map(act).join('')}</ul>` +
    (notes.length
      ? `<p class="fn-k">Behaviour</p><ul class="fn-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>`
      : '') +
    (APPSTORE[code]
      ? `<div class="fn-as"><p class="fn-k">App Store (iOS)</p><ul class="fn-notes">${APPSTORE[code].map((n) => `<li>${n}</li>`).join('')}</ul></div>`
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
  const arch = fig.closest('details');
  if (arch) arch.open = true;
  fillLane(fig.closest('.fn-lane'));
  fig.scrollIntoView({ block: 'center', inline: 'center' });
  fx(fig, 'fn-flash', 1600);
}
window.finGo = finGo;

function renderFinalView() {
  const root = $('final-view');
  if (!root) return;
  const lane = (f) =>
    `<section class="fn-flow" id="fin-flow-${f.k}${f.arch ? '-x' : ''}"><h2 class="fn-h"><span>${f.k}</span>${f.title}</h2>${f.arch ? '' : `<p class="hint">${f.p}</p>`}` +
    `<div class="fn-lane">${f.steps
      .map(
        (s, i) =>
          (i ? `<span class="fn-arrow" aria-hidden="true"><i>${s[4]}</i></span>` : '') +
          finFigure(s),
      )
      .join('')}</div></section>`;
  const main = finLanes();
  const arch = archLanes().map((f) => ({ ...f, arch: true }));
  const n = main.reduce((a, f) => a + f.steps.length, 0);
  root.innerHTML =
    `<header class="main-h"><p class="k">FINAL · BUILD SPEC</p><h1>Every screen, and how you get there</h1>` +
    `<p>${n} screens. Each has a code, what leads to it, every action and where it goes, and how it behaves at the edges. The phones are live. Tap a node in the diagram or an action to jump to that screen.</p></header>` +
    `<section class="fn-block"><h2 class="fn-h">State diagram</h2><div class="fn-diagram glass-page"><p class="hint">Drawing the diagram…</p></div></section>` +
    `<section class="fn-block"><h2 class="fn-h">Moving between screens</h2><div class="fn-rules">${FIN_RULES.map(
      ([k, where, how]) => `<div><b>${k}</b><small>${where}</small><p>${how}</p></div>`,
    ).join('')}</div></section>` +
    `<section class="fn-block"><h2 class="fn-h">App Store (iOS) checklist</h2><p class="hint">What Apple’s review checks, and the screens that handle it. Each screen below also lists its own App Store notes.</p>` +
    `<div class="fn-aslist">${APPSTORE_LIST.map(
      ([g, what, codes]) =>
        `<div><b>${g}</b><p>${what}</p>${codes.length ? `<span>${codes.map((c) => `<button type="button" data-fin-go="${c}">${c}</button>`).join('')}</span>` : ''}</div>`,
    ).join('')}</div></section>` +
    `<section class="fn-block"><h2 class="fn-h">Build status</h2><p class="hint">Every screen says how far dev is with it.</p><div class="fn-stkey">${Object.entries(
      ST_LABEL,
    )
      .map(
        ([k, l]) =>
          `<p class="fn-st st-${k}"><b>${l}</b>${{ built: 'on dev today', planned: 'an open issue covers it', partial: 'some of it is on dev', design: 'a design change over what dev has', store: 'needed for the App Store, no issue yet' }[k]}</p>`,
      )
      .join('')}</div></section>` +
    `<nav class="fn-index" aria-label="All screens">${main
      .map(
        (f) =>
          `<div><b>${f.k} · ${f.title}</b>${f.steps.map((s) => `<button type="button" data-fin-go="${s[0]}">${s[0]} ${s[3]}</button>`).join('')}</div>`,
      )
      .join('')}</nav>` +
    main.map(lane).join('') +
    `<details class="fn-archive"><summary><b>Archived screens</b><span>${arch.reduce((a, f) => a + f.steps.length, 0)} screens not in the app now. They keep their codes; to bring one back, remove it from ARCHIVED in final.js.</span></summary>` +
    arch.map(lane).join('') +
    `</details>`;
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
