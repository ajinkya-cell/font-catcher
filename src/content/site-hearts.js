// Adds heart buttons to Google Fonts and Fontshare:
//   - a floating "Save" pill on a font's own page
//   - a small heart on each font card while browsing
// Both sites are single-page apps, so everything is re-checked as the DOM changes.
(() => {
  const host = location.hostname.replace(/^www\./, '');
  const SITE = host === 'fonts.google.com' ? 'google' : host === 'fontshare.com' ? 'fontshare' : null;
  if (!SITE) return;

  const ATTR = 'data-font-catcher';
  let saved = [];

  const titleCase = (slug) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const idOf = (family) => family.toLowerCase().replace(/\s+/g, ' ').trim();

  // Turn a URL on either site into a font candidate, or null if it isn't a font page.
  function candidateFromUrl(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    const h = u.hostname.replace(/^www\./, '');
    if (SITE === 'google' && h === 'fonts.google.com') {
      const m = u.pathname.match(/^\/specimen\/([^/?#]+)\/?$/);
      return m ? { source: 'google', family: decodeURIComponent(m[1].replace(/\+/g, ' ')) } : null;
    }
    if (SITE === 'fontshare' && h === 'fontshare.com') {
      const m = u.pathname.match(/^\/fonts\/([^/?#]+)\/?$/);
      if (!m) return null;
      const slug = decodeURIComponent(m[1]).toLowerCase();
      return { source: 'fontshare', slug, family: titleCase(slug) };
    }
    return null;
  }

  const isSaved = (c) => saved.some((f) => f.id === idOf(c.family) || (c.slug && f.slug === c.slug));

  function toggle(candidate, onDone) {
    chrome.runtime.sendMessage(
      { type: 'toggle', candidate, page: { url: location.href, title: document.title } },
      (res) => onDone(!chrome.runtime.lastError && res?.ok ? res.saved : null),
    );
  }

  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.6-9.2C.9 8 2.9 4 6.6 4c2.2 0 3.7 1.2 4.6 2.6h1.6C13.7 5.2 15.2 4 17.4 4c3.7 0 5.7 4 4.2 7.3-2.1 4.6-9.6 9.2-9.6 9.2z"/></svg>';
  const STYLES = `
    :host { all: initial; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center;
      gap: 8px; font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif; transition: transform .15s, background .15s, color .15s; }
    button:focus-visible { outline: 2px solid #ff5a36; outline-offset: 2px; }
    svg { width: 18px; height: 18px; fill: transparent; stroke: currentColor; stroke-width: 2; transition: fill .15s; }
    .on svg { fill: currentColor; }
    .pill { padding: 12px 18px 12px 14px; border-radius: 999px; background: #16130f; color: #f6f1e7;
      box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    .pill:hover { transform: translateY(-1px); }
    .pill.on { background: #ff5a36; color: #fff; }
    .dot { width: 34px; height: 34px; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.92);
      color: #16130f; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    .dot svg { width: 17px; height: 17px; }
    .dot:hover { transform: scale(1.08); }
    .dot.on { color: #ff5a36; }
    .busy { opacity: .6; pointer-events: none; }
  `;

  function makeButton(kind, candidate) {
    const el = document.createElement('font-catcher-heart');
    el.setAttribute(ATTR, '');
    const root = el.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLES}</style><button class="${kind}">${HEART}<span></span></button>`;
    const btn = root.querySelector('button');
    const label = root.querySelector('span');
    el.candidate = candidate;
    el.render = () => {
      const on = isSaved(candidate);
      btn.classList.toggle('on', on);
      const text = on ? `Saved ${candidate.family}` : `Save ${candidate.family} to Font Catcher`;
      btn.title = text;
      btn.setAttribute('aria-label', text);
      btn.setAttribute('aria-pressed', String(on));
      if (kind === 'pill') label.textContent = on ? 'Saved' : 'Save font';
      else label.remove();
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('busy');
      toggle(candidate, () => btn.classList.remove('busy'));
    });
    // Cards are links; keep presses on the heart from navigating.
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) el.addEventListener(type, (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.render();
    return el;
  }

  // Floating pill on a font's own page.
  let pill = null;
  function syncPill() {
    const c = candidateFromUrl(location.href);
    if (pill && (!c || pill.candidate.family !== c.family)) { pill.remove(); pill = null; }
    if (!c || pill) return;
    pill = makeButton('pill', c);
    Object.assign(pill.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: '2147483646' });
    document.documentElement.append(pill);
  }

  // Hearts on font cards.
  const LINK_SELECTOR = SITE === 'google' ? 'a[href*="/specimen/"]' : 'a[href*="/fonts/"]';
  function syncCards() {
    for (const a of document.querySelectorAll(LINK_SELECTOR)) {
      if (a.querySelector(`:scope > [${ATTR}]`)) continue;
      const c = candidateFromUrl(a.href);
      if (!c) continue;
      if (candidateFromUrl(location.href)?.family === c.family) continue; // the pill covers this one
      const rect = a.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 70) continue; // only card-sized links, not inline text links
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      const heart = makeButton('dot', c);
      Object.assign(heart.style, { position: 'absolute', top: '10px', right: '10px', zIndex: '5' });
      a.append(heart);
    }
  }

  function renderAll() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) el.render?.();
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; syncPill(); syncCards(); }, 300);
  }

  chrome.storage.local.get('fonts', ({ fonts = [] }) => {
    saved = fonts;
    syncPill();
    syncCards();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule);
    let lastUrl = location.href;
    setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; schedule(); } }, 700);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fonts) {
      saved = changes.fonts.newValue || [];
      renderAll();
    }
  });
})();
