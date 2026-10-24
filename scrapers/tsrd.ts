// 南紡購物中心：POST /api/BrandManagement/Paging 一次回傳全部品牌（館別、樓層＋主題、業種）。
// 地址、電話、營業時間在官網頁尾。
import { getJson, getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.tsrd.com.tw';
type Row = { BrandName: string; BuildingName: string; BrandType: string; Floor: string; Status: boolean };

const FLOOR_ORDER = (f: string) => (/^B(\d+)/.test(f) ? -Number(f.slice(1, -1) || f.slice(1)) : parseInt(f) || 100);

run(async () => {
  const idx = loadBrandIndex();
  const { rows } = await getJson<{ total: number; rows: Row[] }>(`${BASE}/api/BrandManagement/Paging`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Offset: 0, Limit: 5000, BuildingName: '', BrandType: [] }),
  });
  const active = rows.filter((r) => r.Status && r.BrandName.trim());

  const byBuilding = new Map<string, Map<string, { theme: string | null; shops: { name: string; source_category: string | null }[] }>>();
  for (const r of active) {
    const [floorRaw, ...themeParts] = r.Floor.trim().split(/\s+/);
    const floor = (floorRaw || '未標示').toUpperCase().replace(/^(B\d+)F$/, '$1');
    const b = byBuilding.get(r.BuildingName) ?? new Map();
    const f = b.get(floor) ?? { theme: themeParts.join(' ') || null, shops: [] };
    f.shops.push({ name: r.BrandName.trim(), source_category: r.BrandType || null });
    b.set(floor, f);
    byBuilding.set(r.BuildingName, b);
  }
  const buildings: ScrapedMall['buildings'] = [...byBuilding.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, floors]) => ({
      id: name.replace(/館$/, '').toLowerCase(),
      name,
      floors: [...floors.entries()]
        .sort(([a], [b]) => FLOOR_ORDER(a) - FLOOR_ORDER(b))
        .map(([id, f]) => ({ id, label: id, theme: f.theme, shops: f.shops })),
    }));

  const footer = text(await getText(`${BASE}/`));
  const address = footer.match(/地址[：:]\s*\d{0,6}\s*(\S{2}[市縣]\S+?號)/)?.[1] ?? '';
  const phone = footer.match(/電話[：:]\s*([\d-]+)/)?.[1] ?? null;
  const hours = footer.match(/營業時間[：:]\s*([^()（]+)/)?.[1]?.trim() ?? null;

  saveRaw('tsrd', 'tainan-nanfang', { address, phone, hours, count: active.length });
  const { city, district } = parseAddress(address);
  const added = mergeMall(
    {
      base: {
        id: 'tainan-nanfang',
        name: '南紡購物中心',
        group: 'tsrd',
        type: 'shopping_mall',
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
        hours,
        transit: null,
        operator: '南紡流通事業股份有限公司',
      },
      sourceUrl: `${BASE}/nanfang-floor/brand-search`,
      buildings,
    },
    idx,
  );
  console.log(`南紡購物中心: ${active.length} 個櫃位，新增 ${added}`);
});
