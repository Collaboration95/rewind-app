import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use the supplied runtime. No repository dependency changes or installs.
const runtimeRoot = '/Users/speedpowermac/.cache/codex-runtimes/codex-primary-runtime/dependencies';
const runtimeModules =
  process.env.REWIND_RUNTIME_NODE_MODULES || path.join(runtimeRoot, 'node/node_modules');
process.env.RUNTIME_NODE_MODULES = runtimeModules;
process.env.RUNTIME_NODE = path.join(runtimeRoot, 'node/bin/node');
process.env.RUNTIME_PYTHON = path.join(runtimeRoot, 'python/bin/python3');
process.env.RUNTIME_BIN_DIR = path.join(runtimeRoot, 'bin/override');
const runtimeRequire = createRequire(
  path.join(runtimeModules, '../rewind-presentation-bootstrap.cjs'),
);
const { Presentation, PresentationFile, FileBlob } = await import(
  pathToFileURL(runtimeRequire.resolve('@oai/artifact-tool')).href
);
const skillDir =
  process.env.REWIND_PRESENTATION_SKILL_DIR ||
  '/Users/speedpowermac/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations';
const { finalizePresentation, resolvePresentationFont } = await import(
  pathToFileURL(path.join(skillDir, 'container_tools/artifact_tool_utils.mjs')).href
);
const repoRoot = path.resolve(
  process.env.REWIND_SOURCE_ROOT ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..'),
);
const reportDir = path.resolve(
  process.env.REWIND_REPORT_SOURCE_DIR || path.join(repoRoot, 'doc/planning/report'),
);
const workspaceDir = path.resolve(
  process.env.REWIND_BUILD_DIR || '/private/tmp/rewind-presentation-build',
);
const stagingDir = path.join(workspaceDir, 'qa');
const finalPath = path.join(workspaceDir, 'final/rewind-project-demo-draft.pptx');
const renderDir = path.join(workspaceDir, 'renders');
await fs.mkdir(stagingDir, { recursive: true });
await fs.mkdir(path.dirname(finalPath), { recursive: true });
await fs.mkdir(renderDir, { recursive: true });
const codeSha = 'e82dc427cf27264baec5ed1d1b5bc42b036bac11';
const baseUrl = 'https://github.com/Collaboration95/rewind-app';
const source = (file, line) =>
  baseUrl + '/blob/' + codeSha + '/' + file + (line ? '#L' + line : '');
const reportBytes = await fs.readFile(path.join(reportDir, 'report-draft.md'));
const reportHash = createHash('sha256').update(reportBytes).digest('hex');
const provenance = {};
for (const name of [
  'architecture-current.svg',
  'architecture-future.svg',
  'use-cases-overall.svg',
]) {
  const bytes = await fs.readFile(path.join(reportDir, 'diagrams', name));
  provenance[name] = createHash('sha256').update(bytes).digest('hex');
}
const family = resolvePresentationFont({ fontFamily: 'Arial' });
const C = {
  background: '#FFFDF9',
  text: '#29241F',
  muted: '#6B6258',
  accent: '#FFA572',
  line: '#D9CDC1',
  header: '#FFF0E4',
};
const deck = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const noteBase =
  'Draft for issue #362 and lead-owned PR #397. Accepted application source cut: ' +
  codeSha +
  '. Master report source declares factual cut bbcd2bb07179df9313367fd5e1d2afac000af9db. Report content SHA-256: ' +
  reportHash +
  '. All five report chapters are draft. No human contribution, effort, Scrum outcome, lecturer approval or final compliance acceptance is inferred.';

