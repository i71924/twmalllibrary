// 廣三SOGO（台中）：/floor.php 列出各樓 cID，/floor_detail.php?cID= 以 <h3>「1F 品牌名」列出品牌。
// 營業時間、電話、地址在頁尾。和遠東 SOGO 是不同公司。
import { getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.kssogo.com.tw';

run(async () => {
  const idx = loadBrandIndex();
  const index = await getText(`${BASE}/floor.php`);
  const entries = [...index.matchAll(/floor_detail\.php\?cID=(\d+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)].map((m) => {
    const [label, ...theme] = text(m[2]).split(/\s+/);
    return { cid: m[1], label, theme: theme.join(' ') || null };
  });
  const seen = new Set<string>();
  const floors: ScrapedMall['buildings'][number]['floors'] = [];
  for (const e of entries) {
    if (seen.has(e.cid)) continue;
    seen.add(e.cid);
    // 每頁 15 筆，依頁碼往下翻到沒有新品牌為止
    const names: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const html = await getText(`${BASE}/floor_detail.php?cID=${e.cid}&page=${page}`);
      const got = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)]
        .map((m) => text(m[1]))
        .filter((n) => n !== '請選擇樓層')
        .map((n) => n.replace(/^(B?\d+F|餐飲)\s+/i, '').replace(/\s{2,}/g, ' '));
      const fresh = got.filter((n) => !names.includes(n));
      names.push(...fresh);
      if (!fresh.length || !html.includes(`cID=${e.cid}&page=${page + 1}`)) break;
    }
    // 「餐飲」是跨樓層的分類頁，裡面的餐廳已在各樓出現，不另列樓層
    if (!/^B?\d+F$/i.test(e.label) || !names.length) continue;
    const id = e.label.toUpperCase().replace(/^(B\d+)F$/, '$1');
    floors.push({ id, label: id, theme: e.theme, shops: names.map((name) => ({ name })) });
  }

  const footer = text(index);
  const address = (footer.match(/地址[：:]\s*\d{0,6}\s*(\S{2}[市縣]\S+?號)/)?.[1] ?? '').trim();
  const phone = footer.match(/電話[：:]\s*([\d-]+)/)?.[1] ?? null;
  const hours = footer.match(/營業時間[：:]\s*(.+?)\s*電話/)?.[1]?.replace(/\s+(?=例假日)/, '\n') ?? null;
  saveRaw('kssogo', 'kssogo-taichung', { address, phone, hours, floors: floors.map((f) => [f.id, f.shops.length]) });

  const { city, district } = parseAddress(address);
  const n = floors.reduce((k, f) => k + f.shops.length, 0);
  const added = mergeMall(
    {
      base: {
        id: 'kssogo-taichung',
        name: '廣三SOGO',
        group: 'kssogo',
        type: 'department_store',
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
        operator: '廣三崇光國際開發股份有限公司',
      },
      sourceUrl: `${BASE}/floor.php`,
      buildings: [{ id: 'main', name: '廣三SOGO', floors }],
    },
    idx,
  );
  console.log(`廣三SOGO: ${n} 個櫃位，新增 ${added}`);
});
