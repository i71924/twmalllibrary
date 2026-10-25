// 把 ai-verify 的「待確認」業種分類整理成一份給人看、給人改的清單（raw/ai/review.yaml）。
// 每項的 decision 填分類代碼就會在 ai-apply --confirm 時寫入；填 skip 或留空就跳過。
// 兩個 AI 選一樣的，decision 預先填好；意見不一致的留空，等人（或 Claude）判斷。
// 重跑時保留已經填過的 decision，已經有分類的品牌會自動移出清單。
// 用法：npx tsx scripts/ai-review.ts [result.json]（預設用最新一次的驗證結果）
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CategoryNode } from '../src/lib/schema.ts';
import { ROOT } from '../scrapers/lib/store.ts';
import { DATA, loadBrands } from './lib/brands.ts';

const VERIFY_DIR = path.join(ROOT, 'raw/ai-verify');
const resultFile =
  process.argv[2] ??
  path.join(
    VERIFY_DIR,
    fs.readdirSync(VERIFY_DIR).filter((d) => fs.existsSync(path.join(VERIFY_DIR, d, 'result.json'))).sort().at(-1)!,
    'result.json',
  );
const OUT = path.join(ROOT, 'raw/ai/review.yaml');

type Opinion = { source: string; value: unknown; confidence: string; note?: string };
type Decision = {
  status: string;
  target: string;
  label: string;
  field: string;
  reasons: string[];
  opinions: Opinion[];
  evidence: { url: string; issue: string | null }[];
};
export type ReviewItem = {
  brand: string;
  name: string;
  ai: Record<string, string>;
  why: string;
  evidence: string[];
  decision: string | null;
};

const categoryName = new Map(
  (YAML.parse(fs.readFileSync(path.join(DATA, 'taxonomy/categories.yaml'), 'utf8')) as unknown[])
    .map((c) => CategoryNode.parse(c))
    .flatMap((c) => c.children.map((ch) => [ch.code, `${c.name}／${ch.name}`] as const)),
);
const brands = loadBrands();
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { decisions: Decision[] };
const prev = new Map<string, ReviewItem>(
  fs.existsSync(OUT) ? (YAML.parse(fs.readFileSync(OUT, 'utf8')) ?? []).map((x: ReviewItem) => [x.brand, x]) : [],
);

const items: ReviewItem[] = [];
for (const d of result.decisions) {
  if (d.status !== 'pending' || d.field !== 'category') continue;
  const b = brands.get(d.target)?.b;
  if (!b || b.category) continue; // 品牌已被合併，或已經有分類
  const values = [...new Set(d.opinions.map((o) => o.value).filter((v): v is string => typeof v === 'string'))];
  const agreed = values.length === 1 && d.opinions.every((o) => o.value === values[0]) ? values[0] : null;
  items.push({
    brand: b.id,
    name: b.name,
    ai: Object.fromEntries(
      d.opinions.map((o) => [o.source, `${o.value ?? '查不到'}${o.value ? `（${categoryName.get(String(o.value)) ?? '?'}）` : ''}，${o.confidence}${o.note ? `：${o.note}` : ''}`]),
    ),
    why: d.reasons.join('；'),
    evidence: [...new Set(d.evidence.map((e) => e.url))],
    decision: prev.has(b.id) ? prev.get(b.id)!.decision : agreed,
  });
}

const header = `# 待確認的業種分類（${new Date().toISOString().slice(0, 10)} 產生，共 ${items.length} 項）
# 每項只要看 decision 這一行：
#   - 已預先填好的：兩個 AI 選一樣，只是信心不夠或證據沒過。同意就不用動。
#   - 空白的（null）：兩個 AI 意見不一致，填上你要的分類代碼。
#   - 不想現在決定：改成 skip。
# 分類代碼：
${[...categoryName].map(([code, name]) => `#   ${code.padEnd(22)}${name}`).join('\n')}
# 改完後執行：npm run ai:apply -- --confirm raw/ai/review.yaml --dry（試算），沒問題再把 --dry 換成 --pr
`;
fs.writeFileSync(OUT, header + '\n' + YAML.stringify(items, { lineWidth: 0 }));
const blank = items.filter((x) => x.decision == null).length;
console.log(`待確認 ${items.length} 項：已預填 ${items.length - blank}、要決定 ${blank}`);
console.log(`清單：${path.relative(ROOT, OUT)}`);
