// AI 建議的證據檢查工具：抓網頁（含快取與瀏覽器備援）、逐字比對原文、判斷網域可信等級。
// 原則：不信任 AI 的說法，只信「網頁上真的有這段字」。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { decode, sleep, text } from '../../scrapers/lib/http.ts';
import { ROOT, brandKey, latinKey } from '../../scrapers/lib/store.ts';

const CACHE = path.join(ROOT, 'raw/ai-verify/cache');
const CACHE_DAYS = 7;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 twmalllibrary-bot/0.1';

/** 比對用的正規化：全形轉半形、去重音、小寫、「臺」視同「台」、只留文字與數字（空白、標點、符號全部去掉） */
export const norm = (s: string) =>
  s
    .replace(/臺/g, '台')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** 只留數字（電話、坪數、車位數比對用） */
export const digits = (s: string) => s.normalize('NFKC').replace(/\D+/g, '');

export type Page = {
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number | string;
  via: 'fetch' | 'browser';
  /** 看得到的文字（已正規化） */
  visible: string;
  /** 原始碼解碼後（含 script 內的 JSON，已正規化），JS 網站的內容常只在這裡 */
  source: string;
  fetched: string;
};

// ---------- 抓網頁 ----------

/** 擋掉本機與內網位址，避免 AI 給的網址打到不該打的地方 */
export function unsafeUrl(u: string): string | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return '網址格式錯誤';
  }
  if (!/^https?:$/.test(url.protocol)) return '只接受 http／https 網址';
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || /\.(local|localhost|internal|test)$/.test(h)) return '本機網址';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('[')) return '不接受 IP 網址';
  return null;
}

function charsetOf(contentType: string | null, head: string) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '') ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  const cs = (m?.[1] ?? 'utf-8').toLowerCase();
  return cs === 'big-5' || cs === 'x-x-big5' ? 'big5' : cs;
}

function extract(html: string) {
  const meta = [...html.matchAll(/<meta[^>]+content=["']([^"']*)["']/gi)].map((m) => m[1]).join(' ');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const body = html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const visible = norm(`${decode(title)} ${decode(meta)} ${text(body)}`);
  // script 裡的 JSON 常把中文寫成 中 或 \/，先還原再比對
  const unescaped = html
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
  const source = norm(decode(unescaped.replace(/<[^>]+>/g, ' ')));
  return { visible, source };
}

async function viaFetch(url: string): Promise<Omit<Page, 'fetched'>> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 4096).toString('latin1');
    let html: string;
    try {
      html = new TextDecoder(charsetOf(res.headers.get('content-type'), head)).decode(buf);
    } catch {
      html = buf.toString('utf8');
    }
    return { url, finalUrl: res.url || url, ok: res.ok, status: res.status, via: 'fetch', ...extract(html) };
  } catch (e) {
    return { url, finalUrl: url, ok: false, status: String((e as Error).message ?? e), via: 'fetch', visible: '', source: '' };
  }
}

async function viaBrowser(url: string): Promise<Omit<Page, 'fetched'>> {
  // 用到時才載入 Playwright（雲端沒有安裝瀏覽器時，其他功能照常）
  const { openPage, visit } = await import('../../scrapers/lib/browser.ts');
  const page = await openPage();
  try {
    await visit(page, url);
    await sleep(1500); // 等 JS 把內容畫出來
    const inner = await page.evaluate(() => document.body?.innerText ?? '');
    const html = await page.content();
    const { source } = extract(html);
    return { url, finalUrl: page.url(), ok: true, status: 200, via: 'browser', visible: norm(`${await page.title()} ${inner}`), source };
  } catch (e) {
    return { url, finalUrl: url, ok: false, status: String((e as Error).message ?? e).slice(0, 120), via: 'browser', visible: '', source: '' };
  } finally {
    await page.context().close();
  }
}

const memo = new Map<string, Page>();
let lastFetch = 0;

/**
 * 取得網頁內容。先用一般 fetch；需要時（抓不到或找不到原文）再用真的瀏覽器開一次。
 * 結果快取在 raw/ai-verify/cache（7 天），重跑不會重抓。
 */
