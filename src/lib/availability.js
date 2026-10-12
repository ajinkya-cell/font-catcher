// Finds out whether a font is available for free somewhere:
//   Google Fonts, Fontshare, Font Squirrel, or Fontsource (open-source fonts beyond Google).
// Each library's catalogue is downloaded once, compacted into a name index, and cached for a week,
// so checking a font is a local lookup.

import { cleanFamilyName, nameKey } from './names.js';
import { fontshareCss, googleCssUrl } from './resolve.js';

export { cleanFamilyName, nameKey };

const INDEX_KEY = 'freeIndex';
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const FREE_PROVIDERS = {
  google: { label: 'Google Fonts', license: 'Free, open source' },
  fontshare: { label: 'Fontshare', license: 'Free for personal & commercial use' },
  fontsquirrel: { label: 'Font Squirrel', license: 'Free for commercial use' },
  fontsource: { label: 'Fontsource', license: 'Open source' },
};

function lookupKeys(raw) {
  const clean = cleanFamilyName(raw);
  const keys = [nameKey(clean), nameKey(raw), nameKey(clean.replace(/\s+(std|lt|mt)$/i, ''))];
  return [...new Set(keys)].filter(Boolean);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildIndex(previous) {
  const [fontsource, squirrel, fontshare] = await Promise.all([
    fetchJson('https://api.fontsource.org/v1/fonts'),
    fetchJson('https://www.fontsquirrel.com/api/fontlist/all'),
    fetchJson('https://api.fontshare.com/v2/fonts?limit=200'),
  ]);
  // Keep the previous copy of any catalogue that failed to download this time.
  const index = { at: Date.now(), google: null, fontsource: null, fontsquirrel: null, fontshare: null, ...previous };
  index.at = Date.now();
  if (Array.isArray(fontsource)) {
    index.google = {};
    index.fontsource = {};
    for (const f of fontsource) {
      if (f.type === 'google') index.google[nameKey(f.family)] = f.family;
      else index.fontsource[nameKey(f.family)] = [f.id, f.family, f.license || ''];
    }
  }
  if (Array.isArray(squirrel)) {
    index.fontsquirrel = {};
    for (const f of squirrel) index.fontsquirrel[nameKey(f.family_name)] = [f.family_urlname, f.family_name];
  }
  if (Array.isArray(fontshare?.fonts)) {
    index.fontshare = {};
    for (const f of fontshare.fonts) index.fontshare[nameKey(f.name)] = [f.slug, f.name];
  }
  return index;
}

let indexPromise = null;
export function getFreeIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const { [INDEX_KEY]: cached } = await chrome.storage.local.get(INDEX_KEY);
      const complete = cached && cached.google && cached.fontsquirrel && cached.fontshare;
      if (cached && complete && Date.now() - cached.at < INDEX_TTL_MS) return cached;
      const index = await buildIndex(cached || {});
      await chrome.storage.local.set({ [INDEX_KEY]: index });
      return index;
    })().catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

const memo = new Map();

/**
 * Where can this font be had for free?
 * returns { checkedAt, name, matches: [{ provider, label, license, url, family, cssUrl? }] }
 */
export function checkAvailability(rawFamily) {
  const k = nameKey(rawFamily);
  if (!memo.has(k)) {
    memo.set(k, lookup(rawFamily).catch((err) => {
      memo.delete(k);
      throw err;
    }));
  }
  return memo.get(k);
}

async function lookup(rawFamily) {
  const index = await getFreeIndex().catch(() => ({}));
  const keys = lookupKeys(rawFamily);
  const find = (table) => {
    if (!table) return null;
    for (const key of keys) if (table[key]) return table[key];
    return null;
  };
  const matches = [];

  const google = index.google ? find(index.google) : null;
  // If the Fontsource catalogue (our Google index) couldn't be downloaded, ask Google directly.
  const googleFamily = google || (!index.google && (await googleCssUrl(cleanFamilyName(rawFamily))) ? cleanFamilyName(rawFamily) : null);
  if (googleFamily) {
    matches.push({
      provider: 'google',
      ...FREE_PROVIDERS.google,
      family: googleFamily,
      url: `https://fonts.google.com/specimen/${encodeURIComponent(googleFamily).replace(/%20/g, '+')}`,
      cssUrl: await googleCssUrl(googleFamily),
    });
  }

  const share = find(index.fontshare);
  if (share) {
    const [slug, family] = share;
    matches.push({
      provider: 'fontshare',
      ...FREE_PROVIDERS.fontshare,
      family,
      url: `https://www.fontshare.com/fonts/${slug}`,
      cssUrl: (await fontshareCss(slug))?.cssUrl || null,
    });
  }

  const squirrel = find(index.fontsquirrel);
  if (squirrel) {
    const [urlname, family] = squirrel;
    matches.push({
      provider: 'fontsquirrel',
      ...FREE_PROVIDERS.fontsquirrel,
      family,
      url: `https://www.fontsquirrel.com/fonts/${urlname}`,
    });
  }

  const source = find(index.fontsource);
  if (source) {
    const [id, family, license] = source;
    matches.push({
      provider: 'fontsource',
      ...FREE_PROVIDERS.fontsource,
      license: license ? `Open source (${license})` : FREE_PROVIDERS.fontsource.license,
      family,
      url: `https://fontsource.org/fonts/${id}`,
      cssUrl: `https://cdn.jsdelivr.net/npm/@fontsource/${id}/index.css`,
    });
  }

  // If a catalogue couldn't be downloaded, "no match" isn't trustworthy yet.
  const incomplete = !index.google || !index.fontsource || !index.fontsquirrel || !index.fontshare;
  return { checkedAt: Date.now(), name: cleanFamilyName(rawFamily), matches, incomplete };
}
