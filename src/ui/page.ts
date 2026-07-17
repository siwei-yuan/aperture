/**
 * The owner UI, one self-contained page: no framework, no build step, no
 * external resource. The embedded script talks to /api/* with the bearer
 * token it reads from the URL fragment (which never leaves the browser).
 *
 * XSS discipline: everything that came through the membrane (atom layer
 * texts, aliases, topic names) is untrusted and enters the DOM exclusively
 * through textContent — the el() helper has no innerHTML path for data.
 */
/**
 * Token out of the URL fragment. Some openers (observed: Cursor's built-in
 * browser) percent-encode the fragment, turning "#t=abc" into "#t%3Dabc" —
 * so decode first, and fall back to the raw hash when the percent-encoding
 * is malformed. Kept as an exported function (in ES5-compatible style, no
 * closure over module state) so tests exercise the exact code the page
 * runs: its compiled source is serialized into the page script below.
 */
export function parseTokenFromHash(hash: string): string {
  var decoded = hash;
  try {
    decoded = decodeURIComponent(hash);
  } catch (e) {
    /* malformed %-escape: use the hash as-is */
  }
  var m = /(?:^|[#&])t=([0-9a-f]+)/.exec(decoded);
  return m ? m[1]! : '';
}

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aperture</title>
<style>
/* NASApunk / Starfield: a retro-future spacecraft console. Bone-white hull,
   charcoal instrumentation, one signal-orange accent, gauge blue-gray for
   secondary data. Monospace everywhere — this is a terminal, not a website. */
:root {
  --bone: #e9e7e1;      /* hull interior */
  --panel: #efede7;     /* raised panel face */
  --well: #e2dfd7;      /* recessed well */
  --ink: #1a1a1c;       /* charcoal instrumentation */
  --muted: #6b6f71;     /* warm gray secondary text */
  --line: #b8b4a9;      /* soft rule */
  --hard: #4a4a4e;      /* strong rule */
  --accent: #e85d04;    /* signal orange — THE accent */
  --accent-dim: #f0a068;
  --steel: #8b9aa3;     /* gauge blue-gray */
  --danger: #b3261e;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding-bottom: 40px;
  font: 13px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  color: var(--ink); background: var(--bone);
}
/* faint horizontal scanlines — texture, never legibility */
body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 90;
  background: repeating-linear-gradient(0deg, rgba(26,26,28,0.018) 0 1px, transparent 1px 3px); }

.label, h2 { text-transform: uppercase; letter-spacing: 0.12em; }
h2 { font-size: 11px; font-weight: 700; color: var(--ink); margin: 20px 0 8px; }
h2::before { content: "// "; color: var(--accent); }

header { display: flex; align-items: baseline; gap: 28px; padding: 10px 20px 0;
  border-bottom: 2px solid var(--ink); background: var(--panel); }
header h1 { font-size: 14px; font-weight: 700; margin: 0 0 8px; letter-spacing: 0.14em; }
header h1 .slash { color: var(--accent); }
#stamp { font-size: 10px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; }
nav { display: flex; gap: 2px; align-self: flex-end; }
nav button { border: none; background: none; padding: 7px 16px 9px; font: inherit; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); cursor: pointer;
  border-bottom: 3px solid transparent; }
nav button:hover { color: var(--ink); }
nav button.active { color: var(--ink); font-weight: 700; border-bottom-color: var(--accent); }
#sync { margin-left: auto; align-self: center; padding-bottom: 8px; color: var(--muted); font-size: 11px; letter-spacing: 0.08em; }

/* hazard-striped alert bar */
#banner { display: none; padding: 8px 20px; background: var(--ink); color: var(--accent-dim);
  font-size: 12px; letter-spacing: 0.04em;
  border-left: 16px solid; border-image: repeating-linear-gradient(135deg, var(--accent) 0 7px, var(--ink) 7px 14px) 16; }

main { padding: 18px 20px; }

/* telemetry footer */
footer { position: fixed; bottom: 0; left: 0; right: 0; z-index: 95; display: flex; justify-content: space-between;
  padding: 5px 20px; background: var(--ink); color: var(--bone); font-size: 10px;
  letter-spacing: 0.12em; text-transform: uppercase; }
footer .ok { color: var(--accent-dim); }

select, input[type=text] { font: inherit; font-size: 12px; padding: 4px 8px; border: 1px solid var(--hard);
  border-radius: 0; background: var(--panel); color: var(--ink); }
button.act, button.ghost { font: inherit; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
  padding: 5px 14px; border-radius: 0; cursor: pointer; }
button.act { border: 1px solid var(--accent); background: var(--accent); color: var(--bone); font-weight: 700; }
button.act:hover { background: var(--ink); border-color: var(--ink); }
button.ghost { border: 1px solid var(--hard); background: transparent; color: var(--ink); }
button.ghost:hover { background: var(--accent); border-color: var(--accent); color: var(--bone); }
button.linkish { border: none; background: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 12px; padding: 0; text-align: left; }

/* corner-cut panel (the Starfield 45° notch) */
.cut { position: relative; clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%); }
.cut::before { content: ""; position: absolute; top: 7px; right: -3px; width: 21px; height: 1px;
  background: var(--hard); transform: rotate(45deg); }

/* segmented gauge: 4 cells for L1..L4, filled = granted depth */
.gauge { display: inline-flex; gap: 2px; vertical-align: middle; }
.gauge i { width: 8px; height: 11px; border: 1px solid var(--hard); background: transparent; }
.gauge i.on { background: var(--accent); border-color: var(--accent); }
.gauge.steel i.on { background: var(--steel); border-color: var(--steel); }

/* policy rows (circles drawer): topic name + clickable gauge + value tag */
.prow { display: flex; align-items: center; gap: 10px; padding: 4px 2px; border-bottom: 1px solid var(--line); }
.prow .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
.prow .ptag { font-size: 11px; font-weight: 700; min-width: 52px; text-align: right; }
.prow.mini { padding: 2px 2px; border-bottom: none; }
.prow.mini .pname { font-size: 11px; color: var(--muted); }
.pgauge i { width: 14px; height: 14px; cursor: pointer; }
.pgauge i:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
.warnline { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }

