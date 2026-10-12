import { getFile, getFonts, getPrefs, setFonts, setPrefs, updateFont } from '../lib/store.js';
import { createDropdown } from '../ui/dropdown.js';
import { renderFreeTags } from '../ui/tags.js';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const PANGRAM = 'Sphinx of black quartz, judge my vow';

const state = {
  fonts: [],
  previewText: '',
  size: 44,
  sort: 'newest',
  filter: 'all',
  query: '',
};
const cards = new Map(); // id -> card element

// ---------- where is it free? ----------

function freeProviders(font) {
  const set = new Set((font.free?.matches || []).map((m) => m.provider));
  if (font.source === 'google' || font.source === 'fontshare') set.add(font.source);
  return set;
}

const FILTERS = [
  { value: 'all', label: 'All fonts', test: () => true },
  { value: 'free', label: 'Free somewhere', test: (f) => freeProviders(f).size > 0 },
  { value: 'google', label: 'On Google Fonts', swatch: 'google', test: (f) => freeProviders(f).has('google') },
  { value: 'fontshare', label: 'On Fontshare', swatch: 'fontshare', test: (f) => freeProviders(f).has('fontshare') },
  {
    value: 'other-free',
    label: 'Free elsewhere',
    hint: 'Font Squirrel, Fontsource',
    swatch: 'fontsquirrel',
    test: (f) => { const p = freeProviders(f); return p.has('fontsquirrel') || p.has('fontsource'); },
  },
  { value: 'not-free', label: 'No free source', hint: 'Paid or custom fonts', test: (f) => !!f.free && freeProviders(f).size === 0 },
];

const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name', label: 'Name A–Z' },
];

// Saved fonts that haven't been checked yet (e.g. saved before this feature) get checked in the background.
const checking = new Set();
const recheckedThisSession = new Set(); // catalogues were offline last time; retry once
const checkQueue = [];
let activeChecks = 0;
function queueFreeChecks() {
  for (const f of state.fonts) {
    const needs = !f.free || (f.free.incomplete && !recheckedThisSession.has(f.id));
    if (needs && !checking.has(f.id)) {
      checking.add(f.id);
      recheckedThisSession.add(f.id);
      checkQueue.push(f.id);
    }
  }
  pumpChecks();
}
function pumpChecks() {
  while (activeChecks < 2 && checkQueue.length) {
    const id = checkQueue.shift();
    activeChecks++;
    chrome.runtime.sendMessage({ type: 'check-free', id })
      .catch(() => {})
      .finally(() => {
        activeChecks--;
        checking.delete(id);
        const card = cards.get(id);
        const font = state.fonts.find((f) => f.id === id);
        if (card && font) updateCard(card, font);
        pumpChecks();
      });
  }
}

// ---------- font loading ----------

const loaded = new Map(); // id -> { key, promise<css font-family> }

const quote = (name) => `"${name.replace(/"/g, '')}"`;

