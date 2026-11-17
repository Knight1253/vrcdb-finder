'use strict';
// Smoke test: runs the whole pipeline against a fake GitHub/Discord/web (no network needed).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcdb-'));
for (const f of ['config.json']) fs.copyFileSync(path.join(root, f), path.join(work, f));
fs.cpSync(path.join(root, 'data'), path.join(work, 'data'), { recursive: true });
fs.mkdirSync(path.join(work, 'docs'));
process.chdir(work);

const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
const ID = 'avtr_12345678-1234-1234-1234-123456789abc';
const R = {
  'alice/vrc-avatar-db': { name: 'vrc-avatar-db', description: 'VRChat avatar database', topics: ['vrchat', 'avatar'], pushed_at: ago(2), stargazers_count: 120, language: 'Python', fork: false },
  'bob/old-vrc-avatars': { name: 'old-vrc-avatars', description: 'old vrchat avatar list', topics: ['vrchat'], pushed_at: ago(500), stargazers_count: 3, language: 'JavaScript', fork: false },
  'carol/vrc-avatar-db': { name: 'vrc-avatar-db', description: 'fork of the db', topics: ['vrchat'], pushed_at: ago(10), stargazers_count: 0, fork: true, source: { full_name: 'alice/vrc-avatar-db' }, parent: { full_name: 'alice/vrc-avatar-db' } },
  'dave/vrchat-avatar-ripper': { name: 'vrchat-avatar-ripper', description: 'avatar ripper for vrchat', topics: ['vrchat'], pushed_at: ago(1), stargazers_count: 50, fork: false },
  'eve/data-dump': { name: 'data-dump', description: 'misc data', topics: [], pushed_at: ago(5), stargazers_count: 8, language: 'JSON', fork: false },
  'frank/cooking-recipes': { name: 'cooking-recipes', description: 'recipes', topics: [], pushed_at: ago(1), stargazers_count: 1, fork: false },
};
for (const [k, v] of Object.entries(R)) Object.assign(v, { full_name: k, html_url: `https://github.com/${k}`, archived: false, created_at: ago(900), homepage: null });
const README = {
  'alice/vrc-avatar-db': `# VRC DB\n## Usage\nQuery the API: https://good.example/api/v1/avatars\nJoin https://discord.gg/abc123\nSite: https://dead.example/site\nIDs: ${ID} avtr_aaaaaaaa-1234-1234-1234-123456789abc avtr_bbbbbbbb-1234-1234-1234-123456789abc\n`.padEnd(600, '.'),
  'eve/data-dump': '# data\nstuff',
};
const calls = { webhook: [], issues: [], paths: {} };
const web = { 'good.example': 200, 'dead.example': 404 };
let discordUp = true;

const respond = (obj, req, status = 200, extra = {}) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
  if (req.headers['if-none-match'] === etag) return new Response(null, { status: 304 });
  return new Response(body, { status, headers: { etag, 'x-ratelimit-remaining': '4000', ...extra } });
};

global.fetch = async (url, init = {}) => {
  const u = new URL(url); const method = init.method || 'GET';
  const req = { headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
  if (u.hostname === 'api.github.com') {
    calls.paths[u.pathname] = (calls.paths[u.pathname] || 0) + 1;
    if (u.pathname === '/search/repositories') return respond({ items: Object.values(R).filter((r) => !r.source || true).map((r) => ({ ...r, source: undefined, parent: undefined })) }, req);
    if (u.pathname === '/search/code') return respond({ items: [1, 2, 3].map((i) => ({ path: `data/avatars-${i}.json`, repository: { full_name: 'eve/data-dump' } })) }, req);
    if (u.pathname.endsWith('/issues') && method === 'POST') { calls.issues.push(JSON.parse(init.body)); return new Response('{}', { status: 201 }); }
    let m;
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/))) return R[m[1]] ? respond(R[m[1]], req) : new Response('{}', { status: 404 });
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/readme$/))) return respond(README[m[1]] || '# readme', req);
    if (u.pathname.endsWith('/commits')) return respond(Array.from({ length: u.pathname.includes('alice') ? 30 : 2 }, (_, i) => ({ commit: { author: { date: ago(i * 2) } } })), req);
    if (u.pathname.endsWith('/issues')) return respond([{ closed_at: ago(3) }, { closed_at: ago(9) }], req);
    if (u.pathname.endsWith('/releases')) return respond([{ published_at: ago(20) }], req);
    if (u.pathname.endsWith('/contents/')) return respond([{ type: 'file', name: 'avatars.json' }, { type: 'file', name: 'README.md' }], req);
    return new Response('{}', { status: 404 });
  }
  if (u.hostname === 'discord.com' && u.pathname.startsWith('/api/v10/invites/')) return discordUp ? new Response(JSON.stringify({ guild: { name: 'VRC DB Discord' } }), { status: 200 }) : new Response('{}', { status: 404 });
  if (u.hostname === 'discord.com' && u.pathname.startsWith('/api/webhooks/')) { calls.webhook.push(JSON.parse(init.body).content); return new Response(null, { status: 204 }); }
  if (web[u.hostname] !== undefined) return new Response(null, { status: web[u.hostname] });
  throw new Error('unexpected fetch ' + url);
};
require(path.join(root, 'src/links.js')).setResolver(async () => ['93.184.216.34']);

