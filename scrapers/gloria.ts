// 華泰名品城 GLORIA OUTLETS：/chi/brand_list/ 捲動時才陸續載入（共約 250 筆），用 Playwright 捲到底。
// 品牌名稱在 logo 圖片的 title；位置在連結的 location 參數，例如「i-三期・第六大道・616」「i-一期・2F・1122」「i-107b」。
import { closeBrowser, openPage, visit } from './lib/browser.ts';
import { decode, getText, run, sleep, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.gloriaoutlets.com';
const PHASE_ID: Record<string, string> = { 一期: 'phase1', 二期: 'phase2', 三期: 'phase3' };

run(async () => {
  const idx = loadBrandIndex();
  const page = await openPage();
  let html = '';
  let total = 0;
  try {
    await visit(page, `${BASE}/chi/brand_list/`, '#blocklist');
    total = Number((await page.textContent('.search_results'))?.match(/(\d+)/)?.[1] ?? 0);
    for (let last = -1, stable = 0; stable < 10; ) {
      await page.mouse.wheel(0, 4000);
      await sleep(900);
      const n = await page.locator('#blocklist a[href*="brand_content"]').count();
      stable = n === last ? stable + 1 : 0;
      last = n;
      if (total && n >= total) break;
    }
    html = await page.content();
  } finally {
    await closeBrowser();
  }

  const items = [...html.matchAll(/href="\/chi\/brand_content\/\d+\/\?location=i-([^"]*)">\s*<img[^>]*title="([^"]*)"/g)].map((m) => ({
    location: decode(m[1]).trim(),
    name: decode(m[2]).trim(),
  }));
  if (total && items.length < total * 0.9) console.warn(`⚠ 官網共 ${total} 筆，只取得 ${items.length} 筆`);

  const map = new Map<string, Map<string, { name: string; unit_no: string | null }[]>>();
  for (const it of items) {
    if (!it.name) continue;
    const parts = it.location.split('・').map((p) => p.trim());
    const phase = parts.find((p) => PHASE_ID[p]) ?? '其他';
    const floor = parts.find((p) => /^\d+F$/i.test(p))?.toUpperCase() ?? '1F';
    const unit = parts[parts.length - 1] || null;
    const b = map.get(phase) ?? new Map();
    b.set(floor, [...(b.get(floor) ?? []), { name: it.name, unit_no: unit }]);
    map.set(phase, b);
  }
  const order = ['一期', '二期', '三期', '其他'];
  const buildings: ScrapedMall['buildings'] = [...map.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([phase, floors]) => ({
      id: PHASE_ID[phase] ?? 'other',
      name: phase === '其他' ? '其他（官網未標示期別）' : phase,
      floors: [...floors.entries()].sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([f, shops]) => ({ id: f, label: f, shops })),
    }));

  const footer = text(await getText(`${BASE}/chi/`));
  const address = footer.match(/(\S{2}[市縣]\S{1,3}區\S+?號)/)?.[1] ?? '';
  const phone = footer.match(/客服專線[：:]\s*(\(?0\d\)?\s*[\d-]+)/)?.[1]?.replace(/\s+/g, '') ?? null;
  saveRaw('gloria', 'gloria-outlets', { address, phone, total, items });

  const { city, district } = parseAddress(address);
  const added = mergeMall(
    {
      base: {
        id: 'gloria-outlets',
        name: '華泰名品城 GLORIA OUTLETS',
        group: 'gloria',
        type: 'outlet',
        status: 'open',
        city,
        district,
        address,
        geo: null,
        phone,
        website: `${BASE}/chi/`,
        opened: null,
        floor_area_ping: null,
        parking: { car: null, motorcycle: null, fee_note: null },
        hours: null,
        transit: null,
        operator: '華泰商場開發股份有限公司',
      },
      sourceUrl: `${BASE}/chi/brand_list/`,
      buildings,
    },
    idx,
  );
  console.log(`華泰名品城: ${items.length} 個品牌，新增 ${added} 個櫃位`);
});
