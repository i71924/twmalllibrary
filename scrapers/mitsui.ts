// 三井 LaLaport／MITSUI OUTLET PARK：Cloudflare 防護，用 Playwright 開 shopguide.html?type=all（全部店舖一次列出）。
// 地址電話在頁尾，營業時間在 services-time.html。
import { closeBrowser, openPage, visit } from './lib/browser.ts';
import { run } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.mitsui-shopping-park.com.tw';
const SITES: { path: string; id: string; name: string; group: string; type: ScrapedMall['base']['type'] }[] = [
  { path: 'lalaport/nangang', id: 'lalaport-nangang', name: 'LaLaport 南港', group: 'mitsui-lalaport', type: 'shopping_mall' },
  { path: 'lalaport/taichung', id: 'lalaport-taichung', name: 'LaLaport 台中', group: 'mitsui-lalaport', type: 'shopping_mall' },
  { path: 'mop/linkou', id: 'mitsui-outlet-linkou', name: 'MITSUI OUTLET PARK 林口', group: 'mitsui-outlet', type: 'outlet' },
  { path: 'mop/taichungport', id: 'mitsui-outlet-taichung-port', name: 'MITSUI OUTLET PARK 台中港', group: 'mitsui-outlet', type: 'outlet' },
  { path: 'mop/tainan', id: 'mitsui-outlet-tainan', name: 'MITSUI OUTLET PARK 台南', group: 'mitsui-outlet', type: 'outlet' },
];

// GF（地面層）排在 B1 與 1F 之間，例如林口 I館
const FLOOR_ORDER = (f: string) => (f === 'GF' ? 0.5 : /^B(\d+)/.test(f) ? -parseInt(f.slice(1)) : parseInt(f) || 100);

run(async () => {
  const only = process.argv[2];
  const idx = loadBrandIndex();
  const page = await openPage();
  try {
    for (const s of SITES) {
      if (only && s.id !== only) continue;
      // ?type=all 列得最完整；部分館（如台中港）這個網址載不出來，改用預設頁。
      // Cloudflare 偶爾會卡住，每館最多試 3 次，仍失敗就跳過這館、繼續下一館。
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        for (const q of ['?type=all', '']) {
          try {
            await visit(page, `${BASE}/${s.path}/tw/shopguide.html${q}`, '.brand-store__item');
            ok = true;
            break;
          } catch {
            /* 換下一個網址或下一次嘗試 */
          }
        }
      }
      if (!ok) {
        console.warn(`⚠ ${s.name}：店舖頁載入失敗，本次略過`);
        continue;
      }
      const data = await page.evaluate(() => {
        const t = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const shops = [...document.querySelectorAll('.brand-store__item')].map((li) => {
          const loc = t(li.querySelector('.brand-store__location .brand-store__sub-text'));
          const [floor, area] = loc.split('/').map((x) => x.trim());
          return { name: t(li.querySelector('.brand-store__name')), floor: floor || '未標示', area: area || null };
        });
        const foot = (document.body.innerText || '').split('\n').find((l) => /地址[：:]/.test(l)) ?? '';
        return {
          shops,
          address: (foot.match(/地址[：:]\s*(?:\d{3,6}\s*)?(\S+?號)/)?.[1] ?? '').replace(/^\d{3,6}/, ''),
          phone: foot.match(/(?:電話號碼|Tel)[：:]\s*([()\d-]+)/)?.[1]?.replace(/\)-/, ')') ?? null,
        };
      });
      await visit(page, `${BASE}/${s.path}/tw/services-time.html`);
      const hours = await page.evaluate(() => {
        const lines = (document.querySelector('main')?.textContent ?? document.body.textContent ?? '')
          .split('\n')
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter((l) => /\d{1,2}:\d{2}\s*[~～-]\s*\d{1,2}:\d{2}/.test(l));
        return lines.slice(0, 3).join('\n') || null;
      });
      // 部分館的營業時間只寫在首頁
      const hoursFinal =
        hours ??
        (await (async () => {
          await visit(page, `${BASE}/${s.path}/tw/index.html`);
          return page.evaluate(() => {
            const l = (document.body.innerText || '').split('\n').map((x) => x.trim());
            const i = l.indexOf('營業時間');
            return i >= 0 && /\d{1,2}:\d{2}/.test(l[i + 1] ?? '') ? l[i + 1] : null;
          });
        })());
      saveRaw(s.group, s.id, { address: data.address, phone: data.phone, hours: hoursFinal, shops: data.shops });

      // 一般格式是「樓層 / 區域」；林口是「館別 / 樓層」（I館 / 1F），館別當成館棟
      const byBuilding = new Map<string, Map<string, { name: string; source_category: string | null }[]>>();
      for (const x of data.shops) {
        if (!x.name) continue;
        const reversed = /館$/.test(x.floor);
        const building = reversed ? x.floor : s.name;
        const f = (reversed ? x.area ?? '未標示' : x.floor).toUpperCase().replace(/^(B\d+)F$/, '$1');
        const zone = reversed ? null : x.area;
        const b = byBuilding.get(building) ?? new Map();
        b.set(f, [...(b.get(f) ?? []), { name: x.name, source_category: zone }]);
        byBuilding.set(building, b);
      }
      const buildings = [...byBuilding.entries()].map(([name, floors]) => ({
        id: name === s.name ? 'main' : name.replace(/館$/, '').toLowerCase(),
        name,
        floors: [...floors.entries()]
          .sort(([a], [b]) => FLOOR_ORDER(a) - FLOOR_ORDER(b))
          .map(([id, shops]) => ({ id, label: id, shops })),
      }));
      const floors = buildings.flatMap((b) => b.floors);
      const { city, district } = parseAddress(data.address);
      const added = mergeMall(
        {
          base: {
            id: s.id,
            name: s.name,
            group: s.group,
            type: s.type,
            status: 'open',
            city,
            district,
            address: data.address,
            geo: null,
            phone: data.phone,
            website: `${BASE}/${s.path}/tw/index.html`,
            opened: null,
            floor_area_ping: null,
            parking: { car: null, motorcycle: null, fee_note: null },
            hours: hoursFinal,
            transit: null,
            operator: '台灣三井不動產股份有限公司',
          },
          sourceUrl: `${BASE}/${s.path}/tw/shopguide.html`,
          buildings,
        },
        idx,
      );
      console.log(`${s.name}: ${floors.reduce((k, f) => k + new Set(f.shops.map((x) => x.name)).size, 0)} 個櫃位，新增 ${added}`);
    }
  } finally {
    await closeBrowser();
  }
});
