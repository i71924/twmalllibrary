// 合併重複品牌（規則層）：比對鍵相同、或中英並列名稱的英文部分等於某個純英文品牌，就併成一筆。
// 保留的品牌：據點較多者，同數則名稱較短者；其餘名稱變成別名，櫃位的品牌參照一併改寫，多餘檔案刪除。
// 也會把名稱裡殘留的 HTML 實體（&eacute; 等）解碼。用法：npx tsx scripts/merge-brands.ts [--dry]
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, Mall } from '../src/lib/schema.ts';
import { brandKey, cleanName, latinKey } from '../scrapers/lib/store.ts';

const DRY = process.argv.includes('--dry');
const DATA = path.resolve(import.meta.dirname, '../data');
const read = (f: string) => YAML.parse(fs.readFileSync(f, 'utf8'));
const write = (f: string, o: unknown) => !DRY && fs.writeFileSync(f, YAML.stringify(o, { lineWidth: 0 }));

const brandFiles = fs.readdirSync(path.join(DATA, 'brands')).filter((f) => f.endsWith('.yaml'));
const brands = new Map(brandFiles.map((f) => {
  const b = Brand.parse(read(path.join(DATA, 'brands', f)));
  return [b.id, { b, file: f }] as const;
}));
const mallFiles = fs.readdirSync(path.join(DATA, 'malls')).filter((f) => f.endsWith('.yaml'));
const malls = mallFiles.map((f) => ({ f, m: Mall.parse(read(path.join(DATA, 'malls', f))) }));

const locs = new Map<string, number>();
for (const { m } of malls)
  for (const b of m.buildings) for (const fl of b.floors) for (const u of fl.units) for (const id of u.brands) locs.set(id, (locs.get(id) ?? 0) + 1);

// union-find
const parent = new Map([...brands.keys()].map((id) => [id, id]));
const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
const union = (a: string, b: string) => parent.set(find(a), find(b));

const byKey = new Map<string, string>();
for (const { b } of brands.values())
  for (const n of [b.name, ...b.aliases]) {
    const k = brandKey(n);
    if (byKey.has(k)) union(b.id, byKey.get(k)!);
    else byKey.set(k, b.id);
  }
for (const { b } of brands.values()) {
  const lk = latinKey(b.name);
  if (lk && byKey.has(lk)) union(b.id, byKey.get(lk)!);
}

const groups = new Map<string, string[]>();
for (const id of brands.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);

const rename = new Map<string, string>();
let merged = 0;
for (const ids of groups.values()) {
  if (ids.length < 2) continue;
  ids.sort((a, b) => (locs.get(b) ?? 0) - (locs.get(a) ?? 0) || brands.get(a)!.b.name.length - brands.get(b)!.b.name.length);
  const keep = brands.get(ids[0])!.b;
  const aliases = new Set(keep.aliases);
  for (const id of ids.slice(1)) {
    const o = brands.get(id)!.b;
    for (const n of [o.name, ...o.aliases]) if (brandKey(n) !== brandKey(keep.name)) aliases.add(n);
    rename.set(id, keep.id);
    merged++;
  }
  keep.aliases = [...aliases];
  console.log(`合併：${ids.map((i) => brands.get(i)!.b.name).join('／')} → ${keep.name}`);
}

// 寫回品牌（含名稱解碼），刪除被併掉的檔案
for (const { b, file } of brands.values()) {
  const f = path.join(DATA, 'brands', file);
  if (rename.has(b.id)) {
    if (!DRY) fs.unlinkSync(f);
    continue;
  }
  const name = cleanName(b.name);
  write(f, Brand.parse({ ...b, name, aliases: [...new Set(b.aliases.map(cleanName))].filter((a) => a !== name) }));
}
// 改寫櫃位的品牌參照與原始名稱
for (const { f, m } of malls) {
  for (const b of m.buildings)
    for (const fl of b.floors)
      for (const u of fl.units) {
        u.brands = [...new Set(u.brands.map((id) => rename.get(id) ?? id))];
        u.name_raw = cleanName(u.name_raw);
      }
  write(path.join(DATA, 'malls', f), m);
}
console.log(`\n共合併 ${merged} 筆，剩 ${brands.size - merged} 個品牌${DRY ? '（試算，未寫檔）' : ''}`);
