# vrcdb finder

Scans GitHub daily for repos that look like VRChat avatar databases, scores how active they are, and publishes the results as a GitHub Pages site.

- `scan.js` does the searching and scoring (Node 20, no dependencies)
- `config.json` holds the search queries and the "active" threshold in days
- `.github/workflows/scan.yml` runs the scan daily and commits `docs/results.json`
- `docs/index.html` is the Pages site (served from `main` / `/docs`)

Run locally: `GH_TOKEN=<token> node scan.js`

This tool only reads public repo metadata and READMEs. It does not download or redistribute avatar content. Respect VRChat's Terms of Service.

