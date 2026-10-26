// 擷取結果寫回 data/ 的共用邏輯：品牌歸戶（規則層）＋案場 YAML 合併。
// AI 歸戶與撤櫃判定（連續 2 週不見）由每週 agent 處理，這裡只做確定性的部分。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, Mall, type Unit } from '../../src/lib/schema.ts';
import { decode } from './http.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data');

/** 台灣時間的今天（YYYY-MM-DD）；測試時可用環境變數 TODAY 指定 */
export const today = () =>
  process.env.TODAY ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());

/** DRY=1：只解析、不寫檔（測試擷取程式用） */
const DRY = process.env.DRY === '1';

const readYaml = (file: string) => YAML.parse(fs.readFileSync(file, 'utf8'));
const writeYaml = (file: string, obj: unknown) => {
  if (DRY) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(obj, { lineWidth: 0 }));
};

export function saveRaw(group: string, mallId: string, payload: unknown) {
  if (DRY) return console.log(JSON.stringify(payload, null, 1).slice(0, 600));
  const file = path.join(ROOT, 'raw', group, `${mallId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

/** 拉丁字母去掉重音（É→E、Ô→O）；假名的濁音等其他文字不動 */
const stripAccents = (s: string) => s.normalize('NFKD').replace(/([A-Za-z])\p{M}+/gu, '$1').normalize('NFKC');

/** 比對用的鍵：全形轉半形、去空白與標點、統一大寫。 */
export function brandKey(name: string) {
  return stripAccents(decode(name))
    .replace(/[’'`´]/g, '')
    .replace(/[\s\-_.,·・&+!！()（）【】\[\]|/\\]/g, '')
    .toUpperCase();
}

// 只有這些普通英文字時不能當比對鍵（曾把「新馬辣Plus+」誤歸到「迷客夏Plus」、「樂天皇朝 Signature」誤歸到「點點心Signature」）
const GENERIC_LATIN = new Set(
  'PLUS SIGNATURE CAFE COFFEE SHOP STORE SELECT HOME KIDS BABY STUDIO LIFE STYLE OUTLET COLLECTION KITCHEN BAR TEA MARKET CLUB HOUSE LAB GOLF SPORT SPORTS BEAUTY DESIGN TAIWAN TOKYO PARIS NEW THE'.split(' '),
);

