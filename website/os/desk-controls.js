(function () {
  var proofStatus = document.getElementById('proof-status');
  var proofLoad = document.getElementById('proof-load');
  var trialCopy = document.getElementById('trial-copy');
  var trialStart = document.getElementById('trial-start');
  var trialStatus = document.getElementById('trial-status');

  if (trialCopy && window.VALHALLA_SITE) {
    var price = window.VALHALLA_SITE.PRO_PRICE || '';
    var days = window.VALHALLA_SITE.TRIAL_DAYS;
    trialCopy.textContent = price && days ? 'Pro is ' + price + '. The trial is ' + days + ' days.' : 'Pro trial';
  }

  function sayProof(text) { if (proofStatus) proofStatus.textContent = text; }
  function sayTrial(text) { if (trialStatus) trialStatus.textContent = text; }

  async function loadProof() {
    sayProof('Checking…');
    try {
      var response = await fetch('/api/proof', { cache: 'no-store' });
      if (!response.ok) { sayProof('Proof board not connected.'); return; }
      var body = await response.json();
      var checks = body && body.checks || body && body.targets || [];
      if (!checks.length) { sayProof('Checked. No rows were returned.'); return; }
      sayProof(checks.map(function (row) { return (row.name || 'Check') + ' ' + (row.ok === false ? 'failed' : 'ok'); }).join('. '));
    } catch (error) {
      sayProof('Proof board not connected.');
    }
  }

  async function startTrial() {
    sayTrial('');
    if (!window.ValhallaSupabase) { sayTrial('Sign-in required.'); return; }
    var supabase = await window.ValhallaSupabase.client();
    var session = await supabase.auth.getSession();
    var token = session && session.data && session.data.session && session.data.session.access_token;
    if (!token) { sayTrial('Sign-in required.'); return; }
    var response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    });
    var body = {};
    try { body = await response.json(); } catch (error) { body = {}; }
    if (response.status === 503) { sayTrial('Checkout not connected.'); return; }
    if (!response.ok || !body.url) { sayTrial(body.error || 'Checkout not connected.'); return; }
    window.location.assign(body.url);
  }

  if (proofLoad) proofLoad.addEventListener('click', loadProof);
  if (trialStart) trialStart.addEventListener('click', startTrial);
  document.addEventListener('click', function (event) {
    var opener = event.target.closest && event.target.closest('[data-open]');
    if (!opener) return;
    if (opener.dataset.open === 'proof') loadProof();
    if (opener.dataset.open === 'trial' && trialCopy && window.VALHALLA_SITE) {
      var price = window.VALHALLA_SITE.PRO_PRICE || '';
      var days = window.VALHALLA_SITE.TRIAL_DAYS;
      if (price && days) trialCopy.textContent = 'Pro is ' + price + '. The trial is ' + days + ' days.';
    }
  });
})();
