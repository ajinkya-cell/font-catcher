// Injected into pages with chrome.scripting.executeScript({ func: detectPageFonts }).
// Must stay fully self-contained: it is serialized and run in the page, so it
// cannot reference anything outside its own body.
export function detectPageFonts() {
  const GENERIC = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
    'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
    'inherit', 'initial', 'unset', 'revert', '-apple-system', 'blinkmacsystemfont',
  ]);
  const ICON_RE = /icon|awesome|symbols|glyph|fontello|ionicons|feather|remixicon|bootstrap-icons/i;
  const MAX_TEXT_NODES = 5000;

  const clean = (f) => f.trim().replace(/^["']|["']$/g, '').trim();
  const splitStack = (stack) => stack.split(',').map(clean).filter(Boolean);
  const lc = (s) => s.toLowerCase();

  // Families the page loads as web fonts (whether declared in CSS or via the FontFace API).
  const webfonts = new Map();
  try {
    for (const face of document.fonts) {
      const fam = clean(face.family);
      const prev = webfonts.get(lc(fam));
      if (!prev || face.status === 'loaded') webfonts.set(lc(fam), { family: fam, status: face.status });
    }
  } catch { /* document.fonts unavailable */ }

  // Is a locally installed font with this name available? Classic width-comparison trick.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const PROBE = 'mmmmmmmmmmlli1WQ@#&gyAa';
  const baseWidths = {};
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    ctx.font = `72px ${base}`;
    baseWidths[base] = ctx.measureText(PROBE).width;
  }
  const localCache = new Map();
  const isLocallyAvailable = (fam) => {
    if (localCache.has(fam)) return localCache.get(fam);
    let found = false;
    for (const base of Object.keys(baseWidths)) {
      ctx.font = `72px "${fam.replace(/"/g, '')}", ${base}`;
      if (ctx.measureText(PROBE).width !== baseWidths[base]) { found = true; break; }
    }
    localCache.set(fam, found);
    return found;
  };

  // The family from a font stack that the browser most likely actually rendered.
  const renderedFamily = (stack) => {
    const parts = splitStack(stack);
    for (const p of parts) {
      const key = lc(p);
      if (GENERIC.has(key)) continue;
      const wf = webfonts.get(key);
      if (wf && wf.status === 'loaded') return { family: wf.family, webfont: true, stack };
      if (isLocallyAvailable(p)) return { family: p, webfont: false, stack };
    }
    const named = parts.find((p) => !GENERIC.has(lc(p)));
    return named ? { family: named, webfont: webfonts.has(lc(named)), stack } : null;
  };

  // Walk visible text and tally which families it is set in.
  const families = new Map();
  const styleCache = new WeakMap();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'TEXTAREA']);
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el || SKIP.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  let seen = 0;
  while (walker.nextNode() && seen < MAX_TEXT_NODES) {
    const node = walker.currentNode;
    const el = node.parentElement;
    let info = styleCache.get(el);
    if (!info) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.getClientRects().length === 0) {
        styleCache.set(el, { hidden: true });
        continue;
      }
      const role = el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]') ? 'heading'
        : el.closest('pre,code,kbd,samp') ? 'code' : 'body';
      info = { rendered: renderedFamily(cs.fontFamily), weight: cs.fontWeight, style: cs.fontStyle, size: parseFloat(cs.fontSize), role };
      styleCache.set(el, info);
    }
    if (info.hidden || !info.rendered) continue;
    seen++;

    const text = node.textContent.replace(/\s+/g, ' ').trim();
    const key = lc(info.rendered.family);
    let entry = families.get(key);
    if (!entry) {
      entry = {
        family: info.rendered.family,
        webfont: info.rendered.webfont,
        stack: info.rendered.stack,
        chars: 0,
        nodes: 0,
        roles: { heading: 0, body: 0, code: 0 },
        weights: new Set(),
        italic: false,
        maxSize: 0,
        sample: '',
        sampleScore: -1,
      };
      families.set(key, entry);
    }
    const len = Math.min(text.length, 400);
    entry.chars += len;
    entry.nodes++;
    entry.roles[info.role] += len;
    entry.weights.add(info.weight);
    if (info.style === 'italic' || info.style.startsWith('oblique')) entry.italic = true;
    entry.maxSize = Math.max(entry.maxSize, info.size);
    // Prefer short-ish, sentence-like, large text as the sample.
    if (text.length >= 4 && text.length <= 90) {
      const score = info.size * 2 + Math.min(text.length, 40) + (info.role === 'heading' ? 20 : 0);
      if (score > entry.sampleScore) { entry.sample = text; entry.sampleScore = score; }
    }
  }

  // @font-face rules we can read, plus stylesheets we can't (cross-origin without CORS).
  const fontFaces = [];
  const inaccessibleSheets = [];
  const parseSrcUrls = (src, base) => {
    const out = [];
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/g;
    let m;
    while ((m = re.exec(src))) {
      try { out.push({ url: new URL(m[2], base).href, format: m[3] || '' }); } catch { /* bad url */ }
    }
    return out;
  };
  const visitRules = (rules, base, depth) => {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        const family = clean(rule.style.getPropertyValue('font-family'));
        const src = rule.style.getPropertyValue('src');
        if (family && src) {
          fontFaces.push({
            family,
            weight: rule.style.getPropertyValue('font-weight') || '400',
            style: rule.style.getPropertyValue('font-style') || 'normal',
            src: parseSrcUrls(src, base),
          });
        }
      } else if (rule instanceof CSSImportRule && rule.styleSheet && depth < 4) {
        visitSheet(rule.styleSheet, depth + 1);
      } else if (rule.cssRules) {
        visitRules(rule.cssRules, base, depth);
      }
    }
  };
  const visitSheet = (sheet, depth = 0) => {
    const base = sheet.href || location.href;
    let rules;
    try { rules = sheet.cssRules; } catch { if (sheet.href) inaccessibleSheets.push(sheet.href); return; }
    if (rules) visitRules(rules, base, depth);
  };
  for (const sheet of document.styleSheets) visitSheet(sheet);
  try { for (const sheet of document.adoptedStyleSheets || []) visitSheet(sheet); } catch { /* ignore */ }

  // Known font services linked from the page.
  const providers = { google: [], fontshare: [], adobe: false };
  const sheetHrefs = [
    ...Array.from(document.querySelectorAll('link[href]')).map((l) => l.href),
    ...Array.from(document.styleSheets).map((s) => s.href).filter(Boolean),
  ];
  for (const href of new Set(sheetHrefs)) {
    let u;
    try { u = new URL(href); } catch { continue; }
    if (u.hostname === 'fonts.googleapis.com') {
      for (const fam of u.searchParams.getAll('family')) {
        for (const one of fam.split('|')) providers.google.push(lc(one.split(':')[0].replace(/\+/g, ' ').trim()));
      }
    } else if (u.hostname === 'api.fontshare.com') {
      for (const [k, v] of u.searchParams) if (k.startsWith('f')) providers.fontshare.push(lc(v.split('@')[0]));
    } else if (u.hostname === 'use.typekit.net' || u.hostname === 'p.typekit.net') {
      providers.adobe = true;
    }
  }
  for (const face of fontFaces) {
    if (face.src.some((s) => s.url.includes('fonts.gstatic.com'))) providers.google.push(lc(face.family));
  }

  // Font-specimen pages on the two supported font libraries.
  let site = null;
  let specimen = null;
  const host = location.hostname.replace(/^www\./, '');
  if (host === 'fonts.google.com') {
    site = 'google';
    const m = location.pathname.match(/^\/specimen\/([^/?#]+)/);
    if (m) specimen = { source: 'google', family: decodeURIComponent(m[1].replace(/\+/g, ' ')) };
  } else if (host === 'fontshare.com') {
    site = 'fontshare';
    const m = location.pathname.match(/^\/fonts\/([^/?#]+)/);
    if (m) {
      const slug = decodeURIComponent(m[1]).toLowerCase();
      const titled = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      specimen = { source: 'fontshare', slug, family: titled };
    }
  }

  // The font of whatever text is currently selected.
  let selection = null;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) {
    let el = sel.anchorNode;
    if (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
    if (el) {
      const cs = getComputedStyle(el);
      const rendered = renderedFamily(cs.fontFamily);
      if (rendered) {
        selection = {
          ...rendered,
          weight: cs.fontWeight,
          text: sel.toString().replace(/\s+/g, ' ').trim().slice(0, 120),
        };
      }
    }
  }

  const list = Array.from(families.values()).map((e) => ({
    family: e.family,
    webfont: e.webfont,
    stack: e.stack,
    chars: e.chars,
    nodes: e.nodes,
    roles: e.roles,
    weights: Array.from(e.weights).sort(),
    italic: e.italic,
    sample: e.sample,
    icon: ICON_RE.test(e.family),
    hiddenOnly: false,
  }));
  // Web fonts the page loaded but that aren't in visible text right now (menus, tabs, modals…).
  for (const [key, wf] of webfonts) {
    if (families.has(key) || wf.status !== 'loaded' || /fallback/i.test(wf.family)) continue;
    list.push({
      family: wf.family, webfont: true, stack: '', chars: 0, nodes: 0,
      roles: { heading: 0, body: 0, code: 0 }, weights: [], italic: false, sample: '',
      icon: ICON_RE.test(wf.family), hiddenOnly: true,
    });
  }
  list.sort((a, b) => (a.icon - b.icon) || (!!a.hiddenOnly - !!b.hiddenOnly) || (b.chars - a.chars));

  return {
    url: location.href,
    title: document.title,
    site,
    specimen,
    selection,
    families: list,
    fontFaces,
    inaccessibleSheets: Array.from(new Set(inaccessibleSheets)).slice(0, 20),
    providers: { ...providers, google: Array.from(new Set(providers.google)), fontshare: Array.from(new Set(providers.fontshare)) },
  };
}

// Injected to confirm a save on pages where the user caught a font via the context menu.
export function showPageToast(message) {
  const id = '__font-catcher-toast__';
  document.getElementById(id)?.remove();
  const host = document.createElement('div');
  host.id = id;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .t { position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; max-width: 340px;
        padding: 12px 16px; border-radius: 12px; background: #16130f; color: #f6f1e7;
        font: 500 14px/1.4 system-ui, sans-serif; box-shadow: 0 12px 32px rgba(0,0,0,.28);
        opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s; }
      .t.on { opacity: 1; transform: none; }
      b { color: #ff6b4a; font-weight: 600; }
    </style>
    <div class="t"></div>`;
  const t = root.querySelector('.t');
  t.innerHTML = `<b>♥</b> `;
  t.append(document.createTextNode(message));
  document.documentElement.append(host);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => host.remove(), 250); }, 2600);
}
