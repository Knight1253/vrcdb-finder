'use strict';
// Self-healing: open an issue after 3 consecutive failed scans; close it again when a scan succeeds.
//   node src/failure-issue.js            (run on failure)
//   node src/failure-issue.js --resolve  (run on success)
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const resolve = process.argv.includes('--resolve');
const LABEL = 'scan-failure';

async function api(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vrc-avatar-db-finder', 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

(async () => {
  if (!repo || !token) { console.log('No repo/token; skipping.'); return; }
  const open = await api(`/issues?labels=${LABEL}&state=open&per_page=10`);
  if (resolve) {
    for (const i of open) {
      await api(`/issues/${i.number}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Scan succeeded again, closing automatically.' }) });
      await api(`/issues/${i.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
    }
    return;
  }
  const runs = (await api('/actions/workflows/scan.yml/runs?status=completed&per_page=2')).workflow_runs || [];
  if (runs.length < 2 || !runs.every((r) => r.conclusion === 'failure')) { console.log('Fewer than 3 consecutive failures; not opening an issue.'); return; }
  if (open.length) { console.log('A scan-failure issue is already open.'); return; }
  const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
  await api('/issues', { method: 'POST', body: JSON.stringify({
    title: 'Scan has failed 3 times in a row',
    body: `The scheduled scan has failed 3 consecutive runs.\n\nLatest run: ${runUrl}\n\nCommon causes: rate limits (add a \`GH_PAT\` secret), a broken config.json, or a GitHub outage. This issue closes itself when a scan succeeds.`,
    labels: [LABEL],
  }) });
})().catch((e) => { console.error(e.message); });
