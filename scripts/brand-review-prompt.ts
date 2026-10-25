// 為每週 PR 產生給 Claude 的審閱提示：每個新品牌附上最相似的既有品牌、以及業種分類表。
// Claude 只負責判斷並寫 PR 留言，不改資料。用法：npx tsx scripts/brand-review-prompt.ts <新品牌清單.txt>
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, CategoryNode } from '../src/lib/schema.ts';
import { brandKey } from '../scrapers/lib/store.ts';

const DATA = path.resolve(import.meta.dirname, '../data');
const newNames = new Set(
  fs
    .readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean),
);
const brands = fs
  .readdirSync(path.join(DATA, 'brands'))
  .map((f) => Brand.parse(YAML.parse(fs.readFileSync(path.join(DATA, 'brands', f), 'utf8'))));
const categories = (YAML.parse(fs.readFileSync(path.join(DATA, 'taxonomy/categories.yaml'), 'utf8')) as unknown[]).map((c) =>
  CategoryNode.parse(c),
);

// 雙字元片段的 Jaccard 相似度；比對前先套用與擷取程式相同的正規化
const grams = (s: string) => {
  const k = brandKey(s);
  return new Set(k.length < 2 ? [k] : Array.from({ length: k.length - 1 }, (_, i) => k.slice(i, i + 2)));
};
const sim = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / (a.size + b.size - n || 1);
};

const existing = brands.filter((b) => !newNames.has(b.name)).map((b) => ({ b, g: grams(b.name) }));
const lines: string[] = [];
for (const name of newNames) {
  const g = grams(name);
  const k = brandKey(name);
  const cands = existing
    .map(({ b, g: bg }) => {
      const bk = brandKey(b.name);
      const contains = bk.length >= 2 && (k.includes(bk) || bk.includes(k));
      return { b, s: Math.max(sim(g, bg), contains ? 0.6 : 0) };
    })
    .filter((x) => x.s >= 0.35)
    .sort((x, y) => y.s - x.s)
    .slice(0, 5);
  lines.push(
    `- 新品牌「${name}」：${cands.length ? cands.map((c) => `「${c.b.name}」(id: ${c.b.id})`).join('、') : '沒有相似的既有品牌'}`,
  );
}

const taxonomy = categories.map((c) => `- ${c.code} ${c.name}：${c.children.map((ch) => `${ch.code} ${ch.name}`).join('、')}`).join('\n');

console.log(`你是「台灣商場一站查」的資料審閱助理。這週的擷取建立了下列新品牌，請逐一判斷：

1. 它是不是某個既有品牌的另一種寫法（別名）？只在很有把握時才建議合併，例如中英文並列、多了分店名或「專櫃」等字樣。
   同集團的不同品牌（例如 UNIQLO 與 GU）、或只是名稱相近的不同店家，都不要合併。
2. 建議一個業種分類代碼（從下方分類表選最細的一層）。

## 新品牌與相似的既有品牌

${lines.join('\n')}

## 業種分類表

${taxonomy}

## 輸出格式

只輸出一個 Markdown 表格，不要其他說明，欄位如下：

| 新品牌 | 建議 | 對象／分類 | 信心 | 理由 |

- 「建議」欄填「合併」（是既有品牌的別名）或「新品牌」
- 「對象／分類」欄：合併時填既有品牌的 id；新品牌時填分類代碼
- 「信心」填 高／中／低
- 「理由」一句話，繁體中文`);
