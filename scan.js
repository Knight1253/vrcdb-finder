// Finds GitHub repos that look like VRChat avatar databases and scores their activity.
// Only reads public metadata + READMEs. Does not download or redistribute avatar content.
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const TOKEN = process.env.GH_TOKEN;
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vrc-avatar-db-finder',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url, extra = {}, retry = true) {
  const res = await fetch(url, { headers: { ...headers, ...extra } });
  if ((res.status === 403 || res.status === 429) && retry) {
    console.log('Rate limited, waiting 60s...');
    await sleep(60000);
    return gh(url, extra, false);
  }
  return res;
}

async function search(query) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${config.maxReposPerQuery}`;
  const res = await gh(url);
  if (!res.ok) { console.log(`Search failed (${res.status}): ${query}`); return []; }
  return (await res.json()).items || [];
}

async function readme(full) {
  const res = await gh(`https://api.github.com/repos/${full}/readme`, { Accept: 'application/vnd.github.raw+json' });
  return res.ok ? await res.text() : '';
}

async function linkAlive(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return res.status < 400;
  } catch { return false; }
}

async function main() {
  let previous = {};
  try {
    const old = JSON.parse(fs.readFileSync('docs/results.json', 'utf8'));
    for (const r of old.repos || []) previous[r.full_name] = r;
  } catch {}

  const found = new Map();
  for (const q of config.queries) {
    console.log(`Searching: ${q}`);
    for (const repo of await search(q)) found.set(repo.full_name, repo);
    await sleep(2500);
  }
  console.log(`Candidates: ${found.size}`);

  const now = Date.now();
  const repos = [];
  for (const [full, r] of found) {
    const text = await readme(full);
    const avatarIds = (text.match(/avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).length;
    const looksLikeDb = avatarIds > 0 || /avatar/i.test(r.name + ' ' + (r.description || '')) && /(database|search|index|list|finder|api)/i.test(r.name + ' ' + (r.description || '') + ' ' + text.slice(0, 2000));

    const links = [...new Set((text.match(/https?:\/\/[^\s)>\]"']+/g) || []).filter((u) => !/github\.com|shields\.io|githubusercontent/i.test(u)))].slice(0, 3);
    const linkStatus = [];
    for (const u of links) linkStatus.push({ url: u, alive: await linkAlive(u) });

    const daysSincePush = Math.floor((now - new Date(r.pushed_at).getTime()) / 86400000);
    repos.push({
      full_name: full,
      url: r.html_url,
      description: r.description || '',
      stars: r.stargazers_count,
      language: r.language,
      archived: r.archived,
      pushed_at: r.pushed_at,
      days_since_push: daysSincePush,
      active: !r.archived && daysSincePush <= config.activeDays,
      looks_like_db: !!looksLikeDb,
      avatar_ids_in_readme: avatarIds,
      external_links: linkStatus,
      first_seen: previous[full]?.first_seen || new Date().toISOString(),
    });
  }

  repos.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.looks_like_db) - Number(a.looks_like_db) || a.days_since_push - b.days_since_push);
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/results.json', JSON.stringify({ generatedAt: new Date().toISOString(), activeDays: config.activeDays, repos }, null, 2));
  console.log(`Wrote ${repos.length} repos (${repos.filter((r) => r.active).length} active).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
