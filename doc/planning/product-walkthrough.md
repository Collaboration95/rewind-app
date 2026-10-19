# Rewind product walkthrough

This guide describes source `40ebeb5673d103b4b6950d095192aae744980769`
(dev, checked 15 October 2026). It is an operating guide, not evidence of a new
deployment or physical-device pass. Rewind is the real-account app; the old
synthetic Demo is removed. Use your own consenting test accounts and media.
See [client artifacts](client-artifacts.md) for the available clients and the
Android test build's recorded limits.

## Open and sign in

Use the environment URL supplied by the operator. Keep development and release
accounts separate. Web/PWA uses Cognito Managed Login when configured: follow
the hosted sign-in/sign-up and email-verification steps, then choose a display
name in Rewind. Release password sign-in is disabled by policy; release Cognito
deployment is tracked separately in #515. This guide does not establish that
an environment has been deployed or configured.

Local and hosted dev also support **Developer sign-in**, a separate username/
password account. Native Expo/Android test clients use this local/dev route;
they do not implement release Cognito authentication. For Cognito recovery,
use the recovery option on its sign-in page. Developer accounts have no
self-service recovery. Never post passwords, session tokens or recovery codes
to the public support issue tracker.

## Install and allow permissions

- **iPhone:** open the HTTPS website in Safari, Share → Add to Home Screen,
  then launch the icon. iOS delivery is the PWA, not a compiled iOS app.
- **Android/desktop browser:** use the browser's install option if offered;
  otherwise continue in the browser. Installation does not grant permissions.
- **Capture:** allow camera access for photos; allow camera and microphone
  for video. Use a supported device over HTTPS. Localhost is a development
  exception on the same computer, not a phone-accessible HTTPS substitute.
- **Reminders:** enable them in Settings and grant notification permission
  when asked. iPhone web push requires iOS 16.4+ and the installed Home Screen
  app. Browser support, network access and device settings affect delivery.
  Expo/native push is disabled.

These are usage instructions, not a claim that installation, push or camera
has just passed on a physical device. Hosted Safari/PWA integration verification
is tracked in #527.

## A real-account demonstration

1. Sign in with two test accounts in separate browser profiles. Create a group
   with one account and share its invite with the other. Groups allow up to
   ten members. Treat invite links/codes as access information.
2. Join with the second account and check the selected group. In Home, inspect
   the current cycle and remaining contribution allowance.
3. Capture a photo or short video, review it, then submit. A photo contributes
   three seconds; a video is at most 15 seconds and also subject to the
   remaining allowance. Wait for a successful submission before leaving.
   Use only media you own and people who consent to appear.
4. Check the sealed contribution state. Group moments are revealed with the
   film at cycle completion; uploading is not an immediate film release.
   In chat, send a message, reply and react from the other account.
5. When the cycle has released and processing has completed, open Archive and
   play the film. Use the offered film download and own-clip export controls.
   On Android, choose a destination folder when prompted; cancelling is not
   a saved file. Confirm a file opens before describing export as successful.
6. Reload or cold-open the client to check session/group restoration, then
   sign out. Do not claim a journey passed if camera, film readiness or a
   device capability prevented the relevant step.

For a fast local demonstration, run `npm ci`, then `make run-real`, and open
`http://localhost:8090` on the same Mac. The launcher uses local SQLite/disk
storage and gives **new groups** a default ten-minute cycle
(`REWIND_REAL_CYCLE_MINUTES`, unless overridden). Existing groups retain their
cycle configuration. Keep the server/worker running for film processing.
Hosted groups normally use **28-day** cycles; the published Android smoke used
that duration. Do not change a shared hosted clock to stage a demonstration.
A newly created hosted group may have no released film to show.

## Your data and controls

Your Rewind data includes profile/account linkage, group membership, captured
media, chat/reactions, reminder subscriptions and safety actions. Cognito holds
its credentials and verified email; Rewind stores its subject identifier and
checks verified email at sign-in without storing that email in its account
record. Developer accounts instead have a salted password hash in Rewind.

Use Settings to manage reminders or delete the account. Cognito deletion uses
typed `DELETE` confirmation and removes the linked Cognito user first;
developer deletion checks the password. A provider deletion failure leaves the
Rewind account intact and reports an error. Account deletion removes personal
application records and schedules/removes associated media, but already-made
films can remain with a group that still has members. A sole-member group is
deleted; otherwise ownership transfers to the longest-standing remaining
member. Downloads already held by others cannot be recalled. Read the public
[privacy](../../public/privacy.html), [terms](../../public/terms.html) and
[support](../../public/support.html) pages for the user-facing disclosures.

## Limits and troubleshooting

| Symptom                             | What to check                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in returns to welcome or fails | Use the intended environment and sign-in method. Retry from its entry page rather than reusing an expired callback. Developer credentials do not authenticate a Cognito account. |
| Camera unavailable or denied        | Check browser/OS permissions and HTTPS, then reopen. An emulator's unsupported camera is not a physical-device capture pass.                                                     |
| Live video unsupported              | Use the offered MP4 fallback if shown (up to 15 seconds with audio). It stays labelled as a file contribution; do not present it as recorded capture.                            |
| Submission rejected                 | Read the reported allowance, duration or connectivity error. Retrying cannot bypass the server's contribution limits.                                                            |
| Film absent                         | Check cycle end and processing state. A new hosted group can legitimately have no film for 28 days.                                                                              |
| Export not saved                    | Choose a destination and check the resulting file; permission denial, cancellation and unavailable media are not successful exports.                                             |
| Reminder missing                    | Check subscription, installed iPhone PWA, browser support, permission and connectivity. Native test-app push is paused.                                                          |
| Need help                           | Use public support without private media, credentials or other members' personal information. Report client/environment and a redacted error.                                    |

Source anchors: `scripts/run-real-local.mjs`, `server/src/groups/real.ts`,
`server/src/auth/index.ts`, `server/src/auth/cognito.ts`, `server/src/http.ts`,
`src/capture/CameraCaptureScreen.tsx`, `src/capture/VideoCaptureScreen.tsx`.
