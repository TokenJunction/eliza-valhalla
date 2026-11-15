(function () {
  var status = document.getElementById('board-status');
  var pending = document.getElementById('pending');
  var drop = document.getElementById('drop');
  var pr = { number: 0, branch: '' };

  function say(text) { if (status) status.textContent = text; }

  async function send(url, body) {
    var response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    var payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (response.status === 404) { say('Not found.'); return null; }
    if (!response.ok) { say(payload.error || 'That did not work.'); return null; }
    return payload;
  }

  function render(rows) {
    if (!pending) return;
    pending.replaceChildren();
    (rows || []).forEach(function (row) {
      var item = document.createElement('li');
      if (/\.(png|jpe?g|gif|webp|svg)$/i.test(row.path)) {
        var image = document.createElement('img');
        image.alt = '';
        image.src = '/api/admin?preview=' + encodeURIComponent(row.path);
        item.appendChild(image);
      }
      var name = document.createElement('span');
      name.textContent = row.path + ' (' + row.bytes + ' bytes)';
      item.appendChild(name);
      pending.appendChild(item);
    });
  }

  function load() {
    send('/api/push', { action: 'list' }).then(function (body) { if (body) render(body.uploads); });
    send('/api/overseer', { action: 'refresh' }).then(showChecks);
  }

  function showChecks(body) {
    var flag = document.getElementById('flag');
    var list = document.getElementById('checks');
    var latest = body && body.latest;
    if (!latest || !list) return;
    var report = latest.report || {};
    list.replaceChildren();
    (report.checks || []).forEach(function (check) {
      var item = document.createElement('li');
      item.textContent = check.name + ': ' + (check.ok ? 'ok' : 'failed');
      list.appendChild(item);
    });
    if (flag) flag.textContent = latest.rollback_recommended ? 'Roll back recommended' : '';
  }

  async function stage(file) {
    var path = file.webkitRelativePath && /^(website|assets)\//.test(file.webkitRelativePath) ? file.webkitRelativePath : 'website/' + file.name;
    var signed = await send('/api/push', { action: 'sign', path: path, bytes: file.size, type: file.type });
    if (!signed || !signed.uploadUrl) return;
    var put = await fetch(signed.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'true' } });
    if (!put.ok) { say('The file was not staged.'); return; }
    var scanned = await send('/api/push', { action: 'scan', path: path, type: file.type });
    if (scanned) say('Staged.');
    load();
  }

  if (drop) {
    drop.addEventListener('dragover', function (event) { event.preventDefault(); });
    drop.addEventListener('drop', function (event) {
      event.preventDefault();
      Array.prototype.forEach.call(event.dataTransfer.files || [], stage);
    });
  }

  var publish = document.getElementById('publish');
  if (publish) publish.addEventListener('click', function () {
    send('/api/push', { action: 'publish' }).then(function (body) {
      if (!body) return;
      pr = body;
      var line = document.getElementById('pr');
      if (line) line.textContent = body.url || '';
      say('Pull request opened.');
      watch();
    });
  });

  function watch() {
    if (!pr.branch) return;
    send('/api/push', { action: 'preview', branch: pr.branch }).then(function (body) {
      var line = document.getElementById('pr');
      if (body && body.url && line) line.textContent = body.url;
      else if (body && body.pending) setTimeout(watch, 5000);
    });
  }

  var ship = document.getElementById('ship');
  if (ship) ship.addEventListener('click', function () {
    send('/api/push', { action: 'ship', number: pr.number }).then(function (body) { if (body && body.ok) say('Shipped.'); });
  });
  var rollback = document.getElementById('rollback');
  if (rollback) rollback.addEventListener('click', function () {
    send('/api/push', { action: 'rollback' }).then(function (body) { if (body && body.ok) say('Production was rolled back.'); });
  });
  var host = drop && drop.closest('[data-window]');
  if (host && host.hidden) {
    document.addEventListener('click', function (event) {
      var opener = event.target.closest('[data-open="admin"], [data-open="overseer"]');
      if (opener) load();
    });
  } else {
    load();
  }
})();
