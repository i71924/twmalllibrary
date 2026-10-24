// 遠東百貨／大遠百：一般請求會被擋（403），用 Playwright 開 /tw/{館}/MallInfo?tab=floor。
// 所有樓層都在同一頁（隱藏的分頁籤），每層有主題、官方業種分組與品牌連結。
import { closeBrowser, openPage, visit } from './lib/browser.ts';
import { run } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.feds.com.tw';
const MALLS: { sid: number; id: string; name: string }[] = [
  { sid: 55, id: 'feds-xinyi-a13', name: '遠百信義A13' },
  { sid: 32, id: 'feds-baoqing', name: '遠百寶慶' },
  { sid: 50, id: 'feds-banqiao-zhongshan', name: '遠百板橋中山' },
  { sid: 54, id: 'feds-banqiao-mega-city', name: 'Mega City 板橋大遠百' },
  { sid: 40, id: 'feds-taoyuan', name: '遠百桃園' },
  { sid: 72, id: 'feds-zhubei', name: '遠百竹北' },
  { sid: 42, id: 'feds-hsinchu-big-city', name: '新竹大遠百' },
  { sid: 53, id: 'feds-taichung-top-city', name: 'Top City 台中大遠百' },
  { sid: 37, id: 'feds-chiayi', name: '遠百嘉義' },
  { sid: 48, id: 'feds-tainan-chenggong', name: '台南大遠百 成功店' },
  { sid: 34, id: 'feds-tainan-park', name: '台南大遠百 公園店' },
  { sid: 51, id: 'feds-kaohsiung', name: '高雄大遠百' },
  { sid: 52, id: 'feds-hualien', name: '遠百花蓮' },
];

/** 會佔滿整層、值得收錄的設施；停車場、「主題餐廳」這類樓層分類不算 */
const WHOLE_FLOOR = /影城|影院|CINEMA|劇院|樂園|遊樂|書店|超市/i;

type Extracted = {
  floors: { label: string; theme: string | null; shops: { name: string; source_category: string | null }[] }[];
  address: string;
  phone: string | null;
  hours: string | null;
};

run(async () => {
  const only = process.argv[2];
  const idx = loadBrandIndex();
  const page = await openPage();
  try {
    for (const m of MALLS) {
      if (only && m.id !== only) continue;
      await visit(page, `${BASE}/tw/${m.sid}/MallInfo?tab=floor`);
      const data: Extracted = await page.evaluate(() => {
        const t = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const btn = document.querySelector('button[class*="floor-"]');
        const tab = btn?.closest('.m-tab');
        const labels = tab ? [...tab.querySelectorAll(':scope > .m-tab-wrap button')].map((b) => t(b)) : [];
        const panels = tab ? [...(tab.querySelector(':scope > .m-tab-content')?.children ?? [])] : [];
        const floors = labels.map((label, i) => {
          const p = panels[i];
          const theme = [t(p?.querySelector('.floor-title')), t(p?.querySelector('.counters-desc'))].filter(Boolean).join('｜') || null;
          const shops: { name: string; source_category: string | null }[] = [];
          for (const acc of p?.querySelectorAll('.m-accordion') ?? []) {
            const cat = t(acc.querySelector('.accordion-title .text')) || null;
            for (const a of acc.querySelectorAll('.counters-list a')) if (t(a)) shops.push({ name: t(a), source_category: cat });
          }
          return { label, theme, shops };
        });
        const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
        const address = t(document.querySelector('address.address')) || (body.match(/地址\s*(\S{2}[市縣]\S+?號)/)?.[1] ?? '');
        const phone = body.match(/服務電話\s*(\(0\d\)\s*[\d-]{7,})/)?.[1]?.replace(/\s+/g, '') ?? null;
        const hours = body.match(/營業時間\s*(.+?)\s*服務電話/)?.[1] ?? null;
        return { floors, address, phone, hours };
      });

      saveRaw('feds', m.id, { address: data.address, phone: data.phone, hours: data.hours, floors: data.floors });
      const floors = data.floors
        .map((f) => {
          const id = f.label.toUpperCase().replace(/^(B\d+)F$/, '$1');
          // 整層都是同一個設施（如威秀影城）時，官網沒有品牌連結，只有樓層標題；把它當成一個櫃位收錄
          const title = (f.theme ?? '').split('｜')[0].replace(/^B?\d+F\s*/i, '').trim();
          const shops = f.shops.length || !WHOLE_FLOOR.test(title) ? f.shops : [{ name: title, source_category: '整層設施' }];
          return { id, label: id, theme: f.theme, shops };
        })
        .filter((f) => f.shops.length);
      const n = floors.reduce((k, f) => k + f.shops.length, 0);
      if (!n) {
        console.warn(`⚠ ${m.name}：官網沒有櫃位資料（可能整修中），略過`);
        continue;
      }
      const { city, district } = parseAddress(data.address);
      const added = mergeMall(
        {
          base: {
            id: m.id,
            name: m.name,
            group: 'feds',
            type: 'department_store',
            status: 'open',
            city,
            district,
            address: data.address,
            geo: null,
            phone: data.phone,
            website: `${BASE}/tw/${m.sid}`,
            opened: null,
            floor_area_ping: null,
            parking: { car: null, motorcycle: null, fee_note: null },
            hours: data.hours,
            transit: null,
            operator: '遠東百貨股份有限公司',
          },
          sourceUrl: `${BASE}/tw/${m.sid}/MallInfo?tab=floor`,
          buildings: [{ id: 'main', name: m.name, floors }],
        },
        idx,
      );
      console.log(`${m.name}: ${n} 個櫃位，新增 ${added}`);
    }
  } finally {
    await closeBrowser();
  }
});
