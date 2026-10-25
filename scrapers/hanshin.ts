// 漢神：/{館}/tw/Floor/{樓層} 列出該樓品牌（<h6>）。地址在 /Guide，電話與營業時間在 /About。
// 注意：漢神洲際購物廣場在台中北屯，不在高雄。
import { getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.hanshin.com.tw';
const MALLS: { slug: string; id: string; name: string; type: ScrapedMall['base']['type'] }[] = [
  { slug: '漢神巨蛋', id: 'hanshin-arena', name: '漢神巨蛋購物廣場', type: 'shopping_mall' },
  { slug: '漢神百貨', id: 'hanshin-department-store', name: '漢神百貨', type: 'department_store' },
  { slug: '漢神洲際', id: 'hanshin-intercontinental', name: '漢神洲際購物廣場', type: 'shopping_mall' },
];

const url = (slug: string, path = '') => `${BASE}/${encodeURIComponent(slug)}/tw${path}`;
const lines = (html: string) =>
  text(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<\/(p|div|li|td|h\d|span)>/g, '\n'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** 「1F_Cosmetics_&_Luxury」→ 樓層 1F、主題 Cosmetics & Luxury；「Food_Court_&_Supermarket」→ 整段當樓層名 */
function parseFloorSlug(slug: string) {
  const s = slug.replace(/_/g, ' ');
  const m = s.match(/^(B?\d+F)\s*(.*)$/i);
  return m ? { id: m[1].toUpperCase().replace(/^(B\d+)F$/, '$1'), theme: m[2] || null } : { id: s, theme: null };
}

run(async () => {
  const only = process.argv[2];
  const idx = loadBrandIndex();
  for (const m of MALLS) {
    if (only && m.id !== only) continue;
    const home = await getText(url(m.slug));
    // 連結裡的樓層名有 HTML 實體（&amp;）與網址編碼（%27），先還原成原文，組網址時再統一編碼
    const slugs = [...new Set([...home.matchAll(/\/tw\/Floor\/([^/"]+)"/g)].map((x) => decodeURIComponent(text(x[1]))))];
    const floors: ScrapedMall['buildings'][number]['floors'] = [];
    for (const slug of slugs) {
      const html = await getText(url(m.slug, `/Floor/${encodeURIComponent(slug)}`));
      // 只取品牌卡（<div class="_text">）裡的 <h6>；列表檢視的樓層標題（2F）與頁尾（ADDRESS 等）也用 <h6>
      const names = [...html.matchAll(/<div class="_text"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<h6>([^<]+)<\/h6>/g)]
        .map((x) => text(x[1]).replace(new RegExp(`^${m.slug}\\s*`), ''))
        .filter(Boolean);
      const { id, theme } = parseFloorSlug(slug);
      if (names.length) floors.push({ id, label: id, theme, shops: names.map((name) => ({ name })) });
    }
    const guide = lines(await getText(url(m.slug, '/Guide')));
    const about = lines(await getText(url(m.slug, '/About')));
    const address = [...guide, ...about].find((l) => /^\S{2}[市縣]\S{1,3}[區鄉鎮市].{2,30}號$/.test(l)) ?? '';
    const phone = about.find((l) => /服務電話/.test(l))?.match(/\(0\d\)\s*[\d-]+/)?.[0]?.replace(/\s+/g, '') ?? null;
    const hours = about.find((l) => /^\d{2}:\d{2}~\d{2}:\d{2}$/.test(l)) ?? null;
    saveRaw('hanshin', m.id, { address, phone, hours, floors });
    const { city, district } = parseAddress(address);
    const n = floors.reduce((k, f) => k + f.shops.length, 0);
    const added = mergeMall(
      {
        base: {
          id: m.id,
          name: m.name,
          group: 'hanshin',
          type: m.type,
          status: 'open',
          city,
          district,
          address,
          geo: null,
          phone,
          website: url(m.slug),
          opened: null,
          floor_area_ping: null,
          parking: { car: null, motorcycle: null, fee_note: null },
          hours,
          transit: null,
          operator: '漢神百貨股份有限公司',
        },
        sourceUrl: url(m.slug),
        buildings: [{ id: 'main', name: m.name, floors }],
      },
      idx,
    );
    console.log(`${m.name}: ${n} 個櫃位，新增 ${added}`);
  }
});