function loadStylesheet(href) {
  return new Promise((resolve) => {
    if (document.querySelector(`link[data-font-css="${CSS.escape(href)}"]`)) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.fontCss = href;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
}

// How this font can be previewed: its own CSS, its captured file, or a free copy found elsewhere.
function previewPlan(font) {
  if (font.cssUrl) return { kind: 'css', url: font.cssUrl, family: font.family };
  if (font.hasFile) return { kind: 'file' };
  const m = font.free?.matches?.find((x) => x.cssUrl);
  if (m) return { kind: 'css', url: m.cssUrl, family: m.family };
  return { kind: 'local' };
}
const planKey = (p) => `${p.kind}:${p.url || ''}`;

function ensureFont(font) {
  const plan = previewPlan(font);
  const key = planKey(plan);
  const hit = loaded.get(font.id);
  if (hit && hit.key === key) return hit.promise;
  const promise = (async () => {
    const fallback = 'var(--ui)';
    if (plan.kind === 'css') {
      await loadStylesheet(plan.url);
      await document.fonts.load(`40px ${quote(plan.family)}`).catch(() => {});
      return `${quote(plan.family)}, ${fallback}`;
    }
    if (plan.kind === 'file') {
      const dataUrl = await getFile(font.id);
      if (dataUrl) {
        // A private alias, so a same-named font installed on this machine can't shadow it.
        const alias = `fc-${[...font.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;
        try {
          document.fonts.add(await new FontFace(alias, `url(${dataUrl})`).load());
          return `${quote(alias)}, ${fallback}`;
        } catch (err) {
          console.warn('Font Catcher: could not load captured file for', font.family, err);
        }
      }
    }
    return `${quote(font.rawFamily || font.family)}, ${quote(font.family)}, ${fallback}`;
  })();
  loaded.set(font.id, { key, promise });
  return promise;
}

function paintPreview(card) {
  const font = state.fonts.find((f) => f.id === card.dataset.id);
  if (!font) return;
  ensureFont(font).then((stack) => {
    const preview = card.querySelector('.preview');
    preview.style.fontFamily = stack;
    preview.classList.add('ready');
  });
}

// Load fonts only when their card scrolls near the viewport.
const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    io.unobserve(entry.target);
    entry.target.dataset.seen = '1';
    paintPreview(entry.target);
  }
}, { rootMargin: '400px 0px' });

// ---------- helpers ----------

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function sourceUrl(font) {
  if (font.source === 'google') return `https://fonts.google.com/specimen/${encodeURIComponent(font.family).replace(/%20/g, '+')}`;
  if (font.source === 'fontshare' && font.slug) return `https://www.fontshare.com/fonts/${font.slug}`;
  return font.pageUrl || font.seenOn?.[0]?.url || '';
}

function cssSnippet(font) {
  const generic = /mono|code/i.test(font.family) ? 'monospace' : 'sans-serif';
  const decl = `font-family: ${quote(font.family)}, ${generic};`;
  const free = font.free?.matches?.find((m) => m.cssUrl);
  const cssUrl = font.cssUrl || free?.cssUrl;
  if (cssUrl) return `@import url("${cssUrl}");\n\n${decl}`;
  const where = hostOf(font.pageUrl);
  return `${decl}\n/* Caught on ${where || 'the web'}. No free source found; check the font's license before using it. */`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.run(); el.classList.remove('on'); });
    el.append(btn);
  }
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), action ? 6000 : 2200);
}

async function copy(text, message) {
  await navigator.clipboard.writeText(text);
  toast(message);
}

// ---------- cards ----------

function buildCard(font) {
  const card = $('#card-tpl').content.firstElementChild.cloneNode(true);
  card.dataset.id = font.id;

  const name = card.querySelector('.card-name');
  name.title = 'Click to copy the name';
  name.addEventListener('click', () => {
    const f = state.fonts.find((x) => x.id === font.id) || font;
    copy(f.family, `Copied “${f.family}”`);
  });

  card.querySelector('.act-copy').addEventListener('click', () => {
    const f = state.fonts.find((x) => x.id === font.id) || font;
    copy(cssSnippet(f), 'CSS copied');
  });

  const notesBtn = card.querySelector('.act-notes');
  const notesBox = card.querySelector('.notes');
  const textarea = notesBox.querySelector('textarea');
  notesBtn.addEventListener('click', () => {
    notesBox.hidden = !notesBox.hidden;
    notesBtn.setAttribute('aria-pressed', String(!notesBox.hidden));
    if (!notesBox.hidden) textarea.focus();
  });
  let noteTimer;
  textarea.addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => updateFont(font.id, { notes: textarea.value }), 400);
  });

  card.querySelector('.act-remove').addEventListener('click', () => removeWithUndo(font.id));

  io.observe(card);
  return card;
}

