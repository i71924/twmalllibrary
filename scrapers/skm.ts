// 新光三越：/brand_list/{branch}?brand_store_id={館}&page={n}，每頁 12 個品牌，
// 每個品牌底下列出它在各館的樓層（隱藏的也在 HTML 裡）。基本資料取自 /branch/{branch}/{館}。
import { decode, getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.skm.com.tw';

type Building = { sid: string; id: string; name: string; label: string };
const MALLS: { id: string; branch: number; name: string; type?: ScrapedMall['base']['type']; buildings: Building[] }[] = [
  {
    id: 'skm-taipei-xinyi',
    branch: 1,
    name: '新光三越 台北信義新天地',
    buildings: [
      { sid: '1124', id: 'a4', name: 'A4', label: '台北信義新天地A4' },
      { sid: '1122', id: 'a8', name: 'A8', label: '台北信義新天地A8' },
      { sid: '1123', id: 'a9', name: 'A9', label: '台北信義新天地A9' },
      { sid: '1121', id: 'a11', name: 'A11', label: '台北信義新天地A11' },
    ],
  },
  { id: 'skm-taipei-station-front', branch: 2, name: '新光三越 台北站前店', buildings: [{ sid: '1111', id: 'main', name: '站前店', label: '台北站前店' }] },
  {
    id: 'skm-taipei-nanxi',
    branch: 3,
    name: '新光三越 台北南西店',
    buildings: [
      { sid: '1101', id: 'main', name: '一館', label: '台北南西店' },
      { sid: '1103', id: 'b3', name: '三館', label: '台北南西店三館' },
    ],
  },
  {
    id: 'skm-taipei-tianmu',
    branch: 4,
    name: '新光三越 台北天母店',
    buildings: [
      { sid: '1151', id: 'main', name: '一館', label: '台北天母店' },
      { sid: '1152', id: 'b2', name: '二館', label: '台北天母店二館' },
    ],
  },
  { id: 'skm-taipei-main-station', branch: 16, name: '新光三越 臺北車站', type: 'arcade', buildings: [{ sid: '1112', id: 'main', name: '臺北車站', label: '臺北車站' }] },
  { id: 'skm-taoyuan', branch: 6, name: '新光三越 桃園站前店', buildings: [{ sid: '1171', id: 'main', name: '桃園站前店', label: '桃園站前店' }] },
  { id: 'skm-taichung', branch: 7, name: '新光三越 台中中港店', buildings: [{ sid: '1201', id: 'main', name: '中港店', label: '台中中港店' }] },
  {
    id: 'skm-diamond-towers',
    branch: 13,
    name: '新光三越 DIAMOND TOWERS',
    type: 'shopping_mall',
    buildings: [
      { sid: '1131', id: 't1', name: '一館', label: 'DIAMOND TOWERS一館' },
      { sid: '1132', id: 't2', name: '二館', label: 'DIAMOND TOWERS二館' },
    ],
  },
  { id: 'skm-chiayi', branch: 8, name: '新光三越 嘉義垂楊店', buildings: [{ sid: '1331', id: 'main', name: '垂楊店', label: '嘉義垂楊店' }] },
  { id: 'skm-tainan-zhongshan', branch: 9, name: '新光三越 台南中山店', buildings: [{ sid: '1311', id: 'main', name: '中山店', label: '台南中山店' }] },
  {
    id: 'skm-tainan-place',
    branch: 10,
    name: '新光三越 台南新天地',
    buildings: [
      { sid: '1321', id: 'main', name: '本館', label: '台南新天地' },
      { sid: '1322', id: 'xiaoximen', name: '小西門', label: '台南新天地小西門' },
    ],
  },
  { id: 'skm-tainan-xiaobeimen', branch: 15, name: '新光三越 台南小北門', type: 'shopping_mall', buildings: [{ sid: '1361', id: 'main', name: '小北門', label: '台南小北門' }] },
  { id: 'skm-kaohsiung-sanduo', branch: 11, name: '新光三越 高雄三多店', buildings: [{ sid: '1301', id: 'main', name: '三多店', label: '高雄三多店' }] },
  {
    id: 'skm-kaohsiung-zuoying',
    branch: 12,
    name: '新光三越 高雄左營店',
    buildings: [
      { sid: '1351', id: 'main', name: '本館', label: '高雄左營店' },
      { sid: '1352', id: 'rainbow', name: '彩虹市集', label: '高雄左營店彩虹市集' },
    ],
  },
];

/** 解析一頁品牌清單，回傳品牌名稱與筆數 */
function parseNames(html: string) {
  return [...html.matchAll(/class="brand-name[^"]*">([\s\S]*?)<\/div>/g)].map((m) => text(m[1])).filter(Boolean);
}

const listUrl = (branch: number, sid: string, floor: string, page: number) =>
  `${BASE}/brand_list/${branch}?brand_capital=&brand_store_id=${sid}&store_int_floor=${floor}&brand_category=&query=&is_restaurant=&page=${page}`;

/** 逐樓層查詢（官網品牌卡上的樓層標示不一定包含分館名稱，用樓層篩選最可靠） */
async function scrapeBuilding(branch: number, b: Building) {
  const first = await getText(listUrl(branch, b.sid, '', 1));
  const total = Number(first.match(/total_rcnt\s*=\s*"(\d+)"/)?.[1] ?? 0);
  const floors = [...first.matchAll(/name="a_btn_floor" data-value=['"](-?\d+)['"]>\s*([^<]+?)\s*</g)]
    .filter((m) => m[1] !== '-99')
    .map((m) => ({ v: m[1], label: m[2].toUpperCase().replace(/^(B\d+)F$/, '$1') }));
  const out: { label: string; shops: { name: string }[] }[] = [];
  for (const f of floors) {
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const html = await getText(listUrl(branch, b.sid, f.v, page));
      const n = Number(html.match(/total_rcnt\s*=\s*"(\d+)"/)?.[1] ?? 0);
      names.push(...parseNames(html));
      if (page * 12 >= n) break;
    }
    if (names.length) out.push({ label: f.label, shops: names.map((name) => ({ name })) });
  }
  return { floors: out, total };
}

async function branchInfo(branch: number, sid: string) {
  const html = await getText(`${BASE}/branch/${branch}/${sid}`);
  const phone = text(html.match(/icon-phone"><\/i>\s*<p>([^<]+)/)?.[1] ?? '') || null;
  const address = text(html.match(/icon-location"><\/i>\s*<p>([^<]+)/)?.[1] ?? '').replace(/^\d{3,6}/, '');
  const hoursHtml = html.match(/class="div_open_hour">([\s\S]*?)<\/td>/)?.[1] ?? '';
  const hours = [...hoursHtml.matchAll(/<div>([^<]+)<hr[^>]*><\/div>\s*<div><span>([^<]+)<\/span>~<span>([^<]+)<\/span>/g)]
    .map((m) => `${decode(m[1]).trim()} ${m[2]}~${m[3]}`)
    .join('\n');
  const transit = text(html.match(/交通指南<\/[^>]+>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '').split('\n')[0] || null;
  const parkingLine = text(html.match(/停車位數量[\s\S]*?text-pre-wrap">([^<]+)/)?.[1] ?? '');
  const cars = [...parkingLine.matchAll(/汽車[^：:]*[：:]\s*(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const motos = [...parkingLine.matchAll(/機車[^：:]*[：:]\s*(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  return { phone, address, hours: hours || null, transit, car: cars || null, motorcycle: motos || null };
}

run(async () => {
  const only = process.argv[2];
  const idx = loadBrandIndex();
  for (const m of MALLS) {
    if (only && m.id !== only) continue;
    const info = await branchInfo(m.branch, m.buildings[0].sid);
    const buildings: ScrapedMall['buildings'] = [];
    const raw: Record<string, unknown> = { info };
    let n = 0;
    for (const b of m.buildings) {
      const { floors, total } = await scrapeBuilding(m.branch, b);
      raw[b.sid] = floors;
      const count = floors.reduce((k, f) => k + f.shops.length, 0);
      if (count < total * 0.9) console.warn(`⚠ ${b.label}：官網共 ${total} 筆，逐樓層只取得 ${count} 筆`);
      n += count;
      buildings.push({ id: b.id, name: b.name, floors: floors.map((f) => ({ id: f.label, label: f.label, shops: f.shops })) });
    }
    saveRaw('skm', m.id, raw);
    const { city, district } = parseAddress(info.address);
    const added = mergeMall(
      {
        base: {
          id: m.id,
          name: m.name,
          short_name: m.name.replace('新光三越 ', ''),
          group: 'skm',
          type: m.type ?? 'department_store',
          status: 'open',
          city,
          district,
          address: info.address,
          geo: null,
          phone: info.phone,
          website: `${BASE}/store_branch/${m.branch}`,
          opened: null,
          floor_area_ping: null,
          parking: { car: info.car, motorcycle: info.motorcycle, fee_note: null },
          hours: info.hours,
          transit: info.transit,
          operator: '新光三越百貨股份有限公司',
        },
        sourceUrl: `${BASE}/brand_list/${m.branch}`,
        buildings,
      },
      idx,
    );
    console.log(`${m.name}: ${n} 個櫃位，新增 ${added}`);
  }
});
