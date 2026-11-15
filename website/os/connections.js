(function () {
  var form = document.getElementById('connections-form');
  var status = document.getElementById('connections-status');
  if (!form) return;

  window.addEventListener('valhalla-signed-in', function () { load(); });
  document.addEventListener('click', function (event) {
    var opener = event.target.closest && event.target.closest('[data-open="connections"], [data-open="packs"]');
    if (opener) load();
  });

  var service = document.getElementById('connections-service');
  var baseLabel = document.getElementById('connections-base-label');
  if (service && baseLabel) {
    service.addEventListener('change', function () {
      baseLabel.hidden = service.value !== 'custom';
    });
  }

  function say(text) { if (status) status.textContent = text; }

  async function token() {
    if (!window.ValhallaSupabase) return '';
    var supabase = await window.ValhallaSupabase.client();
    var session = await supabase.auth.getSession();
    return session && session.data && session.data.session && session.data.session.access_token || '';
  }

  async function send(method, body) {
    var access = await token();
    if (!access) { say('Sign-in required.'); return null; }
    var response = await fetch('/api/connections', {
      method: method,
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      cache: 'no-store'
    });
    var payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (response.status === 401) { say('Sign-in required.'); return null; }
    if (!response.ok) { say(payload.error || 'That did not work.'); return null; }
    return payload;
  }

  function render(body) {
    var list = document.getElementById('connections-list');
    if (!list || !body) return;
    list.replaceChildren();
    (body.connections || []).forEach(function (row) {
      var item = document.createElement('li');
      item.textContent = row.label + ' ••••' + row.last4 + ' ' + row.status;
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () { send('POST', { action: 'delete', id: row.id }).then(load); });
      item.appendChild(remove);
      list.appendChild(item);
    });
    var packs = body.packs || {};
    var paper = document.getElementById('pack-paper');
    var assistant = document.getElementById('pack-assistant');
    var board = document.getElementById('pack-status');
    if (paper) paper.checked = packs.paper_only !== false;
    if (assistant) assistant.checked = packs.assistant === true;
    if (board) board.checked = packs.status_board === true;
  }

  function load() { send('GET').then(render); }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var key = document.getElementById('connections-key');
    send('POST', {
      action: 'save',
      service: service && service.value,
      key: key && key.value,
      baseUrl: document.getElementById('connections-base') && document.getElementById('connections-base').value
    }).then(function (body) {
      if (!body) return;
      if (key) key.value = '';
      say(body.error || 'Saved.');
      load();
    });
  });

  var test = document.getElementById('connections-test');
  if (test) test.addEventListener('click', function () {
    var key = document.getElementById('connections-key');
    send('POST', {
      action: 'test',
      service: service && service.value,
      key: key && key.value,
      baseUrl: document.getElementById('connections-base') && document.getElementById('connections-base').value
    }).then(function (body) { if (body && body.ok) say('Key works.'); });
  });

  ['pack-paper', 'pack-assistant', 'pack-status'].forEach(function (id) {
    var input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('change', function () {
      send('POST', {
        action: 'packs',
        paperOnly: document.getElementById('pack-paper').checked,
        assistant: document.getElementById('pack-assistant').checked,
        statusBoard: document.getElementById('pack-status').checked
      });
    });
  });

  var mint = document.getElementById('connections-mint');
  if (mint) mint.addEventListener('click', function () {
    send('POST', { action: 'mint' }).then(function (body) {
      var once = document.getElementById('connections-once');
      var curl = document.getElementById('connections-curl');
      if (!body || !once || !curl) return;
      once.hidden = false;
      curl.hidden = false;
      once.textContent = body.key;
      curl.textContent = body.curl;
    });
  });
})();
