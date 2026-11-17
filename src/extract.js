'use strict';
const AVATAR_ID = /avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SKIP_HOSTS = ['github.com', 'githubusercontent.com', 'shields.io', 'npmjs.com', 'nuget.org', 'pypi.org', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 'ko-fi.com', 'patreon.com', 'buymeacoffee.com', 'vrchat.com', 'vrchat.cloud', 'unity3d.com', 'unity.com',
  'creativecommons.org', 'opensource.org', 'gnu.org', 'microsoft.com', 'apple.com', 'google.com', 'imgur.com', 'wikipedia.org',
  'mozilla.org', 'nodejs.org', 'python.org', 'docker.com', 'discord.com', 'discordapp.com', 'discord.gg'];

const countAvatarIds = (t) => new Set((t.match(AVATAR_ID) || []).map((s) => s.toLowerCase())).size;
const skipHost = (h) => SKIP_HOSTS.some((s) => h === s || h.endsWith('.' + s));

// Pull external sources out of README text: Discord invites, API endpoints, websites.
function extractSources(text) {
  const urls = [...new Set((text.match(/https?:\/\/[^\s)<>\]"'`]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const caps = { discord: 2, api: 3, website: 3 };
  const count = { discord: 0, api: 0, website: 0 };
  const out = []; const seen = new Set();
  for (const u of urls) {
    let url; try { url = new URL(u); } catch { continue; }
    const host = url.hostname.toLowerCase();
    let src = null;
    const inv = host === 'discord.gg' ? url.pathname.split('/').filter(Boolean)[0]
      : /(^|\.)discord(app)?\.com$/.test(host) && /^\/invite\/([\w-]+)/.test(url.pathname) ? url.pathname.match(/^\/invite\/([\w-]+)/)[1] : null;
    if (inv) src = { kind: 'discord', url: `https://discord.gg/${inv}`, code: inv };
    else if (skipHost(host)) continue;
    else if (/^api[.-]/.test(host) || /\/(api|v\d+)(\/|$)/.test(url.pathname) || /\.json$/.test(url.pathname)) src = { kind: 'api', url: url.href };
    else src = { kind: 'website', url: url.origin + (url.pathname === '/' ? '' : url.pathname) };
    const k = src.kind === 'discord' ? `d:${src.code.toLowerCase()}` : src.url;
    if (seen.has(k) || count[src.kind] >= caps[src.kind]) continue;
    seen.add(k); count[src.kind]++; out.push(src);
  }
  return out;
}

module.exports = { countAvatarIds, extractSources };
