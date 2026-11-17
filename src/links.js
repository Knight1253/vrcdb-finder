'use strict';
// Link health checks. Guards against SSRF: only public http(s) hosts, redirects followed manually and re-validated.
const dns = require('dns').promises;
const net = require('net');
const UA = 'vrc-avatar-db-finder';

let resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);
const setResolver = (fn) => { resolver = fn; };

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function classify(u) {
  let url; try { url = new URL(u); } catch { return 'blocked'; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return 'blocked';
  if (url.port && !['80', '443'].includes(url.port)) return 'blocked';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /\.(local|internal|localdomain|lan)$/.test(host) || host.startsWith('[')) return 'blocked';
  if (net.isIP(host)) return isPrivateIp(host) ? 'blocked' : 'ok';
  try {
    const ips = await resolver(host);
    if (!ips.length) return 'dns_fail';
    return ips.every((ip) => !isPrivateIp(ip)) ? 'ok' : 'blocked';
  } catch { return 'dns_fail'; }
}

async function safeFetch(url, method, hops = 0) {
  const c = await classify(url);
  if (c === 'blocked') return { status: 0, blocked: true };
  if (c === 'dns_fail') return { status: 0, dnsFail: true };
  let res;
  try { res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA } }); }
  catch { return { status: 0, netFail: true }; }
  if ([301, 302, 303, 307, 308].includes(res.status) && hops < 3) {
    const loc = res.headers.get('location');
    if (loc) return safeFetch(new URL(loc, url).href, method, hops + 1);
  }
  return { status: res.status, res };
}

// returns { status: 'up' | 'down' | 'unknown', label? }
async function check(src) {
  if (src.kind === 'discord') {
    try {
      const res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(src.code)}`, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA } });
      if (res.status === 200) { let label = null; try { label = (await res.json())?.guild?.name || null; } catch {} return { status: 'up', label }; }
      if (res.status === 404) return { status: 'down' };
      return { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  }
  let r = await safeFetch(src.url, 'HEAD');
  if ([400, 403, 405, 501].includes(r.status)) r = await safeFetch(src.url, 'GET');
  if (r.blocked) return { status: 'unknown' };
  if (r.dnsFail || r.netFail) return { status: 'down' };
  if (r.status === 429) return { status: 'unknown' };
  if (r.status >= 200 && r.status < 400) return { status: 'up' };
  if ([401, 403, 405].includes(r.status)) return { status: 'up' };
  return { status: 'down' };
}

module.exports = { check, setResolver, isPrivateIp, classify };
