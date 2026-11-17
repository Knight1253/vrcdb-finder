'use strict';
// 0-100 score: recency 30, commits 20, maintenance 10, releases 5, stars 10, content evidence 15, readme 5, link health 5.
function scoreRepo(r) {
  const s = r.signals; const d = r.days_since_push; const b = {};
  b.recency = d <= 7 ? 30 : d <= 30 ? 24 : d <= 90 ? 16 : d <= 180 ? 8 : d <= 365 ? 3 : 0;
  b.commits = Math.round(Math.min(s.commits90, 40) / 40 * 20);
  b.maintenance = Math.round(Math.min(s.closed90, 10));
  b.releases = s.releaseAgeDays == null ? 0 : s.releaseAgeDays <= 180 ? 5 : s.releaseAgeDays <= 365 ? 3 : 1;
  b.stars = Math.round(Math.min(10, Math.log10(r.stars + 1) * 4));
  b.content = Math.round(Math.min(s.avatarIds, 20) / 20 * 8 + (s.hasDataFiles ? 4 : 0) + Math.min(s.codeFiles, 6) / 6 * 3);
  b.readme = (s.readmeLen >= 500 ? 2 : s.readmeLen >= 150 ? 1 : 0) + (s.hasHeadings ? 1 : 0) + (s.hasUsage ? 2 : 0);
  const checked = (r.sources || []).filter((x) => x.status);
  b.links = checked.length ? Math.round(checked.filter((x) => x.status === 'up').length / checked.length * 5) : 2;
  let score = Object.values(b).reduce((a, v) => a + v, 0);
  if (r.archived) score = Math.min(score, 10);
  return { score: Math.max(0, Math.min(100, score)), breakdown: b };
}
module.exports = { scoreRepo };
