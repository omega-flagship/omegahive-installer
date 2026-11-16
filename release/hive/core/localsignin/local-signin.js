// OmegaHive local sign-in (J1 design r2 B5, r3 N). Same-origin script only: the page's CSP allows no inline code.
// The first statement takes the one-time code from the fragment and removes it from the address and history at once.
var code = (function (h) { history.replaceState(null, '', location.pathname); return h.slice(1); })(location.hash || '');

(function () {
  'use strict';
  var TOKEN_KEY = 'omegadots.hive.token'; // the key the hive UI reads its session from (ui/src/api/live.ts)

  function say(text) {
    function put() {
      var el = document.getElementById('status');
      if (el) el.textContent = text;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put);
    else put();
  }

  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    say('This sign-in link is not complete. Open OmegaHive again from your computer.');
    return;
  }
  fetch('/api/auth/local/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code }),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    redirect: 'error'
  }).then(function (response) {
    code = '';
    if (!response.ok) throw new Error('refused');
    return response.json();
  }).then(function (data) {
    if (!data || typeof data.token !== 'string') throw new Error('refused');
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch (e) { throw new Error('storage'); }
    location.replace('/');
  }).catch(function (e) {
    say(e && e.message === 'storage'
      ? 'This browser would not keep your sign-in. Allow site data for this page, then open OmegaHive again.'
      : 'This sign-in link has expired or was already used. Open OmegaHive again from your computer.');
  });
})();
