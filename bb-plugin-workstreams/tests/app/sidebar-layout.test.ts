import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";

const executablePath = [
  process.env.CHROME_PATH,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path): path is string => !!path && existsSync(path));

const styles = readFileSync(
  new URL("../../src/app/styles.css", import.meta.url),
  "utf8",
);

const longText = "A long sidebar label that should truncate ".repeat(8);

describe.skipIf(!executablePath)(
  "sidebar browser layout",
  { timeout: 30_000 },
  () => {
    it("reveals hover timestamps on pointer hover and keyboard focus without reserving space", async () => {
      const browser = await chromium.launch({ executablePath, headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<style>${styles}</style>
        <div class="ws-row"><a href="#">Task</a><span data-timestamp="hover">10m</span></div>`);
        const age = page.locator("[data-timestamp]");
        await page.mouse.move(0, 500);
        expect(await age.isVisible()).toBe(false);
        await page.locator("a").hover();
        expect(await age.isVisible()).toBe(true);
        await page.mouse.move(0, 500);
        expect(await age.isVisible()).toBe(false);
        await page.keyboard.press("Tab");
        expect(await age.isVisible()).toBe(true);
        await page.locator("a").evaluate((el) => (el as HTMLElement).blur());
        await age.evaluate((el) => el.setAttribute("data-timestamp", "show"));
        expect(await age.isVisible()).toBe(true);
      } finally {
        await browser.close();
      }
    });

    it("keeps nested animated rows within the sidebar and ellipsizes both lines", async () => {
      const browser = await chromium.launch({ executablePath, headless: true });
      try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        await page.setContent(`
        <style>
          ${styles}
          * { box-sizing: border-box; }
          .sidebar { width: 260px; display: flex; flex-direction: column; }
          .ws-list { display: flex; flex-direction: column; }
          ul { margin: 0; padding: 0; list-style: none; }
          .ws-row { display: flex; gap: 6px; padding: 4px 8px; }
          .labels { display: flex; flex: 1; min-width: 0; flex-direction: column; }
          .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .age { flex-shrink: 0; }
        </style>
        <div class="sidebar"><div class="ws-list">
          <div class="ws-presence"><section class="ws-needs">
            <ul><li class="ws-presence"><div>
              <div class="ws-row">
                <span class="labels">
                  <span class="truncate">${longText}</span>
                  <span class="truncate">${longText}</span>
                </span>
                <span class="age">10m</span>
              </div>
            </div></li></ul>
          </section></div>
        </div></div>
      `);
        for (const width of [180, 260, 400]) {
          await page.locator(".sidebar").evaluate((el, width) => {
            (el as HTMLElement).style.width = `${width}px`;
          }, width);
          for (const phase of [null, "enter", "leave"]) {
            await page.locator(".ws-presence").evaluateAll((els, phase) => {
              for (const el of els) {
                if (phase) el.setAttribute("data-presence", phase);
                else el.removeAttribute("data-presence");
              }
            }, phase);
            const layout = await page.evaluate(() => {
              const sidebar = document.querySelector(".sidebar")!;
              const row = document.querySelector(".ws-row")!;
              return {
                sidebarWidth: sidebar.clientWidth,
                scrollWidth: sidebar.scrollWidth,
                rowWidth: row.getBoundingClientRect().width,
                lines: [...document.querySelectorAll(".truncate")].map(
                  (el) => ({
                    clipped: el.scrollWidth > el.clientWidth,
                    overflow: getComputedStyle(el).textOverflow,
                  }),
                ),
              };
            });
            expect(layout.scrollWidth).toBe(layout.sidebarWidth);
            expect(layout.rowWidth).toBeLessThanOrEqual(width);
            expect(layout.lines).toEqual([
              { clipped: true, overflow: "ellipsis" },
              { clipped: true, overflow: "ellipsis" },
            ]);
          }
        }
      } finally {
        await browser.close();
      }
    });
  },
);
