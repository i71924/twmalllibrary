// 把 ai-verify 判定「自動通過」的建議寫進資料（docs/AI-VERIFY.md「建議的自動化流程」的最後一步）。
// 目前支援：品牌業種分類（category）、品牌合併（same_brand）；其他欄位只列在報告裡，之後再處理。
// 安全規則：已有不同分類的品牌不覆蓋；品牌已被合併或刪除就跳過；寫入前都用 schema 驗證。
// 用法：npx tsx scripts/ai-apply.ts [result.json] [--confirm raw/ai/review.yaml] [--dry] [--pr]
//   不指定檔案時用最新一次的 raw/ai-verify/<日期>/result.json
//   --confirm 改為寫入人工確認清單（scripts/ai-review.ts 產生）裡填了分類代碼的項目
//   --dry 只列出會改什麼；--pr 從最新的 main 開分支、寫入、commit、開 ai-verified PR
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, CategoryNode } from '../src/lib/schema.ts';
import { ROOT, brandKey, today } from '../scrapers/lib/store.ts';
import { DATA, loadBrands, loadMalls, locationCounts, renameUnitBrands, writeYaml } from './lib/brands.ts';
import { TIER_LABEL, type Tier } from './lib/evidence.ts';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const PR = argv.includes('--pr') && !DRY;
const CONFIRM = argv.includes('--confirm') ? argv[argv.indexOf('--confirm') + 1] : null;

const VERIFY_DIR = path.join(ROOT, 'raw/ai-verify');
const resultFile =
  argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--confirm') ??
  (() => {
    const days = fs.existsSync(VERIFY_DIR)
      ? fs.readdirSync(VERIFY_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(VERIFY_DIR, d, 'result.json')))
      : [];
    if (!days.length) {
      console.error('找不到 raw/ai-verify/<日期>/result.json，請先執行 npm run ai:verify');
      process.exit(1);
    }
    return path.join(VERIFY_DIR, days.sort().at(-1)!, 'result.json');
  })();

type Ev = { url: string; quote: string; host: string; tier: Tier; issue: string | null; source: string };
type Decision = {
  status: 'accepted' | 'pending';
  task: string;
  target: string;
  label: string;
  field: string;
  value: unknown;
  verdict: string;
  sources: string[];
  evidence: Ev[];
};
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { date: string; decisions: Decision[] };
const fromResult = new Map(result.decisions.filter((d) => d.field === 'category').map((d) => [d.target, d]));
const fromMerge = new Map(result.decisions.filter((d) => d.field === 'same_brand').map((d) => [d.target, d]));

// 人工確認：清單裡 decision 填了代碼的項目視同通過，證據沿用驗證結果（PR 說明裡附連結）
const leafCodes = new Set(
  (YAML.parse(fs.readFileSync(path.join(DATA, 'taxonomy/categories.yaml'), 'utf8')) as unknown[]).flatMap((c) =>
    CategoryNode.parse(c).children.map((ch) => ch.code),
  ),
);
type ReviewItem = { brand?: string; name?: string; pair?: string; names?: string[]; keep?: string; decision: string | null };
const review: ReviewItem[] = CONFIRM ? YAML.parse(fs.readFileSync(CONFIRM, 'utf8')) ?? [] : [];
// 合併清單（有 pair）的 decision 只能是 merge／skip，keep 要是兩個名稱之一；分類清單的 decision 要是有效代碼
const bad = review.filter((r) =>
  r.pair
    ? (r.decision != null && r.decision !== 'merge' && r.decision !== 'skip') || (r.decision === 'merge' && !r.names?.includes(r.keep ?? ''))
    : r.decision && r.decision !== 'skip' && !leafCodes.has(r.decision),
);
if (bad.length) {
  console.error(
    `清單裡有填錯的項目，請修正後再執行：\n${bad.map((r) => `  ${r.name ?? r.names?.join('／')}：decision=${r.decision}${r.pair ? `、keep=${r.keep}` : ''}`).join('\n')}`,
  );
  process.exit(1);
}
const accepted: Decision[] = CONFIRM
  ? review
      .filter((r) => r.decision && r.decision !== 'skip')
      .map((r): Decision =>
        r.pair
          ? {
              status: 'accepted',
              task: 'brand-merge',
              target: r.pair,
              label: r.names!.join('／'),
              field: 'same_brand',
              value: r.keep,
              verdict: 'correct',
              sources: ['人工確認'],
              evidence: fromMerge.get(r.pair)?.evidence ?? [],
            }
          : {
              status: 'accepted',
              task: 'brand-category',
              target: r.brand!,
              label: r.name!,
              field: 'category',
              value: r.decision,
              verdict: 'missing',
              sources: ['人工確認'],
              evidence: fromResult.get(r.brand!)?.evidence ?? [],
            },
      )
  : result.decisions.filter((d) => d.status === 'accepted');

