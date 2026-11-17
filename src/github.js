'use strict';
// GitHub API client: ETag caching (304s are free), rate-limit aware retries,
// request concurrency limit, and search throttling.
const fs = require('fs');
const path = require('path');
const { sleep } = require('./util');

class RateLimitAbort extends Error {}
const UA = 'vrc-avatar-db-finder';

class GitHub {
  constructor(o = {}) {
    this.token = o.token;
    this.concurrency = o.concurrency || 5;
    this.minRemaining = o.minRemaining ?? 60;
    this.gateScale = o.gateScale ?? 1;
    this.log = o.log || console.log;
    this.cacheFile = o.cacheFile || path.join('.cache', 'http.json');
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch {}
    this.active = 0; this.queue = []; this.gates = {};
    this.remaining = null; this.aborted = false;
    this.stats = { requests: 0, cached: 0 };
  }

  lowBudget() { return this.aborted || (this.remaining !== null && this.remaining < this.minRemaining); }

  async limit(fn) {
    if (this.active >= this.concurrency) await new Promise((r) => this.queue.push(r));
    else this.active++;
    try { return await fn(); }
    finally { const n = this.queue.shift(); if (n) n(); else this.active--; }
  }

  async gate(kind, ms) {
    const prev = this.gates[kind] || Promise.resolve();
    let release;
    this.gates[kind] = new Promise((r) => { release = r; });
    await prev;
    setTimeout(release, ms * this.gateScale);
  }

  waitFor(res) {
    const ra = res.headers.get('retry-after');
    if (ra) return (Number(ra) + 1) * 1000;
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      return Math.max(reset - Date.now(), 1000) + 1000;
    }
    return null; // a real 403, not a rate limit
  }

  request(url, o = {}) { return this.limit(() => this._request(url, o)); }

  async _request(url, { accept = 'application/vnd.github+json', truncate = 0 } = {}) {
    if (this.aborted) throw new RateLimitAbort('aborted earlier');
    const key = `${accept}|${url}`;
    const cached = this.cache[key];
    const headers = { Accept: accept, 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try { res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }); }
      catch (e) { if (attempt === 3) throw e; await sleep(1000 * 2 ** attempt * this.gateScale); continue; }
      this.stats.requests++;
      const rem = res.headers.get('x-ratelimit-remaining');
      if (rem !== null) this.remaining = Number(rem);

      if (res.status === 304 && cached) { cached.ts = Date.now(); this.stats.cached++; return { status: 200, body: cached.body, cached: true }; }
      if (res.status === 403 || res.status === 429) {
        const wait = this.waitFor(res);
        if (wait === null) return { status: res.status, body: null };
        if (wait > 120000) { this.aborted = true; throw new RateLimitAbort(`rate limited for ${Math.round(wait / 1000)}s`); }
        this.log(`Rate limited, waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait * this.gateScale);
        continue;
      }
      if (res.status >= 500) { await sleep(1000 * 2 ** attempt * this.gateScale); continue; }
      if (!res.ok) return { status: res.status, body: null };

      let body = await res.text();
      if (truncate && body.length > truncate) body = body.slice(0, truncate);
      const etag = res.headers.get('etag');
      if (etag) this.cache[key] = { etag, body, ts: Date.now() };
      return { status: 200, body };
    }
    return { status: 0, body: null };
  }

  async json(url, o) {
    const r = await this.request(url, o);
    if (r.status === 200 && r.body != null) { try { r.data = JSON.parse(r.body); } catch { r.data = null; } }
    return r;
  }

  async searchRepos(q, perPage = 50) {
    await this.gate('search', 2200);
    const r = await this.json(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perPage}`);
    return r.data?.items || [];
  }
  async searchCode(q) {
    await this.gate('code', 6500);
    const r = await this.json(`https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=100`);
    if (r.status !== 200) { this.log(`Code search unavailable (${r.status}); needs an authenticated token.`); return []; }
    return r.data?.items || [];
  }
  repo(full) { return this.json(`https://api.github.com/repos/${full}`); }
  readme(full) { return this.request(`https://api.github.com/repos/${full}/readme`, { accept: 'application/vnd.github.raw+json', truncate: 40000 }); }
  commits(full, since) { return this.json(`https://api.github.com/repos/${full}/commits?since=${encodeURIComponent(since)}&per_page=100`); }
  closedIssues(full, since) { return this.json(`https://api.github.com/repos/${full}/issues?state=closed&since=${encodeURIComponent(since)}&per_page=50`); }
  releases(full) { return this.json(`https://api.github.com/repos/${full}/releases?per_page=1`); }
  contents(full) { return this.json(`https://api.github.com/repos/${full}/contents/`); }

  save() {
    const entries = Object.entries(this.cache)
      .filter(([, v]) => Date.now() - v.ts < 14 * 864e5)
      .sort((a, b) => b[1].ts - a[1].ts);
    const out = {}; let bytes = 0;
    for (const [k, v] of entries) { bytes += v.body.length; if (bytes > 60e6 || Object.keys(out).length >= 4000) break; out[k] = v; }
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(out));
  }
}

module.exports = { GitHub, RateLimitAbort };