function text(
  slide,
  value,
  x,
  y,
  width,
  height,
  size = 26,
  bold = false,
  color = C.text,
  align = 'left',
) {
  const box = slide.shapes.add({
    geometry: 'textbox',
    position: { left: x, top: y, width, height },
    fill: 'none',
    line: { fill: 'none', width: 0 },
  });
  box.text = value;
  box.text.style = {
    typeface: family,
    fontSize: size,
    bold,
    color,
    alignment: align,
    verticalAlignment: 'top',
    autoFit: 'none',
    wrap: 'word',
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };
  return box;
}
function slide(title, notes, footer = 'Sprint 2 draft') {
  const s = deck.slides.add();
  s.background.fill = C.background;
  text(s, title, 64, 43, 1148, 64, 44, true);
  s.shapes.add({
    geometry: 'line',
    position: { left: 64, top: 122, width: 1152, height: 0 },
    line: { fill: C.accent, width: 3 },
    fill: 'none',
  });
  text(s, footer, 64, 677, 1050, 24, 17, false, C.muted);
  text(s, String(deck.slides.items.length), 1156, 677, 60, 24, 17, false, C.muted, 'right');
  s.speakerNotes.textFrame.setText(noteBase + '\n\n' + notes);
  return s;
}
function table(s, values, widths, top, height, size = 24) {
  const t = s.tables.add({
    rows: values.length,
    columns: values[0].length,
    left: 64,
    top,
    width: 1152,
    height,
    values,
    columnWidths: widths,
  });
  t.styleOptions = { headerRow: true, bandedRows: false };
  t.borders.assign({ style: 'solid', fill: C.line, width: 1 });
  for (let r = 0; r < values.length; r++) {
    t.rows[r].height = height / values.length;
    for (let c = 0; c < values[0].length; c++) {
      const cell = t.getCell(r, c);
      cell.fill = r === 0 ? C.header : C.background;
      cell.text.style = {
        typeface: family,
        fontSize: size,
        bold: r === 0,
        color: C.text,
        verticalAlignment: 'middle',
        autoFit: 'none',
      };
    }
  }
  t.cells
    .block({ row: 0, column: 0, rowCount: values.length, columnCount: values[0].length })
    .assign({ margins: { left: 14, right: 14, top: 10, bottom: 10 }, anchor: 'center' });
  return t;
}
function node(s, value, x, y, width, height, size = 24, fill = '#FFFFFF') {
  const n = s.shapes.add({
    geometry: 'rect',
    position: { left: x, top: y, width, height },
    fill,
    line: { fill: '#6B6258', width: 1.5 },
  });
  n.text = value;
  n.text.style = {
    typeface: family,
    fontSize: size,
    color: C.text,
    alignment: 'center',
    verticalAlignment: 'middle',
    autoFit: 'none',
    insets: { left: 12, right: 12, top: 10, bottom: 10 },
  };
  return n;
}
function connect(s, a, b, fromSide = 'right', toSide = 'left') {
  return s.shapes.connect(a, b, {
    kind: 'straight',
    fromSide,
    toSide,
    line: { fill: '#6B6258', width: 2 },
    tail: { type: 'triangle', width: 'sm', length: 'sm' },
  });
}

// 1. A minimal problem-to-solution cover with editable text.
{
  const s = deck.slides.add();
  s.background.fill = C.background;
  text(s, 'Rewind', 64, 100, 1120, 100, 70, true);
  text(s, 'Private memories for close friends living apart', 64, 229, 1060, 90, 38);
  text(
    s,
    'Ordinary moments enter a sealed capsule.\nA later shared film returns them to the group.',
    64,
    386,
    1020,
    120,
    32,
  );
  text(
    s,
    'SWE5006 Practice Module\nSprint 2 presentation and demo draft',
    64,
    601,
    1120,
    72,
    22,
    false,
    C.muted,
  );
  s.speakerNotes.textFrame.setText(
    noteBase +
      '\n\nSources: master report §§1.1–1.4; ' +
      source('doc/planning/context/project-brief.md', 9) +
      '; ' +
      source('doc/planning/proposals/proposal-rewind.md') +
      '. Reduced pressure to curate is the proposal rationale, not a measured study outcome.',
  );
}

// 2. Editable scope catalogue adapted from the report's overall UC model.
{
  const s = slide(
    'The private group journey',
    'Sources: master report §§1.4.1–1.4.2 and 3.3; report diagrams/use-cases-overall.svg SHA-256 ' +
      provenance['use-cases-overall.svg'] +
      '; accepted package catalogues under doc/planning/report/packages/access, capture, cycle and participation at ' +
      codeSha +
      '. Archive/client scope is traced to master report and current application code. The Archive package is absent from this accepted checkout and is not claimed as accepted here.',
  );
  table(
    s,
    [
      ['Stage', 'Use cases', 'User-visible purpose'],
      ['Access', 'UC01–UC03', 'Account, private group and invitation'],
      ['Capture', 'UC04–UC06', 'Video/photo, review, allowance and correction'],
      ['Cycle', 'UC07–UC08', 'Close collection, compile, reveal and retain'],
      ['Participation', 'UC09–UC11', 'Prompt, opt-in reminder and private chat'],
      ['Archive and client', 'UC12–UC14', 'Playback, authorized download and install/update'],
    ],
    [270, 230, 652],
    155,
    420,
    24,
  );
  text(
    s,
    'Public feeds, discovery and broader account management remain outside the first delivery.',
    64,
    602,
    1135,
    59,
    24,
    false,
    C.muted,
  );
}