const env = { GITHUB_REPOSITORY: 'me/vrc', GITHUB_TOKEN: 't', GH_TOKEN: 't', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-def' };
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const quiet = () => {};

(async () => {
  const { main } = require(path.join(root, 'scan.js'));

  // Run 1: first scan
  let r = await main({ env, full: true, gateScale: 0, log: quiet });
  let names = r.repos.map((x) => x.full_name);
  ok(names.includes('alice/vrc-avatar-db'), 'finds the real database');
  ok(names.includes('eve/data-dump'), 'finds a repo via code search');
  ok(!names.includes('frank/cooking-recipes'), 'drops unrelated repos');
  ok(!names.includes('dave/vrchat-avatar-ripper'), 'flagged repo is not listed');
  ok(read('data/flagged.json').repos.some((f) => f.full_name === 'dave/vrchat-avatar-ripper'), 'flagged repo is logged for review');
  ok(!names.includes('carol/vrc-avatar-db'), 'fork collapsed into parent');
  const alice = r.repos.find((x) => x.full_name === 'alice/vrc-avatar-db');
  ok(alice.forks.includes('carol/vrc-avatar-db'), 'parent records collapsed fork');
  ok(alice.looks_like_db && alice.active && alice.score >= 70, `alice scored ${alice.score}`);
  ok(alice.sources.find((s) => s.kind === 'discord')?.label === 'VRC DB Discord', 'discord invite checked, guild name captured');
  ok(alice.sources.find((s) => s.kind === 'website')?.status === 'down', 'dead website detected');
  ok(alice.activity.length === 12 && alice.activity.some((n) => n > 0), 'activity sparkline data');
  ok(read('docs/graveyard.json').repos.some((g) => g.full_name === 'bob/old-vrc-avatars'), 'stale repo moved to graveyard');
  ok(fs.existsSync('docs/feed.xml') && fs.readFileSync('docs/feed.xml', 'utf8').includes('Initial scan'), 'atom feed generated');
  ok(calls.webhook.length === 1 && calls.issues.length === 0, 'first run: single Discord message, no issue flood');

  // Run 2: incremental; nothing changed
  const commitsBefore = calls.paths['/repos/alice/vrc-avatar-db/commits'];
  r = await main({ env, gateScale: 0, log: quiet });
  ok(calls.paths['/repos/alice/vrc-avatar-db/commits'] === commitsBefore, 'incremental scan reuses unchanged repos (no re-inspection)');
  ok(r.stats.cached > 0, `ETag cache hits: ${r.stats.cached}`);
  ok(calls.webhook.length === 1, 'no alerts when nothing changed');

  // Run 3: dead site comes back, discord goes down
  web['dead.example'] = 200; discordUp = false;
  r = await main({ env, gateScale: 0, log: quiet });
  const last = read('docs/changelog.json').runs.at(-1).events.map((e) => e.type);
  ok(last.includes('link_recovered') && last.includes('link_down'), 'link up/down transitions detected');
  ok(calls.webhook.length === 2 && calls.issues.length === 0, 'link changes go to Discord only');

  // Run 4: alice goes stale -> alert issue + graveyard
  R['alice/vrc-avatar-db'].pushed_at = ago(400);
  r = await main({ env, gateScale: 0, log: quiet });
  ok(!r.repos.some((x) => x.full_name === 'alice/vrc-avatar-db'), 'long-stale repo moved out of the main list');
  ok(read('docs/graveyard.json').repos.some((g) => g.full_name === 'alice/vrc-avatar-db'), 'and into the graveyard');
  ok(calls.issues.length === 1 && calls.issues[0].labels[0] === 'scan-alert', 'went-stale opens a scan-alert issue');

  // Digest
  r = await main({ env: { ...env, DIGEST: '1' }, gateScale: 0, log: quiet });
  ok(calls.issues.some((i) => i.labels[0] === 'digest'), 'weekly digest issue created');

  // SSRF guard
  const links = require(path.join(root, 'src/links.js'));
  ok(await links.classify('http://169.254.169.254/latest/meta-data') === 'blocked', 'SSRF guard blocks metadata IP');
  ok(await links.classify('http://localhost:8080/') === 'blocked', 'SSRF guard blocks localhost');

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
