/**
 * Atom feed builder. Pure string construction — no network, no filesystem.
 */

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Build an Atom feed document for a list of items.
 *
 * @param {{ title: string, items: Array<{ id: string, url: string, title: string }>, updated?: string }} feed
 * @returns {string} the Atom XML document
 */
export function buildFeed({ title, items, updated = new Date().toISOString() }) {
  const entries = items.map(
    (item) => `  <entry>
    <id>${escapeXml(item.id)}</id>
    <title>${escapeXml(item.title)}</title>
    <link href="${escapeXml(item.url)}"/>
    <updated>${escapeXml(updated)}</updated>
  </entry>`,
  );

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(title)}</title>
  <updated>${escapeXml(updated)}</updated>
${entries.join("\n")}
</feed>
`;
}
