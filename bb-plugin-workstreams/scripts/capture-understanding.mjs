import { chromium } from "playwright-core";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: node scripts/capture-understanding.mjs CAPTURE_DIRECTORY",
  );
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const checks = [];
try {
  for (const name of (await readdir(directory)).filter((n) =>
    n.endsWith(".html"),
  )) {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(await readFile(join(directory, name), "utf8"));
      checks.push({
        name,
        width,
        ...(await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          title: document.querySelector("h1")?.textContent,
          evidenceQuotes: document.querySelectorAll("blockquote").length,
        }))),
      });
      await page.screenshot({
        path: join(directory, name.replace(".html", `-${width}.png`)),
        fullPage: true,
      });
      await page.close();
    }
  }
  await writeFile(
    join(directory, "checks.json"),
    JSON.stringify(checks, null, 2),
  );
  if (checks.some((c) => c.overflow))
    throw new Error("Understanding viewport overflows; inspect checks.json");
} finally {
  await browser.close();
}
console.log(`${checks.length} captures; no horizontal document overflow.`);
