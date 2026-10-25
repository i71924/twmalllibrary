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

// ---------- 品牌合併（raw/ai/review-merge.yaml） ----------
// 只列出至少一個 AI 判定「是同一品牌」的配對；兩個 AI 都說不是的，本來就不必改資料，不列。
// 兩個 AI 都說是的，decision 預填 merge；意見不一致的留空。
const OUT_MERGE = path.join(ROOT, 'raw/ai/review-merge.yaml');
type MergeItem = { pair: string; names: string[]; keep: string; ai: Record<string, string>; why: string; evidence: string[]; decision: string | null };
const prevMerge = new Map<string, MergeItem>(
  fs.existsSync(OUT_MERGE) ? (YAML.parse(fs.readFileSync(OUT_MERGE, 'utf8')) ?? []).map((x: MergeItem) => [x.pair, x]) : [],
);
const merges: MergeItem[] = [];
for (const d of result.decisions) {
  if (d.status !== 'pending' || d.field !== 'same_brand') continue;
  const ids = d.target.split('+');
  if (!ids.every((id) => brands.has(id))) continue; // 已經合併過
  const ops = d.opinions as (Opinion & { verdict?: string })[];
  if (!ops.some((o) => o.verdict === 'correct')) continue;
  const names = ids.map((id) => brands.get(id)!.b.name);
  const suggested = ops.find((o) => o.verdict === 'correct' && typeof o.value === 'string')?.value as string | undefined;
  merges.push({
    pair: d.target,
    names,
    keep: prevMerge.get(d.target)?.keep ?? (suggested && names.includes(suggested) ? suggested : names[0]),
    ai: Object.fromEntries(ops.map((o) => [o.source, `${o.verdict === 'correct' ? '是同一品牌' : o.verdict === 'wrong' ? '不是' : '不確定'}，${o.confidence}${o.note ? `：${o.note}` : ''}`])),
    why: d.reasons.join('；'),
    evidence: [...new Set(d.evidence.map((e) => e.url))],
    decision: prevMerge.has(d.target) ? prevMerge.get(d.target)!.decision : ops.every((o) => o.verdict === 'correct') ? 'merge' : null,
  });
}
const headerMerge = `# 待確認的品牌合併（${new Date().toISOString().slice(0, 10)} 產生，共 ${merges.length} 組）
# 只列出至少一個 AI 認為是同一品牌的配對（兩個 AI 都說不是的不必處理）。每組看 decision：
#   - merge：合併，保留 keep 這個名稱（keep 必須是 names 其中之一，可以改）
#   - skip：不合併
#   - 空白（null）：兩個 AI 意見不一致，請填 merge 或 skip
# 改完後執行：npm run ai:apply -- --confirm raw/ai/review-merge.yaml --dry（試算），沒問題再把 --dry 換成 --pr
`;
if (merges.length || fs.existsSync(OUT_MERGE)) {
  fs.writeFileSync(OUT_MERGE, headerMerge + '\n' + YAML.stringify(merges, { lineWidth: 0 }));
  console.log(`待確認合併 ${merges.length} 組：已預填 ${merges.filter((x) => x.decision).length}、要決定 ${merges.filter((x) => !x.decision).length}`);
  console.log(`清單：${path.relative(ROOT, OUT_MERGE)}`);
}