export async function getPage(url: string, opts: { browser: boolean; refresh: boolean; needle?: string }): Promise<Page> {
  const file = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  let page = memo.get(url);
  if (!page && !opts.refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Page;
    if (Date.now() - Date.parse(cached.fetched) < CACHE_DAYS * 86400_000) page = cached;
  }
  if (!page) {
    const wait = lastFetch + 800 - Date.now(); // 禮貌間隔
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    page = { ...(await viaFetch(url)), fetched: new Date().toISOString() };
  }
  const missing = !page.ok || (opts.needle != null && !page.source.includes(opts.needle));
  if (opts.browser && missing && page.via === 'fetch') {
    const b = await viaBrowser(url);
    // 瀏覽器版只在確實比較好時才採用
    if (b.ok && (opts.needle == null || b.source.includes(opts.needle) || b.visible.includes(opts.needle) || !page.ok))
      page = { ...b, fetched: new Date().toISOString() };
  }
  memo.set(url, page);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(page));
  return page;
}

/**
 * 原文是否出現在網頁上。原文中間若有「…」或「...」（AI 常這樣省略），分段後每段都要依序出現。
 * 回傳 visible（看得到的文字）、source（只在原始碼）或 null（找不到）。
 */
export function findQuote(page: Page, quote: string): 'visible' | 'source' | null {
  const parts = quote
    .split(/…+|\.{3,}|⋯+/)
    .map(norm)
    .filter((p) => p.length > 0);
  if (!parts.length) return null;
  const inOrder = (hay: string) => {
    let at = 0;
    for (const p of parts) {
      const i = hay.indexOf(p, at);
      if (i < 0) return false;
      at = i + p.length;
    }
    return true;
  };
  if (inOrder(page.visible)) return 'visible';
  if (inOrder(page.source)) return 'source';
  return null;
}

// ---------- 網域可信等級 ----------

export type Tier = 'official' | 'brand-domain' | 'gov' | 'news' | 'blocked' | 'unknown';
export const TRUSTED: Tier[] = ['official', 'brand-domain', 'gov', 'news'];
export const TIER_LABEL: Record<Tier, string> = {
  official: '官方網站',
  'brand-domain': '品牌官網（網域含品牌名）',
  gov: '政府／公開資料',
  news: '主要新聞媒體',
  blocked: '不採用的來源',
  unknown: '不在白名單',
};

type Sources = { official: string[]; gov: string[]; news: string[]; blocked: string[] };

export function loadSources(extraOfficial: string[]): Sources {
  const y = YAML.parse(fs.readFileSync(path.join(ROOT, 'data/ai/sources.yaml'), 'utf8')) ?? {};
  const list = (k: string) => ((y[k] ?? []) as string[]).map((d) => d.toLowerCase().replace(/^www\./, ''));
  return { official: [...list('official'), ...extraOfficial], gov: list('gov'), news: list('news'), blocked: list('blocked') };
}

export const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const under = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

// 網域裡沒有辨識力的部分
const GENERIC = new Set(['www', 'com', 'net', 'org', 'tw', 'co', 'jp', 'hk', 'cn', 'kr', 'io', 'shop', 'store', 'global', 'asia', 'official', 'online', 'm', 'en', 'zh', 'web', 'group', 'fashion', 'design', 'life', 'home', 'beauty', 'taiwan']);

/** 品牌名稱的英文比對鍵（小寫、只留英數），用來判斷網域是不是品牌自己的 */
export function brandLatinKeys(names: string[]) {
  const keys = new Set<string>();
  for (const n of names) {
    const k = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(n) ? latinKey(n) : brandKey(n);
    if (k && /[A-Z]{3,}/.test(k)) keys.add(k.toLowerCase().replace(/[^a-z0-9]/g, ''));
  }
  return [...keys];
}

export function tierOf(url: string, src: Sources, brandKeys: string[] = []): Tier {
  const host = hostOf(url);
  if (!host) return 'unknown';
  if (src.blocked.some((d) => under(host, d))) return 'blocked';
  if (src.official.some((d) => under(host, d))) return 'official';
  if (host.endsWith('.gov.tw') || src.gov.some((d) => under(host, d))) return 'gov';
  if (src.news.some((d) => under(host, d))) return 'news';
  const labels = host.split('.').filter((l) => !GENERIC.has(l)).map((l) => l.replace(/-/g, ''));
  for (const k of brandKeys)
    for (const l of labels)
      if (l === k || (k.length >= 4 && l.includes(k)) || (l.length >= 5 && k.includes(l))) return 'brand-domain';
  return 'unknown';
}
