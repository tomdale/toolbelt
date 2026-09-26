// Private Hotline contact sheet from the installed plugin SQLite DB.
// Saves only to the caller-provided path; never commit generated artwork.
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const out = process.argv[2];
const scale = process.argv[3] === "2x" ? 2 : 1;
if (!out)
  throw new Error("Usage: node tools-banner-contact.mjs OUT.svg [1x|2x]");
const { default: Database } = await import("better-sqlite3");
const db = new Database(join(homedir(), ".bb/plugins/workstreams/data.db"), {
  readonly: true,
});
const rows = db.prepare("SELECT name, data FROM banners ORDER BY name").all();
db.close();
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const banners = rows
  .filter((r) => Buffer.from(r.data).toString("utf8").startsWith("<svg"))
  .map((r, i) => ({
    name: r.name,
    svg: Buffer.from(r.data).toString("utf8"),
    y: 26 + i * 31,
  }));
let body = `<rect width="760" height="${banners.length * 31 + 40}" fill="#08090c"/>`;
for (const b of banners) {
  const content = b.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  body += `<text x="8" y="${b.y + 8}" fill="#8c919b" font-family="monospace" font-size="8">${escape(b.name)}</text>`;
  body += `<svg x="8" y="${b.y + 12}" width="232" height="18" viewBox="0 0 232 18" shape-rendering="crispEdges">${content}</svg>`;
  body += `<svg x="260" y="${b.y + 12}" width="464" height="36" viewBox="0 0 232 18" shape-rendering="crispEdges">${content}</svg>`;
}
await writeFile(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${banners.length * 31 + 40}">${body}</svg>`,
);