function updateCard(card, font) {
  card.querySelector('.card-name').textContent = font.family;
  renderFreeTags(card.querySelector('.tags'), { free: font.free, font, checking: !font.free && checking.has(font.id) });

  const preview = card.querySelector('.preview');
  const text = state.previewText || font.sample || PANGRAM;
  if (preview.textContent !== text) preview.textContent = text;

  const plan = previewPlan(font);
  card.querySelector('.preview-note').hidden = plan.kind !== 'local';
  // A free copy turned up after the card was drawn: re-render the preview with it.
  if (card.dataset.seen && loaded.get(font.id)?.key !== planKey(plan)) paintPreview(card);

  const visit = card.querySelector('.act-visit');
  const url = sourceUrl(font);
  visit.hidden = !url;
  if (url) visit.href = url;

  const prov = card.querySelector('.provenance');
  prov.textContent = '';
  const seen = font.seenOn?.length ? font.seenOn : (font.pageUrl ? [{ url: font.pageUrl }] : []);
  const libHost = { google: 'fonts.google.com', fontshare: 'fontshare.com' }[font.source];
  const elsewhere = seen.filter((s) => hostOf(s.url) && hostOf(s.url) !== libHost);
  if (elsewhere.length) {
    prov.append('Seen on ');
    const a = document.createElement('a');
    a.href = elsewhere[0].url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = hostOf(elsewhere[0].url);
    a.title = elsewhere[0].title || elsewhere[0].url;
    prov.append(a);
    if (elsewhere.length > 1) prov.append(` +${elsewhere.length - 1}`);
    prov.append(` · ${formatDate(font.savedAt)}`);
  } else {
    prov.textContent = `Saved ${formatDate(font.savedAt)}`;
  }

  const textarea = card.querySelector('.notes textarea');
  if (document.activeElement !== textarea) textarea.value = font.notes || '';
  if (font.notes && card.querySelector('.notes').hidden && !card.dataset.notesInit) {
    card.querySelector('.notes').hidden = false;
    card.querySelector('.act-notes').setAttribute('aria-pressed', 'true');
  }
  card.dataset.notesInit = '1';
}

async function removeWithUndo(id) {
  const fonts = await getFonts();
  const font = fonts.find((f) => f.id === id);
  if (!font) return;
  const index = fonts.indexOf(font);
  const file = font.hasFile ? await getFile(id) : null;

  cards.get(id)?.classList.add('leaving');
  await new Promise((r) => setTimeout(r, 200));
  await setFonts(fonts.filter((f) => f.id !== id));
  await chrome.storage.local.remove(`file:${id}`);

  toast(`Removed ${font.family}`, {
    label: 'Undo',
    run: async () => {
      const now = await getFonts();
      if (now.some((f) => f.id === id)) return;
      now.splice(Math.min(index, now.length), 0, font);
      if (file) await chrome.storage.local.set({ [`file:${id}`]: file });
      await setFonts(now);
    },
  });
}

// ---------- render ----------

const filterDropdown = createDropdown($('#filter-dd'), {
  label: 'Show',
  value: state.filter,
  onChange: (value) => {
    state.filter = value;
    setPrefs({ filter: value });
    render();
  },
});
const sortDropdown = createDropdown($('#sort-dd'), {
  label: 'Sort',
  options: SORTS,
  value: state.sort,
  onChange: (value) => {
    state.sort = value;
    setPrefs({ sort: value });
    render();
  },
});

function visibleFonts() {
  const q = state.query.trim().toLowerCase();
  const filter = FILTERS.find((f) => f.value === state.filter) || FILTERS[0];
  let list = state.fonts.filter((f) =>
    filter.test(f)
    && (!q || f.family.toLowerCase().includes(q) || (f.notes || '').toLowerCase().includes(q)
      || (f.seenOn || []).some((s) => s.url.toLowerCase().includes(q))));
  if (state.sort === 'name') list = list.slice().sort((a, b) => a.family.localeCompare(b.family));
  else if (state.sort === 'oldest') list = list.slice().sort((a, b) => a.savedAt - b.savedAt);
  else list = list.slice().sort((a, b) => b.savedAt - a.savedAt);
  return list;
}

function renderFilterOptions() {
  filterDropdown.setOptions(FILTERS.map((f) => {
    const count = state.fonts.filter(f.test).length;
    return { value: f.value, label: f.label, hint: f.hint, swatch: f.swatch, count, disabled: f.value !== 'all' && count === 0 };
  }));
  filterDropdown.setValue(state.filter);
}

