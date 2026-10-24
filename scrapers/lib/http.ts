// 擷取程式共用的 HTTP 工具：固定 User-Agent、禮貌間隔、失敗重試、簡易 HTML 轉文字。
import { decodeHTML } from 'entities';
const UA = 'Mozilla/5.0 (compatible; twmalllibrary-bot/0.1; +https://twmalllibrary.i71924.workers.dev/about/)';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let last = 0;
export async function get(url: string, init: RequestInit = {}, gapMs = 800): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } });
      if (res.ok) return res;
      if (res.status < 500 || attempt >= 3) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    await sleep(2000 * attempt);
  }
}

export const getText = async (url: string, init?: RequestInit) => (await get(url, init)).text();
export const getJson = async <T = any>(url: string, init?: RequestInit) => (await get(url, init)).json() as Promise<T>;

/** 解碼所有 HTML 實體（含 &eacute; 這類重音字母）；有些官網會重複編碼，所以解兩次 */
export const decode = (s: string) => decodeHTML(decodeHTML(s));

/** 去標籤、解碼、壓縮空白 */
export const text = (html: string) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').trim();

/** 執行一個擷取程式的進入點，統一錯誤處理 */
export function run(main: () => Promise<void>) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
