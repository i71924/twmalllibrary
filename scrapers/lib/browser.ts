// 需要真實瀏覽器才進得去的官網（遠百、三井、華泰）用 Playwright Chromium。
import { chromium, type Browser, type Page } from 'playwright';
import { sleep } from './http.ts';

let browser: Browser | null = null;

export async function openPage(): Promise<Page> {
  browser ??= await chromium.launch({ headless: process.env.HEADED !== '1' });
  const ctx = await browser.newContext({
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 twmalllibrary-bot/0.1',
  });
  // tsx（esbuild keepNames）會在傳進瀏覽器的函式裡呼叫 __name，先在頁面上補一個
  await ctx.addInitScript('window.__name = (f) => f');
  return ctx.newPage();
}

/** 前往網址並等待內容出現；遇到 Cloudflare 驗證頁會多等幾秒 */
export async function visit(page: Page, url: string, waitFor?: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 10 && /Just a moment|Attention Required/i.test(await page.title()); i++) await sleep(1500);
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 40_000 });
  await sleep(1200); // 禮貌間隔
}

export async function closeBrowser() {
  await browser?.close();
  browser = null;
}
