// 品牌資料的共用讀寫：載入品牌與商場、計算據點數、把被合併的品牌參照改寫到保留的品牌。
// scripts/merge-brands.ts（規則合併）與 scripts/ai-apply.ts（AI 驗證後合併）共用。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, Mall } from '../../src/lib/schema.ts';
import { ROOT } from '../../scrapers/lib/store.ts';

export const DATA = path.join(ROOT, 'data');
const read = (f: string) => YAML.parse(fs.readFileSync(f, 'utf8'));
export const writeYaml = (f: string, o: unknown) => fs.writeFileSync(f, YAML.stringify(o, { lineWidth: 0 }));
const yamlFiles = (dir: string) => fs.readdirSync(path.join(DATA, dir)).filter((f) => f.endsWith('.yaml'));

export type BrandEntry = { b: Brand; file: string };
export type MallEntry = { m: Mall; file: string };

export const loadBrands = () =>
  new Map(
    yamlFiles('brands').map((f) => {
      const b = Brand.parse(read(path.join(DATA, 'brands', f)));
      return [b.id, { b, file: path.join(DATA, 'brands', f) }] as const;
    }),
  );

export const loadMalls = (): MallEntry[] =>
  yamlFiles('malls').map((f) => ({ m: Mall.parse(read(path.join(DATA, 'malls', f))), file: path.join(DATA, 'malls', f) }));

/** 每個品牌有幾個櫃位（含已撤櫃），合併時用來決定保留哪一筆 */
export function locationCounts(malls: MallEntry[]) {
  const locs = new Map<string, number>();
  for (const { m } of malls)
    for (const b of m.buildings) for (const fl of b.floors) for (const u of fl.units) for (const id of u.brands) locs.set(id, (locs.get(id) ?? 0) + 1);
  return locs;
}

/** 依 rename（被併掉的 id → 保留的 id）改寫所有櫃位的品牌參照，回傳有變動的商場 */
export function renameUnitBrands(malls: MallEntry[], rename: Map<string, string>) {
  const changed: MallEntry[] = [];
  for (const entry of malls) {
    let dirty = false;
    for (const b of entry.m.buildings)
      for (const fl of b.floors)
        for (const u of fl.units) {
          const next = [...new Set(u.brands.map((id) => rename.get(id) ?? id))];
          if (next.join() !== u.brands.join()) {
            u.brands = next;
            dirty = true;
          }
        }
    if (dirty) changed.push(entry);
  }
  return changed;
}
