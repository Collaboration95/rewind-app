import { Platform } from 'react-native';

// React Native has no backdrop-filter, pseudo-elements or keyframes, so on the
// web the Warm Glass recipe is applied with real CSS. Components opt in with
// `dataSet={{ rw: '…' }}` (rendered as data-rw) and keep plain RN styles for
// layout, which is also what native falls back to. The rules are ported from
// styles-glass.css, styles-screens.css, styles-tabs.css and styles-states.css.
// `html` raises specificity above react-native-web's single-class rules.
const CSS = `
html [data-rw~="glass"] {
  /* No position here: it would beat react-native-web's absolute dialogs and menus.
     RNW views are already position: relative, which the pseudo-elements need. */
  isolation: isolate;
  background: linear-gradient(170deg, rgba(255,255,255,.4), rgba(255,255,255,.1));
  -webkit-backdrop-filter: blur(12px) saturate(190%) brightness(1.04);
  backdrop-filter: blur(12px) saturate(190%) brightness(1.04);
  box-shadow: inset 0 1px 1px rgba(255,255,255,.95), inset 0 -1px 1px rgba(255,255,255,.4),
    inset 0 0 20px rgba(255,255,255,.22), 0 18px 36px -16px rgba(160,90,40,.35),
    0 2px 6px -2px rgba(160,90,40,.14);
}
html [data-rw~="glass"]::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  background: radial-gradient(120% 70% at 16% -12%, rgba(255,255,255,.8), transparent 46%),
    linear-gradient(118deg, transparent 58%, rgba(255,255,255,.2) 64%, transparent 72%);
}
html [data-rw~="glass"]::after {
  content: ''; position: absolute; inset: 0; padding: 1.3px; border-radius: inherit; pointer-events: none;
  background: linear-gradient(135deg, rgba(255,255,255,1), rgba(255,255,255,.25) 30%,
    rgba(255,255,255,.06) 52%, rgba(255,255,255,.35) 76%, rgba(255,255,255,.95));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
}
html [data-rw~="menu"] { background: linear-gradient(170deg, rgba(255,251,246,.94), rgba(255,246,236,.84)); }
html [data-rw~="dialog"] { background: rgba(255,250,244,.92); }
html [data-rw~="sheet"] { background: rgba(255,250,244,.88); }
html [data-rw~="composer"] { background: linear-gradient(170deg, rgba(255,255,255,.78), rgba(255,255,255,.5)); }
html [data-rw~="composer"]:focus-within {
  box-shadow: inset 0 1px 1px #fff, 0 0 0 2px rgba(224,112,58,.6), 0 14px 30px -16px rgba(160,90,40,.4);
}
html [data-rw~="lens"] {
  background: linear-gradient(180deg, rgba(255,255,255,.62), rgba(255,255,255,.28));
  box-shadow: inset 0 1px 1px rgba(255,255,255,1), 0 3px 10px -3px rgba(150,80,30,.28);
}
html [data-rw~="btn"] {
  background: rgba(255,255,255,.6);
  box-shadow: inset 0 1px 1px rgba(255,255,255,1), inset 0 0 0 1px rgba(255,255,255,.8),
    0 6px 16px -10px rgba(150,80,30,.4);
}
html [data-rw~="primary"] {
  background: linear-gradient(180deg, #ffd2a6, #ff9f6b);
  box-shadow: 0 10px 22px -12px rgba(224,112,58,.8);
}
html [data-rw~="danger"] { background: #c2452f; box-shadow: none; }
html [data-rw~="soft"] {
  background: rgba(255,255,255,.55);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.9), 0 4px 12px -4px rgba(150,80,30,.25);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
}
html [data-rw~="pill"] {
  background: rgba(255,255,255,.7);
  box-shadow: inset 0 1px 1px #fff, inset 0 0 0 1px rgba(255,255,255,.8), 0 4px 10px -6px rgba(150,80,30,.4);
}
html [data-rw~="dark-glass"] {
  background: rgba(255,255,255,.14);
  -webkit-backdrop-filter: blur(16px) saturate(160%); backdrop-filter: blur(16px) saturate(160%);
  box-shadow: inset 0 1px 1px rgba(255,255,255,.3), inset 0 0 0 1px rgba(255,255,255,.12);
}
html [data-rw~="dark-pill"] {
  background: rgba(0,0,0,.28); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
}
html [data-rw~="dim"] {
  background: rgba(40,24,14,.32); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
}
html [data-rw~="sealed-veil"] {
  background: rgba(20,12,8,.4); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
}
html [data-rw~="chat-head"] {
  background: rgba(246,237,227,.78);
  -webkit-backdrop-filter: blur(16px) saturate(140%); backdrop-filter: blur(16px) saturate(140%);
  -webkit-mask-image: linear-gradient(#000 80%, transparent); mask-image: linear-gradient(#000 80%, transparent);
}
html [data-rw~="core"] {
  background: radial-gradient(circle at 35% 30%, #ffe1b8, #ffa766 50%, #ea6f45);
  box-shadow: 0 10px 28px -6px rgba(234,111,69,.55);
}
html [data-rw~="core"][data-off="true"] { filter: grayscale(.9); opacity: .45; box-shadow: none; }
html [data-rw~="pills-on"] { background: linear-gradient(90deg, #f6a15b, #e8704a); }
html [data-rw~="own-bubble"] { background: linear-gradient(180deg, #ffdcbc, #ffbf94); }
html [data-rw~="upbar"] { background: linear-gradient(90deg, #ffd2a6, #ff9f6b); }
html [data-rw~="fade-top"] { background: linear-gradient(#f6ede3 55%, transparent); }
html [data-rw~="fade-bottom"] { background: linear-gradient(transparent, #f6ede3 78%); }

html [data-rw~="glow"] { filter: blur(40px); pointer-events: none; }
html [data-rw~="glow"] > div { position: absolute; inset: 0; border-radius: 50%; }
html [data-rw~="glow"] > div:nth-child(1) {
  background: radial-gradient(circle at 50% 42%, #ffcf96 0, rgba(255,168,110,.85) 15%, transparent 38%);
  animation: rw-drift 10s ease-in-out infinite;
}
html [data-rw~="glow"] > div:nth-child(2) {
  background: radial-gradient(circle at 40% 52%, rgba(255,138,118,.6) 0, transparent 30%);
  animation: rw-drift 12s ease-in-out -4s infinite reverse;
}
html [data-rw~="glow"] > div:nth-child(3) {
  background: radial-gradient(circle at 62% 38%, rgba(255,214,120,.75) 0, transparent 28%);
  animation: rw-drift 14s ease-in-out -7s infinite;
}
html [data-rw~="glow-low"] {
  background: radial-gradient(ellipse 60% 45% at 28% 78%, rgba(255,160,110,.55), transparent 70%),
    radial-gradient(ellipse 50% 40% at 78% 58%, rgba(255,210,140,.55), transparent 70%);
  filter: blur(24px); pointer-events: none;
}
html [data-rw~="viewfinder"] { background: radial-gradient(120% 80% at 50% 32%, #3d2619, #120b08 70%); }
html [data-rw~="bokeh"] {
  opacity: .75; filter: blur(18px); mix-blend-mode: screen; transform: translate(-50%, -50%);
  animation: rw-bokeh 9s ease-in-out infinite alternate;
}
html [data-rw~="film-end"] {
  background: radial-gradient(circle at 50% 36%, rgba(255,160,100,.38), transparent 58%), #120b08;
}
html [data-rw~="mo-glow"] {
  background: radial-gradient(circle, #f2b08f 0, rgba(224,112,58,.45) 38%, transparent 70%);
  filter: blur(6px); animation: rw-breathe 3.2s ease-in-out infinite;
}
html [data-rw~="mo-core"] {
  background: radial-gradient(circle, #fff 0, #f1b495 70%); box-shadow: 0 0 30px rgba(224,112,58,.7);
}
html [data-rw~="muted-motif"] { opacity: .35; filter: grayscale(.6); }

/* Hidden overflow can still be scrolled by the browser (focus, media sizing), which
   once left a pushed screen shifted sideways. Clip cannot scroll at all. */
html [data-rw~="clip"] { overflow: clip; }
html [data-rw~="push"] { animation: rw-push .35s cubic-bezier(.2,.8,.2,1) both; }
html [data-rw~="menu-in"] { transform-origin: 50% 0; animation: rw-menu .22s cubic-bezier(.2,.8,.2,1) both; }
html [data-rw~="dlg-in"] { animation: rw-up .3s cubic-bezier(.2,.8,.2,1) both; }
html [data-rw~="fade-in"] { animation: rw-fade .3s ease both; }
html [data-rw~="now-in"] { animation: rw-now .5s ease both; }
html [data-rw~="card-in"] { animation: rw-card .7s cubic-bezier(.2,.8,.2,1) both; }
html [data-rw~="roll"] { animation: rw-roll .7s cubic-bezier(.2,.8,.2,1); }
html [data-rw~="nope"] { animation: rw-nope .42s ease; }
html [data-rw~="tip"] { animation: rw-tip 1.9s ease both; }
html [data-rw~="toast"] { animation: rw-toast 2.6s ease both; }
html [data-rw~="spin"] { animation: rw-spin .9s linear infinite; }
html [data-rw~="slide"] { animation: rw-slide 1.8s ease-in-out infinite; }
html [data-rw~="slide"][data-slow="true"] { animation-duration: 3.6s; opacity: .6; }
html [data-rw~="blink"] { animation: rw-blink 1s steps(2) infinite; }
html [data-rw~="flash"] { animation: rw-flash .45s ease-out both; }
html [data-rw~="launch-out"] { animation: rw-launch .5s ease both; }
html [data-rw~="late-in"] { animation: rw-fade .4s ease 2s both; }
html [data-rw~="fill"] { transition: width .1s linear; }

@keyframes rw-drift { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(16px,-20px) scale(1.08); } }
@keyframes rw-bokeh { to { opacity: .95; transform: translate(-44%,-56%) scale(1.12); } }
@keyframes rw-breathe { 0%,100% { transform: scale(.94); } 50% { transform: scale(1.08); } }
@keyframes rw-push { from { opacity: 0; transform: translateX(28px); } }
@keyframes rw-menu { from { opacity: 0; transform: translateY(-6px) scale(.95); } }
@keyframes rw-up { from { opacity: 0; transform: translateY(16px); } }
@keyframes rw-fade { from { opacity: 0; } }
@keyframes rw-now { from { opacity: 0; transform: translateY(6px); } }
@keyframes rw-card { from { opacity: 0; transform: translateY(-10px) scale(.98); } }
@keyframes rw-roll { from { transform: translateY(45%); opacity: 0; } }
@keyframes rw-nope { 20% { transform: translateX(-5px); } 40% { transform: translateX(5px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(3px); } }
@keyframes rw-tip { 0% { opacity: 0; transform: translateY(4px); } 12%,80% { opacity: 1; transform: none; } 100% { opacity: 0; } }
@keyframes rw-toast { 0% { opacity: 0; transform: translateY(8px); } 8%,88% { opacity: 1; transform: none; } 100% { opacity: 0; } }
@keyframes rw-spin { to { transform: rotate(360deg); } }
@keyframes rw-slide { from { transform: translateX(-110%); } to { transform: translateX(290%); } }
@keyframes rw-blink { 50% { opacity: .2; } }
@keyframes rw-flash { 0% { opacity: .85; } 100% { opacity: 0; } }
@keyframes rw-launch { to { opacity: 0; transform: scale(1.04); } }

html [data-rw~="no-scrollbar"] { scrollbar-width: none; }
html [data-rw~="no-scrollbar"]::-webkit-scrollbar { display: none; }
html textarea[data-rw~="bare"], html input[data-rw~="bare"] { outline: none; }

html [data-rw~="capture-top"] {
  background: linear-gradient(to bottom, rgba(8,5,4,.86), rgba(8,5,4,.55) 70%, transparent);
}
html [data-rw~="capture-bottom"] {
  background: linear-gradient(to top, rgba(8,5,4,.92), rgba(8,5,4,.72) 80%, transparent);
}
html [data-rw~="look-chip"] { background: rgba(8,5,4,.82); }
html [data-rw~="look-grain"] { animation: rw-grain .25s steps(2) infinite; }
@keyframes rw-grain {
  0%,100% { background-position: 0 0; }
  25% { background-position: 32px -16px; }
  50% { background-position: -24px 40px; }
  75% { background-position: 16px 24px; }
}

@media (prefers-reduced-motion: reduce) {
  html [data-rw] { animation: none !important; transition: none !important; }
  html [data-rw] > div { animation: none !important; }
}
`;

let injected = false;

/** Add the Warm Glass stylesheet once, on the web only. */
export function ensureWebStyles() {
  if (injected || Platform.OS !== 'web' || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'rewind-warm-glass';
  style.textContent = CSS;
  document.head.appendChild(style);
}
