'use strict';

(function () {
  var desktop = document.getElementById('desktop');
  var menu = document.getElementById('start-menu');
  var startButton = document.getElementById('start-button');
  var taskbarApps = document.getElementById('taskbar-apps');
  var clock = document.getElementById('clock');
  var activeApp = document.getElementById('active-app');
  var spotlight = document.getElementById('spotlight');
  var spotlightInput = document.getElementById('spotlight-input');
  var spotlightList = document.getElementById('spotlight-list');
  var announcement = document.getElementById('desktop-announcement');
  var windows = Array.prototype.slice.call(document.querySelectorAll('[data-window]'));
  var frontZ = '40';
  var healthTimer = 0;

  function getWindow(name) {
    return windows.find(function (node) { return node.dataset.window === name; });
  }

  function announce(message) {
    if (announcement) announcement.textContent = message;
  }

  function setMenu(open) {
    menu.hidden = !open;
    startButton.setAttribute('aria-expanded', String(open));
  }

  function focusWindow(node) {
    var open = windows.filter(function (item) { return !item.hidden; });
    open.sort(function (a, b) { return Number(a.style.zIndex || 0) - Number(b.style.zIndex || 0); });
    open.forEach(function (item, index) {
      if (item !== node) item.style.zIndex = String(10 + index);
    });
    node.style.zIndex = '40';
    windows.forEach(function (item) {
      var button = taskbarApps.querySelector('[data-task="' + item.dataset.window + '"]');
      if (button) button.setAttribute('aria-pressed', String(item === node && !item.hidden));
    });
    if (activeApp) {
      var title = node.querySelector('.title-bar h2');
      activeApp.textContent = title ? title.textContent : 'Desk';
    }
  }

  function updateTaskbar() {
    taskbarApps.replaceChildren();
    windows.forEach(function (node) {
      if (node.hidden && node.dataset.minimized !== 'true') return;
      var title = node.querySelector('.title-bar h2').textContent;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'taskbar-app';
      button.dataset.task = node.dataset.window;
      button.textContent = title;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', function () {
        if (node.dataset.minimized === 'true') {
          node.hidden = false;
          node.dataset.minimized = 'false';
          updateTaskbar();
          focusWindow(node);
          return;
        }
        if (node.style.zIndex === frontZ) {
          minimizeWindow(node);
          return;
        }
        updateTaskbar();
        focusWindow(node);
      });
      taskbarApps.appendChild(button);
    });
  }

  function openWindow(name) {
    var node = getWindow(name);
    if (!node) return;
    node.hidden = false;
    node.dataset.minimized = 'false';
    updateTaskbar();
    focusWindow(node);
    setMenu(false);
    if (spotlight) spotlight.hidden = true;
    announce(node.querySelector('.title-bar h2').textContent + ' opened.');
    if (name === 'status') checkHealth();
  }

  function showFront() {
    var open = windows.filter(function (item) { return !item.hidden; });
    if (!open.length) {
      if (activeApp) activeApp.textContent = 'Desk';
      return;
    }
    open.sort(function (a, b) { return Number(a.style.zIndex || 0) - Number(b.style.zIndex || 0); });
    focusWindow(open[open.length - 1]);
  }

  function closeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'false';
    if (node.classList) node.classList.remove('is-max');
    updateTaskbar();
    showFront();
    announce(node.querySelector('.title-bar h2').textContent + ' closed.');
  }

  function minimizeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'true';
    if (node.classList) node.classList.remove('is-max');
    updateTaskbar();
    showFront();
    announce(node.querySelector('.title-bar h2').textContent + ' minimized.');
  }

  function setHealth(text, state) {
    var output = document.getElementById('backend-status');
    var light = document.querySelector('.status-light');
    output.textContent = text;
    output.dataset.state = state;
    light.style.background = state === 'ok' ? '#008000' : state === 'error' ? '#c00000' : '#f0c000';
  }

  async function checkHealth() {
    var output = document.getElementById('backend-status');
    if (output.textContent === 'Checking…') setHealth('Checking…', 'loading');
    var checkedAt = document.getElementById('checked-at');
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await fetch('/health', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      var type = response.headers.get('content-type') || '';
      if (!response.ok || type.indexOf('application/json') === -1) throw new Error('closed');
      var result = await response.json();
      var status = result && typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
      if (status !== 'ok' && status !== 'healthy' && status !== 'ready') throw new Error('closed');
      setHealth('Service reports ' + status + '.', 'ok');
      checkedAt.textContent = new Date().toLocaleTimeString();
    } catch (error) {
      setHealth('Unavailable · ' + (error.name === 'AbortError' ? 'timed out' : 'no service status') + '. Not reported as live.', 'error');
      checkedAt.textContent = new Date().toLocaleTimeString();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function startDrag(event) {
    var handle = event.target.closest('[data-drag-handle]');
    var node = handle && handle.closest('[data-window]');
    if (!handle || !node || (node.classList && node.classList.contains('is-max')) || event.target.closest('button') || event.button !== 0) return;
    event.preventDefault();
    focusWindow(node);
    var startX = event.clientX;
    var startY = event.clientY;
    var rect = node.getBoundingClientRect();
    var moved = false;
    handle.setPointerCapture(event.pointerId);
    function move(moveEvent) {
      var dx = moveEvent.clientX - startX;
      var dy = moveEvent.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      var x = Math.max(0, Math.min(window.innerWidth - Math.min(120, rect.width), rect.left + dx));
      var y = Math.max(52, Math.min(window.innerHeight - 60, rect.top + dy));
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }
    function finish() {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (moved) event.stopPropagation();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  desktop.addEventListener('click', function (event) {
    var launcher = event.target.closest('[data-open]');
    if (launcher) {
      openWindow(launcher.dataset.open);
      return;
    }
    var action = event.target.closest('[data-action]');
    if (action) {
      var node = action.closest('[data-window]');
      if (action.dataset.action === 'close') closeWindow(node);
      if (action.dataset.action === 'minimize') minimizeWindow(node);
      if (action.dataset.action === 'maximize' && node.classList) node.classList.toggle('is-max');
      return;
    }
    if (event.target.closest('[data-refresh]')) checkHealth();
    if (event.target.closest('[data-window]')) focusWindow(event.target.closest('[data-window]'));
  });
  desktop.addEventListener('pointerdown', startDrag);

  startButton.addEventListener('click', function () {
    setMenu(menu.hidden);
  });
  document.addEventListener('click', function (event) {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== startButton && !startButton.contains(event.target)) {
      setMenu(false);
    }
  });
  function deskApps() {
    var seen = {};
    var list = [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (node) {
      if (node.hidden || (spotlight && spotlight.contains(node))) return;
      var name = node.dataset.open;
      if (!name || seen[name]) return;
      seen[name] = true;
      list.push({ name: name, label: (node.textContent || name).trim() });
    });
    return list;
  }

  function showSpotlight(matches) {
    if (!spotlightList) return;
    spotlightList.replaceChildren();
    matches.forEach(function (app) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.open = app.name;
      button.textContent = app.label;
      item.appendChild(button);
      spotlightList.appendChild(item);
    });
  }

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
      if (!spotlight) return;
      event.preventDefault();
      spotlight.hidden = !spotlight.hidden;
      if (!spotlight.hidden) {
        showSpotlight(deskApps());
        if (spotlightInput) spotlightInput.focus();
      }
      return;
    }
    if (spotlight && !spotlight.hidden && event.key === 'Escape') {
      spotlight.hidden = true;
      return;
    }
    if (event.key !== 'Escape') return;
    if (!menu.hidden) {
      setMenu(false);
      startButton.focus();
      return;
    }
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var open = windows.filter(function (node) { return !node.hidden; });
    if (!open.length) return;
    open.sort(function (a, b) { return Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0); });
    closeWindow(open[0]);
  });
  document.getElementById('browser-page').addEventListener('change', function (event) {
    if (event.target.value !== '/' && event.target.value !== '/status/') return;
    var page = event.target.value === '/status/' ? '/status/' : '/';
    var iframe = document.querySelector('#window-browser iframe');
    iframe.src = page;
    document.querySelector('#window-browser .address-row a').href = page;
  });

  function updateClock() {
    var now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  if (spotlightInput) {
    spotlightInput.addEventListener('input', function () {
      var query = spotlightInput.value.trim().toLowerCase();
      showSpotlight(deskApps().filter(function (app) { return app.label.toLowerCase().indexOf(query) !== -1; }));
    });
  }

  updateClock();
  window.setInterval(updateClock, 30_000);
  updateTaskbar();
  var initiallyOpen = windows.find(function (node) { return !node.hidden; });
  if (initiallyOpen) focusWindow(initiallyOpen);
  checkHealth();
  healthTimer = window.setInterval(function () {
    if (!getWindow('status').hidden) checkHealth();
  }, 30_000);
  window.addEventListener('pagehide', function () {
    window.clearInterval(healthTimer);
  }, { once: true });
})();