// 3. Native editable adaptation of architecture-current.svg.
{
  const s = slide(
    'Current pilot architecture',
    'Sources: master report §3.1; diagrams/architecture-current.svg SHA-256 ' +
      provenance['architecture-current.svg'] +
      '; ' +
      source('docs/domain/session-contract.md') +
      '; ' +
      source('docs/architecture/hosted-demo-persistence.md') +
      '. Native slide objects reuse the source component responsibilities and connections, with horizontal reflow. Prepared S3/direct-upload adapters are not live hosted acceptance.',
  );
  const ui = node(s, 'Expo / React\nWeb and PWA\nNative adapters share UI', 64, 174, 274, 116);
  const adapters = node(
    s,
    'Typed API and\ncapture adapters\nPublic-only shell cache',
    440,
    174,
    292,
    116,
  );
  const http = node(
    s,
    'Node HTTP boundary\nSession, selected group\nand membership',
    838,
    174,
    378,
    116,
  );
  const domain = node(
    s,
    'Group, chat, reminders\nContribution and\ncycle lifecycle functions',
    440,
    370,
    292,
    116,
  );
  const worker = node(
    s,
    'Durable jobs and leases\nBounded retry\nFFmpeg processing',
    838,
    370,
    378,
    116,
  );
  const db = node(s, 'SQLite metadata\nReceipts and events', 440, 562, 292, 80);
  const store = node(s, 'Media-store adapter\nLocal store, S3 gated', 838, 562, 378, 80);
  connect(s, ui, adapters);
  connect(s, adapters, http);
  connect(s, http, domain, 'bottom', 'top');
  connect(s, http, worker, 'bottom', 'top');
  connect(s, domain, db, 'bottom', 'top');
  connect(s, worker, store, 'bottom', 'top');
  connect(s, store, db, 'left', 'right');
  text(
    s,
    'Password account pilot\nReal and Demo identities\nremain separate',
    64,
    374,
    300,
    150,
    26,
  );
  text(
    s,
    'Same-origin HTTPS /api\nCookie for browser authority\nOpaque token for native',
    64,
    541,
    310,
    109,
    22,
    false,
    C.muted,
  );
}

// 4. The design tension is expressed as flat editable text rather than new artwork.
{
  const s = slide(
    'Quota, lifecycle and private-media tension',
    'Sources: ' +
      source('server/src/contributions/index.ts', 8) +
      '; ' +
      source('server/src/contributions/ledger.ts') +
      '; ' +
      source('server/src/cycles/lifecycle.ts', 38) +
      '; ' +
      source('server/src/archive/capabilities.ts') +
      '; capture package UC06 and cycle package UC07/UC08. Policy is per member within the source-defined seven-day quota window. Maximum video length is 15 seconds. Photo charges one item and three seconds. These limits are implementation rules, not measured performance.',
  );
  text(s, 'Contribution consistency', 64, 170, 390, 58, 30, true);
  text(
    s,
    'Five items and 30 seconds in the quota window.\nAcceptance, quota reservation and retry identity agree in one transaction.',
    466,
    170,
    736,
    108,
    26,
  );
  text(s, 'Recoverable time boundaries', 64, 327, 390, 73, 30, true);
  text(
    s,
    'Closure creates the successor and durable film work.\nVerified output controls publication. Premiere lasts 24 hours from publication.',
    466,
    327,
    736,
    118,
    26,
  );
  text(s, 'Fresh media authority', 64, 497, 390, 66, 30, true);
  text(
    s,
    'Playback/download recheck session, group, release and exact media.\nGroup or session changes clear stale protected context.',
    466,
    497,
    736,
    122,
    26,
  );
}

// 5. One real pattern comparison, kept as an editable native table.
{
  const s = slide(
    'Pattern comparison for cycle recovery',
    'Sources: ' +
      source('doc/planning/report/packages/cycle/design-problem.md') +
      '; ' +
      source('server/src/cycles/scheduler.ts', 45) +
      '; ' +
      source('server/src/cycles/lifecycle.ts', 312) +
      '; ' +
      source('server/src/jobs/index.ts', 599) +
      '; ' +
      source('server/src/jobs/index.ts', 899) +
      '. The before model is a hypothetical alternative. Rewind has no invented State or Command class hierarchy. The selected source design uses functions and persisted records, with claim-generation fencing.',
  );
  table(
    s,
    [
      ['Candidate', 'Useful idea', 'Decision in this implementation'],
      [
        'State',
        'Explicit allowed transitions',
        'Persisted state and transactional functions avoid duplicate state objects',
      ],
      ['Command', 'Work identity and retry', 'Durable job/input rows survive restart'],
      ['Polling', 'Discover due work', 'Wake-up mechanism, not the consistency guarantee'],
      [
        'Selected design',
        'Persisted transition plus queue',
        'Unique receipts, leases and claim generations fence stale workers',
      ],
    ],
    [236, 376, 540],
    160,
    400,
    23,
  );
  text(
    s,
    'A worker executes outside the transaction, then commits only with its current claim and verified output.',
    64,
    597,
    1135,
    59,
    26,
  );
}

