'use strict';
const { xmlEsc: x } = require('./util');

function buildAtom({ title, baseUrl, entries, updated }) {
  const items = entries.map((e, i) => `  <entry>
    <id>tag:vrc-avatar-db-finder,${x(e.at)}:${i}</id>
    <title>${x(e.text)}</title>
    <link href="${x(e.repo ? `https://github.com/${e.repo}` : baseUrl || 'https://github.com')}"/>
    <updated>${x(e.at)}</updated>
    <summary>${x(e.type)}: ${x(e.text)}</summary>
  </entry>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${x(title)}</title>
  <id>${x(baseUrl || 'urn:vrc-avatar-db-finder')}</id>
  <updated>${x(updated)}</updated>
${baseUrl ? `  <link rel="self" href="${x(baseUrl + 'feed.xml')}"/>\n  <link href="${x(baseUrl)}"/>\n` : ''}${items}
</feed>
`;
}
module.exports = { buildAtom };
