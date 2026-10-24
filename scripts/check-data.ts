// 資料品質報告：驗證所有 YAML，輸出 Markdown（各案場統計、缺漏欄位、可疑品牌名稱、可能重複的品牌）。
// 用法：npm run check:data [> report.md]
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, Mall } from '../src/lib/schema.ts';
import { brandKey } from '../scrapers/lib/store.ts';

const DATA = path.resolve(import.meta.dirname, '../data');
const load = <T>(dir: string, s: { parse: (x: unknown) => T }) =>
  fs
    .readdirSync(path.join(DATA, dir))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => s.parse(YAML.parse(fs.readFileSync(path.join(DATA, dir, f), 'utf8'))));

const malls = load('malls', Mall);
const brands = load('brands', Brand);
const used = new Map<string, Set<string>>();
let units = 0;
const rows: string[] = [];
const missing: string[] = [];

for (const m of malls.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, 'zh-Hant'))) {
  const us = m.buildings.flatMap((b) => b.floors.flatMap((f) => f.units.filter((u) => !u.closed_on)));
  units += us.length;
  for (const u of us) for (const b of u.brands) used.set(b, (used.get(b) ?? new Set()).add(m.id));
  const floors = m.buildings.reduce((n, b) => n + b.floors.filter((f) => f.units.length).length, 0);
  rows.push(`| ${m.group} | ${m.name} | ${m.city}${m.district ?? ''} | ${m.buildings.length} | ${floors} | ${us.length} |`);
  const lack = (['address', 'phone', 'hours', 'district'] as const).filter((k) => !m[k]);
  if (m.status === 'open' && lack.length) missing.push(`- ${m.name}：缺 ${lack.join('、')}`);
}

const orphans = brands.filter((b) => !used.has(b.id));
const suspicious = brands.filter(
  (b) => b.name.length > 40 || /(分店|[^\p{L}]店$|樓|^\d+$|^[^\p{L}\p{N}]|專櫃$|POP ?UP|期間限定|&[a-z]+;)/iu.test(b.name),
);
// 去掉中文與空白後相同的品牌，可能是同一品牌的不同寫法
const byLatin = new Map<string, string[]>();
for (const b of brands) {
  const k = brandKey(b.name.replace(/\p{Script=Han}+/gu, ''));
  if (k.length >= 3) byLatin.set(k, [...(byLatin.get(k) ?? []), b.name]);
}
const dupes = [...byLatin.values()].filter((v) => v.length > 1);
const multi = [...used.values()].filter((s) => s.size > 1).length;

const out = [
  `## 資料總覽`,
  ``,
  `- 案場 ${malls.length} 個（營業中 ${malls.filter((m) => m.status === 'open').length}）`,
  `- 櫃位 ${units.toLocaleString()} 個`,
  `- 品牌 ${brands.length.toLocaleString()} 個，其中 ${multi.toLocaleString()} 個開在 2 個以上案場`,
  ``,
  `| 集團 | 案場 | 縣市 | 館棟 | 樓層 | 櫃位 |`,
  `|---|---|---|---:|---:|---:|`,
  ...rows,
  ``,
  `## 基本資料缺漏（${missing.length}）`,
  ``,
  ...(missing.length ? missing : ['- 無']),
  ``,
  `## 可疑品牌名稱（${suspicious.length}）`,
  ``,
  `名稱可能含樓層、分店或活動字樣，需要人工確認：`,
  ``,
  ...suspicious.slice(0, 80).map((b) => `- \`${b.id}\`：${b.name}`),
  ...(suspicious.length > 80 ? [`- …另有 ${suspicious.length - 80} 筆`] : []),
  ``,
  `## 可能重複的品牌（${dupes.length} 組）`,
  ``,
  `英文部分相同、寫法不同，M2 歸戶時處理：`,
  ``,
  ...dupes.slice(0, 80).map((v) => `- ${v.join('／')}`),
  ...(dupes.length > 80 ? [`- …另有 ${dupes.length - 80} 組`] : []),
  ``,
  `## 沒有任何櫃位的品牌（${orphans.length}）`,
  ``,
  ...(orphans.length ? orphans.slice(0, 30).map((b) => `- \`${b.id}\``) : ['- 無']),
];
console.log(out.join('\n'));