// 6. Native editable adaptation of architecture-future.svg.
{
  const s = slide(
    'Future compliance architecture',
    'Sources: master report §3.1 and final draft gates; diagrams/architecture-future.svg SHA-256 ' +
      provenance['architecture-future.svg'] +
      '; issues #363/#364 OIDC, #261 PostgreSQL, #175 managed recovery, #365–#367 pre-upload retro. This is a future target. It does not claim deployed identity/storage/provider activation or final native acceptance. Native slide objects preserve the source responsibilities and connections with a horizontal reflow.',
  );
  text(s, 'Sprint 3 obligations remain pending', 64, 153, 1152, 44, 28, true, C.muted);
  const client = node(
    s,
    'Web/PWA and deferred native\nPre-upload retro processing',
    64,
    224,
    480,
    108,
    24,
    C.header,
  );
  const identity = node(
    s,
    'Managed OIDC\nIdentity mapping and reviewed session migration',
    700,
    224,
    516,
    108,
    24,
    C.header,
  );
  const api = node(
    s,
    'Reviewed API / workers\nPrivate group, media and lifecycle boundaries',
    400,
    389,
    480,
    96,
    24,
    C.header,
  );
  const db = node(
    s,
    'PostgreSQL and managed recovery\nReconciliation, cutover and restore',
    64,
    548,
    570,
    98,
    24,
    C.header,
  );
  const store = node(
    s,
    'Private versioned storage\nLive delivery, provider receipts and inventory gates',
    710,
    548,
    506,
    98,
    24,
    C.header,
  );
  connect(s, client, api, 'bottom', 'top');
  connect(s, identity, api, 'bottom', 'top');
  connect(s, api, db, 'bottom', 'top');
  connect(s, api, store, 'bottom', 'top');
}

// 7. The four course areas with factual evidence and unfilled obligations.
{
  const s = slide(
    'Evidence across the four course areas',
    'Sources: ' +
      source('doc/planning/context/project-brief.md', 9) +
      '; master report §§2, 3, 4 and 5; issue #362 execution contract. Backlog/PR artifacts establish workflow records, not unrecorded Scrum outcomes or individual effort. Full model incorporation and factual human use-case/pattern ownership remain pending.',
  );
  table(
    s,
    [
      ['Course area', 'Draft evidence', 'Remaining factual or delivery gap'],
      [
        'Agile practices',
        'Backlog, Sprint plans and focused PRs',
        'Actual Scrum outcomes and member effort',
      ],
      [
        'Analysis and design',
        'UC01–UC14, paired flow models and source pins',
        'Full incorporation and final source refresh',
      ],
      [
        'Design patterns',
        'Grounded candidates and functional implementation choices',
        'Human ownership and final model review',
      ],
      [
        'DevSecOps',
        'Quality/security checks and release automation',
        'ENOSPC recovery and actual delivery acceptance',
      ],
    ],
    [267, 438, 447],
    163,
    449,
    24,
  );
}

// 8. Accepted verification is separated from outstanding platform/host gates.
{
  const s = slide(
    'Verified local scope and open delivery gates',
    'Sources: PR #387 merged f1d74c510ecff566a25b1449daa8352befa9f00c; #388 merged da96b2444e7fb1f7ff2867c6b003a88eccba2f9d; #392 merged 7827a5b42d57e62e6e6c829b07665cbcd650592c; #396 tested edc8fc9506e4992891cc93109ad859af99f0d93f and merged bbcd2bb07179df9313367fd5e1d2afac000af9db. #396 body records two fresh strict HTTPS Firefox journeys and cleanup. Deploy dev runs https://github.com/Collaboration95/rewind-app/actions/runs/37143129969 and https://github.com/Collaboration95/rewind-app/actions/runs/37143383024 failed [Errno 28] No space left on device during host-side bundle verification/staging, before activation. No new product test or fixture ran for this presentation.',
  );
  table(
    s,
    [
      ['Evidence', 'Actual scope'],
      [
        'Accepted source changes',
        'Photo group context #387, chat prefix #388, portrait guidance #392',
      ],
      [
        'Local strict HTTPS Firefox #396',
        'Two fresh runs cover chat retry, group switching, synthetic media, cycle release and Archive',
      ],
      [
        'Hosted Deploy dev',
        'Runs 37143129969 / 37143383024 failed host-side verification/staging with ENOSPC before activation',
      ],
      [
        'Acceptance gates',
        'Actual Safari/Home Screen audio/lifecycle, hardware, hosted/S3 and provider outcomes',
      ],
    ],
    [360, 792],
    163,
    435,
    24,
  );
  text(
    s,
    'Local synthetic evidence does not establish physical-device or hosted delivery acceptance.',
    64,
    620,
    1152,
    42,
    24,
    false,
    C.muted,
  );
}

