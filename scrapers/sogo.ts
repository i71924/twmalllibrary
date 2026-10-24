// 遠東 SOGO 與遠東 Garden City（同一套官網平台）。
// 樓層清單在 /{館}/floors 頁面；各樓品牌用 POST /RunFunction/FloorsBrand/ 取得（回傳 HTML 片段）。
// Garden City 另有「area」區分各棟。地址電話在 /{館}/traffic/1。
import { getText, run, text } from './lib/http.ts';
import { loadBrandIndex, mergeMall, parseAddress, saveRaw, type ScrapedMall } from './lib/store.ts';

type Site = { host: string; branch: string; id: string; name: string; group: string; type: ScrapedMall['base']['type']; operator: string; areas?: { id: string; area: string; name: string }[] };

const SOGO = 'https://info.sogo.com.tw';
const GC = 'https://www.gardencity.com.tw';
const SITES: Site[] = [
  { host: SOGO, branch: 'tp1', id: 'sogo-taipei-zhongxiao', name: '遠東SOGO 台北忠孝館', group: 'sogo', type: 'department_store', operator: '太平洋崇光百貨股份有限公司' },
  { host: SOGO, branch: 'tp2', id: 'sogo-taipei-fuxing', name: '遠東SOGO 台北復興館', group: 'sogo', type: 'department_store', operator: '太平洋崇光百貨股份有限公司' },
  { host: SOGO, branch: 'tm', id: 'sogo-tianmu', name: '遠東SOGO 天母店', group: 'sogo', type: 'department_store', operator: '太平洋崇光百貨股份有限公司' },
  { host: SOGO, branch: 'zl', id: 'sogo-zhongli', name: '遠東SOGO 中壢店', group: 'sogo', type: 'department_store', operator: '太平洋崇光百貨股份有限公司' },
  { host: SOGO, branch: 'hcbc', id: 'sogo-hsinchu', name: '遠東SOGO 新竹店', group: 'sogo', type: 'department_store', operator: '太平洋崇光百貨股份有限公司' },
  { host: SOGO, branch: 'ks', id: 'sogo-kaohsiung', name: '遠東SOGO 高雄店', group: 'sogo', type: 'department_store', operator: '太平洋崇光百貨股份有限公司' },
  {
    host: GC,
    branch: 'gc',
    id: 'far-eastern-garden-city',
    name: '遠東 Garden City',
    group: 'far-eastern',
    type: 'shopping_mall',
    operator: '遠東集團',
    areas: [
      { id: 'monet', area: '23102418311716', name: '莫內花園（商場棟）' },
      { id: 'light', area: '23102418314189', name: '光之花園（影城棟）' },
      { id: 'dining', area: '23102418320285', name: '食尚庭園（大巨蛋週邊餐廳）' },
      { id: 'underground', area: '24091319175985', name: '花園綠廊（地下商店街）' },
    ],
  },
];

async function floorsOf(site: Site, area = '') {
  const html = await getText(`${site.host}/${site.branch}/floors${area ? `?area=${area}` : ''}`);
  const floors = [...html.matchAll(/name="floor_title_\d+"[^>]*value="([^"]+)"/g)].map((m) => m[1].trim());
  return { html, floors: [...new Set(floors)] };
}

async function brandsOf(site: Site, floor: string, area = '') {
  const form = [
    { name: 'area', value: area },
    { name: 'branchid', value: site.branch },
    { name: 'floor', value: floor },
    { name: 'kinds', value: '全部' },
    { name: 'pages', value: '1' },
    { name: 'acts', value: '' },
    { name: 'act_media', value: '' },
    { name: 'pdate', value: '' },
  ];
  const html = await getText(`${site.host}/RunFunction/FloorsBrand/?20240903`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
    body: 'Val=' + encodeURIComponent(encodeURI(JSON.stringify(form))),
  });
  return [...html.matchAll(/class="title">([^<]+)</g)].map((m) => text(m[1])).filter(Boolean);
}

async function themeOf(site: Site, floor: string) {
  const html = await getText(`${site.host}/${site.branch}/floors/${encodeURIComponent(floor)}`);
  return text(html.match(/<p class="intro">([^<]*)/)?.[1] ?? '') || null;
}

async function infoOf(site: Site, floorsHtml: string) {
  const html = await getText(`${site.host}/${site.branch}/traffic/1`);
  const lines = text(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<\/(p|div|li|td|h\d)>/g, '\n'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const address = (lines.find((l) => /^\d{0,6}\S{2}[市縣].{2,40}號/.test(l)) ?? '').replace(/^\d{3,6}/, '').trim();
  const phone = lines.find((l) => /^\(0\d\)\s*[\d\s-]+$/.test(l))?.replace(/\s+/g, '') ?? null;
  const hoursBlock = text(floorsHtml.match(/營業時間[\s\S]*?百貨<\/[^>]+>([\s\S]*?)<\/(?:p|div)>/)?.[1] ?? '');
  return { address, phone, hours: hoursBlock.replace(/\s*\|\s*/g, '\n').replace(/\s+(?=週[一二三四五六日])/g, '\n') || null };
}

run(async () => {
  const only = process.argv[2];
  const idx = loadBrandIndex();
  for (const site of SITES) {
    if (only && site.id !== only) continue;
    const buildings: ScrapedMall['buildings'] = [];
    let firstHtml = '';
    for (const a of site.areas ?? [{ id: 'main', area: '', name: site.name }]) {
      const { html, floors } = await floorsOf(site, a.area);
      firstHtml ||= html;
      const fl: ScrapedMall['buildings'][number]['floors'] = [];
      for (const f of floors) {
        const names = await brandsOf(site, f, a.area);
        if (!names.length) continue;
        const theme = site.areas ? null : await themeOf(site, f);
        fl.push({ id: f, label: f, theme, shops: names.map((name) => ({ name })) });
      }
      buildings.push({ id: a.id, name: a.name, floors: fl });
    }
    const info = await infoOf(site, firstHtml);
    saveRaw(site.group, site.id, { info, buildings });
    const { city, district } = parseAddress(info.address);
    const n = buildings.reduce((k, b) => k + b.floors.reduce((j, f) => j + f.shops.length, 0), 0);
    const added = mergeMall(
      {
        base: {
          id: site.id,
          name: site.name,
          group: site.group,
          type: site.type,
          status: 'open',
          city,
          district,
          address: info.address,
          geo: null,
          phone: info.phone,
          website: `${site.host}/${site.branch}`,
          opened: null,
          floor_area_ping: null,
          parking: { car: null, motorcycle: null, fee_note: null },
          hours: info.hours,
          transit: null,
          operator: site.operator,
        },
        sourceUrl: `${site.host}/${site.branch}/floors`,
        buildings,
      },
      idx,
    );
    console.log(`${site.name}: ${n} 個櫃位，新增 ${added}`);
  }
});
