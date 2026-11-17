'use strict';
// VRC avatar database finder: discovery -> safety -> incremental inspection -> scoring -> health -> outputs -> alerts.
// Reads public metadata and READMEs only. Never downloads or redistributes avatar content.
const { GitHub, RateLimitAbort } = require('./src/github');
const { readJson, writeJson, pool, daysBetween } = require('./src/util');
const { countAvatarIds, extractSources } = require('./src/extract');
const { scoreRepo } = require('./src/score');
const safety = require('./src/safety');
const links = require('./src/links');
const { notify } = require('./src/notify');
const { buildAtom } = require('./src/feed');
const fs = require('fs');

const key = (n) => String(n).toLowerCase();
const DATA_FILE = /\.(json|csv|tsv|ndjson|db|sqlite3?|parquet)$/i;
const IGNORED_DATA = /^(package(-lock)?|tsconfig[\w.-]*|composer|manifest|renovate|vercel|netlify|\.eslintrc|\.prettierrc|deno|bun|jsconfig|app|config|settings|appsettings)\.json$/i;
const CODE_PATH_OK = /\.(json|csv|tsv|ndjson|txt|db)$/i;
const CODE_PATH_BAD = /(^|\/)(tests?|examples?|samples?|docs?|node_modules|openapi|swagger)(\/|$)/i;

function loadConfig() {
  const c = readJson('config.json', {});
  return {
    activeDays: 90, graveyardDays: 365, fullScanDay: 0, digestDay: 0, reinspectDays: 14, maxCandidates: 300, maxCodeRepos: 40,
    maxInspectionsPerRun: 120, maxLinkChecks: 300, concurrency: 5, minRateLimitRemaining: 60, perPage: 50, queries: [], codeQueries: [],
    ...c,
    notifications: { issues: true, discord: true, ...(c.notifications || {}) },
    safety: { heuristics: true, ...(c.safety || {}) },
    feed: { title: 'VRC Avatar DB Finder', maxItems: 50, ...(c.feed || {}) },
  };
}

function isRelevant(m, c) {
  if (c.via.has('known') || c.via.has('submitted')) return true;
  const text = `${m.name} ${m.description || ''} ${(m.topics || []).join(' ')}`.toLowerCase();
  if (/vrc|vrchat|vr chat/.test(text) && /avatar|avtr/.test(text)) return true;
  return c.codeFiles >= 2;
}

async function inspect(gh, m, c) {
  const full = m.full_name;
  const sinceIso = new Date(Date.now() - 90 * 864e5).toISOString();
  const [rd, cm, is, rl, ct] = await Promise.all([gh.readme(full), gh.commits(full, sinceIso), gh.closedIssues(full, sinceIso), gh.releases(full), gh.contents(full)]);
  const readme = rd.status === 200 && rd.body ? rd.body : '';
  const commits = Array.isArray(cm.data) ? cm.data : [];
  const bins = new Array(12).fill(0);
  for (const x of commits) {
    const t = new Date(x.commit?.author?.date || x.commit?.committer?.date || 0).getTime();
    const w = Math.floor((Date.now() - t) / (7 * 864e5));
    if (w >= 0 && w < 12) bins[11 - w]++;
  }
  const closed90 = (Array.isArray(is.data) ? is.data : []).filter((i) => i.closed_at && new Date(i.closed_at) >= new Date(sinceIso)).length;
  const rel = Array.isArray(rl.data) && rl.data[0] ? daysBetween(rl.data[0].published_at || rl.data[0].created_at) : null;
  const files = Array.isArray(ct.data) ? ct.data : [];
  const hasDataFiles = files.some((f) => (f.type === 'file' && DATA_FILE.test(f.name) && !IGNORED_DATA.test(f.name)) || (f.type === 'dir' && /^(data|db|database|avatars?|dataset|datasets)$/i.test(f.name)));
  const sources = extractSources(readme);
  const signals = {
    commits90: commits.length, closed90, releaseAgeDays: rel, avatarIds: countAvatarIds(readme), codeFiles: c.codeFiles || 0, hasDataFiles,
    readmeLen: readme.length, hasHeadings: /^#{1,3}\s/m.test(readme), hasUsage: /(usage|install|api|endpoint|how to|getting started|query)/i.test(readme),
  };
  const tags = new Set((m.topics || []).filter((t) => !/^vrc(hat)?$|^avatars?$/.test(t)).slice(0, 4));
  if (m.language) tags.add(m.language.toLowerCase());
  if (sources.some((s) => s.kind === 'api') || /\b(api|endpoint)\b/i.test(readme)) tags.add('api');
  if (sources.some((s) => s.kind === 'discord') || /discord bot/i.test(readme)) tags.add('discord');
  if (/\bbot\b/i.test(readme + ' ' + (m.description || ''))) tags.add('bot');
  if (m.homepage || sources.some((s) => s.kind === 'website')) tags.add('web');
  if (hasDataFiles || signals.avatarIds > 0) tags.add('dataset');
  return { readme, signals, sources, activity: bins, tags: [...tags].slice(0, 8), at: new Date().toISOString() };
}

