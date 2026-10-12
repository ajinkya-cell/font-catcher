import { checkAvailability } from '../lib/availability.js';
import { detectPageFonts } from '../lib/detect.js';
import { cleanFamilyName, nameKey } from '../lib/names.js';
import { captureFile, facesForFamily, fontshareCss, googleCssUrl, rankSources, slugify } from '../lib/resolve.js';
import { findSaved, getFonts } from '../lib/store.js';
import { renderFreeTags } from '../ui/tags.js';

const $ = (sel) => document.querySelector(sel);
const main = $('#main');

let saved = [];
let scan = null;
let previewText = '';
const controls = []; // { candidate, el, kind } — re-rendered when storage changes
const previews = []; // { el, sample, family }

document.getElementById('open-dashboard').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open-dashboard' });
  window.close();
});

function setStatus(text) {
  main.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'status';
  p.textContent = text;
  main.append(p);
}

const quote = (name) => `"${name.replace(/"/g, '')}"`;

function loadStylesheet(href) {
  return new Promise((resolve) => {
    if (document.querySelector(`link[href="${CSS.escape(href)}"]`)) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
}

let aliasCount = 0;
// Make the popup able to render a font from the page. Resolves to a CSS font-family, or null.
async function loadPageFont(f) {
  const raw = f.family;
  const clean = cleanFamilyName(raw);
  const providers = scan.providers;

  // Loaded from a font library: use the library's CSS.
  if (providers.google.some((g) => nameKey(g) === nameKey(raw) || nameKey(g) === nameKey(clean))) {
    const url = await googleCssUrl(clean);
    if (url) { await loadStylesheet(url); return quote(clean); }
  }
  if (providers.fontshare.includes(slugify(clean))) {
    const fs = await fontshareCss(slugify(clean));
    if (fs) { await loadStylesheet(fs.cssUrl); return quote(fs.family || clean); }
  }
  // Web font: fetch the page's own file.
  if (f.webfont) {
    const faces = await facesForFamily(raw, scan);
    const dataUrl = faces.length ? await captureFile(rankSources(faces)) : null;
    if (dataUrl) {
      const alias = `fc-preview-${++aliasCount}`;
      try {
        document.fonts.add(await new FontFace(alias, `url(${dataUrl})`).load());
        return quote(alias);
      } catch { /* fall through */ }
    }
  } else {
    // It rendered on this machine without being downloaded, so it's installed here.
    return quote(raw);
  }
  // Last resort: a free copy of the same font.
  const free = await checkAvailability(raw).catch(() => null);
  const m = free?.matches.find((x) => x.cssUrl);
  if (m) { await loadStylesheet(m.cssUrl); return quote(m.family); }
  return null;
}

function describe(f) {
  if (f.hiddenOnly) return 'Loaded by the page, not in visible text';
  const parts = [];
  const { heading, body, code } = f.roles;
  const total = heading + body + code || 1;
  const uses = [];
  if (heading / total > 0.15) uses.push('Headings');
  if (body / total > 0.15) uses.push('Body');
  if (code / total > 0.15) uses.push('Code');
  if (uses.length) parts.push(uses.join(' & '));
  parts.push(f.webfont ? 'Web font' : 'System font');
  if (f.weights.length) parts.push(f.weights.join(' · '));
  if (cleanFamilyName(f.family) !== f.family) parts.push(`“${f.family}”`);
  return parts.join('  ·  ');
}

function renderControls() {
  for (const c of controls) {
    const on = !!findSaved(saved, c.candidate);
    c.el.classList.toggle('on', on);
    if (c.kind === 'hero') c.el.textContent = on ? '♥ Saved — click to remove' : 'Save this font';
    else {
      c.el.setAttribute('aria-label', `${on ? 'Remove' : 'Save'} ${cleanFamilyName(c.candidate.family)}`);
      c.el.title = on ? 'Saved — click to remove' : 'Save to Font Catcher';
    }
    c.el.setAttribute('aria-pressed', String(on));
  }
  $('#saved-count').textContent = saved.length;
}

function renderPreviews() {
  for (const p of previews) p.el.textContent = previewText || p.sample || p.family;
}

async function toggle(candidate, el) {
  el.classList.add('busy');
  const existing = findSaved(saved, candidate);
  const page = { url: scan.url, title: scan.title };
  const msg = existing
    ? { type: 'remove', id: existing.id }
    : { type: 'save', candidate, context: scan, page };
  const prevText = el.textContent;
  if (!existing && el.classList.contains('save-btn')) el.textContent = 'Catching…';
  const res = await chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err) }));
  el.classList.remove('busy');
  if (!res?.ok) {
    el.textContent = prevText;
    console.warn('Font Catcher:', res?.error);
  }
  saved = await getFonts();
  renderControls();
}

function fillTags(container, rawFamily, opts = {}) {
  renderFreeTags(container, { checking: true, ...opts });
  checkAvailability(rawFamily)
    .then((free) => renderFreeTags(container, { free, ...opts }))
    .catch(() => renderFreeTags(container, { free: null, ...opts }));
}

