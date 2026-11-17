# vrcdbfinder

Scans GitHub daily for repos that look like VRChat avatar databases, scores them, tracks their health, and publishes a GitHub Pages site.

## What it does
- **Discovery**: repo search + code search (`avtr_` IDs in data files) + community submissions + everything seen before
- **Scoring (0-100)**: recency, commit rate, closed issues, releases, stars, content evidence, README quality, link health (hover the score on the site)
- **Forks collapsed** into the best-scoring family member
- **Link health**: Discord invites, API endpoints and websites found in READMEs are checked with uptime history
- **Incremental scans**: unchanged repos are reused; ETag caching makes unchanged API calls free; a full scan runs weekly
- **Alerts**: Discord webhook + GitHub Issues for new active DBs, repos going stale, deletions; link up/down goes to Discord
- **Weekly digest** (Discord + issue), **Atom feed** (`docs/feed.xml`), **changelog page**
- **Graveyard**: stale (>365d) / archived / deleted repos are archived, and come back if they revive
- **Safety**: repos that look like rippers / unauthorized content are flagged and never listed
- **Self-healing**: rate-limit aware retries; opens an issue after 3 failed runs and closes it on recovery
- **Submissions**: the site opens a prefilled issue; a workflow validates and queues it

## Secrets (optional, Settings > Secrets and variables > Actions)
| Secret | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | Alerts and the weekly digest in Discord |
| `GH_PAT` | Classic PAT, no scopes needed. Raises rate limits (the built-in token gets ~1,000 requests/hour) and makes code search reliable |

## Files you edit
- `config.json` - queries, thresholds, notification toggles
- `data/blocklist.json` - `repos`, `owners`, `keywords` (regex) to never list
- `data/allowlist.json` - override a false-positive safety flag
- `data/flagged.json` - review what was flagged (not shown on the site)

## Local use
`manage.bat` opens a menu (run a scan, edit lists, set secrets, trigger the workflow, open the site).
`node test/mock-run.js` runs a full offline smoke test.

## Notes
Only public repo metadata and READMEs are read. Avatar content is never downloaded or redistributed. Respect VRChat's Terms of Service.
