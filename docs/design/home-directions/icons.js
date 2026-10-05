'use strict';

// The app icon, Campfire, in the Warm Glass palette. The svg is 512×512 with its corner radius baked in;
// the blur filter #blur18 is defined once in index.html. For the App Store, export a square 1024 px PNG
// without the corner radius or transparency.
const FLAME =
  'M256 112C300 186 352 228 352 300c0 52-42 86-96 86s-96-34-96-86c0-48 34-74 52-114 8 34 22 50 38 58-6-44-12-86 2-132z';

const APP_ICON = {
  name: 'Campfire',
  note: 'A small fire at dusk with five friends’ colours around it: the group gathering for the film.',
  bg: '#4a2c2a',
  svg:
    '<svg viewBox="0 0 512 512"><defs><linearGradient id="ic5-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f2230"/><stop offset="1" stop-color="#6b3a2e"/></linearGradient></defs>' +
    '<rect width="512" height="512" rx="112" fill="url(#ic5-bg)"/>' +
    '<circle cx="256" cy="300" r="150" fill="#ff8a5c" opacity=".55" filter="url(#blur18)"/>' +
    '<g transform="translate(0 -14)"><path d="' +
    FLAME +
    '" fill="#ff8a5c"/>' +
    '<path d="' +
    FLAME +
    '" fill="#ffb36b" transform="translate(256 386) scale(.66) translate(-256 -386)"/>' +
    '<path d="' +
    FLAME +
    '" fill="#ffe7b0" transform="translate(256 386) scale(.34) translate(-256 -386)"/></g>' +
    '<g fill="#b9734f"><rect x="164" y="372" width="184" height="30" rx="15" transform="rotate(-10 256 387)"/><rect x="164" y="372" width="184" height="30" rx="15" transform="rotate(10 256 387)" opacity=".85"/></g>' +
    '<g><circle cx="92" cy="356" r="17" fill="#e07a5f"/><circle cx="132" cy="430" r="17" fill="#e9b44c"/><circle cx="256" cy="458" r="17" fill="#7fb08f"/><circle cx="380" cy="430" r="17" fill="#6d90c4"/><circle cx="420" cy="356" r="17" fill="#b480b0"/></g></svg>',
};
