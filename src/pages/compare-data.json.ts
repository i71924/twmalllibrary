// 商場比較頁用的資料（建置時產生靜態 JSON，瀏覽器端讀取後比對）。
// 為了檔案小：品牌只存一次（名稱、大類），各商場只存品牌的索引。
import type { APIRoute } from 'astro';
import { CATEGORY_COLOR, categoryMix, db, floorCount, MALL_TYPE } from '../lib/data';

export const GET: APIRoute = () => {
  const { malls, brands, brandById, categories } = db();
  const open = malls.filter((m) => m.status === 'open' && m.buildings.some((b) => b.floors.some((f) => f.units.some((u) => !u.closed_on))));
  const used = new Set<string>();
  const mallBrands = new Map<string, string[]>();
  for (const m of open) {
    const ids = new Set<string>();
    for (const b of m.buildings) for (const f of b.floors) for (const u of f.units) if (!u.closed_on) for (const id of u.brands) ids.add(id);
    mallBrands.set(m.id, [...ids]);
    ids.forEach((id) => used.add(id));
  }
  const brandList = brands.filter((b) => used.has(b.id)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { sensitivity: 'base' }));
  const index = new Map(brandList.map((b, i) => [b.id, i]));

  return new Response(
    JSON.stringify({
      categories: categories.map((c) => ({ code: c.code, name: c.name, icon: c.icon, color: CATEGORY_COLOR[c.code] ?? '#999' })),
      // [id, 名稱, 大類]
      brands: brandList.map((b) => [b.id, b.name, brandById.get(b.id)?.category?.split('.')[0] ?? '']),
      malls: open.map((m) => {
        const mix = categoryMix(m);
        return {
          id: m.id,
          name: m.name,
          city: m.city,
          district: m.district,
          type: MALL_TYPE[m.type],
          units: mix.total,
          floors: floorCount(m),
          mix: Object.fromEntries([...mix.rows.map((r) => [r.code, r.n]), ['', mix.other]]),
          brands: mallBrands.get(m.id)!.map((id) => index.get(id)!).sort((a, b) => a - b),
        };
      }),
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
};
