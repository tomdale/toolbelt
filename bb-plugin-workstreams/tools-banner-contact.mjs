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
  .map((r) => ({ name: r.name, svg: Buffer.from(r.data).toString("utf8") }));
const scaled = banners.map((b, i) => ({ ...b, y: 28 + i * 42 }));
const height = scaled.length * 42 + 52;
let body = `<rect width="760" height="${height}" fill="#050609"/>`;
for (const b of scaled) {
  const content = b.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const sep = `<rect x="19" y="0" width=".6" height="18" fill="#fff4"/>`;
  body += `<text x="8" y="${b.y + 9}" fill="#9ba3b2" font-family="Chicago, Monaco, monospace" font-size="8">${escape(b.name)}</text>`;
  body += `<svg x="8" y="${b.y + 12}" width="232" height="18" viewBox="0 0 232 18">${content}${sep}</svg>`;
  body += `<svg x="260" y="${b.y + 7}" width="464" height="36" viewBox="0 0 232 18">${content}</svg>`;
}
await writeFile(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}">${body}</svg>`,
);