function hero({ eyebrow, candidate, sample, previewCss, previewFamily }) {
  const node = $('#hero-tpl').content.firstElementChild.cloneNode(true);
  node.querySelector('.eyebrow').textContent = eyebrow;
  const name = node.querySelector('.hero-name');
  name.textContent = cleanFamilyName(candidate.family);
  name.style.fontFamily = `${quote(previewFamily || candidate.family)}, var(--ui)`;
  if (previewCss) loadStylesheet(previewCss);
  const sampleEl = node.querySelector('.hero-sample');
  sampleEl.textContent = sample || '';
  sampleEl.style.fontFamily = name.style.fontFamily;
  fillTags(node.querySelector('.tags'), candidate.family, { font: candidate, compact: true });
  const btn = node.querySelector('.save-btn');
  btn.addEventListener('click', () => toggle(candidate, btn));
  controls.push({ candidate, el: btn, kind: 'hero' });
  return node;
}

function row(f, index) {
  const node = $('#row-tpl').content.firstElementChild.cloneNode(true);
  const clean = cleanFamilyName(f.family);
  const name = node.querySelector('.row-name');
  name.textContent = clean;
  name.title = f.family;

  const preview = node.querySelector('.row-preview');
  previews.push({ el: preview, sample: f.sample, family: clean });
  preview.textContent = previewText || f.sample || clean;
  preview.title = f.sample || clean;
  loadPageFont(f).then((family) => {
    if (family) preview.style.fontFamily = `${family}, var(--ui)`;
    preview.classList.remove('loading');
  }, () => preview.classList.remove('loading'));

  node.querySelector('.row-meta').textContent = describe(f);
  const lead = index === 0 && f.chars > 0 ? [{ provider: 'top', text: 'Most used' }] : [];
  fillTags(node.querySelector('.tags'), f.family, { compact: true, lead });

  const candidate = { family: f.family, sample: f.sample, weights: f.weights };
  const btn = node.querySelector('.heart-btn');
  btn.addEventListener('click', () => toggle(candidate, btn));
  controls.push({ candidate, el: btn, kind: 'row' });
  return node;
}

function listBar(count) {
  const bar = document.createElement('div');
  bar.className = 'list-bar';
  bar.innerHTML = `
    <h2 class="section-title">Fonts<b></b></h2>
    <label class="preview-field">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4V3h10v1M8 3v10M6 13h4"/></svg>
      <input type="text" placeholder="Type to preview them all" aria-label="Preview text" autocomplete="off">
    </label>`;
  bar.querySelector('b').textContent = count;
  const input = bar.querySelector('input');
  input.value = previewText;
  input.addEventListener('input', () => {
    previewText = input.value;
    renderPreviews();
    try { localStorage.setItem('fc-preview', previewText); } catch { /* storage unavailable */ }
  });
  return bar;
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  return p;
}

function render() {
  main.innerHTML = '';
  controls.length = 0;
  previews.length = 0;
  const families = scan.families.filter((f) => !f.icon);

  if (scan.specimen) {
    const s = scan.specimen;
    const previewCss = s.source === 'google'
      ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(s.family).replace(/%20/g, '+')}&display=swap`
      : `https://api.fontshare.com/v2/css?f[]=${encodeURIComponent(s.slug)}@1&display=swap`;
    main.append(hero({
      eyebrow: s.source === 'google' ? 'On Google Fonts' : 'On Fontshare',
      candidate: { family: s.family, source: s.source, slug: s.slug },
      previewCss,
    }));
  } else if (scan.selection) {
    const sel = scan.selection;
    const match = families.find((f) => f.family === sel.family);
    const node = hero({
      eyebrow: 'Your selection',
      candidate: { family: sel.family, sample: sel.text, weights: [sel.weight] },
      sample: sel.text,
    });
    main.append(node);
    if (match) {
      loadPageFont(match).then((fam) => {
        if (!fam) return;
        for (const el of node.querySelectorAll('.hero-name, .hero-sample')) el.style.fontFamily = `${fam}, var(--ui)`;
      });
    }
  }

  if (scan.site) {
    // The library's own UI fonts aren't interesting; point at the hearts instead.
    if (!scan.specimen) {
      main.append(note(scan.site === 'google'
        ? 'Open any font on Google Fonts to save it here, or use the ♥ on the font cards.'
        : 'Open any font on Fontshare to save it here, or use the ♥ on the font cards.'));
    }
  } else if (families.length) {
    main.append(listBar(families.length));
    const list = document.createElement('ul');
    list.className = 'list';
    families.forEach((f, i) => list.append(row(f, i)));
    main.append(list);
  } else {
    main.append(note('No text fonts found on this page.'));
  }

  renderControls();
}

async function init() {
  try { previewText = localStorage.getItem('fc-preview') || ''; } catch { /* storage unavailable */ }
  saved = await getFonts();
  $('#saved-count').textContent = saved.length;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) {
    setStatus('Font Catcher can’t read this page. Try it on a regular website.');
    return;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: detectPageFonts });
    scan = result;
  } catch (err) {
    console.warn('Font Catcher:', err);
    setStatus('Font Catcher can’t read this page (the browser blocks extensions here).');
    return;
  }
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.fonts) {
    saved = changes.fonts.newValue || [];
    renderControls();
  }
});

init();