// 9. A source-backed demo route, with explicit rehearsal limits.
{
  const s = slide(
    'Demo route with a disposable local fixture',
    'Sources: presentation/demo-script.md; ' +
      source('scripts/run-real-account-e2e.mjs', 151) +
      '; ' +
      source('tests/e2e-real-account/real-account.spec.mjs', 312) +
      '; ' +
      source('tests/e2e-real-account/chat-verification.mjs', 27) +
      '; ' +
      source('tests/e2e-real-account/group-switch-verification.mjs', 59) +
      '. Existing runner is headless Firefox, strict HTTPS, Demo disabled, owned ports/data/profile and synthetic media. Cycle timing is controlled only in the disposable fixture database. The route is a planned narration tied to accepted assertions, not a newly executed rehearsal, physical recording or hosted test.',
  );
  text(s, '1  Owner creates a group. Invited member joins.', 64, 174, 1152, 54, 28);
  text(s, '2  Capture names the group. Chat keeps a lost-response retry.', 64, 249, 1152, 67, 28);
  text(s, '3  Member joins a second group and switches context.', 64, 337, 1152, 58, 28);
  text(
    s,
    '4  Synthetic media and controlled cycles reach released Archive.',
    64,
    416,
    1152,
    67,
    28,
  );
  text(s, '5  Outsider access and reused media capability remain denied.', 64, 505, 1152, 65, 28);
  text(
    s,
    'Headless fixture route available. Visible rehearsal and hardware/hosted/provider acceptance remain separate work.',
    64,
    599,
    1152,
    67,
    23,
    false,
    C.muted,
  );
}

const candidatePath = path.join(stagingDir, 'candidate.pptx');
await (await PresentationFile.exportPptx(deck)).save(candidatePath);
const result = await finalizePresentation({
  workspaceDir,
  candidatePath,
  finalPath,
  explicitTotalSlideCount: 9,
  requiredNativeTableOwnerSlides: [2, 5, 7, 8],
  requiredNativeChartOwnerSlides: [],
  pythonExecutable: path.join(runtimeRoot, 'python/bin/python3'),
  integrityValidatorPath: path.join(
    skillDir,
    'container_tools/inspect_presentation_package_integrity.py',
  ),
  layoutValidatorPath: path.join(
    skillDir,
    'container_tools/inspect_presentation_layout_geometry.py',
  ),
  layoutArgs: [
    '--expected-slide-size-emu',
    '12192000,6858000',
    '--validate-bullet-geometry',
    '--validate-heading-fit',
    '--require-native-table-slide',
    '2',
    '--require-native-table-slide',
    '5',
    '--require-native-table-slide',
    '7',
    '--require-native-table-slide',
    '8',
  ],
  fontPolicy: { basis: 'design', families: [family] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(stagingDir, 'validation.json'),
});
const finalDeck = await PresentationFile.importPptx(await FileBlob.load(finalPath));
for (let i = 0; i < finalDeck.slides.items.length; i++) {
  const s = finalDeck.slides.items[i];
  const image = await finalDeck.export({ slide: s, format: 'png', scale: 1 });
  await fs.writeFile(
    path.join(renderDir, 'slide-' + (i + 1) + '.png'),
    new Uint8Array(await image.arrayBuffer()),
  );
  const layout = await s.export({ format: 'layout' });
  await fs.writeFile(
    path.join(stagingDir, 'slide-' + (i + 1) + '.layout.json'),
    await layout.text(),
  );
}
console.log(
  JSON.stringify(
    { finalPath, slideCount: finalDeck.slides.items.length, renderDir, result },
    null,
    2,
  ),
);
