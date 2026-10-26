// 給 Claude 當查證 AI 時用：讀網頁原文，印出含關鍵字或品牌名稱後面的文字（未正規化，可直接當逐字引述）。
// 用法：npx tsx scripts/ai-peek.ts <網址> [關鍵字1,關鍵字2] [品牌名稱]（docs/AI-CLAUDE-RUN.md）
import { decode, text } from '../scrapers/lib/http.ts';

const [url, kw = '', brand = ''] = process.argv.slice(2);
const keys = kw.split(',').filter(Boolean);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 twmalllibrary-bot/0.1';

async function viaFetch() {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-TW' }, signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 4096).toString('latin1');
  const cs = (/charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '') ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head))?.[1] ?? 'utf-8';
  let html: string;
  try { html = new TextDecoder(cs.toLowerCase() === 'big-5' ? 'big5' : cs).decode(buf); } catch { html = buf.toString('utf8'); }
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/gi)].map((m) => decode(m[1])).join(' ｜ ');
  const body = text(html.replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, ' '));
  return { status: res.status, title, meta, body };
}
async function viaBrowser() {
  const { openPage, visit, closeBrowser } = await import('../scrapers/lib/browser.ts');
  const page = await openPage();
  try {
    await visit(page, url);
    await new Promise((r) => setTimeout(r, 1500));
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    return { status: 'browser', title: await page.title(), meta: '', body };
  } finally { await closeBrowser(); }
}

let r: { status: unknown; title: string; meta: string; body: string };
try { r = await viaFetch(); } catch (e) { r = { status: String(e), title: '', meta: '', body: '' }; }
const blocked = r.body.length < 400 || /access denied|page unavailable|just a moment/i.test(r.body.slice(0, 500));
if (blocked) { try { r = await viaBrowser(); } catch (e) { console.log('瀏覽器也失敗', String(e).slice(0, 80)); } }
const flat = r.body.replace(/\s+/g, ' ');
console.log(`[${r.status}] ${r.title}`);
if (r.meta) console.log(`meta: ${r.meta.slice(0, 200)}`);
let shown = 0;
for (const k of keys) {
  let at = 0;
  for (let n = 0; n < 2; n++) {
    const i = flat.toLowerCase().indexOf(k.toLowerCase(), at);
    if (i < 0) break;
    console.log(`…${flat.slice(Math.max(0, i - 50), i + 90)}…`);
    at = i + k.length; shown++;
  }
}
// 有給品牌名稱時：印出品牌名稱後面的文字（跳過導覽選單），最多 3 處
if (brand) {
  const low = flat.toLowerCase(), b = brand.toLowerCase();
  const hits: number[] = [];
  for (let i = low.indexOf(b); i >= 0; i = low.indexOf(b, i + b.length)) hits.push(i);
  for (const i of hits.filter((i) => i > 300).slice(-3)) console.log(`＞${flat.slice(i, i + 220)}`);
}
if (!shown && !brand) console.log(flat.slice(0, 400));
