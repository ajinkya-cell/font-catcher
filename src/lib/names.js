// Font-name helpers shared by the popup, dashboard and background.

// Lookup key: case, spacing and punctuation don't matter ("Open Sans" = "OpenSans" = "open-sans").
export const nameKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Turn the names sites give fonts into the font's real name:
//   "__Inter_d65c78" (Next.js) -> "Inter", "PlusJakartaSans-Variable" -> "Plus Jakarta Sans",
//   "Satoshi Variable" -> "Satoshi", "proxima-nova" -> "Proxima Nova".
export function cleanFamilyName(raw) {
  let s = String(raw).trim().replace(/^["']|["']$/g, '');
  const next = s.match(/^__(.+?)(?:_Fallback)?_[0-9a-f]{5,8}$/i);
  if (next) s = next[1];
  s = s.replace(/[_-]+/g, ' ');
  // Split CamelCase words, but leave names that are already spaced alone ("McLaren Sans").
  s = s.split(' ').map((w, i, all) => (all.length > 2 ? w : w.replace(/([a-z])([A-Z])/g, '$1 $2'))).join(' ');
  // Packaging words, only at the end ("Graphik Web", "InterVariable") — never "Times New Roman".
  let prev;
  do {
    prev = s;
    s = s.replace(/\s+(variable|var|vf|webfont|web|regular)$/i, '').trim();
  } while (s !== prev);
  if (s && s === s.toLowerCase()) s = s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return s || String(raw).trim();
}
