// 擷取結果寫回 data/ 的共用邏輯：品牌歸戶（規則層）＋案場 YAML 合併。
// AI 歸戶與撤櫃判定（連續 2 週不見）由每週 agent 處理，這裡只做確定性的部分。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, Mall, type Unit } from '../../src/lib/schema.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data');

export const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());

const readYaml = (file: string) => YAML.parse(fs.readFileSync(file, 'utf8'));
const writeYaml = (file: string, obj: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(obj, { lineWidth: 0 }));
};

export function saveRaw(group: string, mallId: string, payload: unknown) {
  const file = path.join(ROOT, 'raw', group, `${mallId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

/** 比對用的鍵：全形轉半形、去空白與標點、統一大寫。 */
export function brandKey(name: string) {
  return name
    .normalize('NFKC')
    .replace(/[’'`´]/g, '')
    .replace(/[\s\-_.,·・&+!！()（）【】\[\]|/\\]/g, '')
    .toUpperCase();
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
  return raw
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
  return { byKey, ids };
}

/** 找到既有品牌就回傳 id；找不到就建立一筆 pending 品牌。 */
export function resolveBrand(idx: BrandIndex, rawName: string): { id: string; created: boolean } {
  const name = cleanName(rawName);
  const hit = idx.byKey.get(brandKey(name));
  if (hit) return { id: hit, created: false };
  let id = slugify(name);
  for (let n = 2; idx.ids.has(id); n++) id = `${slugify(name)}-${n}`;
  writeYaml(path.join(DATA, 'brands', `${id}.yaml`), Brand.parse({ id, name, review: 'pending' }));
  idx.ids.add(id);
  idx.byKey.set(brandKey(name), id);
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
  const prevUnits = new Map<string, Unit>();
  for (const b of prev?.buildings ?? [])
    for (const f of b.floors) for (const u of f.units) prevUnits.set(`${b.id}|${f.id}|${brandKey(u.name_raw)}`, u);

  let added = 0;
  let seq = prevUnits.size;
  const seen = new Set<string>();
  const buildings = scraped.buildings.map((b) => ({
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
      return { id: f.id, label: f.label, theme: f.theme ?? null, units };
    }),
  }));

  const mall = Mall.parse({
    ...scraped.base,
    ...(prev ? { ...prev, buildings: undefined, meta: undefined } : {}),
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
  const m = address.replace(/^\d{3,6}/, '').match(/^(.{2,3}[市縣])(.{1,3}?[區鄉鎮市])/);
  return { city: m?.[1]?.replace(/^臺/, '台') ?? '', district: m?.[2] ?? null };
}
