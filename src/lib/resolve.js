import { checkAvailability } from './availability.js';
import { cleanFamilyName, nameKey } from './names.js';

// Works out where a caught font comes from and how to preview it later:
//   - Google Fonts / Fontshare fonts get a stylesheet URL from the library's API.
//   - Anything else gets its font file captured and stored, so the dashboard can
//     render it even after you've left the site.

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  try {
    const res = await fetchWithTimeout(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export function slugify(family) {
  return family.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const googleCache = new Map();
// Returns a working Google Fonts css2 URL for the family, or null if Google doesn't host it.
export function googleCssUrl(family) {
  const key = family.toLowerCase();
  if (!googleCache.has(key)) googleCache.set(key, findGoogleCss(family));
  return googleCache.get(key);
}

async function findGoogleCss(family) {
  const fam = encodeURIComponent(family.trim()).replace(/%20/g, '+');
  // The plain request asks for weight 400 and fails (HTTP 400) for families without one,
  // so probe other weights too, in parallel, and keep the first that works in this order.
  const urls = [`family=${fam}`, ...[300, 500, 700, 200, 600, 800, 900, 100].map((w) => `family=${fam}:wght@${w}`)]
    .map((q) => `https://fonts.googleapis.com/css2?${q}&display=swap`);
  const results = await Promise.all(urls.map(fetchText));
  const i = results.findIndex((css) => css && css.includes('@font-face'));
  return i === -1 ? null : urls[i];
}

// Returns { cssUrl, family } for a Fontshare slug, or null.
export async function fontshareCss(slug) {
  // @1 = variable roman (if any), then common static weights.
  for (const variant of ['1', '400', '500', '700', '300']) {
    const url = `https://api.fontshare.com/v2/css?f[]=${encodeURIComponent(slug)}@${variant}&display=swap`;
    const css = await fetchText(url);
    if (!css || !css.includes('@font-face')) continue;
    const comment = css.match(/\/\*\s*(.+?)\s*\*\//);
    const decl = css.match(/font-family:\s*['"]?([^'";]+)['"]?/);
    const family = (decl && decl[1].trim()) || (comment && comment[1]) || null;
    return { cssUrl: url, family };
  }
  return null;
}

// Read one declaration's value from a CSS block, respecting quotes and parentheses
// (font src values often contain data: URIs with semicolons inside url()).
export function cssDecl(block, name) {
  const re = new RegExp(`(?:^|[;{\\s])${name}\\s*:`, 'i');
  const m = re.exec(block);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let quote = null;
  let out = '';
  for (; i < block.length; i++) {
    const ch = block[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ';' || ch === '}') && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

export function parseSrc(src, base) {
  const out = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/g;
  let m;
  while ((m = re.exec(src))) {
    try { out.push({ url: new URL(m[2], base).href, format: m[3] || '' }); } catch { /* skip */ }
  }
  return out;
}

// Pull @font-face rules (and @import targets) out of raw stylesheet text.
export function parseFontFaces(cssText, base) {
  const faces = [];
  const blockRe = /@font-face\s*\{/gi;
  let m;
  while ((m = blockRe.exec(cssText))) {
    // Find the matching closing brace, skipping braces inside quotes.
    let i = blockRe.lastIndex;
    let quote = null;
    for (; i < cssText.length; i++) {
      const ch = cssText[i];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '}') break;
    }
    const block = '{' + cssText.slice(blockRe.lastIndex, i) + '}';
    const family = (cssDecl(block, 'font-family') || '').replace(/^["']|["']$/g, '').trim();
    const src = cssDecl(block, 'src');
    if (family && src) {
      faces.push({
        family,
        weight: cssDecl(block, 'font-weight') || '400',
        style: cssDecl(block, 'font-style') || 'normal',
        src: parseSrc(src, base),
      });
    }
    blockRe.lastIndex = i;
  }
  const imports = [];
  const importRe = /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi;
  while ((m = importRe.exec(cssText))) {
    try { imports.push(new URL(m[1], base).href); } catch { /* skip */ }
  }
  return { faces, imports };
}

// Several fonts on one page share the same stylesheets; download and parse them once.
const sheetMemo = new Map();
function facesFromSheets(urls) {
  const key = urls.join(' ');
  if (!sheetMemo.has(key)) sheetMemo.set(key, loadSheetFaces(urls));
  return sheetMemo.get(key);
}

async function loadSheetFaces(urls) {
  const faces = [];
  const visited = new Set();
  let queue = urls.slice(0, 12);
  for (let depth = 0; depth < 2 && queue.length; depth++) {
    const next = [];
    await Promise.all(queue.map(async (url) => {
      if (visited.has(url)) return;
      visited.add(url);
      const text = await fetchText(url);
      if (!text) return;
      const parsed = parseFontFaces(text, url);
      faces.push(...parsed.faces);
      next.push(...parsed.imports);
    }));
    queue = next.slice(0, 12);
  }
  return faces;
}

function weightDistance(weight) {
  const w = String(weight).trim().toLowerCase();
  const nums = (w === 'normal' ? '400' : w === 'bold' ? '700' : w).split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
  if (!nums.length) return 0;
  const [lo, hi = lo] = nums;
  return 400 >= lo && 400 <= hi ? 0 : Math.min(Math.abs(lo - 400), Math.abs(hi - 400));
}

const FORMAT_RANK = { woff2: 0, woff: 1, truetype: 2, opentype: 2, ttf: 2, otf: 2 };
function srcRank(s) {
  const fmt = s.format.toLowerCase().replace('-variations', '')
    || (s.url.match(/\.(woff2|woff|ttf|otf)(?:[?#]|$)/i) || [])[1]?.toLowerCase()
    || (s.url.match(/^data:font\/([\w-]+)/i) || [])[1]?.toLowerCase()
    || '';
  return FORMAT_RANK[fmt] ?? 5;
}

// Ordered list of URLs worth trying for the face closest to Regular 400.
export function rankSources(faces) {
  const sorted = faces.slice().sort((a, b) =>
    ((a.style !== 'normal') - (b.style !== 'normal')) || (weightDistance(a.weight) - weightDistance(b.weight)));
  const out = [];
  for (const face of sorted) {
    for (const s of face.src.slice().sort((a, b) => srcRank(a) - srcRank(b))) {
      if (!out.includes(s.url)) out.push(s.url);
    }
  }
  return out;
}

const MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

function sniffMime(bytes, url) {
  const sig = String.fromCharCode(...bytes.slice(0, 4));
  if (sig === 'wOF2') return MIME.woff2;
  if (sig === 'wOFF') return MIME.woff;
  if (sig === 'OTTO') return MIME.otf;
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return MIME.ttf;
  if (sig === 'true') return MIME.ttf;
  const ext = (url.match(/\.(woff2|woff|ttf|otf)(?:[?#]|$)/i) || [])[1];
  return ext ? MIME[ext.toLowerCase()] : null;
}

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export async function captureFile(urls) {
  for (const url of urls.slice(0, 6)) {
    if (url.startsWith('data:')) {
      if (url.length < MAX_FILE_BYTES * 1.4) return url;
      continue;
    }
    try {
      const res = await fetchWithTimeout(url, { credentials: 'omit' });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) continue;
      const mime = sniffMime(bytes, url);
      if (!mime) continue;
      return `data:${mime};base64,${toBase64(bytes)}`;
    } catch { /* try the next one */ }
  }
  return null;
}

// @font-face rules on the page for this family, including ones in stylesheets the page couldn't read.
export async function facesForFamily(family, context = {}) {
  const lc = family.toLowerCase();
  let faces = (context.fontFaces || []).filter((f) => f.family.toLowerCase() === lc);
  if (!faces.length && context.inaccessibleSheets?.length) {
    faces = (await facesFromSheets(context.inaccessibleSheets)).filter((f) => f.family.toLowerCase() === lc);
  }
  return faces;
}

/**
 * candidate: { family, source?, slug?, sample?, weights? }
 * context:   detectPageFonts() output for the page (fontFaces, inaccessibleSheets, providers), optional
 * returns:   { family, rawFamily, source, slug?, cssUrl?, file?, free }
 *   family is the cleaned-up name ("__Inter_d65c78" -> "Inter"); rawFamily is what the page called it.
 */
export async function resolveFont(candidate, context = {}) {
  const rawFamily = candidate.family.trim();
  const family = cleanFamilyName(rawFamily);
  const providers = context.providers || { google: [], fontshare: [], adobe: false };
  const freeP = checkAvailability(rawFamily).catch(() => null);
  const done = async (r) => ({ rawFamily, ...r, free: await freeP });

  // 1. Font library pages and pages that load from a font library.
  const fsSlug = candidate.slug
    || (candidate.source === 'fontshare' ? slugify(family) : null)
    || (providers.fontshare.includes(slugify(family)) ? slugify(family) : null);
  if (fsSlug) {
    const fs = await fontshareCss(fsSlug);
    if (fs) return done({ family: fs.family || family, source: 'fontshare', slug: fsSlug, cssUrl: fs.cssUrl });
  }
  const onGooglePage = providers.google.some((g) => nameKey(g) === nameKey(rawFamily) || nameKey(g) === nameKey(family));
  if (candidate.source === 'google' || onGooglePage) {
    const cssUrl = await googleCssUrl(family);
    if (cssUrl) return done({ family, source: 'google', cssUrl });
  }

  // 2. Self-hosted or third-party web font: capture the file itself.
  const faces = await facesForFamily(rawFamily, context);
  const isAdobe = faces.some((f) => f.src.some((s) => /typekit\.(net|com)/.test(s.url)));
  const file = faces.length ? await captureFile(rankSources(faces)) : null;
  if (file) return done({ family, source: isAdobe ? 'adobe' : 'web', file });

  // 3. No file we could grab (system font, protected kit, ...). If a free library has it, use that.
  const free = await freeP;
  const google = free?.matches.find((m) => m.provider === 'google' && m.cssUrl);
  if (google) return done({ family: google.family, source: 'google', cssUrl: google.cssUrl });
  const share = free?.matches.find((m) => m.provider === 'fontshare' && m.cssUrl);
  if (share) return done({ family: share.family, source: 'fontshare', slug: share.url.split('/').pop(), cssUrl: share.cssUrl });
  return done({ family, source: isAdobe ? 'adobe' : 'web' });
}