const linkKey = (s) => (s.kind === 'discord' ? `discord:${s.code.toLowerCase()}` : s.url);

async function main(opts = {}) {
  const cfg = loadConfig();
  const env = opts.env || process.env;
  const log = opts.log || console.log;
  const nowIso = new Date().toISOString();
  const full = opts.full ?? (env.FULL_SCAN === '1' || process.argv.includes('--full') || (env.EVENT_NAME === 'schedule' && new Date().getUTCDay() === cfg.fullScanDay));
  const digest = env.DIGEST === '1' || (env.EVENT_NAME === 'schedule' && new Date().getUTCDay() === cfg.digestDay);
  const gh = opts.gh || new GitHub({ token: env.GH_TOKEN, concurrency: cfg.concurrency, minRemaining: cfg.minRateLimitRemaining, gateScale: opts.gateScale ?? 1, log });
  log(`Scan mode: ${full ? 'full' : 'incremental'}`);

  // ---- load state ----
  const prevResults = readJson('docs/results.json', { repos: [] });
  const prevByName = new Map(prevResults.repos.map((r) => [key(r.full_name), r]));
  const graveyard = readJson('docs/graveyard.json', { repos: [] });
  const graveByName = new Map(graveyard.repos.map((r) => [key(r.full_name), r]));
  const health = readJson('docs/health.json', { links: {} });
  const changelog = readJson('docs/changelog.json', { runs: [] });
  const flaggedFile = readJson('data/flagged.json', { repos: [] });
  const flaggedSet = new Set(flaggedFile.repos.map((r) => key(r.full_name)));
  const block = safety.toSets(readJson('data/blocklist.json', {}), ['repos', 'owners', 'keywords']);
  const allow = safety.toSets(readJson('data/allowlist.json', {}), ['repos']);
  const subs = readJson('data/submissions.json', { repos: [] }).repos || [];
  const isFirstRun = prevResults.repos.length === 0 && graveyard.repos.length === 0;

  // ---- 1. discovery ----
  const cands = new Map();
  const addCand = (name, meta, via) => {
    const k = key(name);
    const c = cands.get(k) || { full_name: name, meta: null, codeFiles: 0, via: new Set() };
    if (meta && !c.meta) c.meta = meta;
    c.via.add(via); cands.set(k, c); return c;
  };
  for (const r of prevResults.repos) addCand(r.full_name, null, 'known');
  for (const s of subs) addCand(s, null, 'submitted');
  try {
    for (const q of cfg.queries) {
      const items = await gh.searchRepos(q, cfg.perPage);
      log(`Search "${q}": ${items.length}`);
      for (const it of items) addCand(it.full_name, it, 'search');
    }
    for (const q of cfg.codeQueries) {
      const items = await gh.searchCode(q);
      log(`Code search "${q}": ${items.length} files`);
      for (const it of items) {
        const p = it.path || '';
        if (!CODE_PATH_OK.test(p) || CODE_PATH_BAD.test(p) || !it.repository?.full_name) continue;
        addCand(it.repository.full_name, null, 'code').codeFiles++;
      }
    }
  } catch (e) {
    if (e instanceof RateLimitAbort) log(`Discovery stopped: ${e.message}`); else throw e;
  }

  // ---- 2. metadata for stubs and forks ----
  let list = [...cands.values()];
  const codeOnly = list.filter((c) => !c.meta && c.via.size === 1 && c.via.has('code'));
  const dropCode = new Set(codeOnly.filter((c) => c.codeFiles < 2).map((c) => key(c.full_name)));
  const keepCode = new Set(codeOnly.filter((c) => c.codeFiles >= 2).sort((a, b) => b.codeFiles - a.codeFiles).slice(0, cfg.maxCodeRepos).map((c) => key(c.full_name)));
  list = list.filter((c) => !(c.via.size === 1 && c.via.has('code')) || keepCode.has(key(c.full_name)));
  list = list.filter((c) => !dropCode.has(key(c.full_name))).slice(0, cfg.maxCandidates);
  const need = list.filter((c) => !c.meta || (c.meta.fork && !c.meta.source));
  const detailRes = await pool(need, cfg.concurrency, async (c) => {
    const r = await gh.repo(c.full_name);
    if (r.status === 200 && r.data) c.meta = r.data;
    else if (r.status === 404 || r.status === 451) c.gone = true;
  });
  detailRes.forEach((r) => { if (r?.__error && !(r.__error instanceof RateLimitAbort)) log(`Detail fetch error: ${r.__error.message}`); });

  const events = [];
  const gone = list.filter((c) => c.gone && prevByName.has(key(c.full_name)));
  for (const c of gone) events.push({ type: 'gone', repo: c.full_name, text: `${c.full_name} was deleted or made private` });

  // dedupe by canonical name (handles renames)
  const byName = new Map();
  for (const c of list) {
    if (c.gone) continue;
    if (!c.meta) { const p = prevByName.get(key(c.full_name)); if (p) byName.set(key(c.full_name), { ...c, meta: null, prevOnly: true }); continue; }
    const k = key(c.meta.full_name);
    const ex = byName.get(k);
    if (ex) { ex.codeFiles = Math.max(ex.codeFiles, c.codeFiles); c.via.forEach((v) => ex.via.add(v)); } else byName.set(k, { ...c, full_name: c.meta.full_name });
  }

  // ---- 3. safety + relevance + graveyard filter ----
  const newlyFlagged = [];
  const revived = [];
  let work = [];
  for (const c of byName.values()) {
    if (c.prevOnly) { work.push(c); continue; }
    const m = c.meta; const k = key(m.full_name);
    if (flaggedSet.has(k) && !allow.repos.has(k)) continue;
    const q = safety.evaluate(m, '', block, allow, cfg);
    if (q.flagged) { newlyFlagged.push({ full_name: m.full_name, reasons: q.reasons, flagged_at: nowIso }); continue; }
    if (!isRelevant(m, c)) continue;
    if (graveByName.has(k)) {
      if (m.archived || daysBetween(m.pushed_at) > cfg.graveyardDays) continue;
      revived.push(m.full_name);
    }
    work.push(c);
  }

  // ---- 4. fork pre-collapse ----
  const workKeys = new Map(work.filter((c) => c.meta).map((c) => [key(c.meta.full_name), c]));
  const preCollapsed = new Map();
  work = work.filter((c) => {
    const m = c.meta; if (!m || !m.fork) return true;
    const root = m.source?.full_name || m.parent?.full_name; if (!root) return true;
    c.fork_of = root;
    const rc = workKeys.get(key(root));
    if (rc && new Date(rc.meta.pushed_at) >= new Date(m.pushed_at)) {
      const arr = preCollapsed.get(key(root)) || []; arr.push(m.full_name); preCollapsed.set(key(root), arr); return false;
    }
    return true;
  });

  // ---- 5. inspection (incremental) ----
  const needsInspect = (c) => {
    if (c.prevOnly) return false;
    const p = prevByName.get(key(c.meta.full_name));
    return full || !p || p.pushed_at !== c.meta.pushed_at || !p.inspected_at || daysBetween(p.inspected_at) >= cfg.reinspectDays;
  };
  const toInspect = work.filter(needsInspect)
    .sort((a, b) => Number(prevByName.has(key(a.meta.full_name))) - Number(prevByName.has(key(b.meta.full_name))) || new Date(b.meta.pushed_at) - new Date(a.meta.pushed_at))
    .slice(0, cfg.maxInspectionsPerRun);
  const inspectSet = new Set(toInspect.map((c) => key(c.meta.full_name)));
  const inspected = new Map();
  await pool(toInspect, cfg.concurrency, async (c) => {
    if (gh.lowBudget()) return;
    try {
      const insp = await inspect(gh, c.meta, c);
      const q = safety.evaluate(c.meta, insp.readme, block, allow, cfg);
      if (q.flagged) { newlyFlagged.push({ full_name: c.meta.full_name, reasons: q.reasons, flagged_at: nowIso }); inspected.set(key(c.meta.full_name), { flagged: true }); return; }
      inspected.set(key(c.meta.full_name), insp);
    } catch (e) { if (!(e instanceof RateLimitAbort)) log(`Inspect failed for ${c.meta.full_name}: ${e.message}`); }
  });

  // ---- 6. build records ----
  let records = [];
  let reused = 0;
  for (const c of work) {
    if (c.prevOnly) { const p = prevByName.get(key(c.full_name)); if (p) { records.push({ ...p }); reused++; } continue; }
    const m = c.meta; const k = key(m.full_name); const p = prevByName.get(k);
    let insp = inspected.get(k);
    if (insp?.flagged) continue;
    if (!insp) {
      if (!p) continue; // new but over budget: pick it up next run
      insp = { signals: p.signals, sources: p.sources || [], activity: p.activity, tags: p.tags, at: p.inspected_at };
      reused++;
    }
    const sig = { ...insp.signals, codeFiles: Math.max(insp.signals.codeFiles || 0, c.codeFiles || 0) };
    records.push({
      full_name: m.full_name, url: m.html_url, description: m.description || '', topics: m.topics || [], stars: m.stargazers_count || 0,
      language: m.language || null, archived: !!m.archived, fork: !!m.fork, fork_of: c.fork_of || p?.fork_of || null, forks: [],
      created_at: m.created_at, pushed_at: m.pushed_at, homepage: m.homepage || null, signals: sig,
      sources: (insp.sources || []).map((s) => ({ kind: s.kind, url: s.url, ...(s.code ? { code: s.code } : {}) })),
      activity: insp.activity, tags: insp.tags, first_seen: p?.first_seen || nowIso, inspected_at: insp.at,
    });
  }
  if (!records.length && prevResults.repos.length) throw new Error('No repositories could be processed; keeping previous results.');

  // ---- 7. link health ----
  const uniq = new Map();
  [...records].sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at)).forEach((r) => {
    for (const s of r.sources) { const k = linkKey(s); if (!uniq.has(k)) uniq.set(k, { src: s, repos: new Set() }); uniq.get(k).repos.add(r.full_name); }
  });
  const toCheck = [...uniq.entries()].slice(0, cfg.maxLinkChecks);
  const checked = await pool(toCheck, 6, async ([, v]) => links.check(v.src));
  const linkEvents = [];
  toCheck.forEach(([k, v], i) => {
    const res = checked[i];
    if (!res || res.__error || res.status === 'unknown') return;
    const h = (health.links[k] ||= { kind: v.src.kind, url: v.src.url, first_checked: nowIso, status: null, down_since: null, history: [], checks: 0, ups: 0 });
    const was = h.status; const up = res.status === 'up';
    h.last_checked = nowIso; h.last_seen = nowIso; h.checks++; if (up) h.ups++;
    h.history = [...h.history, up ? 1 : 0].slice(-30);
    h.status = up ? 'up' : 'down';
    if (!up && was !== 'down') h.down_since = nowIso;
    if (up) h.down_since = null;
    if (res.label) h.label = res.label;
    if (was && was !== h.status) linkEvents.push({ key: k, status: h.status, label: h.label || v.src.url, repos: [...v.repos] });
  });
  for (const [k, v] of uniq) if (health.links[k]) health.links[k].last_seen = nowIso;
  for (const [k, h] of Object.entries(health.links)) if (h.last_seen && daysBetween(h.last_seen) > 30) delete health.links[k];

  // ---- 8. enrich, score ----
  for (const r of records) {
    r.sources = r.sources.map((s) => {
      const h = health.links[linkKey(s)];
      return { ...s, label: h?.label || null, status: h?.status || null, down_days: h?.down_since ? daysBetween(h.down_since) : 0, uptime: h?.checks ? Math.round(h.ups / h.checks * 100) : null };
    });
    r.days_since_push = daysBetween(r.pushed_at);
    r.active = !r.archived && r.days_since_push <= cfg.activeDays;
    const nd = `${r.full_name.split('/')[1]} ${r.description}`;
    r.looks_like_db = r.signals.avatarIds > 0 || r.signals.codeFiles >= 2 ||
      (/avatar|avtr/i.test(nd) && (r.signals.hasDataFiles || /database|dataset|index|search|finder|api/i.test(nd + ' ' + r.tags.join(' '))));
    const { score, breakdown } = scoreRepo(r);
    const p = prevByName.get(key(r.full_name));
    r.score = score; r.score_breakdown = breakdown; r.score_prev = p?.score ?? null;
  }

  // ---- 9. fork collapse (keep the best-scoring member of each fork family) ----
  const families = new Map();
  for (const r of records) { const root = key(r.fork_of || r.full_name); (families.get(root) || families.set(root, []).get(root)).push(r); }
  const dropped = new Set();
  for (const [root, group] of families) {
    const extra = preCollapsed.get(root) || [];
    if (group.length === 1 && !extra.length) continue;
    const rep = [...group].sort((a, b) => b.score - a.score || (key(a.full_name) === root ? -1 : 1))[0];
    const others = group.filter((g) => g !== rep).map((g) => g.full_name);
    group.filter((g) => g !== rep).forEach((g) => dropped.add(key(g.full_name)));
    rep.forks = [...new Set([...extra, ...others])];
  }
  records = records.filter((r) => !dropped.has(key(r.full_name)));

  // ---- 10. graveyard ----
  const stayGrave = graveyard.repos.filter((g) => !revived.some((n) => key(n) === key(g.full_name)) && !records.some((r) => key(r.full_name) === key(g.full_name)));
  const newGrave = [];
  const results = [];
  for (const r of records) {
    if (!r.active && (r.archived || r.days_since_push > cfg.graveyardDays)) {
      newGrave.push({ full_name: r.full_name, url: r.url, description: r.description, stars: r.stars, pushed_at: r.pushed_at, reason: r.archived ? 'archived' : 'stale', moved_at: nowIso, last_score: r.score });
    } else results.push(r);
  }
  for (const c of gone) { const p = prevByName.get(key(c.full_name)); if (p) newGrave.push({ full_name: p.full_name, url: p.url, description: p.description, stars: p.stars, pushed_at: p.pushed_at, reason: 'deleted', moved_at: nowIso, last_score: p.score }); }
  const graveOut = [...new Map([...stayGrave, ...newGrave].map((g) => [key(g.full_name), g])).values()].sort((a, b) => new Date(b.moved_at) - new Date(a.moved_at)).slice(0, 1000);

  results.sort((a, b) => Number(b.active) - Number(a.active) || b.score - a.score || a.days_since_push - b.days_since_push);

  // ---- 11. events ----
  const resByName = new Map(results.map((r) => [key(r.full_name), r]));
  for (const r of results) {
    const p = prevByName.get(key(r.full_name));
    if (r.active && (!p || !p.active) && r.looks_like_db) events.push({ type: 'new_active', repo: r.full_name, text: p ? `${r.full_name} is active again (score ${r.score})` : `New active database: ${r.full_name} (score ${r.score})` });
    if (p && p.active && !r.active) events.push({ type: 'went_stale', repo: r.full_name, text: `${r.full_name} went stale (last push ${r.days_since_push}d ago)` });
  }
  for (const g of newGrave) { const p = prevByName.get(key(g.full_name)); if (p && p.active && g.reason !== 'deleted') events.push({ type: 'went_stale', repo: g.full_name, text: `${g.full_name} went stale and moved to the graveyard (${g.reason})` }); }
  for (const n of revived) if (resByName.has(key(n))) events.push({ type: 'revived', repo: n, text: `${n} came back from the graveyard` });
  for (const le of linkEvents) {
    const active = le.repos.filter((n) => resByName.get(key(n))?.active);
    if (!active.length) continue;
    events.push({ type: le.status === 'down' ? 'link_down' : 'link_recovered', repo: active[0], text: `${le.label} is ${le.status === 'down' ? 'down' : 'back up'} (${active[0]})` });
  }
  if (newlyFlagged.length) events.push({ type: 'flagged', repo: null, text: `${newlyFlagged.length} repo(s) flagged for review and not listed (see data/flagged.json)` });
  const finalEvents = isFirstRun ? [{ type: 'initial', repo: null, text: `Initial scan: ${results.length} repos tracked, ${results.filter((r) => r.active).length} active` }] : events;

  // ---- 12. write outputs ----
  const repository = env.GITHUB_REPOSITORY || null;
  const out = {
    generatedAt: nowIso, repository, activeDays: cfg.activeDays, mode: full ? 'full' : 'incremental',
    stats: { candidates: byName.size, inspected: inspected.size, reused, requests: gh.stats.requests, cached: gh.stats.cached, links_checked: toCheck.length, flagged: newlyFlagged.length },
    graveyard_count: graveOut.length, repos: results,
  };
  writeJson('docs/results.json', out);
  writeJson('docs/graveyard.json', { generatedAt: nowIso, repos: graveOut });
  writeJson('docs/health.json', health);
  changelog.runs.push({ at: nowIso, mode: out.mode, stats: out.stats, events: finalEvents.map(({ type, repo, text }) => ({ type, repo, text })) });
  changelog.runs = changelog.runs.slice(-200);
  writeJson('docs/changelog.json', changelog);
  if (newlyFlagged.length) {
    const merged = new Map([...flaggedFile.repos, ...newlyFlagged].map((f) => [key(f.full_name), f]));
    writeJson('data/flagged.json', { repos: [...merged.values()] });
  }
  const baseUrl = repository ? `https://${repository.split('/')[0].toLowerCase()}.github.io/${repository.split('/')[1]}/` : '';
  const entries = changelog.runs.slice().reverse().flatMap((r) => r.events.map((e) => ({ ...e, at: r.at }))).slice(0, cfg.feed.maxItems);
  fs.writeFileSync('docs/feed.xml', buildAtom({ title: cfg.feed.title, baseUrl, entries, updated: nowIso }));
  gh.save();
  log(`Done: ${results.length} repos (${results.filter((r) => r.active).length} active), graveyard ${graveOut.length}, requests ${gh.stats.requests} (${gh.stats.cached} cached), events ${finalEvents.length}`);

  try { await notify({ events: finalEvents, results: out, changelog, cfg, env, first: isFirstRun, digest, log }); }
  catch (e) { log(`Notification step failed: ${e.message}`); }
  return out;
}

module.exports = { main };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
