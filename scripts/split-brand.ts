// 把誤歸到某個品牌的櫃位移到正確的品牌（「一筆品牌混了兩家店」時用）。
// 目標品牌已存在（id 或名稱相符）就直接改指向它；不存在就建立一筆 pending 品牌。
// 用法：npx tsx scripts/split-brand.ts <櫃位 uid> <目標品牌名稱或 id> [--dry]
// 例：npx tsx scripts/split-brand.ts breeze-center-0006 maison-kayser
import fs from 'node:fs';
import path from 'node:path';
import { Brand } from '../src/lib/schema.ts';
import { brandKey, slugify } from '../scrapers/lib/store.ts';
import { DATA, loadBrands, loadMalls, writeYaml } from './lib/brands.ts';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const [uid, target] = argv.filter((a) => !a.startsWith('--'));
if (!uid || !target) {
  console.error('用法：npx tsx scripts/split-brand.ts <櫃位 uid> <目標品牌名稱或 id> [--dry]');
  process.exit(1);
}

const brands = loadBrands();
const malls = loadMalls();
const hit = malls.flatMap(({ m, file }) =>
  m.buildings.flatMap((b) => b.floors.flatMap((f) => f.units.filter((u) => u.uid === uid).map((u) => ({ m, file, u })))),
);
if (hit.length !== 1) {
  console.error(`找不到櫃位 ${uid}`);
  process.exit(1);
}
const { m, file, u } = hit[0];

// 目標品牌：先比 id，再比名稱與別名
let toId = brands.has(target) ? target : [...brands.values()].find((e) => [e.b.name, ...e.b.aliases].some((n) => brandKey(n) === brandKey(target)))?.b.id;
let created = false;
if (!toId) {
  toId = slugify(target);
  for (let n = 2; brands.has(toId); n++) toId = `${slugify(target)}-${n}`;
  created = true;
  if (!DRY) writeYaml(path.join(DATA, 'brands', `${toId}.yaml`), Brand.parse({ id: toId, name: target, review: 'pending' }));
}
const from = u.brands.join('、');
u.brands = [toId];
if (!DRY) writeYaml(file, m);

// 原本的品牌如果已經沒有任何櫃位就刪掉，避免留下空品牌
const stillUsed = (id: string) => malls.some(({ m: mm }) => mm.buildings.some((b) => b.floors.some((f) => f.units.some((x) => x.brands.includes(id)))));
for (const id of from.split('、'))
  if (id !== toId && !stillUsed(id) && !DRY) {
    fs.rmSync(brands.get(id)!.file);
    console.log(`品牌 ${id} 已沒有櫃位，刪除`);
  }
console.log(`${m.name}｜${u.name_raw}（${uid}）：${from} → ${toId}${created ? '（新建品牌）' : ''}${DRY ? '（試算）' : ''}`);
