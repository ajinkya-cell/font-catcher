import { FREE_PROVIDERS } from '../lib/availability.js';

const URLS = {
  google: (f) => `https://fonts.google.com/specimen/${encodeURIComponent(f.family).replace(/%20/g, '+')}`,
  fontshare: (f) => (f.slug ? `https://www.fontshare.com/fonts/${f.slug}` : 'https://www.fontshare.com'),
};

function tag(provider, text, { href, title, className } = {}) {
  const el = document.createElement(href ? 'a' : 'span');
  el.className = `tag${className ? ` ${className}` : ''}`;
  el.dataset.provider = provider;
  el.textContent = text;
  if (title) el.title = title;
  if (href) {
    el.href = href;
    el.target = '_blank';
    el.rel = 'noopener';
  }
  return el;
}

/**
 * Fill `el` with "where is this free" tags.
 *   free:     checkAvailability() result, or null if not checked yet
 *   font:     { family, slug, source } — the font's own source counts even before a check
 *   checking: show a loading shimmer
 *   compact:  shorter labels (popup rows)
 *   lead:     extra tags to put first, e.g. [{ provider: 'top', text: 'Most used' }]
 */
export function renderFreeTags(el, { free, font = {}, checking = false, compact = false, lead = [] }) {
  el.textContent = '';
  for (const t of lead) el.append(tag(t.provider, t.text));

  const matches = free?.matches ? free.matches.slice() : [];
  // A font saved from Google Fonts / Fontshare is free there even if the lookup hasn't run.
  for (const p of ['google', 'fontshare']) {
    if (font.source === p && !matches.some((m) => m.provider === p)) {
      matches.unshift({ provider: p, ...FREE_PROVIDERS[p], url: URLS[p](font) });
    }
  }

  for (const m of matches) {
    const text = m.provider === 'google' || compact ? m.label : `Free · ${m.label}`;
    el.append(tag(m.provider, text, { href: m.url, title: `${m.label}: ${m.license}` }));
  }
  if (matches.length) return;

  if (checking) {
    el.append(tag('checking', '', { className: 'checking', title: 'Checking free sources…' }));
  } else if (font.source === 'adobe') {
    el.append(tag('adobe', 'Adobe Fonts', { title: 'Served by Adobe Fonts — needs a Creative Cloud plan' }));
  } else if (free && !free.incomplete) {
    el.append(tag('none', compact ? 'No free source' : 'No free source found', {
      title: 'Not on Google Fonts, Fontshare, Font Squirrel or Fontsource — probably a paid or custom font',
    }));
  }
}
