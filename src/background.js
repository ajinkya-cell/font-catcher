import { detectPageFonts, showPageToast } from './lib/detect.js';
import { checkAvailability, getFreeIndex } from './lib/availability.js';
import { resolveFont } from './lib/resolve.js';
import { fontId, findSaved, getFonts, setFonts, removeFont } from './lib/store.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/dashboard.html');

// Every write goes through this queue so two quick saves can't clobber each other.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function saveFont(candidate, context, page) {
  const existing = findSaved(await getFonts(), candidate);
  if (existing) return serialized(() => addSighting(existing.id, page).then((font) => ({ status: 'exists', font })));

  // Network work happens outside the queue; only the final write is serialized.
  const resolved = await resolveFont(candidate, context);
  return serialized(async () => {
    const fonts = await getFonts();
    const dupe = findSaved(fonts, { family: resolved.family, slug: resolved.slug || candidate.slug });
    if (dupe) return { status: 'exists', font: await addSighting(dupe.id, page) };

    const id = fontId(resolved.family);
    const font = {
      id,
      family: resolved.family,
      rawFamily: resolved.rawFamily,
      source: resolved.source,
      slug: resolved.slug || null,
      cssUrl: resolved.cssUrl || null,
      hasFile: !!resolved.file,
      sample: candidate.sample || '',
      weights: candidate.weights || [],
      pageUrl: page.url,
      pageTitle: page.title || '',
      seenOn: page.url ? [{ url: page.url, title: page.title || '', at: Date.now() }] : [],
      free: resolved.free || null,
      notes: '',
      savedAt: Date.now(),
    };
    if (resolved.file) await chrome.storage.local.set({ [`file:${id}`]: resolved.file });
    await setFonts([font, ...fonts]);
    return { status: 'added', font };
  });
}

async function addSighting(id, page) {
  const fonts = await getFonts();
  const font = fonts.find((f) => f.id === id);
  if (!font) return null;
  if (page?.url && !font.seenOn?.some((s) => s.url === page.url)) {
    font.seenOn = [{ url: page.url, title: page.title || '', at: Date.now() }, ...(font.seenOn || [])].slice(0, 12);
    await setFonts(fonts);
  }
  return font;
}

async function toggleFont(candidate, page) {
  const existing = findSaved(await getFonts(), candidate);
  if (existing) {
    await serialized(() => removeFont(existing.id));
    return { saved: false };
  }
  const res = await saveFont(candidate, null, page);
  return { saved: true, font: res.font };
}

// Look up (or refresh) where a saved font is available for free.
async function checkFree(id) {
  const font = (await getFonts()).find((f) => f.id === id);
  if (!font) return { free: null };
  const free = await checkAvailability(font.rawFamily || font.family);
  await serialized(async () => {
    const fonts = await getFonts();
    const f = fonts.find((x) => x.id === id);
    if (!f) return;
    f.free = free;
    await setFonts(fonts);
  });
  return { free };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const page = msg.page || { url: sender.tab?.url, title: sender.tab?.title };
  const handle = {
    save: () => saveFont(msg.candidate, msg.context, page),
    toggle: () => toggleFont(msg.candidate, page),
    'check-free': () => checkFree(msg.id),
    remove: () => serialized(() => removeFont(msg.id)).then(() => ({ removed: true })),
    'open-dashboard': () => openDashboard().then(() => ({})),
  }[msg.type];
  if (!handle) return false;
  handle()
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

async function openDashboard() {
  const [tab] = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
}

// Right-click menu: catch the font of the selected text on any site.
chrome.runtime.onInstalled.addListener(() => {
  getFreeIndex().catch(() => {}); // download the free-font catalogues ahead of the first lookup
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'catch-selection', title: 'Catch this font', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'open-dashboard', title: 'Open font dashboard', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-dashboard') return openDashboard();
  if (info.menuItemId !== 'catch-selection' || !tab?.id) return;

  const target = { tabId: tab.id, frameIds: [info.frameId ?? 0] };
  const toast = (message) => chrome.scripting.executeScript({ target, func: showPageToast, args: [message] }).catch(() => {});
  try {
    const [{ result: scan }] = await chrome.scripting.executeScript({ target, func: detectPageFonts });
    if (!scan?.selection) return toast("Couldn't tell which font that text uses.");
    const sel = scan.selection;
    const res = await saveFont(
      { family: sel.family, sample: sel.text, weights: [sel.weight] },
      scan,
      { url: scan.url || tab.url, title: scan.title || tab.title },
    );
    toast(res.status === 'exists' ? `${res.font.family} is already in your collection` : `Caught ${res.font.family}`);
  } catch (err) {
    console.warn('Font Catcher: could not catch font', err);
    toast("Couldn't catch a font here.");
  }
});
