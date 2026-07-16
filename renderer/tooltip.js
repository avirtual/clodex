// tooltip.js — one shared attr-driven tooltip for the sidebar chrome, replacing
// the native yellow-box `title` on the small icon controls with a styled bubble
// that matches the session hovercard family (same bg/border/radius) so the
// sidebar reads as one system rather than a mix of custom cards and OS titles.
//
// A single fixed-position node reused across targets, pointer-events:none so it
// can never intercept a click, and killed on any mousedown / scroll / keydown so
// it can't overlap or outlive a dialog or popover opening. Fixed-position +
// delegated (NOT a CSS `::after`) on purpose: a pseudo-element would clip against
// the sidebar's overflow, a viewport-clamped fixed node escapes it.
//
// Attr-driven (`data-tip="…"`) so the eventual full sweep is mechanical — swap
// `title="…"` for `data-tip="…"` on the element. Scoped to the sidebar this
// week; the ~50 dialog-internal `title`s stay native pending that later sweep
// (they sit behind modals, not on the demo-visible surface).
//
// DOM-bound, so no unit tests per the R1 rule.

function initTooltips({ delayMs = 400 } = {}) {
  const tip = document.createElement('div');
  tip.id = 'ui-tooltip';
  tip.hidden = true;
  document.body.appendChild(tip);

  let timer = null;   // pending show
  let current = null; // element the visible tip describes

  // Below the control, centered; flip above if it would clip the bottom, and
  // clamp horizontally so an edge control's tip stays on-screen.
  function place(el) {
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = Math.round(r.bottom + 6);
    if (top + h > window.innerHeight - 8) top = Math.round(r.top - h - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  function show(el) {
    timer = null;
    const text = el.getAttribute('data-tip') || '';
    if (!text || !el.isConnected) { hide(); return; }
    current = el;
    tip.textContent = text; // textContent, never innerHTML — labels are trusted but this stays injection-proof
    tip.hidden = false;
    place(el);
  }

  function hide() {
    current = null;
    tip.hidden = true;
  }

  function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
  function hideAll() { cancel(); hide(); }

  document.body.addEventListener('mouseover', (e) => {
    const el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el === current) return;
    cancel();
    if (!el) { hide(); return; }
    hide();
    timer = setTimeout(() => show(el), delayMs);
  });
  document.body.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (current && to && to.closest && to.closest('[data-tip]') === current) return;
    hideAll();
  });

  // Any press, scroll or key kills the tip — same guarantee the hovercard makes:
  // it can never paint over a popover/dialog being opened or outlive its control.
  document.addEventListener('mousedown', hideAll, true);
  document.addEventListener('scroll', hideAll, true);
  document.addEventListener('keydown', hideAll, true);
}

module.exports = { initTooltips };
