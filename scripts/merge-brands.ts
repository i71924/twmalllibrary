// 合併重複品牌（規則層）：比對鍵相同、或中英並列名稱的英文部分等於某個純英文品牌，就併成一筆。
// 保留的品牌：據點較多者，同數則名稱較短者；其餘名稱變成別名，櫃位的品牌參照一併改寫，多餘檔案刪除。
// 也會把名稱裡殘留的 HTML 實體（&eacute; 等）解碼。用法：npx tsx scripts/merge-brands.ts [--dry]
import fs from 'node:fs';
import { Brand } from '../src/lib/schema.ts';
import { brandKey, cleanName, latinKey } from '../scrapers/lib/store.ts';
import { loadBrands, loadMalls, locationCounts, renameUnitBrands, writeYaml } from './lib/brands.ts';

const DRY = process.argv.includes('--dry');
const write = (f: string, o: unknown) => !DRY && writeYaml(f, o);

const brands = loadBrands();
const malls = loadMalls();
const locs = locationCounts(malls);

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
  if (rename.has(b.id)) {
    if (!DRY) fs.unlinkSync(file);
    continue;
  }
  const name = cleanName(b.name);
  write(file, Brand.parse({ ...b, name, aliases: [...new Set(b.aliases.map(cleanName))].filter((a) => a !== name) }));
}
// 改寫櫃位的品牌參照與原始名稱
renameUnitBrands(malls, rename);
for (const { file, m } of malls) {
  for (const b of m.buildings) for (const fl of b.floors) for (const u of fl.units) u.name_raw = cleanName(u.name_raw);
  write(file, m);
}
console.log(`\n共合併 ${merged} 筆，剩 ${brands.size - merged} 個品牌${DRY ? '（試算，未寫檔）' : ''}`);