function render() {
  // Reconcile cards with stored fonts.
  const ids = new Set(state.fonts.map((f) => f.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) { io.unobserve(card); card.remove(); cards.delete(id); loaded.delete(id); }
  }
  for (const font of state.fonts) {
    let card = cards.get(font.id);
    if (!card) { card = buildCard(font); cards.set(font.id, card); }
    updateCard(card, font);
  }

  const visible = visibleFonts();
  grid.replaceChildren(...visible.map((f) => cards.get(f.id)));

  const n = state.fonts.length;
  const freeCount = state.fonts.filter((f) => freeProviders(f).size > 0).length;
  $('#tally').textContent = n
    ? `${n} font${n === 1 ? '' : 's'} caught · ${freeCount} available free`
    : 'Your collection is empty';
  $('#empty').hidden = n > 0;
  $('#no-results').hidden = !(n > 0 && visible.length === 0);
  document.querySelector('.toolbar').hidden = n === 0;
  renderFilterOptions();
}

// ---------- toolbar ----------

const previewInput = $('#preview-input');
const sizeInput = $('#size-input');
const sizeOutput = $('#size-output');

function applySize() {
  document.documentElement.style.setProperty('--preview-size', `${state.size}px`);
  sizeInput.value = state.size;
  const fill = ((state.size - sizeInput.min) / (sizeInput.max - sizeInput.min)) * 100;
  // Offset by the thumb's half-width so the fill and the bubble line up with the thumb's centre.
  const pos = `calc(${fill}% + ${10 - fill * 0.2}px)`;
  sizeInput.style.setProperty('--fill', pos);
  sizeOutput.style.setProperty('--fill', pos);
  sizeOutput.textContent = `${state.size}px`;
}

let prefTimer;
previewInput.addEventListener('input', () => {
  state.previewText = previewInput.value;
  for (const font of state.fonts) {
    const card = cards.get(font.id);
    if (card) card.querySelector('.preview').textContent = state.previewText || font.sample || PANGRAM;
  }
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => setPrefs({ previewText: state.previewText }), 400);
});
sizeInput.addEventListener('input', () => {
  state.size = Number(sizeInput.value);
  applySize();
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => setPrefs({ size: state.size }), 300);
});
const sliderWrap = sizeInput.parentElement;
sizeInput.addEventListener('pointerdown', () => sliderWrap.classList.add('dragging'));
window.addEventListener('pointerup', () => sliderWrap.classList.remove('dragging'));

$('#search-input').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});

// ---------- export / import ----------

$('#export-btn').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const files = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('file:')));
  const blob = new Blob([JSON.stringify({ app: 'font-catcher', version: 1, exportedAt: new Date().toISOString(), fonts: all.fonts || [], files })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `font-catcher-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.fonts)) throw new Error('No fonts in file');
    const current = await getFonts();
    const have = new Set(current.map((f) => f.id));
    const incoming = data.fonts.filter((f) => f && f.id && f.family && !have.has(f.id));
    const files = {};
    for (const f of incoming) {
      const dataUrl = data.files?.[`file:${f.id}`];
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) files[`file:${f.id}`] = dataUrl;
      else f.hasFile = false;
    }
    if (Object.keys(files).length) await chrome.storage.local.set(files);
    await setFonts([...current, ...incoming]);
    toast(incoming.length ? `Imported ${incoming.length} font${incoming.length === 1 ? '' : 's'}` : 'Nothing new to import');
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

// ---------- boot ----------

async function init() {
  const prefs = await getPrefs();
  Object.assign(state, {
    previewText: prefs.previewText || '',
    size: prefs.size || 44,
    sort: SORTS.some((s) => s.value === prefs.sort) ? prefs.sort : 'newest',
    filter: FILTERS.some((f) => f.value === prefs.filter) ? prefs.filter : 'all',
  });
  previewInput.value = state.previewText;
  sortDropdown.setValue(state.sort);
  applySize();
  state.fonts = await getFonts();
  queueFreeChecks();
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.fonts) return;
  state.fonts = changes.fonts.newValue || [];
  queueFreeChecks();
  render();
});

init();
