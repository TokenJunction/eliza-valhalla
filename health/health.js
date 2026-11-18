(function () {
  'use strict';
  var LABELS = { 'supabase': 'Supabase database', 'upstash-redis': 'Upstash Redis cache', 'elizaos': 'elizaOS agents' };
  var STATUS_CLASS = { up: 'pill-ok', ok: 'pill-ok', down: 'pill-bad', degraded: 'pill-bad', partial: 'pill-warn', not_configured: 'pill-warn', disabled: 'pill-ok', enabled: 'pill-bad' };
  var STATUS_TEXT = { up: 'Up', ok: 'All systems operational', down: 'Down', degraded: 'Degraded', partial: 'Partially configured', not_configured: 'Not configured', disabled: 'Disabled', enabled: 'Enabled' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pill(status) {
    return el('span', 'pill ' + (STATUS_CLASS[status] || 'pill-wait'), STATUS_TEXT[status] || status);
  }

  function card(title, status, lines) {
    var c = el('article', 'card');
    var h = el('h3', null, title);
    h.appendChild(pill(status));
    c.appendChild(h);
    lines.forEach(function (l) { c.appendChild(el('p', 'muted', l)); });
    return c;
  }

  function render(data) {
    var overall = document.getElementById('overall');
    overall.className = 'pill ' + (STATUS_CLASS[data.status] || 'pill-wait');
    overall.textContent = STATUS_TEXT[data.status] || data.status;
    var execution = data.execution || {};
    document.getElementById('meta').textContent =
      'Mode: ' + (execution.mode || data.mode) + ' · checked ' + new Date(data.checkedAt).toLocaleTimeString();

    var systems = document.getElementById('systems');
    systems.replaceChildren();
    data.checks.forEach(function (c) {
      var lines = [];
      if (c.latencyMs != null) lines.push('Latency ' + c.latencyMs + ' ms');
      if (c.error) lines.push('Error: ' + c.error);
      if (c.status === 'not_configured') lines.push('Set the server-side secrets to enable.');
      systems.appendChild(card(LABELS[c.name] || c.name, c.status, lines));
    });

    var safety = document.getElementById('safety');
    safety.replaceChildren();
    [['Trading', data.safety.trading], ['Social posting', data.safety.social], ['Key storage', data.safety.keyStorage]]
      .forEach(function (s) { safety.appendChild(card(s[0], s[1], [])); });
    safety.appendChild(card('Owner access', data.safety.adminConfigured ? 'up' : 'not_configured', []));
    safety.appendChild(card(
      'Execution capability',
      execution.liveTrading ? 'enabled' : 'disabled',
      [
        'Mode: ' + (execution.mode || data.mode || 'unknown'),
        'Signed: ' + (execution.signing === 'available' ? 'available' : 'unavailable'),
        'Config: ' + String(execution.configHash || 'not reported').slice(0, 16)
      ]
    ));
    var note = document.getElementById('executionNote');
    if (note) {
      note.textContent = execution.liveTrading
        ? 'A signed server capability currently authorizes live execution. This page never enables it.'
        : 'No signed server capability authorizes live execution. Paper mode only.';
    }
  }

  function renderError(msg) {
    var overall = document.getElementById('overall');
    overall.className = 'pill pill-bad';
    overall.textContent = 'Unreachable';
    document.getElementById('meta').textContent = msg;
  }

  function proposalRow(proposal) {
    var item = el('article', 'proposal');
    var head = el('div', 'proposal-head');
    head.appendChild(el('code', 'proposal-id', proposal.id || 'unknown'));
    head.appendChild(el('span', 'pill pill-warn', 'Pending approval'));
    item.appendChild(head);

    var created = proposal.createdAt ? new Date(proposal.createdAt) : null;
    var when = created && !isNaN(created.getTime()) ? created.toLocaleString() : 'time unavailable';
    var bits = ['Created ' + when];
    if (proposal.files && proposal.files.length) {
      bits.push(proposal.files.length + (proposal.files.length === 1 ? ' file' : ' files'));
    }
    bits.push(proposal.testsTimedOut ? 'Tests timed out' : proposal.testsOk ? 'Tests passed' : 'Tests not passed');
    bits.push(proposal.syntaxOk ? 'Syntax passed' : 'Syntax not passed');
    if (proposal.patchSha256) bits.push('Patch ' + proposal.patchSha256.slice(0, 12));
    item.appendChild(el('p', 'proposal-meta', bits.join(' · ')));

    if (proposal.files && proposal.files.length) {
      var files = el('ul', 'proposal-files');
      proposal.files.forEach(function (file) { files.appendChild(el('li', null, file)); });
      item.appendChild(files);
    }
    return item;
  }

  function renderProposals(data) {
    var list = document.getElementById('proposals');
    var note = document.getElementById('proposalNote');
    var count = document.getElementById('proposalCount');
    list.replaceChildren();

    if (!data || data.configured === false) {
      count.textContent = 'Not configured';
      note.textContent = 'Set VALKYRIE_PROJECT_ROOT to a review checkout to show pending patches.';
      list.appendChild(el('div', 'proposal-empty', 'No review checkout is configured.'));
      return;
    }
    if (data.error) {
      count.textContent = 'Unavailable';
      note.textContent = 'The proposal queue could not be read.';
      list.appendChild(el('div', 'proposal-empty', 'No proposal data is available.'));
      return;
    }

    var proposals = Array.isArray(data.proposals) ? data.proposals : [];
    var total = typeof data.pendingCount === 'number' ? data.pendingCount : proposals.length;
    count.textContent = total + ' pending';
    if (!proposals.length) {
      note.textContent = 'No patches are waiting for human approval.';
      list.appendChild(el('div', 'proposal-empty', 'Queue is clear.'));
      return;
    }

    note.textContent = 'Tested in a sandbox. A human must review and approve each patch in a terminal.';
    if (data.truncated) note.textContent += ' Showing the latest ' + proposals.length + '.';
    proposals.forEach(function (proposal) { list.appendChild(proposalRow(proposal)); });
  }

  function renderProposalError(msg) {
    var list = document.getElementById('proposals');
    var note = document.getElementById('proposalNote');
    var count = document.getElementById('proposalCount');
    count.textContent = 'Unavailable';
    note.textContent = msg;
    list.replaceChildren(el('div', 'proposal-empty', 'No proposal data is available.'));
  }

  function loadProposals() {
    fetch('/api/valkyrie/proposals', { cache: 'no-store' })
      .then(function (r) {
        return r.json().then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (res) {
        if (!res.ok || !res.body || res.body.error) {
          renderProposalError('Proposal queue endpoint returned ' + (res.body && res.body.error ? res.body.error : 'an error') + '.');
          return;
        }
        renderProposals(res.body);
      })
      .catch(function () { renderProposalError('Could not reach /api/valkyrie/proposals.'); });
  }

  function load() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) {
        // 503 still carries a valid degraded snapshot
        return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
      })
      .then(function (res) {
        if (res.body && res.body.checks) render(res.body);
        else renderError('Health endpoint returned ' + res.status + '.');
      })
      .catch(function () { renderError('Could not reach /api/health.'); });
  }

  function refresh() {
    load();
    loadProposals();
  }

  document.getElementById('refresh').addEventListener('click', refresh);
  refresh();
  setInterval(refresh, 30000);
})();
