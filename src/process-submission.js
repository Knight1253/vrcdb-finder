'use strict';
// Handles issues created from the "Submit a database" form: validates the repo, adds it to data/submissions.json.
// The issue body is treated strictly as data (read from the event payload, never interpolated into a shell).
const fs = require('fs');
const { readJson, writeJson } = require('./util');

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const event = readJson(process.env.GITHUB_EVENT_PATH || '', null);

async function api(path, opts = {}, base = `https://api.github.com/repos/${repo}`) {
  return fetch(`${base}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vrc-avatar-db-finder', 'Content-Type': 'application/json' } });
}
async function reply(number, body, close) {
  await api(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  if (close) await api(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
}

(async () => {
  if (!event?.issue || !token) { console.log('No issue payload.'); return; }
  const issue = event.issue;
  const m = String(issue.body || '').match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!m) { await reply(issue.number, 'Could not find a GitHub repository URL in this submission.', true); return; }
  const full = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  const res = await api('', {}, `https://api.github.com/repos/${full}`);
  if (!res.ok) { await reply(issue.number, `Could not find the public repository \`${full}\`.`, true); return; }
  const meta = await res.json();
  const block = readJson('data/blocklist.json', {});
  const names = [...(block.repos || [])].map((s) => String(s).toLowerCase());
  const owners = [...(block.owners || [])].map((s) => String(s).toLowerCase());
  if (names.includes(meta.full_name.toLowerCase()) || owners.includes(meta.owner.login.toLowerCase())) { await reply(issue.number, 'This repository cannot be added.', true); return; }
  const subs = readJson('data/submissions.json', { repos: [] });
  if (subs.repos.map((s) => s.toLowerCase()).includes(meta.full_name.toLowerCase())) { await reply(issue.number, `\`${meta.full_name}\` is already queued.`, true); return; }
  subs.repos.push(meta.full_name);
  writeJson('data/submissions.json', subs);
  await reply(issue.number, `Thanks! \`${meta.full_name}\` was queued and will appear after the next scan if it looks like an active avatar database.`, true);
})().catch((e) => { console.error(e.message); process.exit(1); });
