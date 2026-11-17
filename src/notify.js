'use strict';
// Alerts (Discord webhook + GitHub Issues) and the weekly digest.
const { daysBetween } = require('./util');
const DISCORD_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const MAJOR = ['new_active', 'went_stale', 'gone', 'revived'];
const MINOR = ['link_down', 'link_recovered'];
const ICON = { new_active: '🟢', went_stale: '🟠', gone: '⚫', revived: '🔄', link_down: '🔴', link_recovered: '✅', initial: '🚀', flagged: '🚩' };

async function sendDiscord(url, text, log) {
  if (!url) return false;
  if (!DISCORD_RE.test(url)) { log('DISCORD_WEBHOOK_URL is not a valid Discord webhook URL; skipping.'); return false; }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) });
    if (!res.ok) log(`Discord webhook returned ${res.status}`);
    return res.ok;
  } catch (e) { log(`Discord webhook failed: ${e.message}`); return false; }
}

async function createIssue({ repo, token, title, body, labels }, log) {
  if (!repo || !token) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vrc-avatar-db-finder', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: body.slice(0, 60000), labels }),
    });
    if (!res.ok) log(`Issue creation returned ${res.status}`);
    return res.ok;
  } catch (e) { log(`Issue creation failed: ${e.message}`); return false; }
}

const line = (e) => `${ICON[e.type] || '•'} ${e.text}`;

function digestText(results, changelog) {
  const repos = results.repos;
  const week = Date.now() - 7 * 864e5;
  const top = [...repos].filter((r) => r.active).sort((a, b) => b.score - a.score).slice(0, 10);
  const fresh = repos.filter((r) => new Date(r.first_seen).getTime() > week);
  const stale = changelog.runs.filter((r) => new Date(r.at).getTime() > week).flatMap((r) => r.events).filter((e) => e.type === 'went_stale');
  const down = repos.filter((r) => r.active).flatMap((r) => (r.sources || []).filter((s) => s.status === 'down').map((s) => `${r.full_name}: ${s.label || s.url} (down ${s.down_days}d)`));
  const out = [`Weekly digest - ${new Date().toISOString().slice(0, 10)}`,
    `Tracking ${repos.length} repos, ${repos.filter((r) => r.active).length} active, ${results.graveyard_count ?? 0} in graveyard.`, '',
    'Top by score:', ...top.map((r, i) => `${i + 1}. ${r.full_name} - score ${r.score}, ${r.stars}★, pushed ${r.days_since_push}d ago`)];
  if (fresh.length) out.push('', 'New this week:', ...fresh.slice(0, 10).map((r) => `- ${r.full_name}`));
  if (stale.length) out.push('', 'Went stale this week:', ...stale.slice(0, 10).map((e) => `- ${e.repo}`));
  if (down.length) out.push('', 'Links currently down:', ...down.slice(0, 10).map((d) => `- ${d}`));
  return out.join('\n');
}

async function notify({ events, results, changelog, cfg, env, first, digest, log = console.log }) {
  const webhook = cfg.notifications?.discord === false ? null : env.DISCORD_WEBHOOK_URL;
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const canIssue = cfg.notifications?.issues !== false;
  const date = new Date().toISOString().slice(0, 10);

  if (first) {
    await sendDiscord(webhook, events.map(line).join('\n') || 'Initial scan complete.', log);
  } else {
    const major = events.filter((e) => MAJOR.includes(e.type));
    const minor = events.filter((e) => MINOR.includes(e.type));
    if (major.length || minor.length) {
      await sendDiscord(webhook, ['**VRC avatar DB scan**', ...[...major, ...minor].slice(0, 25).map(line)].join('\n'), log);
    }
    if (canIssue && major.length) {
      await createIssue({ repo, token, title: `Scan alert ${date}: ${major.length} change(s)`, body: major.map((e) => `- ${line(e)}`).join('\n'), labels: ['scan-alert'] }, log);
    }
  }
  if (digest) {
    const text = digestText(results, changelog);
    await sendDiscord(webhook, text, log);
    if (canIssue) await createIssue({ repo, token, title: `Weekly digest ${date}`, body: text, labels: ['digest'] }, log);
  }
}

module.exports = { notify, digestText, MAJOR };
