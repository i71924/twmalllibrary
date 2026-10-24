// SKM Park Outlets 高雄草衙（新光三越旗下，獨立官網 skmpark.com）。
// /BrandView/BrandIndex 一頁列出全部品牌：名稱在 brand_data--main，位置在 brand_data--site（如「大道東-1F/大道東-2F」）。
import { getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.skmpark.com';
const AREA_ID: Record<string, string> = { 大道東: 'east', 大道西: 'west' };

run(async () => {
  const idx = loadBrandIndex();
  const html = await getText(`${BASE}/BrandView/BrandIndex?LangCode=zhtw`);
  const items = [...html.matchAll(/brand_data--main">([\s\S]*?)<\/div>[\s\S]*?brand_data--site">([\s\S]*?)<\/div>/g)].map((m) => ({
    name: text(m[1]),
    sites: text(m[2]).split('/').map((s) => s.trim()).filter(Boolean),
  }));

  const map = new Map<string, Map<string, { name: string }[]>>();
  for (const it of items) {
    for (const site of it.sites.length ? it.sites : ['其他-未標示']) {
      const [area, floor = '未標示'] = site.split('-');
      const b = map.get(area) ?? new Map();
      b.set(floor, [...(b.get(floor) ?? []), { name: it.name }]);
      map.set(area, b);
    }
  }
  const buildings: ScrapedMall['buildings'] = [...map.entries()].map(([area, floors]) => ({
    id: AREA_ID[area] ?? area,
    name: area,
    floors: [...floors.entries()].sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([f, shops]) => ({ id: f, label: f, shops })),
  }));

  const traffic = text((await getText(`${BASE}/CusService/CusTraficIndex?LangCode=zhtw`)).replace(/<script[\s\S]*?<\/script>/g, ''));
  const address = traffic.match(/(\S{2}[市縣]\S{1,3}區[^號]{2,30}號)/)?.[1]?.replace(/\s+/g, '') ?? '';
  const phone = traffic.match(/\b(0\d-\d{7,8})\b/)?.[1] ?? null;
  saveRaw('skm', 'skm-park-outlets', { address, phone, count: items.length });

  const { city, district } = parseAddress(address);
  const added = mergeMall(
    {
      base: {
        id: 'skm-park-outlets',
        name: 'SKM Park Outlets 高雄草衙',
        group: 'skm',
        type: 'outlet',
        status: 'open',
        city,
        district,
        address,
        geo: null,
        phone,
        website: `${BASE}/`,
        opened: null,
        floor_area_ping: null,
        parking: { car: null, motorcycle: null, fee_note: null },
        hours: null,
        transit: null,
        operator: '新光三越百貨股份有限公司',
      },
      sourceUrl: `${BASE}/BrandView/BrandIndex?LangCode=zhtw`,
      buildings,
    },
    idx,
  );
  console.log(`SKM Park Outlets: ${items.length} 個品牌，新增 ${added} 個櫃位`);
});
