'use strict';

const ISOLATED_WORLD = 4242;
const TEXT_MAX = 400000;
const ELEMENTS_MAX = 6000;
const MAIN_SEL = 'main, article, [role=main]';

const DEEP = `
  const deepAll = (root, test, out = []) => {
    for (const el of root.querySelectorAll('*')) {
      if (test(el)) out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, test, out);
    }
    return out;
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };`;

function readText(main) {
  return `(() => {
  const DROP = 'script,style,noscript,svg,nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.navbox,.mw-editsection,.reference,.reflist,#toc,.toc';
  const score = el => {
    const t = (el.innerText || '').length;
    let l = 0; el.querySelectorAll('a').forEach(a => l += (a.innerText || '').length);
    return t - 2 * l;
  };
  const forced = ${main ? `document.querySelector(${JSON.stringify(MAIN_SEL)})` : 'null'};
  let root = forced || document.querySelector('main article, article, [role=main], main, #mw-content-text, #content');
  if (!forced && (!root || (root.innerText || '').length < 200)) {
    let best = document.body, bs = -1;
    document.querySelectorAll('div,section,td').forEach(el => {
      const s = score(el); if (s > bs) { bs = s; best = el; }
    });
    root = best;
  }
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll(DROP).forEach(n => n.remove());
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px';
  host.appendChild(clone); document.body.appendChild(host);
  const txt = clone.innerText; host.remove();
  return (document.title + '\\n\\n' + txt).replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, ${TEXT_MAX});
})()`;
}

function readInteractive(main) {
  return `(() => {${DEEP}
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=combobox],summary,[contenteditable=true]';
  if (!window.__cxEls) { window.__cxEls = [null]; window.__cxOf = new WeakMap(); }
  const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const labelOf = el => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    return el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder')
      || el.value || (el.querySelector('img[alt]') || {}).alt || el.getAttribute('name') || '';
  };
  const mainRoot = ${main ? `document.querySelector(${JSON.stringify(MAIN_SEL)})` : 'null'};
  const inScope = el => {
    if (!mainRoot) return true;
    let n = el;
    while (n) { if (n === mainRoot) return true; n = n.parentNode || n.host; }
    return false;
  };
  const stamp = el => {
    let n = window.__cxOf.get(el);
    if (!n) { n = window.__cxEls.length; window.__cxEls.push(new WeakRef(el)); window.__cxOf.set(el, n); }
    el.setAttribute('data-cx', String(n));
    return n;
  };
  const out = []; const seen = new Set(); let truncated = false;
  for (const el of deepAll(document, e => e.matches(sel))) {
    if (!vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    const kind = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    let line = '';
    if (tag === 'a') {
      let h = el.getAttribute('href') || '';
      try { const u = new URL(el.href); h = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href; } catch {}
      if (h.startsWith('#') || h.startsWith('javascript:')) h = '';
      const label = clip(labelOf(el), 60);
      const key = label + '|' + h;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!label.trim() && !h) continue;
      line = label + (h ? ' → ' + clip(h, 80) : '') + (el.hasAttribute('download') ? ' [download]' : '');
    } else if (tag === 'select') {
      const opts = [...el.options].map(o => o.text.trim());
      const cur = el.selectedOptions[0] ? el.selectedOptions[0].text : '';
      const shown = opts.length <= 40 ? opts.join('|') : opts.slice(0, 20).join('|') + '|…(+' + (opts.length - 20) + ' more)';
      line = clip(labelOf(el) === el.value ? (el.name || el.id) : labelOf(el), 40) + ' = "' + clip(cur, 30) + '" {' + shown + '}';
    } else if (tag === 'input' || tag === 'textarea') {
      const lab = el.labels && el.labels[0] ? el.labels[0].innerText : (el.getAttribute('aria-label') || el.placeholder || el.name || el.id);
      const pw = el.type === 'password';
      line = clip(lab, 50) + (el.value && !pw ? ' = "' + clip(el.value, 30) + '"' : '')
        + (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? ' [x]' : ' [ ]') : '')
        + (pw ? ' (operator only)' : '');
    } else {
      line = clip(labelOf(el), 60);
    }
    if (!inScope(el)) { stamp(el); continue; }
    if (out.length >= ${ELEMENTS_MAX}) { truncated = true; stamp(el); continue; }
    out.push('[' + stamp(el) + '] ' + kind + ' ' + line + (disabled ? ' [disabled]' : ''));
  }
  return { lines: out, truncated };
})()`;
}

