// 微風：官網是 Next.js，各館資料在 /_next/data/{buildId}/zh_tw/branches/{id}.json
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

const BASE = 'https://www.breeze.com.tw';
const UA = 'twmalllibrary-bot/0.1 (+https://twmalllibrary.pages.dev/about)';

// 官網 branch id → 本站案場 id 與類型
const BRANCHES: Record<string, { id: string; type: ScrapedMall['base']['type'] }> = {
  '001': { id: 'breeze-center', type: 'department_store' },
  '009': { id: 'breeze-xinyi', type: 'department_store' },
  '012': { id: 'breeze-nanshan', type: 'department_store' },
  '007': { id: 'breeze-songgao', type: 'department_store' },
  '005': { id: 'breeze-nanjing', type: 'department_store' },
  '014': { id: 'breeze-east-coast', type: 'shopping_mall' },
  '006': { id: 'breeze-ntuh', type: 'arcade' },
  '011': { id: 'breeze-academia-sinica', type: 'arcade' },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (url: string) => {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};
const htmlToText = (h: string) =>
  h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\r/g, '').trim();

async function main() {
  const home = await (await get(BASE + '/')).text();
  const buildId = home.match(/"buildId":"([^"]+)"/)?.[1];
  if (!buildId) throw new Error('找不到 Next.js buildId，官網可能改版了');

  const idx = loadBrandIndex();
  for (const [branchId, conf] of Object.entries(BRANCHES)) {
    const url = `${BASE}/_next/data/${buildId}/zh_tw/branches/${branchId}.json?branchId=${branchId}`;
    const json = await (await get(url)).json();
    const d = json?.pageProps?.initialState?.branch?.data;
    if (!d?.floors) throw new Error(`${branchId} 資料格式不符`);
    saveRaw('breeze', conf.id, d);

    const { city, district } = parseAddress(d.address);
    const added = mergeMall(
      {
        base: {
          id: conf.id,
          name: d.name,
          group: 'breeze',
          type: conf.type,
          status: 'open',
          city,
          district,
          address: d.address.replace(/^\d{3,6}/, ''),
          geo: null,
          phone: d.telephone || null,
          website: `${BASE}/branches/${branchId}`,
          opened: null,
          floor_area_ping: null,
          parking: { car: null, motorcycle: null, fee_note: null },
          hours: d.opening_hours ? htmlToText(d.opening_hours) : null,
          transit: d.address_alias || null,
          operator: '微風廣場實業股份有限公司',
        },
        sourceUrl: `${BASE}/branches/${branchId}`,
        buildings: [
          {
            id: 'main',
            name: d.name,
            floors: d.floors.map((f: any) => ({
              id: f.floor_name,
              label: f.floor_name,
              theme: f.floor_description || null,
              shops: (f.branch_shops ?? []).map((s: any) => ({ name: s.shop_name })),
            })),
          },
        ],
      },
      idx,
    );
    const total = d.floors.reduce((n: number, f: any) => n + (f.branch_shops?.length ?? 0), 0);
    console.log(`${d.name}: ${total} 個櫃位，新增 ${added}`);
    await sleep(1500); // 禮貌間隔
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