// ---------- git（--pr） ----------
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: ROOT, encoding: 'utf8' }).trim();
const gh = (...args: string[]) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8' }).trim();
let branch = '';
if (PR) {
  if (git('status', '--porcelain', '--', 'data')) {
    console.error('data/ 有尚未 commit 的變更，請先處理再開 PR');
    process.exit(1);
  }
  git('switch', '-q', 'main');
  git('pull', '-q', '--ff-only', 'origin', 'main');
  // 精確到秒，連續開兩個 PR 時分支名稱才不會撞到
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date())
    .replace(/:/g, '');
  branch = `ai/${today()}-${stamp}`;
  git('switch', '-q', '-c', branch);
}

// ---------- 套用 ----------
const brands = loadBrands();
const malls = loadMalls();
const locs = locationCounts(malls);
const rename = new Map<string, string>(); // 被併掉的 id → 保留的 id
const finalId = (id: string): string => (rename.has(id) ? finalId(rename.get(id)!) : id);
const touched = new Set<string>(); // 有修改的品牌 id
const removed = new Map<string, string>(); // 被併掉的品牌 id → 要刪的檔案

type Done = { d: Decision; text: string };
const applied: Done[] = [];
const skipped: Done[] = [];

// 1. 先合併，後面的分類才會寫到保留下來的那一筆
for (const d of accepted.filter((x) => x.field === 'same_brand' && x.verdict === 'correct')) {
  const ids = [...new Set(d.target.split('+').map(finalId))];
  const missing = ids.filter((id) => !brands.has(id));
  if (missing.length) {
    skipped.push({ d, text: `品牌已不存在：${missing.join('、')}` });
    continue;
  }
  if (ids.length < 2) {
    skipped.push({ d, text: '已經是同一個品牌' });
    continue;
  }
  // 保留：名稱等於 AI 建議的那筆；沒有的話保留據點多的、同數取名稱短的
  const want = brandKey(String(d.value ?? ''));
  ids.sort(
    (a, b) =>
      Number(brandKey(brands.get(b)!.b.name) === want) - Number(brandKey(brands.get(a)!.b.name) === want) ||
      (locs.get(b) ?? 0) - (locs.get(a) ?? 0) ||
      brands.get(a)!.b.name.length - brands.get(b)!.b.name.length,
  );
  const keep = brands.get(ids[0])!.b;
  const aliases = new Set(keep.aliases);
  for (const id of ids.slice(1)) {
    const o = brands.get(id)!.b;
    for (const n of [o.name, ...o.aliases]) if (brandKey(n) !== brandKey(keep.name)) aliases.add(n);
    // 保留的那筆沒有的資料，從被併掉的補上
    keep.category ??= o.category;
    keep.website ??= o.website;
    keep.agent ??= o.agent;
    keep.name_zh ??= o.name_zh;
    rename.set(id, keep.id);
    locs.set(keep.id, (locs.get(keep.id) ?? 0) + (locs.get(id) ?? 0));
    removed.set(id, brands.get(id)!.file);
    brands.delete(id);
  }
  keep.aliases = [...aliases];
  touched.add(keep.id);
  applied.push({ d, text: `合併為「${keep.name}」（${keep.id}），其他名稱改為別名` });
}

// 2. 業種分類
for (const d of accepted.filter((x) => x.field === 'category')) {
  const id = finalId(d.target);
  const entry = brands.get(id);
  if (!entry) {
    skipped.push({ d, text: `品牌已不存在：${d.target}` });
    continue;
  }
  const b = entry.b;
  const code = String(d.value);
  if (b.category === code) {
    skipped.push({ d, text: '已經是這個分類' });
    continue;
  }
  if (b.category) {
    skipped.push({ d, text: `已有不同的分類（${b.category}），不覆蓋` });
    continue;
  }
  b.category = code;
  // 兩個以上 AI 的證據都來自同一個品牌網域時，順便記下官網（只有一個 AI 引用的可能是海外站或同名的別家公司）
  const byHost = new Map<string, Set<string>>();
  for (const e of d.evidence.filter((x) => !x.issue && x.tier === 'brand-domain')) {
    const origin = new URL(e.url).origin + '/';
    byHost.set(origin, (byHost.get(origin) ?? new Set()).add(e.source));
  }
  const site = [...byHost].find(([, s]) => s.size >= 2)?.[0];
  const setSite = !!site && !b.website;
  if (setSite) b.website = site;
  touched.add(id);
  applied.push({ d, text: `分類設為 ${code}${setSite ? `，官網 ${site}` : ''}` });
}

// 3. 其他還不支援自動寫入的
for (const d of accepted)
  if (!applied.some((x) => x.d === d) && !skipped.some((x) => x.d === d))
    skipped.push({
      d,
      text: d.field === 'same_brand' ? 'AI 判定不是同一品牌，不需要改資料' : `「${d.field}」還不支援自動寫入，請人工處理`,
    });

// ---------- 寫檔 ----------
const changedMalls = renameUnitBrands(malls, rename);
if (!DRY) {
  // 同一次寫入裡先被保留、後來又被併進別的品牌的（例如 A＝B 保留 A，之後 A＝C 保留 C），已經不在 brands 裡，不必寫
  for (const id of touched) {
    const e = brands.get(id);
    if (e) writeYaml(e.file, Brand.parse(e.b));
  }
  for (const file of removed.values()) fs.rmSync(file, { force: true });
  for (const { file, m } of changedMalls) writeYaml(file, m);
}