const REF = (n) => `const ref = window.__cxEls && window.__cxEls[${Number(n) | 0}];
  const el = ref && ref.deref();
  if (!el || !el.isConnected) return null;`;

function find(n) {
  return `(() => {
  ${REF(n)}
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const type = (el.type || '').toLowerCase();
  const kind = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (type || 'text') : tag);
  const raw = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.innerText
    || el.getAttribute('title') || el.getAttribute('placeholder') || (tag === 'input' && type !== 'password' ? el.value : '') || el.getAttribute('name') || '';
  const label = String(raw).replace(/\\s+/g, ' ').trim().slice(0, 60);
  const textual = tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type));
  return {
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag, type, kind, label,
    password: tag === 'input' && type === 'password',
    otp: el.getAttribute('autocomplete') === 'one-time-code',
    editable: (textual && !el.disabled && !el.readOnly) || el.isContentEditable,
  };
})()`;
}

function clear(n) {
  return `(() => {
  ${REF(n)}
  el.focus();
  if (el.isContentEditable) document.execCommand('selectAll');
  else if (typeof el.select === 'function') el.select();
  return true;
})()`;
}

function select(n, option) {
  return `(() => {
  ${REF(n)}
  if (el.tagName !== 'SELECT') return { err: 'NOT_SELECT' };
  const want = ${JSON.stringify(String(option))};
  const opts = [...el.options].map(o => ({ o, value: o.value, text: o.text.trim() }));
  let hit = opts.filter(x => x.value === want || x.text === want);
  if (!hit.length) hit = opts.filter(x => x.value.toLowerCase() === want.toLowerCase() || x.text.toLowerCase() === want.toLowerCase());
  if (!hit.length) hit = opts.filter(x => x.text.toLowerCase().includes(want.toLowerCase()));
  if (hit.length !== 1) return { err: 'NO_OPTION', ambiguous: hit.length > 1, options: (hit.length ? hit : opts).map(x => x.text) };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, hit[0].value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: el.value, text: hit[0].text };
})()`;
}

const LOGIN_PROBE = `(() => {${DEEP}
  const any = (test) => deepAll(document, test).some(vis);
  const host = location.hostname;
  const idp = /(^|\\.)accounts\\.google\\.com$/.test(host) ? 'google'
    : /(^|\\.)(login\\.microsoftonline\\.com|login\\.live\\.com)$/.test(host) ? 'microsoft'
    : /(^|\\.)appleid\\.apple\\.com$/.test(host) ? 'apple'
    : /(^|\\.)okta\\.com$/.test(host) ? 'okta' : null;
  const body = (document.body && document.body.innerText) || '';
  return {
    password: any(el => el.tagName === 'INPUT' && el.type === 'password'),
    otp: any(el => el.tagName === 'INPUT' && el.getAttribute('autocomplete') === 'one-time-code'),
    captcha: any(el => el.tagName === 'IFRAME' && /recaptcha|hcaptcha|challenges\\.cloudflare\\.com/.test(el.src || '')),
    idp,
    googleRejected: idp === 'google' && (location.pathname.startsWith('/v3/signin/rejected') || body.includes('This browser or app may not be secure')),
    logoutLink: any(el => (el.tagName === 'A' || el.tagName === 'BUTTON') && /\\b(log|sign)\\s?out\\b/i.test(el.innerText || '')),
  };
})()`;

const CONTENT_TYPE = 'document.contentType';

module.exports = {
  ISOLATED_WORLD, TEXT_MAX, ELEMENTS_MAX, LOGIN_PROBE, CONTENT_TYPE,
  READ_TEXT: readText, READ_INTERACTIVE: readInteractive, FIND: find, CLEAR: clear, SELECT: select,
};
