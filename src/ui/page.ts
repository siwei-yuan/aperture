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
:root {
  --accent: #2563eb;
  --ink: #1f2937;
  --muted: #6b7280;
  --line: #e5e7eb;
  --bg: #ffffff;
  --bg2: #f9fafb;
  --warn: #b45309;
  --danger: #b91c1c;
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); }
header { display: flex; align-items: center; gap: 24px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: 0.4px; }
nav { display: flex; gap: 4px; }
nav button { border: none; background: none; padding: 6px 12px; font: inherit; color: var(--muted); cursor: pointer; border-radius: 6px; }
nav button.active { color: var(--accent); background: #eff6ff; font-weight: 600; }
#sync { margin-left: auto; color: var(--muted); font-size: 12px; }
#banner { display: none; padding: 8px 20px; background: #fef2f2; color: var(--danger); font-size: 13px; }
main { padding: 20px; }
h2 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin: 18px 0 8px; }
select, input { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
button.act { font: inherit; padding: 5px 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
button.ghost { font: inherit; padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); cursor: pointer; }
button.linkish { border: none; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }

/* matrix */
table.matrix { border-collapse: collapse; }
table.matrix th, table.matrix td { border: 1px solid var(--line); padding: 0; }
table.matrix th { background: var(--bg2); font-weight: 500; padding: 6px 10px; text-align: left; }
table.matrix th .cnt { display: block; font-size: 11px; color: var(--muted); font-weight: 400; }
table.matrix th.rowhead { position: sticky; left: 0; z-index: 1; min-width: 170px; }
table.matrix th.rowhead .sub { display: block; font-size: 11px; color: var(--muted); font-weight: 400; }
td.cell { width: 64px; height: 40px; text-align: center; cursor: pointer; position: relative; font-variant-numeric: tabular-nums; }
td.cell:hover { outline: 2px solid var(--accent); outline-offset: -2px; }
td.cell.r0 { background: #f3f4f6; color: #9ca3af; }
td.cell.r1 { background: #dbeafe; }
td.cell.r2 { background: #bfdbfe; }
td.cell.r3 { background: #93c5fd; }
td.cell.r4 { background: #3b82f6; color: #fff; }
td.cell.derived { background: var(--bg); }
td.cell.derived span.v { opacity: 0.55; }
td.cell.derived::after { content: ""; position: absolute; top: 0; right: 0; border: 5px solid transparent; border-top-color: #9ca3af; border-right-color: #9ca3af; }
td.cell.blank { color: #d1d5db; }
tr.sep td { border: none; padding: 10px 0 2px; background: var(--bg); color: var(--muted); font-size: 12px; }
#ctxmenu { position: absolute; display: none; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 4px; z-index: 50; min-width: 190px; }
#ctxmenu button { display: block; width: 100%; text-align: left; border: none; background: none; font: inherit; padding: 6px 10px; cursor: pointer; border-radius: 5px; }
#ctxmenu button:hover { background: var(--bg2); }
#ctxmenu .note { padding: 6px 10px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); margin-top: 4px; }

/* audit */
#audit { margin-top: 14px; }
#audit .people { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
#audit label { display: inline-flex; align-items: center; gap: 4px; color: var(--ink); }

/* reverse view */
.stats { display: flex; gap: 12px; margin: 10px 0 16px; }
.stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; min-width: 110px; }
.stat b { display: block; font-size: 20px; font-weight: 600; }
.stat span { color: var(--muted); font-size: 12px; }
.cols { display: flex; gap: 24px; align-items: flex-start; }
.col { flex: 1; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; background: var(--bg); }
.chip.on { border-color: var(--accent); color: var(--accent); }
.tl-item { border-left: 2px solid var(--line); padding: 4px 0 10px 12px; margin-left: 4px; }
.tl-item.throttled { border-left-color: var(--warn); }
.tl-item.escalated { border-left-color: var(--danger); }
.tl-item .when { color: var(--muted); font-size: 12px; }
.tl-item .kind { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 6px; }
.tl-item.throttled .kind { color: var(--warn); }
.tl-item.escalated .kind { color: var(--danger); }
.tl-item ul { margin: 4px 0 0; padding-left: 18px; }
.ka { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
.ka .lvl { font-size: 11px; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; padding: 0 5px; margin-right: 6px; }
.ka .more { color: var(--muted); font-size: 12px; }
.ka .full { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
.notice { color: var(--muted); font-size: 12px; margin: 6px 0 14px; }

/* circles */
#circles-wrap { display: flex; gap: 20px; align-items: flex-start; }
#graph { border: 1px solid var(--line); border-radius: 10px; background: var(--bg2); }
#drawer { width: 320px; border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
#drawer h3 { margin: 0 0 8px; font-size: 14px; }
#drawer table { border-collapse: collapse; width: 100%; margin: 6px 0; }
#drawer td { border-bottom: 1px solid var(--line); padding: 3px 6px 3px 0; }
.diff { margin: 8px 0; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--bg2); }
.diff .row { display: flex; justify-content: space-between; }
.diff .up { color: var(--accent); }
.diff .down { color: var(--danger); }
.muted { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>aperture</h1>
  <nav>
    <button data-view="circles">Circles</button>
    <button data-view="matrix" class="active">Matrix</button>
    <button data-view="reverse">Disclosures</button>
  </nav>
  <span id="sync"></span>
</header>
<div id="banner"></div>
<main><div id="view"></div></main>
<div id="ctxmenu"></div>
<script>
(function () {
  'use strict';

  var parseTokenFromHash = ${parseTokenFromHash.toString()};
  var token = parseTokenFromHash(location.hash);
  var state = null;
  var headSeq = -1;
  var currentView = 'matrix';
  var reversePerson = null;   // preselected person for the reverse view
  var selectedNode = null;    // circles: selected person
  var draftTiers = [];        // circles: named-but-empty tiers (client-side until first member)
  var pendingException = null; // matrix: person picked for a not-yet-explicit exception row
  var auditChecks = {};       // matrix audit mode selections
  var expandedAtoms = {};     // reverse view ladder expansion

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
      document.getElementById('sync').textContent = 'ledger #' + s.headSeq;
      render();
    });
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
    hideMenu();
    if (!state) {
      // never a silent blank view: say why there is nothing to show
      root.appendChild(el('div', { class: 'muted', text: token
        ? 'loading… (if this persists, the server may be down — restart aperture-ui)'
        : 'No token in the URL. Open the exact URL printed by aperture-ui — it ends with #t=<token>.' }));
      return;
    }
    if (currentView === 'matrix') renderMatrix(root);
    else if (currentView === 'reverse') renderReverse(root);
    else renderCircles(root);
  }

  // ---- view B: policy matrix ------------------------------------------------

  function cellTd(cell, object, subject, ownerRow) {
    var explicit = cell.explicit !== null;
    var v = explicit ? cell.explicit : cell.effective;
    var td = el('td', { class: 'cell r' + v + (explicit ? '' : ' derived') + (v === 0 && !explicit ? ' blank' : '') }, [
      el('span', { class: 'v', text: (!explicit && cell.effective === 0) ? '·' : String(v) }),
    ]);
    var tip = explicit ? 'explicit tuple = ' + v
      : cell.effective > 0 ? 'derived' + (cell.derivedFrom ? ' — inherited from ' + cell.derivedFrom : '') + ' = ' + v
      : 'no policy (default deny)';
    td.title = tip + ' — click to change, right-click for options';

    td.addEventListener('click', function () {
      if (explicit) {
        post('/api/grant', { object: object, relation: 'viewer', subject: subject, resolution: (cell.explicit + 1) % 5 });
      } else {
        var msg = cell.effective > 0
          ? 'This value is ' + (cell.derivedFrom ? 'inherited from ' + cell.derivedFrom : 'derived') + ' = ' + cell.effective +
            '. Create an explicit exception for ' + subject + ' on ' + object + '?'
          : 'No policy here (default deny). Create an explicit tuple ' + object + ' viewer ' + subject + ' = 1?';
        if (confirm(msg)) {
          post('/api/grant', { object: object, relation: 'viewer', subject: subject, resolution: cell.effective > 0 ? cell.effective : 1 });
        }
      }
    });
    td.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      showMenu(ev.pageX, ev.pageY, object, subject, cell, ownerRow);
    });
    return td;
  }

  function showMenu(x, y, object, subject, cell, ownerRow) {
    var m = document.getElementById('ctxmenu');
    m.textContent = '';
    for (var i = 0; i <= 4; i++) (function (r) {
      m.appendChild(el('button', {
        text: 'set ' + r + (cell.explicit === r ? '  (current)' : ''),
        onclick: function () { hideMenu(); post('/api/grant', { object: object, relation: 'viewer', subject: subject, resolution: r }); },
      }));
    })(i);
    if (cell.explicit !== null) {
      m.appendChild(el('button', {
        text: 'inherit (revoke explicit tuple)',
        onclick: function () {
          hideMenu();
          if (confirm('Revoke the explicit tuple? The cell falls back to its derived value. Note: past disclosures cannot be recalled — tightening only affects future ones.')) {
            post('/api/revoke', { object: object, relation: 'viewer', subject: subject });
          }
        },
      }));
    }
    var pathNote = cell.explicit !== null
      ? 'explicit: ' + object + ' viewer ' + subject + ' = ' + cell.explicit
      : cell.effective > 0
        ? 'derived = ' + cell.effective + (cell.derivedFrom ? ' via ' + cell.derivedFrom : '')
        : 'no path — default deny';
    if (ownerRow) pathNote += ' — row: ' + ownerRow;
    m.appendChild(el('div', { class: 'note', text: pathNote }));
    m.style.left = x + 'px'; m.style.top = y + 'px'; m.style.display = 'block';
  }
  function hideMenu() { document.getElementById('ctxmenu').style.display = 'none'; }
  document.addEventListener('click', function (ev) { if (!document.getElementById('ctxmenu').contains(ev.target)) hideMenu(); });

  function renderMatrix(root) {
    var topics = state.topics;
    root.appendChild(el('h2', { text: 'Policy matrix — tiers, then per-person exceptions' }));
    root.appendChild(el('div', { class: 'notice', text: 'Solid cells are explicit tuples (click cycles 0→4). Hollow cells with a corner mark are derived by the evaluator — clicking asks before creating an exception. Tightening never recalls what was already disclosed.' }));

    var thead = el('tr', {}, [el('th', { class: 'rowhead', text: '' })].concat(topics.map(function (t) {
      var th = el('th', {}, [document.createTextNode(t.name), el('span', { class: 'cnt', text: t.atomCount + ' atom' + (t.atomCount === 1 ? '' : 's') })]);
      return th;
    })));
    var table = el('table', { class: 'matrix' }, [thead]);

    state.matrix.tierRows.forEach(function (row) {
      var tr = el('tr', {}, [el('th', { class: 'rowhead', text: 'tier:' + row.tier })]);
      topics.forEach(function (t) { tr.appendChild(cellTd(row.cells[t.name], 'topic:' + t.name, 'tier:' + row.tier + '#member', 'tier:' + row.tier)); });
      table.appendChild(tr);
    });

    table.appendChild(el('tr', { class: 'sep' }, [el('td', { colspan: String(topics.length + 1), text: 'per-person exceptions' })]));

    var personRows = state.matrix.personRows.slice();
    if (pendingException && !personRows.some(function (r) { return r.personId === pendingException; })) {
      var cells = {};
      topics.forEach(function (t) { cells[t.name] = { explicit: null, effective: 0, derivedFrom: null }; });
      personRows.push({ personId: pendingException, tiers: [], cells: cells, pending: true });
    }
    personRows.forEach(function (row) {
      var head = el('th', { class: 'rowhead' }, [
        document.createTextNode(personLabel(row.personId)),
        el('span', { class: 'sub', text: row.tiers.length ? 'in: ' + row.tiers.join(', ') : (row.pending ? 'new exception row — click a cell to sign the first tuple' : 'no tiers') }),
      ]);
      var tr = el('tr', {}, [head]);
      topics.forEach(function (t) { tr.appendChild(cellTd(row.cells[t.name], 'topic:' + t.name, row.personId, personLabel(row.personId))); });
      table.appendChild(tr);
    });

    root.appendChild(table);

    // add-exception picker
    var candidates = state.people.filter(function (p) {
      return !state.matrix.personRows.some(function (r) { return r.personId === p.personId; });
    });
    if (candidates.length) {
      var sel = el('select', {}, [el('option', { value: '', text: '+ add per-person exception…' })].concat(
        candidates.map(function (p) { return el('option', { value: p.personId, text: personLabel(p.personId) + '  (' + p.personId + ')' }); })
      ));
      sel.addEventListener('change', function () { if (sel.value) { pendingException = sel.value; render(); } });
      root.appendChild(el('div', { style: 'margin-top:10px' }, [sel]));
    }

    // audit mode
    var audit = el('div', { id: 'audit' });
    audit.appendChild(el('h2', { text: 'Audit — what someone effectively sees' }));
    var picker = el('div', { class: 'people' });
    state.people.forEach(function (p) {
      if (p.isOwner) return;
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!auditChecks[p.personId];
      cb.addEventListener('change', function () { auditChecks[p.personId] = cb.checked; renderAudit(); });
      picker.appendChild(el('label', {}, [cb, document.createTextNode(personLabel(p.personId))]));
    });
    audit.appendChild(picker);
    audit.appendChild(el('div', { id: 'audit-out' }));
    root.appendChild(audit);
    renderAudit();
  }

  function renderAudit() {
    var out = document.getElementById('audit-out');
    if (!out) return;
    out.textContent = '';
    var chosen = Object.keys(auditChecks).filter(function (p) { return auditChecks[p]; });
    if (!chosen.length) { out.appendChild(el('div', { class: 'muted', text: 'Select people to see their effective row (several = the group-chat ceiling, min per topic).' })); return; }
    Promise.all(chosen.map(function (p) { return api('/api/effective?person=' + encodeURIComponent(p)); })).then(function (rows) {
      var topics = state.topics.map(function (t) { return t.name; });
      var table = el('table', { class: 'matrix' }, [
        el('tr', {}, [el('th', { class: 'rowhead', text: '' })].concat(topics.map(function (t) { return el('th', { text: t }); }))),
      ]);
      chosen.forEach(function (p, i) {
        var tr = el('tr', {}, [el('th', { class: 'rowhead', text: personLabel(p) })]);
        topics.forEach(function (t) {
          var v = rows[i][t] || 0;
          tr.appendChild(el('td', { class: 'cell r' + v, text: String(v) }));
        });
        table.appendChild(tr);
      });
      if (chosen.length > 1) {
        var tr = el('tr', {}, [el('th', { class: 'rowhead', text: 'group ceiling (min)' })]);
        topics.forEach(function (t) {
          var v = Math.min.apply(null, rows.map(function (r) { return r[t] || 0; }));
          tr.appendChild(el('td', { class: 'cell r' + v, text: String(v) }));
        });
        table.appendChild(tr);
      }
      out.appendChild(table);
    });
  }

  // ---- view C: reverse ("what does X know") ----------------------------------

  var reverseTopicFilter = null;

  function renderReverse(root) {
    root.appendChild(el('h2', { text: 'Disclosures — what a person has actually learned' }));
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
        el('div', { class: 'stat' }, [el('b', { text: String(rep.summary.atomCount) }), el('span', { text: 'atoms known' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(rep.summary.deepCount) }), el('span', { text: 'seen at L3+' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(rep.summary.topicCount) }), el('span', { text: 'topics covered' })]),
        el('div', { class: 'stat' }, [el('b', { text: rep.summary.lastTs ? fmtTs(rep.summary.lastTs) : '—' }), el('span', { text: 'last disclosure' })]),
      ]));
      box.appendChild(el('div', { class: 'notice', text: 'This view is read-only: it is a fold over the ledger. Tightening policy in the matrix only affects future disclosures — nothing here can be recalled.' }));

      var cols = el('div', { class: 'cols' });

      // left: timeline
      var left = el('div', { class: 'col' }, [el('h2', { text: 'Disclosure timeline' })]);
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
      var right = el('div', { class: 'col' }, [el('h2', { text: 'What they know (their view)' })]);
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
    root.appendChild(el('h2', { text: 'Circles — who is in which tier' }));
    root.appendChild(el('div', { class: 'notice', text: 'Click a person, then move them between circles from the panel — every move shows its per-topic consequence before you sign it.' }));

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
      svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: ringRadius[t], fill: 'none', stroke: isDraft ? '#9ca3af' : '#bfdbfe', 'stroke-width': 1.5, 'stroke-dasharray': isDraft ? '5 4' : 'none' }));
      var label = svgEl('text', { x: cx, y: cy - ringRadius[t] - 5, 'text-anchor': 'middle', 'font-size': 11, fill: '#6b7280' });
      label.textContent = t + ' · L' + tierGeneralRes(t) + (isDraft ? ' (empty)' : '');
      svg.appendChild(label);
    });
    svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: unknownR, fill: 'none', stroke: '#e5e7eb', 'stroke-width': 1, 'stroke-dasharray': '3 5' }));
    var uLabel = svgEl('text', { x: cx, y: cy - unknownR - 5, 'text-anchor': 'middle', 'font-size': 11, fill: '#9ca3af' });
    uLabel.textContent = 'unknown — no grants, sees nothing';
    svg.appendChild(uLabel);

    // owner at the center
    svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: 16, fill: '#2563eb' }));
    var ownText = svgEl('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#fff' });
    ownText.textContent = 'me';
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
        var g = svgEl('g', { cursor: 'pointer', onclick: function () { selectedNode = p.personId; render(); } });
        var isSel = selectedNode === p.personId;
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 13, fill: key === '(unknown)' ? '#e5e7eb' : '#fff', stroke: isSel ? '#2563eb' : '#9ca3af', 'stroke-width': isSel ? 3 : 1.5 }));
        var initial = svgEl('text', { x: x, y: y + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#374151' });
        initial.textContent = personLabel(p.personId).charAt(0).toUpperCase();
        g.appendChild(initial);
        var name = svgEl('text', { x: x, y: y + 26, 'text-anchor': 'middle', 'font-size': 10, fill: '#6b7280' });
        name.textContent = personLabel(p.personId).slice(0, 16) + (p.tiers.length > 1 ? ' +' + (p.tiers.length - 1) : '');
        g.appendChild(name);
        svg.appendChild(g);
      });
    });

    wrap.appendChild(svg);
    wrap.appendChild(renderDrawer(tierList));
    root.appendChild(wrap);

    var newTier = el('button', { class: 'ghost', text: '+ new circle' });
    newTier.addEventListener('click', function () {
      var name = prompt('Circle (tier) name — it becomes real when the first person moves in:');
      if (name && /^[a-z0-9_-]+$/i.test(name)) { draftTiers.push(name); render(); }
      else if (name) banner('tier names: letters, digits, - and _ only');
    });
    root.appendChild(el('div', { style: 'margin-top:12px' }, [newTier]));
  }

  function renderDrawer(tierList) {
    var drawer = el('div', { id: 'drawer' });
    if (!selectedNode) {
      drawer.appendChild(el('div', { class: 'muted', text: 'Select a person on the map.' }));
      return drawer;
    }
    var p = state.people.find(function (q) { return q.personId === selectedNode; });
    if (!p) { selectedNode = null; drawer.appendChild(el('div', { class: 'muted', text: 'Select a person on the map.' })); return drawer; }

    drawer.appendChild(el('h3', { text: personLabel(p.personId) }));
    drawer.appendChild(el('div', { class: 'muted', text: p.personId }));

    var t = el('table');
    p.aliases.forEach(function (a) { t.appendChild(el('tr', {}, [el('td', { text: a.platform }), el('td', { text: a.externalId })])); });
    if (p.aliases.length) drawer.appendChild(t);
    drawer.appendChild(el('div', { text: p.tiers.length ? 'circles: ' + p.tiers.join(', ') : 'in no circle (sees nothing by default)' }));

    // effective row
    api('/api/effective?person=' + encodeURIComponent(p.personId)).then(function (row) {
      var eff = el('table');
      Object.keys(row).sort().forEach(function (topic) {
        eff.appendChild(el('tr', {}, [el('td', { text: topic }), el('td', { text: 'L' + row[topic] })]));
      });
      drawer.insertBefore(eff, moveBox);
      drawer.insertBefore(el('h2', { text: 'effective resolutions' }), eff);
    });

    var moveBox = el('div');
    moveBox.appendChild(el('h2', { text: 'move to circle' }));
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
        var card = el('div', { class: 'diff' });
        card.appendChild(el('div', { class: 'muted', text: (from ? from + ' → ' : 'unknown → ') + sel.value + ' would change:' }));
        var changed = diff.filter(function (d) { return d.before !== d.after; });
        if (!changed.length) card.appendChild(el('div', { class: 'muted', text: 'no effective change on any topic' }));
        changed.forEach(function (d) {
          card.appendChild(el('div', { class: 'row' }, [
            el('span', { text: d.topic }),
            el('span', { class: d.after > d.before ? 'up' : 'down', text: 'L' + d.before + ' → L' + d.after }),
          ]));
        });
        var confirmBtn = el('button', { class: 'act', text: 'Sign the move' });
        confirmBtn.addEventListener('click', function () {
          post('/api/tier-move', { person: p.personId, from: from, to: sel.value });
        });
        var cancel = el('button', { class: 'ghost', text: 'Cancel', style: 'margin-left:8px' });
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
