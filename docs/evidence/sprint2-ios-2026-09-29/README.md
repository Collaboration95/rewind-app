# Sprint 2 iOS simulator walkthrough — 29 September 2026

Environment: iPhone 15 Pro simulator, iOS 17.5, Expo Go. The app bundle came from PR #297 (`55f2f79`); the local SQLite/FFmpeg runtime came from `dev` (`5291cef`) at `http://10.249.89.135:8787`. The runtime health response reported `ok: true`, SQLite ready, FFmpeg configured, and schema ready. Test identity Amber and the group Weekend People are synthetic Demo fixtures.

## Observed actions

1. Signed out of Demo. [Welcome](ios-welcome-no-transport-warning.png) showed the Rewind identity, Sign in, and Try Demo, without a generic insecure-transport warning.
2. Opened Sign in. [The sign-in form](ios-signin-secure-warning.png) explained that real credentials require same-origin HTTPS and disabled submission on this HTTP local runtime. No password was entered.
3. Chose Try Demo. [The member chooser](ios-demo-chooser.png) explicitly described its members as synthetic and local. Selected Amber.
4. [Home](ios-demo-connected-home.png) reported a connected local service, SQLite ready, FFmpeg configured, the sample group, cycle state, and contribution allowance.
5. Opened Chat, sent “Simulator walkthrough: chat connected.”, added a sparkle reaction, then sent “Reply works on iOS simulator.” as a reply. [Chat after the first send](ios-demo-chat-sent.png) showed the message in the group conversation; the accessibility tree confirmed reaction count 1 and the reply context and text.
6. Opened Camera. [The still-capture state](ios-camera-simulator-unsupported.png) correctly said that the simulator cannot provide a camera; clip capture similarly said a physical camera and microphone are required. No physical media was captured.
7. Opened Archive; it showed the group film sealed until reveal and did not expose playback. Returned to Settings and signed out; Welcome returned.

This walkthrough verifies PR #297’s placement of the HTTP transport warning and the connected synthetic Demo entry. It does not verify real-account sign-in, native physical recording, hosted HTTPS behavior, or any issue acceptance that specifically requires those checks.
