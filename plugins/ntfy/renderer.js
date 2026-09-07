'use strict';

module.exports.activate = (rhost) => {
  let disposed = false;
  let statusEl = null;

  const alive = () => !disposed;

  function field(bodyEl, key, label, hint, type) {
    const row = document.createElement('div');
    row.className = 'ntfy-settings-row';
    const lab = document.createElement('label');
    lab.className = 'ntfy-settings-label';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.className = 'ntfy-settings-input';
    input.setAttribute('data-ntfy-key', key);
    lab.appendChild(input);
    row.appendChild(lab);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'ntfy-settings-hint';
      h.textContent = hint;
      row.appendChild(h);
    }
    bodyEl.appendChild(row);
    return input;
  }

  function renderStatus(res) {
    if (!statusEl) return;
    if (!res || !res.ok) {
      statusEl.textContent = 'Status unavailable.';
      return;
    }
    const bits = [res.connected ? 'connected' : 'not connected'];
    if (res.lastEventAt) bits.push(`last message ${new Date(res.lastEventAt).toLocaleString()}`);
    if (res.lastId) bits.push(`resuming after id ${res.lastId}`);
    if (res.error) bits.push(`error: ${res.error}`);
    statusEl.textContent = bits.join(' · ');
  }

  function refreshStatus() {
    rhost.invoke('status.get')
      .then((res) => { if (alive()) renderStatus(res); })
      .catch((e) => rhost.log.error('status.get failed', e));
  }

  const disposeSection = rhost.ui.settings.section({
    id: 'prefs',
    title: 'ntfy',
    render(bodyEl, values) {
      const v = values || {};
      const routes = (v.routes && typeof v.routes === 'object') ? v.routes : {};
      bodyEl.innerHTML = '';

      const url = field(bodyEl, 'url', 'Topic URL',
        'The full ntfy topic URL, e.g. https://ntfy.example.com/clodex. Empty means the plugin stays idle.', 'text');
      url.value = typeof v.url === 'string' ? v.url : '';

      const inbox = field(bodyEl, 'inbox', 'Inbox note',
        'Raise every message as an operator inbox note.', 'checkbox');
      inbox.checked = routes.inbox === undefined ? true : !!routes.inbox;

      const seat = field(bodyEl, 'seat', 'Also DM seat',
        'A session name to DM each message to, or empty for none.', 'text');
      seat.value = typeof routes.seat === 'string' ? routes.seat : '';

      statusEl = document.createElement('div');
      statusEl.className = 'ntfy-settings-status';
      statusEl.textContent = 'Checking…';
      bodyEl.appendChild(statusEl);
      refreshStatus();
    },
    collect(bodyEl) {
      const get = (key) => bodyEl.querySelector(`[data-ntfy-key="${key}"]`);
      const urlEl = get('url');
      const inboxEl = get('inbox');
      const seatEl = get('seat');
      const patch = {
        url: urlEl ? String(urlEl.value).trim() : '',
        routes: {
          inbox: inboxEl ? !!inboxEl.checked : true,
          seat: seatEl ? String(seatEl.value).trim() : '',
        },
      };
      rhost.invoke('settings.set', patch)
        .then((res) => {
          if (!alive()) return;
          if (res && res.ok === false && statusEl) statusEl.textContent = `Not saved: ${res.error}`;
          else refreshStatus();
        })
        .catch((e) => rhost.log.error('settings.set failed', e));
      return null;
    },
  });

  return () => {
    disposed = true;
    statusEl = null;
    try { if (typeof disposeSection === 'function') disposeSection(); } catch (_) { /* ignore */ }
  };
};
