'use strict';
// Flags repos that look like they host or facilitate ripped/unauthorized avatar content.
// Flagged repos are NOT listed on the site; they are logged to data/flagged.json for review.
// Override false positives by adding the repo to data/allowlist.json.
const HEURISTICS = [
  { id: 'ripper', re: /\b(avatar[\s_-]?)?(rip(per|ped|ping)?|cache[\s_-]?rip(per)?)\b/i },
  { id: 'unauthorized', re: /\bunauthori[sz]ed\b/i },
  { id: 'leaked', re: /\bleak(ed|s)?\b/i },
  { id: 'stolen', re: /\bstol(e|en)\b|\bsteal(er|ing)?\b/i },
  { id: 'cracked', re: /\bcrack(ed)?\b/i },
  { id: 'avatar-copier', re: /\bavatar[\s_-]?(thief|stealer|copier)\b/i },
  { id: 'bypass', re: /\bbypass(es)?\b.{0,40}\b(lock|protection|ban|privacy|permission)/i },
];

function toSets(list, keys) {
  const out = {};
  for (const k of keys) out[k] = new Set(((list && list[k]) || []).map((x) => String(x).toLowerCase()));
  return out;
}

function evaluate(meta, readme, block, allow, cfg) {
  const name = meta.full_name.toLowerCase();
  if (allow.repos.has(name)) return { flagged: false, reasons: [] };
  const reasons = [];
  if (block.repos.has(name)) reasons.push('blocklist:repo');
  if (block.owners.has(name.split('/')[0])) reasons.push('blocklist:owner');
  const hay = `${meta.full_name} ${meta.description || ''} ${(meta.topics || []).join(' ')} ${(readme || '').slice(0, 1500)}`;
  for (const kw of block.keywords) { try { if (new RegExp(kw, 'i').test(hay)) reasons.push(`blocklist:keyword:${kw}`); } catch {} }
  if (cfg.safety?.heuristics !== false) for (const h of HEURISTICS) if (h.re.test(hay)) reasons.push(`heuristic:${h.id}`);
  return { flagged: reasons.length > 0, reasons };
}
module.exports = { evaluate, toSets };
