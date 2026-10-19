const { fmtAgo } = require('./lib/format');
const { scanLinks } = require('./lib/path-scan');
const { coverageText, hhmm } = require('../open-requests');

const REFRESH_MS = 30000;

function createInboxDrawer({ openFilePeek, showToast, focusSeat }) {
  const drawer = document.getElementById('inbox-drawer');
  const listEl = document.getElementById('inbox-list');
  const emptyEl = document.getElementById('inbox-empty');
  const coverageEl = document.getElementById('inbox-coverage');
  const markAllBtn = document.getElementById('inbox-mark-all');
  const closeBtn = document.getElementById('inbox-close');
  const openBtn = document.getElementById('inbox-open');
  const countEl = document.getElementById('inbox-count');
  let loaded = 30;
  let otherOpen = false;
  let resolvedOpen = false;
  let openReply = null;
  let focusReply = false;
  let renderGen = 0;
  let tick = null;
  const drafts = new Map();
  const replyStatus = new Map();
  const sending = new Set();

  async function refreshBadge() {
    let n = 0;
    try {
      const c = await window.api.openRequestCount();
      n = (c && Number(c.open)) || 0;
    } catch { n = 0; }
    countEl.textContent = String(n);
    countEl.classList.toggle('zero', !n);
  }

  // Resolve workspaceId -> display name at render time (renames stay correct;
  // a deleted workspace falls back to a label, never a crash).
  async function workspaceNames() {
    const map = new Map();
    try {
      for (const w of (await window.api.listWorkspaces()) || []) map.set(w.id, w.name);
    } catch { /* empty map → every row uses the fallback */ }
    return map;
  }

  function wsLabelOf(wsNames, workspaceId) {
    if (workspaceId == null) return '';
    return wsNames.get(workspaceId) || (workspaceId ? '(deleted workspace)' : '');
  }

  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function button(className, text, title, onClick) {
    const b = document.createElement('button');
    b.className = className;
    b.type = 'button';
    if (title) b.title = title;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function rowHead({ kind, from, wsLabel, ago }) {
    const head = document.createElement('div');
    head.className = 'inbox-item-head';
    if (kind) head.appendChild(span('inbox-kind', kind));
    head.appendChild(span('inbox-from', from));
    if (wsLabel) head.appendChild(span('inbox-ws', wsLabel));
    head.appendChild(span('inbox-ago', ago));
    return head;
  }

  // The note body is AGENT-AUTHORED text and this renderer runs
  // nodeIntegration:true, so an injection here is arbitrary local code. Build it
  // out of DOM nodes ONLY — never by splicing generated <a>/<button> markup into
  // an escaped string. textContent is the whole defence.
  function renderBody(note) {
    const body = document.createElement('div');
    body.className = 'inbox-body';
    for (const span of scanLinks(note.body)) {
      if (span.kind === 'url') {
        // A <button>, not an <a>: an anchor without href is not focusable, and
        // an href here would be a real navigation target in a nodeIntegration
        // renderer. Both link kinds being buttons keeps Tab order complete.
        const a = document.createElement('button');
        a.className = 'inbox-link';
        a.textContent = span.text;
        // No scheme gate here: scanLinks already dropped everything that is not
        // http/https, and ipc-handlers.js's openExternal re-gates main-side,
        // which is the authority.
        a.addEventListener('click', () => window.api.openExternal(span.text));
        body.appendChild(a);
      } else if (span.kind === 'path') {
        const b = document.createElement('button');
        b.className = 'inbox-path';
        b.textContent = span.text;
        b.addEventListener('click', async () => {
          const res = await window.api.fileResolve(note.from, span.path, null)
            .catch((e) => ({ ok: false, error: String(e) }));
          if (!res || !res.ok) {
            // Misses are ORDINARY here, not exceptional: notes outlive their
            // author, and resolveFilePath answers "Session not running" once the
            // seat has exited. Suppressing the link for a dead session would
            // need the live session map, which this drawer deliberately cannot
            // reach — so toast the miss, exactly as the terminal does.
            showToast((res && res.error) || `Can't find "${span.path}"`, { kind: 'warn', duration: 4000 });
            return;
          }
          openFilePeek(note.from, res.path, 'file', span.line);
        });
        body.appendChild(b);
      } else {
        body.appendChild(document.createTextNode(span.text));
      }
    }
    return body;
  }

  async function revealRequest(req, wsLabel) {
    if (focusSeat(req.name)) { closeDrawer(); return; }
    const res = await window.api.revealSession(req.name).catch((e) => ({ ok: false, error: String(e) }));
    if (res && res.ok) { closeDrawer(); return; }
    showToast(`${req.name} is in workspace ${wsLabel || req.workspaceId || '(unknown)'} — open it to answer the dialog`,
      { kind: 'warn', duration: 5000 });
  }

  function renderRequest(req, wsNames) {
    const wsLabel = wsLabelOf(wsNames, req.workspaceId);
    const el = document.createElement('div');
    el.className = 'inbox-item request';
    const head = rowHead({
      kind: req.kind || 'permission',
      from: String(req.name),
      wsLabel,
      ago: `since ${hhmm(req.ts)} · ${fmtAgo(req.ts)}`,
    });
    if (req.pending > 1) head.insertBefore(span('inbox-pending', `${req.pending} dialogs`), head.lastChild);
    el.appendChild(head);
    const msg = document.createElement('div');
    msg.className = 'inbox-body';
    msg.textContent = req.message == null ? '' : String(req.message);
    el.appendChild(msg);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', () => revealRequest(req, wsLabel));
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      revealRequest(req, wsLabel);
    });
    return el;
  }

  function renderReplyBox(note) {
    const box = document.createElement('div');
    box.className = 'inbox-reply';
    const ta = document.createElement('textarea');
    ta.className = 'inbox-reply-input';
    ta.rows = 1;
    ta.placeholder = `Reply to ${note.from}`;
    ta.value = drafts.get(note.id) || '';
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    };
    const status = document.createElement('div');
    status.className = 'inbox-reply-status';
    status.textContent = replyStatus.get(note.id) || '';
    const sendBtn = button('inbox-reply-send', 'Send', 'Send this reply to the seat', () => send());
    sendBtn.disabled = sending.has(note.id);
    async function send() {
      const text = ta.value;
      if (!text.trim() || sending.has(note.id)) return;
      sending.add(note.id);
      sendBtn.disabled = true;
      const res = await window.api.replyNotification(note.id, text)
        .catch((e) => ({ ok: false, error: String(e) }));
      sending.delete(note.id);
      if (res && res.ok) {
        drafts.delete(note.id);
        if (openReply === note.id) openReply = null;
        if (res.warn) replyStatus.set(note.id, res.warn);
        else replyStatus.delete(note.id);
        await renderList();
        await refreshBadge();
        return;
      }
      const why = res && res.code === 'gone'
        ? `${note.from} is no longer running — this note stays open; Done resolves it without a reply.`
        : (res && res.error) || 'The reply could not be sent.';
      replyStatus.set(note.id, why);
      await renderList();
    }
    ta.addEventListener('input', () => {
      drafts.set(note.id, ta.value);
      grow();
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        send();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        openReply = null;
        renderList();
      }
    });
    ta.addEventListener('click', (ev) => ev.stopPropagation());
    const row = document.createElement('div');
    row.className = 'inbox-reply-row';
    row.appendChild(ta);
    row.appendChild(sendBtn);
    box.appendChild(row);
    box.appendChild(status);
    requestAnimationFrame(grow);
    return { box, ta };
  }

  function renderNote(note, wsNames, focusTarget) {
    const el = document.createElement('div');
    el.className = 'inbox-item' + (note.readAt == null ? ' unread' : '');
    const resolvedMeta = note.readAt == null
      ? ''
      : note.repliedAt ? `replied ${hhmm(note.repliedAt)}` : `read ${hhmm(note.readAt)}`;
    const head = rowHead({
      kind: note.kind === 'shout' ? 'shout' : '',
      from: String(note.from),
      wsLabel: wsLabelOf(wsNames, note.workspaceId),
      ago: resolvedMeta ? `${fmtAgo(note.createdAt)} · ${resolvedMeta}` : fmtAgo(note.createdAt),
    });
    if (note.replyable) {
      head.appendChild(button('inbox-action inbox-reply-toggle', 'Reply', `Reply to ${note.from}`, (ev) => {
        ev.stopPropagation();
        openReply = openReply === note.id ? null : note.id;
        focusReply = openReply === note.id;
        renderList();
      }));
    }
    if (note.readAt == null) {
      head.appendChild(button('inbox-action inbox-done', 'Done', 'Resolve without a reply', async (ev) => {
        ev.stopPropagation();
        try { await window.api.markNotificationRead(note.id); } catch { return; }
        if (openReply === note.id) openReply = null;
        await renderList();
        await refreshBadge();
      }));
    }
    const del = document.createElement('button');
    del.className = 'inbox-delete';
    del.type = 'button';
    del.title = 'Delete this note';
    del.textContent = '×';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await window.api.removeNotification(note.id); } catch { return; }
      drafts.delete(note.id);
      if (openReply === note.id) openReply = null;
      await renderList();
      await refreshBadge();
    });
    head.appendChild(del);
    el.appendChild(head);
    el.appendChild(renderBody(note));
    if (note.repliedAt && note.reply) {
      const r = document.createElement('div');
      r.className = 'inbox-reply-text';
      r.textContent = note.reply;
      el.appendChild(r);
    }
    if (note.replyable && openReply === note.id) {
      const { box, ta } = renderReplyBox(note);
      el.appendChild(box);
      focusTarget.ta = ta;
    } else if (replyStatus.has(note.id)) {
      const s = document.createElement('div');
      s.className = 'inbox-reply-status';
      s.textContent = replyStatus.get(note.id);
      el.appendChild(s);
    }
    return el;
  }

  function sectionHead(title, n) {
    const h = document.createElement('div');
    h.className = 'inbox-section';
    h.textContent = `${title} (${n})`;
    return h;
  }

  function fold(title, n, isOpen, onToggle) {
    const d = document.createElement('details');
    d.className = 'inbox-fold';
    d.open = isOpen;
    const s = document.createElement('summary');
    s.className = 'inbox-section';
    s.textContent = `${title} (${n})`;
    d.appendChild(s);
    d.addEventListener('toggle', () => onToggle(d.open));
    return d;
  }

  async function renderList() {
    const gen = ++renderGen;
    const [snap, wsNames] = await Promise.all([
      window.api.openRequests({ limit: loaded }).catch(() => null),
      workspaceNames(),
    ]);
    if (gen !== renderGen) return;
    const active = document.activeElement;
    const refocus = focusReply || !!(active && active.classList && active.classList.contains('inbox-reply-input'));
    focusReply = false;
    listEl.innerHTML = '';
    if (!snap) {
      coverageEl.textContent = 'Could not load requests.';
      emptyEl.style.display = 'none';
      return;
    }
    coverageEl.textContent = coverageText({ open: snap.open, at: snap.at, blindSeats: snap.blindSeats });
    const requests = Array.isArray(snap.requests) ? snap.requests : [];
    const shouts = Array.isArray(snap.shouts) ? snap.shouts : [];
    const other = Array.isArray(snap.other) ? snap.other : [];
    const resolved = (snap.resolved && Array.isArray(snap.resolved.items)) ? snap.resolved.items : [];
    const hasMore = !!(snap.resolved && snap.resolved.hasMore);
    const ids = new Set([...shouts, ...other, ...resolved].map((n) => n.id));
    if (openReply != null && !ids.has(openReply)) openReply = null;
    emptyEl.style.display = (requests.length + shouts.length + other.length + resolved.length) ? 'none' : '';
    const focusTarget = { ta: null };
    if (requests.length) {
      listEl.appendChild(sectionHead('Permission dialogs', requests.length));
      for (const req of requests) listEl.appendChild(renderRequest(req, wsNames));
    }
    if (shouts.length) {
      listEl.appendChild(sectionHead('Shouts', shouts.length));
      for (const note of shouts) listEl.appendChild(renderNote(note, wsNames, focusTarget));
    }
    if (other.length) {
      const d = fold('Other notes', other.length, otherOpen, (v) => { otherOpen = v; });
      for (const note of other) d.appendChild(renderNote(note, wsNames, focusTarget));
      listEl.appendChild(d);
    }
    if (resolved.length) {
      const d = fold('Resolved', `${resolved.length}${hasMore ? '+' : ''}`, resolvedOpen, (v) => { resolvedOpen = v; });
      for (const note of resolved) d.appendChild(renderNote(note, wsNames, focusTarget));
      if (hasMore) {
        d.appendChild(button('inbox-load-older', 'Load older', '', async () => {
          loaded += 30;
          await renderList();
        }));
      }
      listEl.appendChild(d);
    }
    if (refocus && focusTarget.ta) {
      const ta = focusTarget.ta;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  function openDrawer() {
    drawer.classList.remove('hidden');
    loaded = 30;
    otherOpen = false;
    resolvedOpen = false;
    clearInterval(tick);
    tick = setInterval(refreshFromEvent, REFRESH_MS);
    renderList();
    refreshBadge();
  }
  function closeDrawer() {
    drawer.classList.add('hidden');
    clearInterval(tick);
    tick = null;
  }
  const isOpen = () => !drawer.classList.contains('hidden');

  openBtn.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  markAllBtn.addEventListener('click', async () => {
    try { await window.api.markAllNotificationsRead(); } catch { /* no-op */ }
    await renderList();
    await refreshBadge();
  });

  function refreshFromEvent() {
    refreshBadge();
    if (isOpen()) renderList();
  }

  window.api.onIpcMessage((msg) => {
    if (!msg || msg.type !== 'notify') return;
    refreshFromEvent();
  });
  window.api.onNotificationsChanged(() => refreshFromEvent());
  window.api.onAttentionChanged(() => refreshFromEvent());
  window.addEventListener('focus', refreshBadge);

  window.api.onRequestOpenInboxDrawer(() => openDrawer());

  refreshBadge();
  return { openDrawer, closeDrawer };
}

module.exports = { createInboxDrawer };
