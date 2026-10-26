// 為一批品牌找出不必搜尋就能直接讀的官方品牌頁，省下網頁搜尋次數（docs/AI-CLAUDE-RUN.md）。
// 目前只有微風的擷取原始檔（raw/breeze/*.json）存了店鋪編號，可組出 https://www.breeze.com.tw/stores/<編號>。
// 用法：npx tsx scripts/ai-hints.ts raw/ai/<批次>
// 輸出：raw/ai/<批次>/hints.tsv（品牌 id、網址）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, brandKey } from '../scrapers/lib/store.ts';
import { loadBrands } from './lib/brands.ts';

const dir = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(path.join(dir, 'brands.txt'))) {
  console.error('用法：npx tsx scripts/ai-hints.ts raw/ai/<批次>');
  process.exit(1);
}

// 微風各館的店鋪：比對鍵 → 店鋪編號（同一品牌在多館時都留下，最多 2 個）
const shops = new Map<string, Set<number>>();
const breezeDir = path.join(ROOT, 'raw/breeze');
const walk = (o: unknown): void => {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === 'object') {
    const x = o as Record<string, unknown>;
    if (typeof x.shop_name === 'string' && typeof x.id === 'number') {
      const k = brandKey(x.shop_name);
      shops.set(k, (shops.get(k) ?? new Set()).add(x.id));
    }
    Object.values(x).forEach(walk);
  }
};
for (const f of fs.existsSync(breezeDir) ? fs.readdirSync(breezeDir) : []) if (f.endsWith('.json')) walk(JSON.parse(fs.readFileSync(path.join(breezeDir, f), 'utf8')));

const brands = loadBrands();
const rows: string[] = [];
for (const id of fs.readFileSync(path.join(dir, 'brands.txt'), 'utf8').split('\n').filter(Boolean)) {
  const b = brands.get(id)?.b;
  if (!b) continue;
  for (const n of [b.name, ...b.aliases]) {
    const ids = shops.get(brandKey(n));
    if (ids) {
      for (const sid of [...ids].slice(0, 2)) rows.push(`${id}\thttps://www.breeze.com.tw/stores/${sid}`);
      break;
    }
  }
}
fs.writeFileSync(path.join(dir, 'hints.tsv'), rows.join('\n') + (rows.length ? '\n' : ''));
console.log(`${new Set(rows.map((r) => r.split('\t')[0])).size} 個品牌有微風品牌頁 → ${path.relative(ROOT, path.join(dir, 'hints.tsv'))}`);
