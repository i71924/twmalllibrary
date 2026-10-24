// 遠企購物中心 TheMall：/store/floor.aspx?store=1&floor={樓層} 以 brand= 連結列出品牌；
// 營業時間與地址在 /store/info.aspx?store=1。B4、B5 是停車場，沒有櫃位會自動略過。
import { getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.themall.com.tw';
const ORDER = (f: string) => (/^B(\d+)/.test(f) ? -parseInt(f.slice(1)) : parseInt(f));

run(async () => {
  const idx = loadBrandIndex();
  const first = await getText(`${BASE}/store/floor.aspx?store=1&floor=1F`);
  const floorIds = [...new Set([...first.matchAll(/floor=([A-Z0-9]+)/g)].map((m) => m[1]))].sort((a, b) => ORDER(a) - ORDER(b));
  const floors: ScrapedMall['buildings'][number]['floors'] = [];
  for (const f of floorIds) {
    const html = f === '1F' ? first : await getText(`${BASE}/store/floor.aspx?store=1&floor=${f}`);
    const names = [...new Set([...html.matchAll(/brand=\d+[^>]*>([^<]{1,60})</g)].map((m) => text(m[1])).filter(Boolean))];
    if (names.length) floors.push({ id: f, label: f, shops: names.map((name) => ({ name })) });
  }

  const info = text((await getText(`${BASE}/store/info.aspx?store=1`)).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<\/(p|div|li|td)>/g, '\n'));
  const address = info.match(/地址[：:]\s*(\S+?號)/)?.[1] ?? '';
  const hours = [...info.matchAll(/(星期[一二三四五六日]至星期[一二三四五六日]\s*\d{1,2}:\d{2}~\d{1,2}:\d{2})/g)].map((m) => m[1]).join('\n') || null;
  saveRaw('far-eastern', 'far-eastern-plaza-mall', { address, hours, floors: floors.map((f) => [f.id, f.shops.length]) });

  const { city, district } = parseAddress(address);
  const n = floors.reduce((k, f) => k + f.shops.length, 0);
  const added = mergeMall(
    {
      base: {
        id: 'far-eastern-plaza-mall',
        name: '遠企購物中心 TheMall',
        group: 'far-eastern',
        type: 'shopping_mall',
        status: 'open',
        city,
        district,
        address,
        geo: null,
        phone: null,
        website: `${BASE}/`,
        opened: null,
        floor_area_ping: null,
        parking: { car: null, motorcycle: null, fee_note: null },
        hours,
        transit: null,
        operator: '遠東集團',
      },
      sourceUrl: `${BASE}/store/floor.aspx?store=1`,
      buildings: [{ id: 'main', name: '遠企購物中心', floors }],
    },
    idx,
  );
  console.log(`遠企購物中心: ${n} 個櫃位，新增 ${added}`);
});
