'use strict';

// App icon candidates in the Warm Glass palette (cream #fff3e2, cocoa #3a2a22, peach #ff9f6b,
// honey #e9b44c, coral #e07a5f). Each svg is 512×512 with its own corner radius; the blur
// filters #blur10 / #blur18 are defined once in index.html. For the real app, export each one
// to PNG (1024 px) with text outlined.
const RING =
  '<path d="M279.4 89.6A168 168 0 0 1 407.0 182.4"/><path d="M421.4 226.8A168 168 0 0 1 372.7 376.8"/><path d="M334.9 404.3A168 168 0 0 1 177.1 404.3"/><path d="M139.3 376.8A168 168 0 0 1 90.6 226.8" opacity=".45"/><path d="M105.0 182.4A168 168 0 0 1 232.6 89.6" opacity=".45"/>';
const FLAME =
  'M256 112C300 186 352 228 352 300c0 52-42 86-96 86s-96-34-96-86c0-48 34-74 52-114 8 34 22 50 38 58-6-44-12-86 2-132z';

const ICONS = [
  {
    id: 'ember',
    no: 1,
    name: 'Ember ring',
    note: 'The shutter on Home, as an icon: a warm core inside the five-moment ring, three lit.',
    bg: '#ffe6cf',
    svg:
      '<svg viewBox="0 0 512 512"><defs><linearGradient id="ic1-bg" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#fff6ea"/><stop offset="1" stop-color="#ffd2ad"/></linearGradient>' +
      '<radialGradient id="ic1-core" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#fff1dc"/><stop offset=".45" stop-color="#ffaa72"/><stop offset="1" stop-color="#ec7b55"/></radialGradient></defs>' +
      '<rect width="512" height="512" rx="112" fill="url(#ic1-bg)"/>' +
      '<circle cx="256" cy="262" r="150" fill="#ff9f6b" opacity=".55" filter="url(#blur18)"/>' +
      '<g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round">' +
      RING +
      '</g><circle cx="256" cy="256" r="94" fill="url(#ic1-core)"/>' +
      '<ellipse cx="226" cy="222" rx="34" ry="20" fill="#fff" opacity=".55" transform="rotate(-30 226 222)"/></svg>',
  },
  {
    id: 'rewind',
    no: 2,
    name: 'Soft rewind',
    note: 'Two rounded rewind marks in cream on a peach-to-coral glow, with a glass sheen on top.',
    bg: '#f6936a',
    svg:
      '<svg viewBox="0 0 512 512"><defs><linearGradient id="ic2-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffbe86"/><stop offset=".55" stop-color="#ff9a6c"/><stop offset="1" stop-color="#e07052"/></linearGradient>' +
      '<linearGradient id="ic2-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
      '<rect width="512" height="512" rx="112" fill="url(#ic2-bg)"/>' +
      '<circle cx="380" cy="400" r="120" fill="#ffd27a" opacity=".45" filter="url(#blur18)"/>' +
      '<g fill="#fff3e2" stroke="#fff3e2" stroke-width="40" stroke-linejoin="round">' +
      '<path d="M246 172v168L124 256z"/><path d="M396 172v168L274 256z" opacity=".72"/></g>' +
      '<path d="M0 112A112 112 0 0 1 112 0h288a112 112 0 0 1 112 112v96C380 250 132 250 0 208z" fill="url(#ic2-sheen)"/></svg>',
  },
  {
    id: 'capsule',
    no: 3,
    name: 'Time capsule',
    note: 'A glass capsule on cocoa, half full of warm light: moments sealed until the film.',
    bg: '#3a2a22',
    svg:
      '<svg viewBox="0 0 512 512"><defs><linearGradient id="ic3-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c362b"/><stop offset="1" stop-color="#271b15"/></linearGradient>' +
      '<linearGradient id="ic3-light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd08a"/><stop offset=".5" stop-color="#ffa26c"/><stop offset="1" stop-color="#ec7b55"/></linearGradient>' +
      '<clipPath id="ic3-cap"><rect x="182" y="92" width="148" height="328" rx="74"/></clipPath></defs>' +
      '<rect width="512" height="512" rx="112" fill="url(#ic3-bg)"/>' +
      '<ellipse cx="256" cy="340" rx="120" ry="110" fill="#ff9f6b" opacity=".5" filter="url(#blur18)"/>' +
      '<rect x="182" y="92" width="148" height="328" rx="74" fill="#fff" fill-opacity=".1"/>' +
      '<rect x="182" y="256" width="148" height="170" fill="url(#ic3-light)" clip-path="url(#ic3-cap)"/>' +
      '<path d="M182 256h148" stroke="#fff3e2" stroke-width="6" opacity=".6"/>' +
      '<rect x="182" y="92" width="148" height="328" rx="74" fill="none" stroke="#fff3e2" stroke-opacity=".55" stroke-width="7"/>' +
      '<rect x="204" y="124" width="20" height="264" rx="10" fill="#fff" opacity=".28"/></svg>',
  },
  {
    id: 'soft-r',
    no: 4,
    name: 'Soft r.',
    note: 'The page’s r. mark: a soft italic Fraunces r in cocoa, with a glowing peach full stop.',
    bg: '#fff3e2',
    svg:
      '<svg viewBox="0 0 512 512"><defs><radialGradient id="ic4-dot" cx=".38" cy=".35" r=".7"><stop offset="0" stop-color="#ffe3c2"/><stop offset=".5" stop-color="#ff9f6b"/><stop offset="1" stop-color="#e57852"/></radialGradient></defs>' +
      '<rect width="512" height="512" rx="112" fill="#fff3e2"/>' +
      '<circle cx="420" cy="430" r="150" fill="#ffc79a" opacity=".55" filter="url(#blur18)"/>' +
      '<text x="128" y="392" font-size="420" font-family="Fraunces,serif" font-style="italic" font-weight="500" fill="#3a2a22" style="font-variation-settings:\'SOFT\' 100,\'opsz\' 144">r</text>' +
      '<circle cx="372" cy="362" r="58" fill="#ff9f6b" opacity=".6" filter="url(#blur10)"/>' +
      '<circle cx="372" cy="356" r="40" fill="url(#ic4-dot)"/></svg>',
  },
  {
    id: 'campfire',
    no: 5,
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
  },
];