// ---------- 報告（也當 PR 說明） ----------
const show = (v: unknown) => String(v ?? '（空）').replace(/\|/g, '｜');
const evLine = (e: Ev) =>
  `  - [${e.host}](${e.url})（${TIER_LABEL[e.tier]}，${e.source}）：「${e.quote.replace(/\n/g, ' ')}」${e.issue ? `（⚠ ${e.issue}）` : ''}`;
// 人工確認時沒有通過驗證的證據也列出來（標 ⚠），讓人知道 AI 當初的依據
const shown = (d: Decision) => d.evidence.filter((e) => CONFIRM || !e.issue);
// 從這次寫入的項目隨機抽 3 筆請人點開證據看一下，確認 AI 和驗證程式沒有一起出錯
const picks = [...applied].sort(() => Math.random() - 0.5).slice(0, 3);

const L: string[] = [];
if (CONFIRM) {
  L.push('AI 驗證沒有自動通過（信心不夠、證據讀不到、或 AI 意見不一致），由人工確認分類後寫入。下方證據連結是 AI 當初附的，不一定都通過驗證。', '');
  L.push(`- 人工確認清單：\`${path.relative(ROOT, path.resolve(CONFIRM))}\`（${review.length} 項，其中 ${accepted.length} 項有填分類）`);
} else {
  L.push(`AI 建議經 \`scripts/ai-verify.ts\` 驗證（原文逐字在網頁上、網域可信、多個 AI 一致且信心 high）後自動寫入。`, '');
  L.push(`- 驗證結果：\`${path.relative(ROOT, resultFile)}\`（${result.date}）`);
}
L.push(`- 寫入 **${applied.length}** 項；跳過 ${skipped.length} 項；改動品牌 ${[...touched].filter((id) => brands.has(id)).length} 筆、刪除（併入其他品牌）${removed.size} 筆、商場 ${changedMalls.length} 個`, '');
if (picks.length) {
  L.push('## 🔍 請抽查這幾筆', '', '點開證據網址，確認原文真的在網頁上、而且確實支持這個結論：', '');
  for (const p of picks) L.push(`- **${p.d.label}**：${p.text}`, ...shown(p.d).slice(0, 2).map(evLine));
  L.push('');
}
L.push('## 寫入', '');
if (!applied.length) L.push('（無）', '');
else {
  L.push('| 品牌 | 改動 | AI |', '|---|---|---|');
  for (const a of applied) L.push(`| ${show(a.d.label)} | ${show(a.text)} | ${a.d.sources.join('、')} |`);
  L.push('', '<details><summary>全部證據</summary>', '');
  for (const a of applied) L.push(`- **${a.d.label}｜${a.d.field}**`, ...shown(a.d).map(evLine));
  L.push('', '</details>', '');
}
if (skipped.length) {
  L.push('## 跳過', '', '| 對象 | 欄位 | 建議 | 原因 |', '|---|---|---|---|');
  for (const s of skipped) L.push(`| ${show(s.d.label)} | ${s.d.field} | ${show(s.d.value)} | ${show(s.text)} |`);
  L.push('');
}
const reportFile = path.join(path.dirname(resultFile), 'apply.md');
fs.writeFileSync(reportFile, L.join('\n'));

console.log(`寫入 ${applied.length} 項、跳過 ${skipped.length} 項${DRY ? '（試算，未寫檔）' : ''}`);
for (const a of applied) console.log(`  ✓ ${a.d.label}：${a.text}`);
for (const s of skipped) console.log(`  – ${s.d.label}｜${s.d.field}：${s.text}`);
console.log(`報告：${reportFile.startsWith(ROOT + path.sep) ? path.relative(ROOT, reportFile) : reportFile}`);

// ---------- 開 PR ----------
if (PR) {
  if (!git('status', '--porcelain', '--', 'data')) {
    console.log('沒有任何資料變更，不開 PR');
    git('switch', '-q', 'main');
    git('branch', '-q', '-D', branch);
    process.exit(0);
  }
  const title = CONFIRM
    ? `人工確認：${review.some((r) => r.pair) ? '品牌合併' : '品牌分類'} ${applied.length} 項（${today()}）` : `AI 驗證：品牌分類與合併 ${applied.length} 項（${today()}）`;
  const body = `${L.join('\n')}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`;
  const bodyFile = path.join(path.dirname(resultFile), 'pr-body.md');
  fs.writeFileSync(bodyFile, body);
  git('add', 'data');
  git('commit', '-q', '-m', `${title}\n\n依 ${path.relative(ROOT, resultFile)} 的自動通過項目寫入。\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
  git('push', '-q', '-u', 'origin', branch);
  gh('label', 'create', 'ai-verified', '--color', 'C5DEF5', '--description', 'AI 建議經證據驗證後自動寫入', '--force');
  const url = gh('pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile, '--label', 'ai-verified');
  git('switch', '-q', 'main');
  console.log(`已開 PR：${url}`);
}
