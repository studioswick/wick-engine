// Lua view for a code textarea: syntax colors, squiggly underlines and a click-to-fix popup (see lualint.js).
// The colors come from a <pre> laid exactly under a textarea whose text is transparent, so typing, selection, undo and
// the caret stay the browser's own.

import { h } from './ui.js';
import { analyze, BUILTINS } from './lualint.js';

const TOKEN_CLASS = { str: 'hl-str', num: 'hl-num', cmt: 'hl-cmt', kw: 'hl-kw', op: '', name: '', bad: '' };
const CONSTANTS = new Set(['nil', 'true', 'false']);
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ESCAPES[c]);
const RANK = { error: 3, fix: 2, tip: 1 };

/** Class for a token, using the token before it to spot function names and fields. */
function classOf(tok, prev, next) {
  if (tok.t === 'kw') return CONSTANTS.has(tok.v) ? 'hl-const' : 'hl-kw';
  if (tok.t !== 'name') return TOKEN_CLASS[tok.t] ?? '';
  if (prev && prev.t === 'kw' && prev.v === 'function') return 'hl-fn';
  if (prev && prev.t === 'op' && (prev.v === '.' || prev.v === ':')) return next && next.v === '(' ? 'hl-fn' : '';
  return BUILTINS.has(tok.v) ? 'hl-builtin' : '';
}

/** HTML for the colored text with diagnostics drawn as underlines. */
function render(text, tokens, diagnostics) {
  const cuts = new Set([0, text.length]);
  for (const t of tokens) { cuts.add(t.s); cuts.add(t.e); }
  for (const d of diagnostics) { cuts.add(Math.max(0, d.s)); cuts.add(Math.min(text.length, d.e)); }
  const points = [...cuts].sort((a, b) => a - b);
  const sig = tokens.filter((t) => t.t !== 'ws' && t.t !== 'cmt');
  const sigIndex = new Map(sig.map((t, i) => [t, i]));
  let ti = 0;
  let out = '';
  for (let k = 0; k + 1 < points.length; k++) {
    const s = points[k], e = points[k + 1];
    if (s === e) continue;
    while (ti < tokens.length && tokens[ti].e <= s) ti++;
    const tok = tokens[ti];
    let cls = '';
    if (tok && tok.s <= s) { const si = sigIndex.get(tok); cls = si === undefined ? TOKEN_CLASS[tok.t] ?? '' : classOf(tok, sig[si - 1], sig[si + 1]); }
    let best = null;
    for (const d of diagnostics) if (d.s <= s && d.e >= e && (!best || RANK[d.kind] > RANK[best.kind])) best = d;
    if (best) cls = `${cls} wk-sq-${best.kind}`.trim();
    const chunk = escapeHtml(text.slice(s, e));
    out += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
  }
  return `${out}\n`;
}

/**
 * Adds the Lua view to an existing textarea (already placed in the page). Returns { update, setEnabled }.
 * Call update() after changing area.value from code; typing is handled here.
 */
export function attachLua(area) {
  const wrap = h('div', { class: 'wk-codewrap is-lua' });
  const pre = h('pre', { class: 'wk-hl', 'aria-hidden': 'true' });
  const pop = h('div', { class: 'wk-diag' });
  pop.hidden = true;
  area.replaceWith(wrap);
  wrap.append(pre, area, pop);

  let enabled = true, frame = 0, current = { tokens: [], diagnostics: [] }, text = '', lineStarts = [0];
  let metrics = null;

  const measure = () => {
    const cs = getComputedStyle(area);
    const ctx = measure.ctx ||= document.createElement('canvas').getContext('2d');
    ctx.font = cs.font;
    metrics = { charW: ctx.measureText('0').width, lineH: parseFloat(cs.lineHeight) || 20, padL: parseFloat(cs.paddingLeft), padT: parseFloat(cs.paddingTop) };
    return metrics;
  };

  const syncScroll = () => { pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; };

  function update() {
    cancelAnimationFrame(frame);
    frame = 0;
    hidePop();
    if (!enabled) { pre.textContent = ''; return; }
    text = area.value;
    current = analyze(text);
    lineStarts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    pre.innerHTML = render(text, current.tokens, current.diagnostics);
    syncScroll();
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

  /** Visual column of a character offset, counting a tab as the next multiple of two. */
  function column(line, offset) {
    let col = 0;
    for (let i = lineStarts[line]; i < offset; i++) col += text[i] === '\t' ? 2 - (col % 2) : 1;
    return col;
  }
  const lineOf = (offset) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };

  function diagnosticAt(offset) {
    let best = null;
    for (const d of current.diagnostics) if (d.s <= offset && offset <= d.e && (!best || d.e - d.s <= best.e - best.s)) best = d;
    return best;
  }

  /** Character offset under a mouse position. */
  function offsetAt(clientX, clientY) {
    const m = metrics ?? measure();
    const r = area.getBoundingClientRect();
    const line = Math.min(lineStarts.length - 1, Math.max(0, Math.floor((clientY - r.top - m.padT + area.scrollTop) / m.lineH)));
    const col = Math.max(0, Math.floor((clientX - r.left - m.padL + area.scrollLeft) / m.charW));
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    let c = 0, i = lineStarts[line];
    while (i < end && c + (text[i] === '\t' ? 2 - (c % 2) : 1) <= col) { c += text[i] === '\t' ? 2 - (c % 2) : 1; i++; }
    return i;
  }

  function applyFix(fix) {
    area.focus();
    area.setSelectionRange(fix.s, fix.e);
    const done = fix.text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, fix.text);
    if (!done) {
      area.setRangeText(fix.text, fix.s, fix.e, 'end');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
    update();
  }

  function hidePop() { pop.hidden = true; }

  function showPop(d) {
    const m = metrics ?? measure();
    const line = lineOf(d.s);
    pop.className = `wk-diag is-${d.kind}`;
    pop.replaceChildren(
      h('div', { class: 'wk-diag-msg' }, d.msg),
      d.fix ? h('button', { class: 'wk-btn is-primary', onmousedown: (e) => e.preventDefault(), onclick: () => applyFix(d.fix) }, d.fix.label) : null);
    pop.hidden = false;
    const width = pop.offsetWidth, height = pop.offsetHeight;
    const wantX = m.padL + column(line, d.s) * m.charW - area.scrollLeft;
    const below = m.padT + (line + 1) * m.lineH - area.scrollTop + 2;
    pop.style.left = `${Math.max(4, Math.min(wantX, wrap.clientWidth - width - 4))}px`;
    pop.style.top = `${below + height > wrap.clientHeight ? Math.max(4, below - m.lineH - height - 4) : below}px`;
  }

  area.addEventListener('input', schedule);
  area.addEventListener('scroll', () => { syncScroll(); hidePop(); });
  area.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop(); });
  area.addEventListener('blur', () => setTimeout(hidePop, 150));
  area.addEventListener('click', () => {
    if (!enabled || area.selectionStart !== area.selectionEnd) return;
    if (frame) update();
    const d = diagnosticAt(area.selectionStart);
    if (d) showPop(d); else hidePop();
  });
  area.addEventListener('mousemove', (e) => {
    if (!enabled) { area.title = ''; return; }
    const d = diagnosticAt(offsetAt(e.clientX, e.clientY));
    area.title = d ? d.msg : '';
  });
  pop.addEventListener('mousedown', (e) => e.preventDefault());

  update();
  return {
    update,
    /** Turns the colors and underlines on or off (off for files that are not Lua). */
    setEnabled(on) {
      enabled = on;
      wrap.classList.toggle('is-lua', on);
      update();
    },
  };
}
