import { chromium } from "playwright-core";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: node scripts/capture-new-work.mjs CAPTURE_DIRECTORY");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const results = [];
try {
  for (const name of (await readdir(directory)).filter((n) =>
    n.endsWith(".html"),
  )) {
    for (const width of [900, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      await page.setContent(await readFile(join(directory, name), "utf8"));
      const checks = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        labels: [...document.querySelectorAll(".ws-intake-type")].every(
          (e) => e.scrollWidth <= e.clientWidth,
        ),
        action: [
          ...document.querySelectorAll(".ws-intake-action .ws-intake-value"),
        ].every((e) => e.scrollWidth <= e.clientWidth),
      }));
      results.push({ name, width, ...checks });
      await page.locator(".capture-dialog").screenshot({
        path: join(directory, name.replace(".html", `-${width}.png`)),
      });
      await page.close();
    }
  }
  await writeFile(
    join(directory, "checks.json"),
    JSON.stringify(results, null, 2),
  );
  if (results.some((r) => r.overflow || !r.labels || !r.action))
    throw new Error("Screenshot layout checks failed; see checks.json");
} finally {
  await browser.close();
}
console.log(
  `${results.length} actual component screenshots captured; all overflow, type-label and action checks passed.`,
);
