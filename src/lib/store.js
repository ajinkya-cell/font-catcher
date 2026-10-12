// Saved fonts live in chrome.storage.local:
//   "fonts"      -> array of font records (newest first)
//   "file:<id>"  -> data: URL of a captured font file, for fonts not served by a font library
//   "prefs"      -> dashboard preferences

import { cleanFamilyName, nameKey } from './names.js';

export const SOURCES = {
  google: 'Google Fonts',
  fontshare: 'Fontshare',
  adobe: 'Adobe Fonts',
  web: 'Web',
};

// Fonts are keyed by family name, so the same typeface caught on different sites
// (or hearted on Google Fonts and later caught on a blog) is stored once.
export function fontId(family) {
  return String(family).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Matches on the cleaned-up name, so "__Inter_d65c78" on one site finds the "Inter" saved from another.
export function findSaved(fonts, { family, slug }) {
  const key = family ? nameKey(cleanFamilyName(family)) : null;
  return fonts.find((f) =>
    (key && (f.id === fontId(family) || nameKey(f.family) === key
      || (f.rawFamily && nameKey(cleanFamilyName(f.rawFamily)) === key)))
    || (slug && f.slug === slug)) || null;
}

export async function getFonts() {
  const { fonts = [] } = await chrome.storage.local.get('fonts');
  return fonts;
}

export async function setFonts(fonts) {
  await chrome.storage.local.set({ fonts });
}

export async function getFile(id) {
  const key = `file:${id}`;
  const res = await chrome.storage.local.get(key);
  return res[key] || null;
}

export async function updateFont(id, patch) {
  const fonts = await getFonts();
  const i = fonts.findIndex((f) => f.id === id);
  if (i === -1) return null;
  fonts[i] = { ...fonts[i], ...patch };
  await setFonts(fonts);
  return fonts[i];
}

export async function removeFont(id) {
  const fonts = await getFonts();
  await setFonts(fonts.filter((f) => f.id !== id));
  await chrome.storage.local.remove(`file:${id}`);
}

export async function getPrefs() {
  const { prefs = {} } = await chrome.storage.local.get('prefs');
  return prefs;
}

export async function setPrefs(patch) {
  const prefs = await getPrefs();
  await chrome.storage.local.set({ prefs: { ...prefs, ...patch } });
}