/* overview blocks (no selection): tier × topic mini array */
.ovtier { border: 1px solid var(--line); background: var(--well); padding: 6px 10px; margin-top: 8px; cursor: pointer; }
.ovtier:hover { border-color: var(--accent); }
.ovtier .ovname { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; margin-bottom: 2px; }

/* reverse view */
.stats { display: flex; gap: 12px; margin: 12px 0 16px; }
.stat { border: 1px solid var(--hard); background: var(--panel); padding: 10px 16px; min-width: 130px; }
.stat b { display: block; font-size: 22px; font-weight: 700; }
.stat span { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
.cols { display: flex; gap: 28px; align-items: flex-start; }
.col { flex: 1; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chip { border: 1px solid var(--hard); padding: 1px 8px; font-size: 11px; cursor: pointer;
  background: var(--panel); letter-spacing: 0.04em; }
.chip:hover { border-color: var(--accent); }
.chip.on { border-color: var(--accent); color: var(--bone); background: var(--accent); }
.tl-item { border-left: 2px solid var(--steel); padding: 4px 0 12px 14px; margin-left: 4px; position: relative; }
.tl-item::before { content: ""; position: absolute; left: -5px; top: 8px; width: 8px; height: 8px; background: var(--steel); }
.tl-item.throttled { border-left-color: var(--accent); }
.tl-item.throttled::before { background: var(--accent); }
.tl-item.escalated { border-left-color: var(--danger); }
.tl-item.escalated::before { background: var(--danger); }
.tl-item .when { color: var(--muted); font-size: 11px; }
.tl-item .kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; margin-left: 8px; }
.tl-item.throttled .kind { color: var(--accent); }
.tl-item.escalated .kind { color: var(--danger); }
.tl-item ul { margin: 4px 0 0; padding-left: 18px; }
.ka { border: 1px solid var(--line); background: var(--panel); padding: 8px 12px; margin-bottom: 8px; }
.ka .lvl { font-size: 10px; font-weight: 700; color: var(--accent); border: 1px solid var(--accent); padding: 0 5px; margin-right: 8px; letter-spacing: 0.06em; }
.ka .more { color: var(--muted); font-size: 11px; }
.ka .full { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
.notice { color: var(--muted); font-size: 11px; margin: 6px 0 14px; max-width: 860px; }

/* circles */
#circles-wrap { display: flex; gap: 20px; align-items: flex-start; }
#graph { border: 1px solid var(--hard); background: var(--panel); }
#drawer { width: 330px; border: 1px solid var(--hard); background: var(--panel); padding: 14px; }
#drawer h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; }
#drawer table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 12px; }
#drawer td { border-bottom: 1px solid var(--line); padding: 3px 6px 3px 0; }
.diff { margin: 8px 0; border: 1px solid var(--ink); background: var(--well); padding: 26px 12px 10px; }
/* ::after, not ::before — .cut owns ::before for the corner-cut diagonal */
.diff::after { content: attr(data-directive); position: absolute; top: 8px; left: 12px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.14em; color: var(--accent); }
.diff .row { display: flex; justify-content: space-between; font-size: 12px; }
.diff .up { color: var(--accent); font-weight: 700; }
.diff .down { color: var(--danger); font-weight: 700; }
.muted { color: var(--muted); }

/* knowledge browser */
#knowledge { display: flex; gap: 20px; align-items: flex-start; }
#ktree { width: 250px; flex: none; border: 1px solid var(--hard); background: var(--panel); padding: 8px 6px; }
.knode { cursor: pointer; padding: 3px 8px; display: flex; justify-content: space-between; gap: 8px; font-size: 12px; align-items: center; }
.knode:hover { background: var(--well); }
.knode.on { background: var(--ink); color: var(--bone); }
.knode.on .cnt { color: var(--accent-dim); }
.knode .cnt { color: var(--muted); }
.knode.child { border-left: 1px solid var(--steel); }
.knode.child .tick { width: 8px; height: 1px; background: var(--steel); flex: none; margin-right: 2px; }
.knode .nm { flex: 1; }
#kmain { flex: 1; min-width: 0; }
.kfilters { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; font-size: 11px; }
.kcard { border: 1px solid var(--hard); background: var(--panel); padding: 10px 14px; margin-bottom: 10px; }
.kcard .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; cursor: pointer; }
.kcard .src { color: var(--muted); font-size: 11px; margin-top: 4px; }
/* scope badges: square LED + label */
.badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  padding: 1px 7px; border: 1px solid var(--hard); display: inline-flex; align-items: center; gap: 6px; }
.badge::before { content: ""; width: 8px; height: 8px; flex: none; }
.badge.local { color: var(--accent); border-color: var(--accent); }
.badge.local::before { background: var(--accent); }
.badge.global { color: #5d6f7a; border-color: var(--steel); }
.badge.global::before { background: var(--steel); }
.badge.sealed { color: var(--muted); border-color: var(--line); text-decoration: line-through; }
.badge.sealed::before { background: var(--line); }
.badge.vlevel { color: var(--accent); border-color: var(--accent); }
.badge.vlevel::before { display: none; }
.rung { border-left: 3px solid var(--line); background: var(--well); padding: 5px 10px; margin-top: 3px; font-size: 12px; }
.rung .ent { color: var(--muted); font-size: 10px; letter-spacing: 0.03em; }
.rung.d1 { border-left-color: #b5bfc6; }
.rung.d2 { border-left-color: var(--steel); }
.rung.d3 { border-left-color: var(--accent-dim); }
.rung.d4 { border-left-color: var(--accent); }
.vtable { margin-top: 8px; border-collapse: collapse; }
.vtable th, .vtable td { border-bottom: 1px solid var(--line); padding: 3px 12px 3px 0; font-size: 12px; text-align: left; font-weight: 400; }
.vtable th { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
</style>
</head>
<body>
<header>
  <div>
    <h1>APERTURE <span class="slash">//</span> OWNER CONSOLE</h1>
    <div id="stamp">DISCLOSURE CONTROL &middot; SYS 0.1.0 &middot; LOCAL LINK</div>
  </div>
  <nav>
    <button data-view="circles" class="active">Circles</button>
    <button data-view="knowledge">Knowledge</button>
    <button data-view="reverse">Disclosures</button>
  </nav>
  <span id="sync">STANDBY</span>
</header>
<div id="banner"></div>
<main><div id="view"></div></main>
<footer>
  <span>APERTURE OWNER CONSOLE</span>
  <span id="telemetry">LINK 127.0.0.1 LOCAL ONLY &middot; AWAITING LEDGER</span>
</footer>
<script>
(function () {
  'use strict';

  var parseTokenFromHash = ${parseTokenFromHash.toString()};
  var token = parseTokenFromHash(location.hash);
  var state = null;
  var headSeq = -1;
  var currentView = 'circles';
  var reversePerson = null;   // preselected person for the reverse view
  var selectedNode = null;    // circles: selected person
  var selectedRing = null;    // circles: selected tier (policy panel)
  var draftTiers = [];        // circles: named-but-empty tiers (client-side until first member)
  var expandedAtoms = {};     // reverse view ladder expansion
  var kTopic = null;          // knowledge: selected topic subtree
  var kScope = '';            // knowledge: scope filter ('' = all)
  var kViewer = '';           // knowledge: someone's-perspective filter
  var kExpanded = {};         // knowledge: expanded cards

  // ---- helpers ------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function fmtTs(ts) { return new Date(ts).toLocaleString(); }
  function personLabel(personId) {
    var p = state && state.people.find(function (q) { return q.personId === personId; });
    if (p && p.isOwner) return 'you (owner)';
    if (p && p.aliases.length) return p.aliases[0].platform + ':' + p.aliases[0].externalId;
    return personId.replace(/^person:/, '').slice(0, 12);
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ authorization: 'Bearer ' + token }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { banner('No/invalid token — open the exact URL printed by aperture-ui (the #t=… part matters).', true); throw new Error('unauthorized'); }
      return res.json().then(function (body) {
        if (!res.ok) { banner(body.error || ('HTTP ' + res.status)); throw new Error(body.error || res.status); }
        return body;
      });
    });
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { refresh(); return r; });
  }
  var bannerTimer = null;
  function banner(text, sticky) {
    var b = document.getElementById('banner');
    b.textContent = text; b.style.display = 'block';
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    // sticky errors (no/bad token) stay up — a blank page with no
    // explanation is worse than a nagging red bar
    if (!sticky) bannerTimer = setTimeout(function () { b.style.display = 'none'; }, 6000);
  }

  function refresh() {
    return api('/api/state').then(function (s) {
      state = s; headSeq = s.headSeq;
      document.getElementById('sync').textContent = 'LEDGER #' + s.headSeq;
      document.getElementById('telemetry').innerHTML = '';
      var tele = document.getElementById('telemetry');
      tele.appendChild(el('span', { class: 'ok', text: 'LEDGER HEAD #' + s.headSeq }));
      tele.appendChild(document.createTextNode(' \\u00b7 ' + s.people.length + ' CONTACTS \\u00b7 LINK 127.0.0.1 LOCAL ONLY \\u00b7 SESSION TOKEN ACTIVE'));
      render();
    });
  }

  /* segmented gauge: 4 cells for L1..L4, v of them lit */
  function gauge(v, steel) {
    var g = el('span', { class: 'gauge' + (steel ? ' steel' : '') });
    for (var i = 1; i <= 4; i++) g.appendChild(el('i', { class: i <= v ? 'on' : '' }));
    return g;
  }
  setInterval(function () {
    if (!token) return;
    api('/api/head').then(function (h) { if (h.seq !== headSeq) refresh(); }).catch(function () {});
  }, 3000);
  window.addEventListener('focus', function () { if (token) refresh(); });

  // ---- navigation ----------------------------------------------------------

  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      currentView = b.getAttribute('data-view');
      document.querySelectorAll('nav button').forEach(function (x) { x.classList.toggle('active', x === b); });
      render();
    });
  });

  function render() {
    var root = document.getElementById('view');
    root.textContent = '';
    if (!state) {
      // never a silent blank view: say why there is nothing to show
      root.appendChild(el('div', { class: 'muted', text: token
        ? 'loading… (if this persists, the server may be down — restart aperture-ui)'
        : 'No token in the URL. Open the exact URL printed by aperture-ui — it ends with #t=<token>.' }));
      return;
    }
    if (currentView === 'reverse') renderReverse(root);
    else if (currentView === 'knowledge') renderKnowledge(root);
    else renderCircles(root);
  }

  // ---- policy editing (lives in the circles drawer) ---------------------------

  /* interactive 4-segment gauge: click segment N to stage SET L<N>;
     clicking the current explicit level stages the revoke (back to derived/L0) */
  function policyGauge(cell, onPick) {
    var explicit = cell.explicit !== null;
    var v = explicit ? cell.explicit : cell.effective;
    var g = el('span', { class: 'gauge pgauge' + (explicit ? '' : ' steel') });
    for (var i = 1; i <= 4; i++) (function (n) {
      var seg = el('i', { class: n <= v ? 'on' : '' });
      seg.title = explicit && n === cell.explicit
        ? 'CLEAR \\u2014 back to ' + (cell.derivedFrom ? 'derived' : 'L0 (default deny)')
        : 'SET L' + n;
      seg.addEventListener('click', function (ev) { ev.stopPropagation(); onPick(n); });
      g.appendChild(seg);
    })(i);
    return g;
  }

  /* an AUTHORIZATION card: the exact tuples about to hit the ledger, SIGN / ABORT */
  function directiveCard(box, title, lines, op) {
    box.textContent = '';
    var card = el('div', { class: 'diff cut', 'data-directive': title });
    lines.forEach(function (l) { card.appendChild(el('div', { class: l.warn ? 'warnline' : 'muted', text: l.text })); });
    var sign = el('button', { class: 'act', text: 'SIGN' });
    sign.addEventListener('click', function () { post(op.path, op.body); });
    var abort = el('button', { class: 'ghost', text: 'ABORT', style: 'margin-left:8px' });
    abort.addEventListener('click', function () { box.textContent = ''; });
    card.appendChild(el('div', { style: 'margin-top:8px' }, [sign, abort]));
    box.appendChild(card);
  }

  /* one topic row: name + clickable gauge + value tag. Shared by the tier
     panel and the person panel; exceptionNote keeps the old matrix's
     anti-misedit semantics — touching a derived value warns that it forges
     a per-person exception before anything is signed. */
  function policyRow(topic, cell, subject, directiveBox, exceptionNote) {
    var explicit = cell.explicit !== null;
    var v = explicit ? cell.explicit : cell.effective;
    var tag = explicit ? 'L' + v : (cell.effective > 0 ? 'DRV L' + v : '\\u2014');
    var pick = function (n) {
      var object = 'topic:' + topic;
      if (explicit && n === cell.explicit) {
        directiveCard(directiveBox, 'AUTHORIZATION // POLICY REVOKE', [
          { text: 'REVOKE ' + object + ' viewer ' + subject },
          { text: cell.derivedFrom ? 'falls back to derived via ' + cell.derivedFrom : 'falls back to L0 (default deny)' },
          { text: 'past disclosures cannot be recalled' },
        ], { path: '/api/revoke', body: { object: object, relation: 'viewer', subject: subject } });
      } else {
        var lines = [{ text: 'GRANT ' + object + ' viewer ' + subject + ' = ' + n }];
        if (exceptionNote && !explicit) {
          lines.unshift({ warn: true, text: 'CREATES A PER-PERSON EXCEPTION' + (cell.derivedFrom ? ' \\u2014 value now derived from ' + cell.derivedFrom : '') });
        }
        directiveCard(directiveBox, 'AUTHORIZATION // POLICY GRANT', lines,
          { path: '/api/grant', body: { object: object, relation: 'viewer', subject: subject, resolution: n } });
      }
    };
    var row = el('div', { class: 'prow' }, [
      el('span', { class: 'pname', text: topic }),
      policyGauge(cell, pick),
      el('span', { class: 'ptag' + (explicit ? '' : ' muted'), text: tag }),
    ]);
    row.title = explicit
      ? 'explicit tuple = ' + v + ' \\u2014 click a segment to change, click the lit level to clear'
      : cell.effective > 0
        ? 'derived = ' + v + (cell.derivedFrom ? ' via ' + cell.derivedFrom : '') + ' \\u2014 click a segment to override'
        : 'no policy (default deny) \\u2014 click a segment to grant';
    return row;
  }

  // ---- view C: reverse ("what does X know") ----------------------------------

  var reverseTopicFilter = null;

  function renderReverse(root) {
    root.appendChild(el('h2', { text: 'PANEL 03 \\u2014 DISCLOSURE AUDIT' }));
    var others = state.people.filter(function (p) { return !p.isOwner; });
    var sel = el('select', {}, [el('option', { value: '', text: 'choose a person…' })].concat(
      others.map(function (p) {
        var o = el('option', { value: p.personId, text: personLabel(p.personId) + '  (' + p.personId + ')' });
        if (p.personId === reversePerson) o.selected = true;
        return o;
      })
    ));
    sel.addEventListener('change', function () { reversePerson = sel.value || null; reverseTopicFilter = null; render(); });
    root.appendChild(el('div', {}, [sel]));
    if (!reversePerson) return;

    api('/api/viewer?person=' + encodeURIComponent(reversePerson)).then(function (rep) {
      var box = el('div');

      box.appendChild(el('div', { class: 'stats' }, [
        el('div', { class: 'stat cut' }, [el('b', { text: String(rep.summary.atomCount) }), el('span', { text: 'atoms known' })]),
        el('div', { class: 'stat cut' }, [el('b', { text: String(rep.summary.deepCount) }), el('span', { text: 'seen at L3+' })]),
        el('div', { class: 'stat cut' }, [el('b', { text: String(rep.summary.topicCount) }), el('span', { text: 'topics covered' })]),
        el('div', { class: 'stat cut' }, [el('b', { text: rep.summary.lastTs ? fmtTs(rep.summary.lastTs) : '—' }), el('span', { text: 'last disclosure' })]),
      ]));
      box.appendChild(el('div', { class: 'notice', text: 'This view is read-only: it is a fold over the ledger. Tightening policy in the matrix only affects future disclosures — nothing here can be recalled.' }));

      var cols = el('div', { class: 'cols' });

      // left: timeline
      var left = el('div', { class: 'col' }, [el('h2', { text: 'DISCLOSURE TIMELINE' })]);
      var topicsInTl = {};
      rep.timeline.forEach(function (e) { e.items.forEach(function (i) { (i.topics || []).forEach(function (t) { topicsInTl[t] = true; }); }); });
      var chipRow = el('div', { class: 'chips' });
      Object.keys(topicsInTl).sort().forEach(function (t) {
        var chip = el('span', { class: 'chip' + (reverseTopicFilter === t ? ' on' : ''), text: t });
        chip.addEventListener('click', function () { reverseTopicFilter = reverseTopicFilter === t ? null : t; render(); });
        chipRow.appendChild(chip);
      });
      left.appendChild(chipRow);
      rep.timeline.forEach(function (e) {
        if (reverseTopicFilter && !e.items.some(function (i) { return (i.topics || []).indexOf(reverseTopicFilter) >= 0; })) return;
        var item = el('div', { class: 'tl-item ' + e.kind }, [
          el('span', { class: 'when', text: fmtTs(e.ts) + '  · ledger #' + e.seq }),
          el('span', { class: 'kind', text: e.kind }),
        ]);
        if (e.items.length) {
          var ul = el('ul');
          e.items.forEach(function (i) { ul.appendChild(el('li', { text: '[L' + i.level + '] ' + i.text })); });
          item.appendChild(ul);
        }
        if (e.detail) item.appendChild(el('div', { class: 'muted', text: e.detail }));
        left.appendChild(item);
      });
      if (!rep.timeline.length) left.appendChild(el('div', { class: 'muted', text: 'no disclosures yet' }));

      // right: knowledge inventory grouped by topic
      var right = el('div', { class: 'col' }, [el('h2', { text: 'KNOWN INVENTORY (THEIR VIEW)' })]);
      var byTopic = {};
      rep.knownAtoms.forEach(function (a) {
        var key = (a.topics && a.topics[0]) || '(untagged)';
        (byTopic[key] = byTopic[key] || []).push(a);
      });
      Object.keys(byTopic).sort().forEach(function (topic) {
        right.appendChild(el('h2', { text: topic }));
        byTopic[topic].forEach(function (a) {
          var ka = el('div', { class: 'ka' }, [
            el('span', { class: 'lvl', text: 'L' + a.seenLevel + '/' + a.ladderDepth }),
            document.createTextNode(a.seenText),
            el('div', { class: 'muted', text: 'first disclosed ' + fmtTs(a.firstTs) }),
          ]);
          if (a.hiddenDeeper > 0) {
            var more = el('button', { class: 'linkish more', text: a.hiddenDeeper + ' finer layer' + (a.hiddenDeeper === 1 ? '' : 's') + ' withheld — expand (owner view)' });
            more.addEventListener('click', function () { expandedAtoms[a.atomId] = !expandedAtoms[a.atomId]; render(); });
            ka.appendChild(el('div', {}, [more]));
            if (expandedAtoms[a.atomId]) {
              var ol = el('ol', { class: 'full' });
              a.layers.forEach(function (l) { ol.appendChild(el('li', { text: 'L' + l.level + ': ' + l.text })); });
              ka.appendChild(ol);
            }
          }
          right.appendChild(ka);
        });
      });
      if (!rep.knownAtoms.length) right.appendChild(el('div', { class: 'muted', text: 'they know nothing yet' }));

      cols.appendChild(left); cols.appendChild(right);
      box.appendChild(cols);
      root.appendChild(box);
    });
  }

  // ---- view D: knowledge browser ------------------------------------------------

  function renderKnowledge(root) {
    root.appendChild(el('h2', { text: 'PANEL 02 \\u2014 KNOWLEDGE ARCHIVE' }));

    var params = [];
    if (kScope) params.push('scope=' + encodeURIComponent(kScope));
    if (kTopic) params.push('topic=' + encodeURIComponent(kTopic));
    if (kViewer) params.push('viewer=' + encodeURIComponent(kViewer));
    var atomsUrl = '/api/atoms' + (params.length ? '?' + params.join('&') : '');

    Promise.all([api('/api/topics'), api(atomsUrl)]).then(function (results) {
      var tree = results[0], atoms = results[1];
      var wrap = el('div', { id: 'knowledge' });

      // --- left: topic tree (pipe-diagram ticks for child nodes)
      var side = el('div', { id: 'ktree', class: 'cut' });
      var allRow = el('div', { class: 'knode' + (kTopic === null ? ' on' : '') }, [
        el('span', { class: 'nm', text: 'ALL TOPICS' }),
      ]);
      allRow.addEventListener('click', function () { kTopic = null; render(); });
      side.appendChild(allRow);
      var addNodes = function (nodes, depth) {
        nodes.forEach(function (n) {
          var row = el('div', { class: 'knode' + (depth > 0 ? ' child' : '') + (kTopic === n.path ? ' on' : ''), style: 'margin-left:' + (depth * 14) + 'px' }, [
            depth > 0 ? el('span', { class: 'tick' }) : null,
            el('span', { class: 'nm', text: n.path.split('/').pop() }),
            el('span', { class: 'cnt', text: String(n.atomCount) }),
          ]);
          row.title = n.path;
          row.addEventListener('click', function () { kTopic = kTopic === n.path ? null : n.path; render(); });
          side.appendChild(row);
          addNodes(n.children, depth + 1);
        });
      };
      addNodes(tree, 0);

      // --- right: filters + cards
      var main = el('div', { id: 'kmain' });
      var scopeSel = el('select', {}, [
        el('option', { value: '', text: 'all scopes' }),
        el('option', { value: 'global', text: 'global' }),
        el('option', { value: 'local', text: 'local (room-bound)' }),
        el('option', { value: 'sealed', text: 'sealed (rejected)' }),
      ]);
      scopeSel.value = kScope;
      scopeSel.addEventListener('change', function () { kScope = scopeSel.value; render(); });
      var viewerSel = el('select', {}, [el('option', { value: '', text: 'everything (owner view)' })].concat(
        state.people.filter(function (p) { return !p.isOwner; }).map(function (p) {
          return el('option', { value: p.personId, text: 'as seen by ' + personLabel(p.personId) });
        })
      ));
      viewerSel.value = kViewer;
      viewerSel.addEventListener('change', function () { kViewer = viewerSel.value; render(); });
      var filters = el('div', { class: 'kfilters' }, [
        scopeSel,
        viewerSel,
        el('span', { class: 'muted', text: atoms.length + ' atom' + (atoms.length === 1 ? '' : 's') + (kTopic ? ' in ' + kTopic : '') }),
      ]);
      main.appendChild(filters);
      if (kViewer) {
        main.appendChild(el('div', { class: 'notice', text: 'Perspective mode: only memories ' + personLabel(kViewer) + ' can retrieve, each marked with their deepest visible layer. This is the same ceiling logic retrieval uses.' }));
      }

      if (!atoms.length) main.appendChild(el('div', { class: 'muted', text: 'no atoms match these filters' }));
      atoms.forEach(function (a) { main.appendChild(kCard(a)); });

      wrap.appendChild(side);
      wrap.appendChild(main);
      root.appendChild(wrap);
    });
  }

  function kCard(a) {
    var card = el('div', { class: 'kcard cut' });

    var badge;
    if (a.scope === 'local') {
      badge = el('span', { class: 'badge local', text: 'local · room: ' + a.acquisitionAudience.map(personLabel).join(', ') });
      badge.title = 'usable only where everyone present already heard it; promotion makes it global';
    } else if (a.scope === 'sealed') {
      badge = el('span', { class: 'badge sealed', text: 'sealed — visible nowhere' });
    } else {
      badge = el('span', { class: 'badge global', text: 'global' });
    }

    var head = el('div', { class: 'head' }, [badge]);
    if (a.viewerLevel !== undefined) {
      head.appendChild(el('span', { class: 'badge vlevel', text: 'sees L' + a.viewerLevel + '/' + a.layers.length }));
    }
    head.appendChild(el('span', { text: (a.layers[0] && a.layers[0].text) || '(no layers)' }));
    a.topics.forEach(function (t) {
      var chip = el('span', { class: 'chip', text: t });
      chip.addEventListener('click', function (ev) { ev.stopPropagation(); kTopic = t; render(); });
      head.appendChild(chip);
    });
    head.addEventListener('click', function () { kExpanded[a.atomId] = !kExpanded[a.atomId]; render(); });
    card.appendChild(head);
    card.appendChild(el('div', { class: 'src', text: 'from ' + personLabel(a.who) + ' · ' + a.channel + ' · ' + fmtTs(a.ts) }));

    if (!kExpanded[a.atomId]) return card;

    // full ladder — the owner's shelf shows everything
    var ladder = el('div', { class: 'ladder' });
    a.layers.forEach(function (l) {
      ladder.appendChild(el('div', { class: 'rung d' + l.level, style: 'margin-left:' + ((l.level - 1) * 14) + 'px' }, [
        el('div', {}, [el('b', { text: 'L' + l.level + '  ' }), document.createTextNode(l.text)]),
        l.entities.length ? el('div', { class: 'ent', text: 'entities: ' + l.entities.join(', ') }) : null,
      ]));
    });
    card.appendChild(ladder);

    // who sees which layer — fetched fresh on every expand (grants may have moved)
    var visBox = el('div');
    card.appendChild(visBox);
    api('/api/atoms/' + encodeURIComponent(a.atomId) + '/visibility').then(function (vis) {
      var table = el('table', { class: 'vtable' }, [
        el('tr', {}, [el('th', { text: 'who' }), el('th', { text: 'sees' })]),
      ]);
      var hidden = vis.people.filter(function (p) { return p.level === 0; });
      vis.people.filter(function (p) { return p.level > 0; }).forEach(function (p) {
        table.appendChild(el('tr', {}, [
          el('td', { text: personLabel(p.personId) }),
          el('td', { text: 'L' + p.level + '/' + a.layers.length + ' — "' + (a.layers[p.level - 1] ? a.layers[p.level - 1].text : '') + '"' }),
        ]));
      });
      if (hidden.length) {
        table.appendChild(el('tr', {}, [
          el('td', { class: 'muted', text: hidden.length + ' other' + (hidden.length === 1 ? ' person' : ' people') }),
          el('td', { class: 'muted', text: 'not visible' }),
        ]));
      }
      visBox.appendChild(el('h2', { text: 'EXPOSURE TABLE \\u2014 WHO SEES WHICH LAYER' }));
      visBox.appendChild(table);
    });

    // local atoms carry the two owner verbs — straight pass-throughs
    if (a.scope === 'local') {
      var promoteBtn = el('button', { class: 'act', text: 'PROMOTE' });
      promoteBtn.addEventListener('click', function () {
        if (confirm('SIGN: atom.promoted ' + a.atomId + '\\n\\nIt becomes retrievable everywhere, layer-gated by tier policy.')) {
          post('/api/promote', { atomId: a.atomId });
        }
      });
      var sealBtn = el('button', { class: 'ghost', text: 'SEAL', style: 'margin-left:8px' });
      sealBtn.addEventListener('click', function () {
        if (confirm('SIGN: atom.sealed ' + a.atomId + '\\n\\nIt becomes visible nowhere (stays on the ledger for audit).')) {
          post('/api/seal', { atomId: a.atomId });
        }
      });
      card.appendChild(el('div', { style: 'margin-top:10px' }, [promoteBtn, sealBtn]));
    }

    return card;
  }

  // ---- view A: circles --------------------------------------------------------

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    return n;
  }

  function tierGeneralRes(tierName) {
    var row = state.matrix.tierRows.find(function (r) { return r.tier === tierName; });
    if (!row) return 0;
    var cell = row.cells['general'];
    return cell ? cell.effective : 0;
  }

  function renderCircles(root) {
    root.appendChild(el('h2', { text: 'PANEL 01 \\u2014 RELATIONSHIP RINGS & POLICY' }));
    root.appendChild(el('div', { class: 'notice', text: 'Click a ring to edit that tier\\u2019s per-topic policy; click a person for their exceptions and moves. Every change is staged as an AUTHORIZATION card before it is signed onto the ledger.' }));

    var wrap = el('div', { id: 'circles-wrap' });
    var size = 640, cx = size / 2, cy = size / 2;
    var svg = svgEl('svg', { id: 'graph', width: size, height: size, viewBox: '0 0 ' + size + ' ' + size });

    // rings inner→outer by descending topic:general resolution
    var tierList = state.tiers.map(function (t) { return t.name; });
    draftTiers.forEach(function (t) { if (tierList.indexOf(t) < 0) tierList.push(t); });
    tierList.sort(function (a, b) { return tierGeneralRes(b) - tierGeneralRes(a) || a.localeCompare(b); });
    var ringGap = tierList.length ? Math.min(55, (size / 2 - 110) / Math.max(1, tierList.length)) : 55;
    var ringRadius = {};
    tierList.forEach(function (t, i) { ringRadius[t] = 70 + (i + 1) * ringGap; });
    var unknownR = 70 + (tierList.length + 1) * ringGap + 12;

    tierList.forEach(function (t) {
      var isDraft = !state.tiers.some(function (x) { return x.name === t; });
      var isSel = selectedRing === t;
      var pickRing = function () { selectedRing = t; selectedNode = null; render(); };
      svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: ringRadius[t], fill: 'none',
        stroke: isSel ? '#e85d04' : (isDraft ? '#b8b4a9' : '#8b9aa3'), 'stroke-width': isSel ? 2.5 : 1,
        'stroke-dasharray': isDraft ? '5 4' : 'none' }));
      // fat invisible twin: a 1px stroke is no click target
      svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: ringRadius[t], fill: 'none', stroke: 'rgba(0,0,0,0)',
        'stroke-width': 12, 'pointer-events': 'stroke', cursor: 'pointer', onclick: pickRing }));
      var label = svgEl('text', { x: cx, y: cy - ringRadius[t] - 5, 'text-anchor': 'middle', 'font-size': 10,
        fill: isSel ? '#e85d04' : '#6b6f71', 'letter-spacing': '1', cursor: 'pointer', onclick: pickRing });
      label.textContent = (t + ' \\u00b7 L' + tierGeneralRes(t) + (isDraft ? ' (EMPTY)' : '')).toUpperCase();
      svg.appendChild(label);
    });
    svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: unknownR, fill: 'none', stroke: '#b8b4a9', 'stroke-width': 1, 'stroke-dasharray': '2 6' }));
    var uLabel = svgEl('text', { x: cx, y: cy - unknownR - 5, 'text-anchor': 'middle', 'font-size': 10, fill: '#8b8d8f', 'letter-spacing': '1' });
    uLabel.textContent = 'UNKNOWN \\u2014 NO GRANTS, SEES NOTHING';
    svg.appendChild(uLabel);

    // owner at the center — the one orange element on the chart
    svg.appendChild(svgEl('rect', { x: cx - 14, y: cy - 14, width: 28, height: 28, fill: '#e85d04' }));
    var ownText = svgEl('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 10, fill: '#e9e7e1', 'font-weight': 'bold' });
    ownText.textContent = 'ME';
    svg.appendChild(ownText);

    // group people by their innermost (highest-privilege) ring
    var byRing = {};
    state.people.forEach(function (p) {
      if (p.isOwner) return;
      var ring = null;
      p.tiers.forEach(function (t) { if (ring === null || ringRadius[t] < ringRadius[ring]) ring = t; });
      var key = ring === null ? '(unknown)' : ring;
      (byRing[key] = byRing[key] || []).push(p);
    });

    Object.keys(byRing).forEach(function (key, ringIdx) {
      var r = key === '(unknown)' ? unknownR : ringRadius[key];
      var members = byRing[key];
      members.forEach(function (p, i) {
        // stagger rings so single-member rings don't stack at 12 o'clock (where labels live)
        var angle = (2 * Math.PI * i) / members.length - Math.PI / 2 + (ringIdx + 1) * 0.9;
        var x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
        var g = svgEl('g', { cursor: 'pointer', onclick: function () { selectedNode = p.personId; selectedRing = null; render(); } });
        var isSel = selectedNode === p.personId;
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 13, fill: key === '(unknown)' ? '#dbd8cf' : '#efede7', stroke: isSel ? '#e85d04' : '#4a4a4e', 'stroke-width': isSel ? 3 : 1 }));
        var initial = svgEl('text', { x: x, y: y + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#1a1a1c' });
        initial.textContent = personLabel(p.personId).charAt(0).toUpperCase();
        g.appendChild(initial);
        var name = svgEl('text', { x: x, y: y + 26, 'text-anchor': 'middle', 'font-size': 10, fill: '#6b6f71' });
        name.textContent = personLabel(p.personId).slice(0, 16) + (p.tiers.length > 1 ? ' +' + (p.tiers.length - 1) : '');
        g.appendChild(name);
        svg.appendChild(g);
      });
    });

    wrap.appendChild(svg);
    wrap.appendChild(renderDrawer(tierList));
    root.appendChild(wrap);

    var newTier = el('button', { class: 'ghost', text: '+ NEW RING' });
    newTier.addEventListener('click', function () {
      var name = prompt('Circle (tier) name — it becomes real when the first person moves in:');
      if (name && /^[a-z0-9_-]+$/i.test(name)) { draftTiers.push(name); render(); }
      else if (name) banner('tier names: letters, digits, - and _ only');
    });
    root.appendChild(el('div', { style: 'margin-top:12px' }, [newTier]));
  }

  function renderDrawer(tierList) {
    var drawer = el('div', { id: 'drawer', class: 'cut' });
    if (selectedRing) return ringPanel(drawer, selectedRing);
    if (selectedNode) return personPanel(drawer, tierList);
    return overviewPanel(drawer);
  }

  /* no selection: the compact tier × topic policy array — the old matrix's
     at-a-glance view, one click away from any tier's editor */
  function overviewPanel(drawer) {
    drawer.appendChild(el('h3', { text: 'POLICY OVERVIEW' }));
    if (!state.matrix.tierRows.length) {
      drawer.appendChild(el('div', { class: 'muted', text: 'No tiers yet \\u2014 add a ring and move someone in, or sign a first policy tuple.' }));
      return drawer;
    }
    drawer.appendChild(el('div', { class: 'muted', text: 'Click a ring on the map \\u2014 or a row here \\u2014 to edit that tier\\u2019s grants.' }));
    state.matrix.tierRows.forEach(function (row) {
      var block = el('div', { class: 'ovtier' }, [el('div', { class: 'ovname', text: 'TIER:' + row.tier.toUpperCase() })]);
      state.topics.forEach(function (t) {
        var cell = row.cells[t.name] || { explicit: null, effective: 0 };
        var v = cell.explicit !== null ? cell.explicit : cell.effective;
        block.appendChild(el('div', { class: 'prow mini' }, [
          el('span', { class: 'pname', text: t.name }),
          gauge(v, cell.explicit === null),
          el('span', { class: 'ptag' + (cell.explicit === null ? ' muted' : ''), text: cell.explicit !== null ? 'L' + v : (v > 0 ? 'DRV L' + v : '\\u2014') }),
        ]));
      });
      block.addEventListener('click', function () { selectedRing = row.tier; selectedNode = null; render(); });
      drawer.appendChild(block);
    });
    if (state.matrix.personRows.length) {
      drawer.appendChild(el('div', { class: 'muted', style: 'margin-top:8px', text: state.matrix.personRows.length + ' per-person exception' + (state.matrix.personRows.length === 1 ? '' : 's') + ' \\u2014 click the person on the map.' }));
    }
    return drawer;
  }

  /* ring selected: the tier's per-topic policy editor */
  function ringPanel(drawer, tier) {
    var row = state.matrix.tierRows.find(function (r) { return r.tier === tier; });
    var members = (state.tiers.find(function (t) { return t.name === tier; }) || { members: [] }).members;
    var subject = 'tier:' + tier + '#member';

    drawer.appendChild(el('h3', { text: 'TIER:' + tier.toUpperCase() }));
    drawer.appendChild(el('div', { class: 'muted', text: subject + ' \\u00b7 ' + members.length + ' member' + (members.length === 1 ? '' : 's') }));

    var directiveBox = el('div');
    drawer.appendChild(el('h2', { text: 'POLICY \\u2014 TOPIC GRANTS' }));
    if (!state.topics.length) drawer.appendChild(el('div', { class: 'muted', text: 'no topics yet' }));
    state.topics.forEach(function (t) {
      var cell = (row && row.cells[t.name]) || { explicit: null, effective: 0, derivedFrom: null };
      drawer.appendChild(policyRow(t.name, cell, subject, directiveBox, false));
    });
    drawer.appendChild(directiveBox);

    var back = el('button', { class: 'ghost', text: '\\u2190 OVERVIEW', style: 'margin-top:12px' });
    back.addEventListener('click', function () { selectedRing = null; render(); });
    drawer.appendChild(el('div', {}, [back]));
    return drawer;
  }

  /* person selected: identity, per-topic policy (explicit vs derived), move, audit link */
  function personPanel(drawer, tierList) {
    var p = state.people.find(function (q) { return q.personId === selectedNode; });
    if (!p) { selectedNode = null; return overviewPanel(drawer); }

    drawer.appendChild(el('h3', { text: personLabel(p.personId) }));
    drawer.appendChild(el('div', { class: 'muted', text: p.personId }));

    var t = el('table');
    p.aliases.forEach(function (a) { t.appendChild(el('tr', {}, [el('td', { text: a.platform }), el('td', { text: a.externalId })])); });
    if (p.aliases.length) drawer.appendChild(t);
    drawer.appendChild(el('div', { text: p.tiers.length ? 'circles: ' + p.tiers.join(', ') : 'in no circle (sees nothing by default)' }));

    // per-topic rows: orange = their explicit exception tuple, steel DRV =
    // derived through their tiers. Editing a derived value warns first.
    var directiveBox = el('div');
    var exceptionRow = state.matrix.personRows.find(function (r) { return r.personId === p.personId; });
    api('/api/effective?person=' + encodeURIComponent(p.personId)).then(function (effRow) {
      var box = el('div');
      box.appendChild(el('h2', { text: 'POLICY \\u2014 EFFECTIVE & EXCEPTIONS' }));
      Object.keys(effRow).sort().forEach(function (topic) {
        var cell = (exceptionRow && exceptionRow.cells[topic]) ||
          { explicit: null, effective: effRow[topic], derivedFrom: null };
        box.appendChild(policyRow(topic, cell, p.personId, directiveBox, true));
      });
      box.appendChild(directiveBox);
      drawer.insertBefore(box, moveBox);
    });

    var moveBox = el('div');
    moveBox.appendChild(el('h2', { text: 'MOVE TO RING' }));
    var from = p.tiers[0] || null;
    var sel = el('select', {}, [el('option', { value: '', text: 'choose target…' })].concat(
      tierList.filter(function (x) { return x !== from; }).map(function (x) { return el('option', { value: x, text: x }); })
    ));
    var diffBox = el('div');
    sel.addEventListener('change', function () {
      diffBox.textContent = '';
      if (!sel.value) return;
      var q = '/api/move-preview?person=' + encodeURIComponent(p.personId) + '&to=' + encodeURIComponent(sel.value) +
        (from ? '&from=' + encodeURIComponent(from) : '');
      api(q).then(function (diff) {
        var card = el('div', { class: 'diff cut', 'data-directive': 'AUTHORIZATION // TIER MOVE' });
        // the directive: exactly the tuples that will hit the ledger on SIGN
        if (from) card.appendChild(el('div', { class: 'muted', text: 'REVOKE tier:' + from + ' member ' + p.personId }));
        card.appendChild(el('div', { class: 'muted', text: 'GRANT  tier:' + sel.value + ' member ' + p.personId + ' = 4' }));
        var changed = diff.filter(function (d) { return d.before !== d.after; });
        if (!changed.length) card.appendChild(el('div', { class: 'muted', text: 'no effective change on any topic' }));
        changed.forEach(function (d) {
          card.appendChild(el('div', { class: 'row' }, [
            el('span', { text: d.topic }),
            el('span', { class: d.after > d.before ? 'up' : 'down', text: 'L' + d.before + ' \\u2192 L' + d.after }),
          ]));
        });
        var confirmBtn = el('button', { class: 'act', text: 'SIGN' });
        confirmBtn.addEventListener('click', function () {
          post('/api/tier-move', { person: p.personId, from: from, to: sel.value });
        });
        var cancel = el('button', { class: 'ghost', text: 'ABORT', style: 'margin-left:8px' });
        cancel.addEventListener('click', function () { sel.value = ''; diffBox.textContent = ''; });
        card.appendChild(el('div', { style: 'margin-top:8px' }, [confirmBtn, cancel]));
        diffBox.appendChild(card);
      });
    });
    moveBox.appendChild(sel);
    moveBox.appendChild(diffBox);
    drawer.appendChild(moveBox);

    var know = el('button', { class: 'ghost', text: 'What do they know? →', style: 'margin-top:10px' });
    know.addEventListener('click', function () {
      reversePerson = p.personId; currentView = 'reverse';
      document.querySelectorAll('nav button').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === 'reverse'); });
      render();
    });
    drawer.appendChild(el('div', {}, [know]));
    return drawer;
  }

  // ---- boot -------------------------------------------------------------------

  if (!token) {
    banner('No token in the URL. Start the server and open the printed URL (it ends with #t=…).', true);
    render();
  } else {
    refresh().catch(function () {});
  }
})();
</script>
</body>
</html>`;
}