/** 中英並列的名稱（如「UNIQLO 優衣庫」）只取英文部分當第二個比對鍵；英文少於 3 個字母或只是普通英文字不採用，避免誤併。 */
export function latinKey(name: string) {
  const n = stripAccents(decode(name));
  if (!/\p{Script=Han}/u.test(n)) return null;
  const latin = n.replace(/[^A-Za-z0-9&'’. -]/g, ' ').trim();
  const k = brandKey(latin);
  return /[A-Z]{3,}/.test(k) && !GENERIC_LATIN.has(k) ? k : null;
}

/** 檔名／網址用的 id：英數轉小寫連字號，中文保留。 */
export function slugify(name: string) {
  return (
    name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[’'`´]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'brand'
  );
}

/** 去掉官網店名常見的雜訊（分店名、樓層註記）。 */
export function cleanName(raw: string) {
  return decode(raw)
    .replace(/\s+/g, ' ')
    .replace(/[（(](期間限定|快閃|POP ?UP)[)）]/gi, '')
    .trim();
}

type BrandIndex = { byKey: Map<string, string>; ids: Set<string> };

export function loadBrandIndex(): BrandIndex {
  const dir = path.join(DATA, 'brands');
  const byKey = new Map<string, string>();
  const ids = new Set<string>();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.yaml')) continue;
    const b = Brand.parse(readYaml(path.join(dir, f)));
    ids.add(b.id);
    for (const n of [b.name, b.name_zh, ...b.aliases]) if (n) byKey.set(brandKey(n), b.id);
  }
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.yaml')) continue;
    const b = Brand.parse(readYaml(path.join(dir, f)));
    for (const n of [b.name, ...b.aliases]) {
      const k = n && latinKey(n);
      if (k && !byKey.has(k)) byKey.set(k, b.id);
    }
  }
  return { byKey, ids };
}

/** 找到既有品牌就回傳 id；找不到就建立一筆 pending 品牌。 */
export function resolveBrand(idx: BrandIndex, rawName: string): { id: string; created: boolean } {
  const name = cleanName(rawName);
  const lk = latinKey(name);
  const hit = idx.byKey.get(brandKey(name)) ?? (lk ? idx.byKey.get(lk) : undefined);
  if (hit) return { id: hit, created: false };
  let id = slugify(name);
  for (let n = 2; idx.ids.has(id); n++) id = `${slugify(name)}-${n}`;
  writeYaml(path.join(DATA, 'brands', `${id}.yaml`), Brand.parse({ id, name, review: 'pending' }));
  idx.ids.add(id);
  idx.byKey.set(brandKey(name), id);
  if (lk && !idx.byKey.has(lk)) idx.byKey.set(lk, id);
  return { id, created: true };
}

export type ScrapedFloor = {
  id: string;
  label: string;
  theme?: string | null;
  shops: { name: string; unit_no?: string | null; source_category?: string | null }[];
};

export type ScrapedMall = {
  base: Omit<Mall, 'buildings' | 'meta'>; // 第一次建檔時使用；之後保留人工修改過的值
  sourceUrl: string;
  buildings: { id: string; name: string; floors: ScrapedFloor[] }[];
};

/** 合併擷取結果到 data/malls/<id>.yaml，回傳本次新增的櫃位數。 */
export function mergeMall(scraped: ScrapedMall, idx: BrandIndex) {
  const file = path.join(DATA, 'malls', `${scraped.base.id}.yaml`);
  const prev = fs.existsSync(file) ? Mall.parse(readYaml(file)) : null;
  const d = today();
  // 只拿營業中的舊櫃位來比對；已撤櫃的原樣保留，同品牌之後回到同位置會是一筆新櫃位
  const prevUnits = new Map<string, Unit>();
  const prevClosed = new Map<string, Unit[]>();
  let seq = 0;
  for (const b of prev?.buildings ?? [])
    for (const f of b.floors)
      for (const u of f.units) {
        seq = Math.max(seq, Number(u.uid.match(/-(\d+)$/)?.[1] ?? 0));
        if (u.closed_on) prevClosed.set(`${b.id}|${f.id}`, [...(prevClosed.get(`${b.id}|${f.id}`) ?? []), u]);
        else prevUnits.set(`${b.id}|${f.id}|${brandKey(u.name_raw)}`, u);
      }

  let added = 0;
  const seen = new Set<string>();
  const buildings: Mall['buildings'] = scraped.buildings.map((b) => ({
    id: b.id,
    name: b.name,
    floors: b.floors.map((f) => {
      const units: Unit[] = [];
      for (const s of f.shops) {
        if (!cleanName(s.name ?? '')) continue; // 官網偶爾有空白店名
        const key = `${b.id}|${f.id}|${brandKey(s.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const old = prevUnits.get(key);
        if (old) {
          units.push({ ...old, last_seen: d, source_category: s.source_category ?? old.source_category });
          continue;
        }
        added++;
        units.push({
          uid: `${scraped.base.id}-${String(++seq).padStart(4, '0')}`,
          name_raw: s.name,
          brands: [resolveBrand(idx, s.name).id],
          unit_no: s.unit_no ?? null,
          source_category: s.source_category ?? null,
          first_seen: d,
          last_seen: d,
          closed_on: null,
          source: 'scraper',
        });
      }
      // 這次沒看到的舊櫃位先保留（last_seen 不更新），由每週 agent 判定是否撤櫃
      for (const [k, u] of prevUnits)
        if (k.startsWith(`${b.id}|${f.id}|`) && !seen.has(k)) units.push(u);
      units.push(...(prevClosed.get(`${b.id}|${f.id}`) ?? []));
      return { id: f.id, label: f.label, theme: f.theme ?? null, units };
    }),
  }));

  // 整層或整棟這次都沒出現時，保留舊資料，同樣交給 agent 判定
  for (const pb of prev?.buildings ?? []) {
    let nb = buildings.find((b) => b.id === pb.id);
    if (!nb) buildings.push((nb = { id: pb.id, name: pb.name, floors: [] }));
    for (const pf of pb.floors) if (!nb.floors.some((f) => f.id === pf.id)) nb.floors.push(pf);
  }

  // 已有的值（可能是人工修改過的）優先；舊資料是空的欄位才用這次擷取到的值補上
  const kept = Object.fromEntries(
    Object.entries(prev ?? {}).filter(([k, v]) => k !== 'buildings' && k !== 'meta' && v !== null && v !== ''),
  );
  const mall = Mall.parse({
    ...scraped.base,
    ...kept,
    buildings,
    meta: {
      source_url: scraped.sourceUrl,
      last_checked: d,
      last_changed: added > 0 || !prev ? d : prev.meta.last_changed,
    },
  });
  writeYaml(file, mall);
  return added;
}

export function parseAddress(address: string) {
  const a = address.replace(/^\d{3,6}/, '').trim();
  const city = a.match(/^(.{2}[市縣])/)?.[1]?.replace(/^臺/, '台') ?? '';
  const rest = a.slice(city.length);
  const district = rest.match(/^(.{1,3}?區)/)?.[1] ?? rest.match(/^(.{1,3}?[鄉鎮市])(?!場)/)?.[1] ?? null;
  return { city, district };
}
