// AI 建議的證據驗證（docs/AI-VERIFY.md「建議的自動化流程」）：不信任 AI 的結論，只信證據。
// 讀入一個或多個 AI 輸出的 JSON（檔名就是 AI 名稱，例如 raw/ai/<批次>/claude.json），逐筆檢查：
//   1. 格式正確、對象（品牌／商場）存在、分類代碼在分類表裡
//   2. 證據網址打得開，而且引述的原文真的出現在網頁上（逐字比對，忽略空白與標點）
//   3. 證據網域在白名單（商場官網、品牌官網、政府、主要媒體；見 data/ai/sources.yaml）
//   4. 證據跟這個品牌有關、建議的值（代理商名稱、電話…）出現在原文裡
//   5. 至少兩個不同的 AI 結論一致，而且都標 high
// 全部通過 → 自動通過（之後可自動寫入資料）；其餘 → 待確認，並寫明原因。
// 用法：npx tsx scripts/ai-verify.ts <JSON 檔或資料夾>... [--min-sources 2] [--no-browser] [--refresh]
// 輸出：raw/ai-verify/<日期>/report.md（給人看）、result.json（給之後的寫入程式用）
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { Brand, CategoryNode } from '../src/lib/schema.ts';
import { ROOT, brandKey, today } from '../scrapers/lib/store.ts';
import { closeBrowser } from '../scrapers/lib/browser.ts';
import {
  TIER_LABEL,
  TRUSTED,
  brandLatinKeys,
  digits,
  findQuote,
  getPage,
  hostOf,
  loadSources,
  norm,
  tierOf,
  unsafeUrl,
  type Tier,
} from './lib/evidence.ts';

// ---------- 參數 ----------
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MIN_SOURCES = Number(opt('--min-sources') ?? 2);
const BROWSER = !flag('--no-browser') && process.env.NO_BROWSER !== '1';
const REFRESH = flag('--refresh');
const MAX_QUOTE = 60; // 指南要求 50 字以內，多留一點彈性
const inputs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--min-sources');
if (!inputs.length) {
  console.error('用法：npx tsx scripts/ai-verify.ts <JSON 檔或資料夾>... [--min-sources 2] [--no-browser] [--refresh]');
  process.exit(1);
}

// ---------- AI 輸出格式（docs/AI-VERIFY.md「共用輸出格式」） ----------
const Value = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
const Finding = z.object({
  field: z.string().min(1),
  current: Value.optional(),
  suggested: Value.default(null),
  verdict: z.enum(['correct', 'wrong', 'missing', 'uncertain']),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(z.object({ url: z.string(), quote: z.string() })).default([]),
  note: z.string().optional(),
});
const Result = z.object({
  task: z.enum(['mall-info', 'brand-merge', 'unit-sample', 'brand-category']),
  target: z.string().min(1),
  source: z.string().optional(),
  findings: z.array(Finding),
});
type Finding = z.infer<typeof Finding>;

// ---------- 讀現有資料 ----------
const DATA = path.join(ROOT, 'data');
const readYaml = (f: string) => YAML.parse(fs.readFileSync(f, 'utf8'));
const yamls = (dir: string) =>
  fs.existsSync(path.join(DATA, dir))
    ? fs.readdirSync(path.join(DATA, dir)).filter((f) => f.endsWith('.yaml')).map((f) => readYaml(path.join(DATA, dir, f)))
    : [];

const brands = new Map(yamls('brands').map((b) => [b.id as string, Brand.parse(b)]));
const brandByKey = new Map<string, string>();
for (const b of brands.values()) for (const n of [b.name, ...b.aliases]) if (!brandByKey.has(brandKey(n))) brandByKey.set(brandKey(n), b.id);
// 商場只需要基本資料，不必驗證整份櫃位
const malls = new Map(yamls('malls').map((m) => [m.id as string, m as Record<string, any>]));
const groups = yamls('groups');
const leafCodes = new Set(
  (readYaml(path.join(DATA, 'taxonomy/categories.yaml')) as unknown[]).flatMap((c) => CategoryNode.parse(c).children.map((ch) => ch.code)),
);
const officialDomains = [
  ...[...malls.values()].flatMap((m) => [m.website, m.meta?.source_url]),
  ...groups.map((g) => g.website),
  ...[...brands.values()].map((b) => b.website),
]
  .filter(Boolean)
  .map((u) => hostOf(u as string))
  .filter(Boolean);
const sources = loadSources([...new Set(officialDomains)]);

const findBrand = (s: string) => (brands.has(s) ? s : brandByKey.get(brandKey(s)));

// ---------- 讀 AI 輸出 ----------
type Item = { source: string; file: string; task: string; target: string; finding: Finding };
const items: Item[] = [];
const invalid: { file: string; source: string; target: string; field: string; reason: string }[] = [];

const listFiles = (p: string): string[] =>
  fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => listFiles(path.join(p, f))) : p.endsWith('.json') ? [p] : [];

function parseLoose(raw: string): unknown {
  // 容許 AI 多包了 ```json ``` 或前後有說明文字
  const s = raw.replace(/^﻿/, '').replace(/```(?:json)?/g, '');
  try {
    return JSON.parse(s);
  } catch {
    const a = Math.min(...['{', '['].map((c) => s.indexOf(c)).filter((i) => i >= 0));
    const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    return JSON.parse(s.slice(a, b + 1));
  }
}

for (const file of inputs.flatMap((p) => listFiles(path.resolve(p)))) {
  // 專案外的檔案只顯示「資料夾/檔名」，報告比較好讀
  const rel = file.startsWith(ROOT + path.sep) ? path.relative(ROOT, file) : path.join(path.basename(path.dirname(file)), path.basename(file));
  let data: unknown;
  try {
    data = parseLoose(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    invalid.push({ file: rel, source: '?', target: '?', field: '?', reason: `JSON 讀不懂：${(e as Error).message}` });
    continue;
  }
  const list = Array.isArray(data) ? data : [data];
  for (const r of list) {
    const parsed = Result.safeParse(r);
    if (!parsed.success) {
      const t = (r as any)?.target ?? '?';
      invalid.push({ file: rel, source: '?', target: t, field: '?', reason: `格式不符：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}` });
      continue;
    }
    // AI 名稱：JSON 裡的 source，否則用檔名（raw/ai/<批次>/claude.json → claude）
    const source = parsed.data.source ?? path.basename(file, '.json');
    for (const finding of parsed.data.findings) items.push({ source, file: rel, task: parsed.data.task, target: parsed.data.target, finding });
  }
}

// ---------- 對象與值的基本檢查 ----------
const asNames = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[／/、,，;；|｜]/).map((s) => s.trim()).filter(Boolean) : [];

type Resolved = { key: string; label: string; brandIds: string[]; mallId?: string };

function resolve(it: Item): Resolved | string {
  const { task, target, finding: f } = it;
  if (task === 'brand-merge') {
    const names = asNames(f.current).length ? asNames(f.current) : asNames(target);
    const ids = [...new Set(names.map(findBrand))];
    if (names.length < 2) return 'current 要列出至少兩個品牌名稱';
    if (ids.includes(undefined)) return `找不到品牌：${names.filter((n) => !findBrand(n)).join('、')}`;
    if (ids.length < 2) return '這些名稱已經是同一個品牌';
    const sorted = (ids as string[]).sort();
    return { key: sorted.join('+'), label: sorted.map((id) => brands.get(id)!.name).join('／'), brandIds: sorted };
  }
  if (task === 'brand-category') {
    const id = findBrand(target);
    if (!id) return `找不到品牌：${target}`;
    return { key: id, label: brands.get(id)!.name, brandIds: [id] };
  }
  if (task === 'mall-info') {
    if (!malls.has(target)) return `找不到商場：${target}`;
    return { key: target, label: malls.get(target)!.name, brandIds: [], mallId: target };
  }
  // unit-sample：target 可能是「商場｜品牌」，只做證據檢查
  const [m, b] = target.split(/[|｜]/).map((s) => s.trim());
  const id = b ? findBrand(b) : undefined;
  return { key: target, label: target, brandIds: id ? [id] : [], mallId: malls.has(m) ? m : undefined };
}

const NUMERIC = new Set(['phone', 'floor_area_ping', 'parking.car', 'parking.motorcycle']);
// 這些欄位的建議值本身要出現在證據原文裡
const VALUE_IN_QUOTE = new Set(['agent', 'name', 'address', 'operator', ...NUMERIC]);

/** 用來判斷兩個 AI 是否一致的比較值 */
function canon(field: string, f: Finding) {
  if (field === 'same_brand') return f.verdict === 'correct' ? '是同一品牌' : f.verdict === 'wrong' ? '不是同一品牌' : '不確定';
  if (f.suggested == null) return '（無）';
  if (NUMERIC.has(field)) return digits(String(f.suggested)) || String(f.suggested);
  if (field === 'category') return String(f.suggested).trim();
  return norm(String(f.suggested));
}

// ---------- 逐筆檢查證據 ----------
type Ev = {
  source: string;
  url: string;
  quote: string;
  host: string;
  tier: Tier;
  found: 'visible' | 'source' | null;
  status: string;
  issue: string | null;
  /** 網頁可見文字與原始碼（正規化），用來檢查有沒有提到品牌；不寫進 result.json */
  page?: string;
  pageSrc?: string;
};

async function checkEvidence(it: Item, brandIds: string[]): Promise<Ev[]> {
  const names = brandIds.flatMap((id) => [brands.get(id)!.name, ...brands.get(id)!.aliases]);
  const keys = brandLatinKeys(names);
  const out: Ev[] = [];
  for (const e of it.finding.evidence) {
    const ev: Ev = { source: it.source, url: e.url, quote: e.quote, host: hostOf(e.url), tier: 'unknown', found: null, status: '', issue: null };
    out.push(ev);
    const bad = unsafeUrl(e.url);
    if (bad) {
      ev.issue = bad;
      continue;
    }
    if (norm(e.quote).length < 4) {
      ev.issue = '引述太短';
      continue;
    }
    ev.tier = tierOf(e.url, sources, keys);
    if (ev.tier === 'blocked') {
      ev.issue = `${ev.host} 不能當證據（部落格、論壇、社群、電商等）`;
      continue;
    }
    const page = await getPage(e.url, { browser: BROWSER, refresh: REFRESH, needle: norm(e.quote.split(/…|\.{3,}/)[0]) });
    ev.status = `${page.status}${page.via === 'browser' ? '（瀏覽器）' : ''}`;
    // 轉址到別的網站時，以實際內容所在的網域為準
    if (hostOf(page.finalUrl) !== ev.host) {
      const t2 = tierOf(page.finalUrl, sources, keys);
      if (!TRUSTED.includes(t2)) ev.tier = t2;
    }
    if (!page.ok) {
      ev.issue = `網頁打不開（${page.status}）`;
      continue;
    }
    ev.page = page.visible;
    ev.pageSrc = page.source;
    ev.found = findQuote(page, e.quote);
    if (!ev.found) ev.issue = '原文不在網頁上';
    else if (e.quote.length > MAX_QUOTE) ev.issue = `引述超過 ${MAX_QUOTE} 字`;
    else if (!TRUSTED.includes(ev.tier)) ev.issue = `${ev.host} 不在白名單`;
  }
  return out;
}

/** 名稱切成可比對的片段：英數段（≥2 字）與中日韓文段（≥2 字），全部出現在網頁上才算提到這個名稱 */
const nameTokens = (n: string) =>
  (n.replace(/臺/g, '台').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [])
    .flatMap((w) => w.match(/[A-Za-z0-9]+|[^A-Za-z0-9]+/g) ?? [])
    .map(norm)
    // 樓層字（2F、B1）是擷取時帶進來的，官網上不會有
    .filter((t) => t.length >= 2 && !/^(b?\d+f|b\d+)$/.test(t));
const mentions = (page: string, n: string) => {
  const t = nameTokens(n);
  return t.length > 0 && t.every((x) => page.includes(x));
};

// ---------- 分組、判定 ----------
type Decision = {
  status: 'accepted' | 'pending';
  task: string;
  target: string;
  label: string;
  field: string;
  current: unknown;
  value: unknown;
  verdict: string;
  sources: string[];
  opinions: { source: string; value: unknown; verdict: string; confidence: string; note?: string }[];
  reasons: string[];
  evidence: Omit<Ev, 'page' | 'pageSrc'>[];
};

/** 目前資料庫裡的值（顯示用） */
function currentValue(r: Resolved, field: string): unknown {
  if (r.mallId && !r.brandIds.length) return field.split('.').reduce<any>((o, k) => o?.[k], malls.get(r.mallId));
  if (r.brandIds.length === 1) return (brands.get(r.brandIds[0]) as any)[field] ?? null;
  return r.label;
}

async function main() {
  const groupsByKey = new Map<string, { r: Resolved; items: Item[] }>();
  for (const it of items) {
    const r = resolve(it);
    const field = it.finding.field;
    if (typeof r === 'string') {
      invalid.push({ file: it.file, source: it.source, target: it.target, field, reason: r });
      continue;
    }
    if (field === 'category' && it.finding.suggested != null && !leafCodes.has(String(it.finding.suggested))) {
      invalid.push({ file: it.file, source: it.source, target: it.target, field, reason: `分類代碼不在分類表（或不是最細一層）：${it.finding.suggested}` });
      continue;
    }
    const k = `${it.task}|${r.key}|${field}`;
    const g = groupsByKey.get(k) ?? { r, items: [] };
    // 同一個 AI 對同一件事講兩次，以最後一次為準
    g.items = [...g.items.filter((x) => x.source !== it.source), it];
    groupsByKey.set(k, g);
  }

  const decisions: Decision[] = [];
  let n = 0;
  for (const { r, items: its } of groupsByKey.values()) {
    n++;
    process.stdout.write(`\r檢查中 ${n}/${groupsByKey.size}：${r.label}`.padEnd(60).slice(0, 80));
    // 表示查不到（uncertain 且沒有建議值）的 AI 算棄權，不算反對
    const abstain = (it: Item) => it.finding.verdict === 'uncertain' && (it.finding.suggested == null || it.finding.field === 'same_brand');
    const answers = its.filter((it) => !abstain(it));
    const { task } = its[0];
    const finding = (answers[0] ?? its[0]).finding;
    const field = finding.field;
    const reasons: string[] = [];

    const evidence: Ev[] = [];
    for (const it of its) evidence.push(...(await checkEvidence(it, r.brandIds))); // 依序抓，保持禮貌間隔
    const good = evidence.filter((e) => !e.issue);

    // 5. 多個 AI 是否一致
    // 規則：有答案的 AI 全部選同一個值，而且其中至少 MIN_SOURCES 個標 high。
    // 三個以上 AI 時，信心較低但答案相同的不會擋住；只要有人選了不同的值就待確認。
    const values = new Map(answers.map((it) => [it.source, canon(field, it.finding)]));
    const distinct = new Set(values.values());
    if (answers.length < MIN_SOURCES)
      reasons.push(`只有 ${answers.length} 個 AI 給出答案（需要 ${MIN_SOURCES} 個）${answers.length < its.length ? `；${its.filter(abstain).map((it) => it.source).join('、')} 查不到` : ''}`);
    if (distinct.size > 1) reasons.push(`AI 意見不一致：${its.map((it) => `${it.source}＝${it.finding.suggested ?? it.finding.verdict}`).join('、')}`);
    const highs = answers.filter((it) => it.finding.confidence === 'high');
    // 答案相同但自稱不確定的 AI 不擋；只有標 high 的 AI 又說不確定時才待確認
    if (highs.some((it) => it.finding.verdict === 'uncertain')) reasons.push('有 AI 標 high 卻表示不確定');
    if (highs.length < MIN_SOURCES)
      reasons.push(
        `標 high 的只有 ${highs.length} 個（需要 ${MIN_SOURCES} 個）：${answers.filter((it) => it.finding.confidence !== 'high').map((it) => `${it.source}（${it.finding.confidence}）`).join('、')}`,
      );

    // 2、3. 證據
    if (!evidence.length) reasons.push('沒有附證據');
    else if (!good.length) reasons.push(`沒有通過檢查的證據：${[...new Set(evidence.map((e) => e.issue))].join('；')}`);

    // 4. 證據內容是否支持這個建議
    if (good.length) {
      const names = r.brandIds.flatMap((id) => [brands.get(id)!.name, ...brands.get(id)!.aliases]);
      if (r.brandIds.length && !good.some((e) => e.tier === 'brand-domain' || names.some((nm) => mentions(e.page ?? '', nm))))
        reasons.push('證據網頁沒有提到這個品牌');
      const v = finding.suggested;
      if (VALUE_IN_QUOTE.has(field) && v != null && distinct.size === 1) {
        const inQuote = (q: string) => (NUMERIC.has(field) ? digits(q).includes(digits(String(v))) : norm(q).includes(norm(String(v))));
        if (!good.some((e) => inQuote(e.quote))) reasons.push(`證據原文裡沒有出現建議的值「${v}」`);
      }
      if (field === 'same_brand' && distinct.size === 1 && finding.verdict === 'correct') {
        const each = r.brandIds.map((id) => brands.get(id)!.name);
        if (!good.some((e) => each.every((nm) => mentions(e.pageSrc ?? '', nm))))
          reasons.push(`沒有一個證據網頁同時出現這些名稱：${each.join('、')}`);
      }
    }

    decisions.push({
      status: reasons.length ? 'pending' : 'accepted',
      task,
      target: r.key,
      label: r.label,
      field,
      current: currentValue(r, field),
      value: finding.suggested,
      verdict: finding.verdict,
      sources: its.map((it) => it.source),
      opinions: its.map((it) => ({ source: it.source, value: it.finding.suggested, verdict: it.finding.verdict, confidence: it.finding.confidence, note: it.finding.note })),
      reasons,
      evidence: evidence.map(({ page, pageSrc, ...e }) => e),
    });
  }
  process.stdout.write('\r'.padEnd(80) + '\r');
  await closeBrowser();

  // ---------- 輸出 ----------
  const outDir = path.join(ROOT, 'raw/ai-verify', today());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify({ date: today(), min_sources: MIN_SOURCES, inputs, decisions, invalid }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, 'report.md'), report(decisions));

  const acc = decisions.filter((d) => d.status === 'accepted').length;
  console.log(`共 ${decisions.length} 項建議：自動通過 ${acc}、待確認 ${decisions.length - acc}；無效 ${invalid.length} 筆`);
  console.log(`報告：${path.relative(ROOT, path.join(outDir, 'report.md'))}`);
}

const show = (v: unknown) => (v == null ? '（空）' : Array.isArray(v) ? v.join('／') : String(v)).replace(/\|/g, '｜');
const evLine = (e: Omit<Ev, 'page' | 'pageSrc'>) =>
  `  - ${e.issue ? '✗' : '✓'} [${e.host || e.url}](${e.url})（${TIER_LABEL[e.tier]}${e.found === 'source' ? '，原文只在原始碼' : ''}）${e.issue ? `：${e.issue}` : ''}\n    > ${e.quote.replace(/\n/g, ' ')}`;

function report(ds: Decision[]) {
  const acc = ds.filter((d) => d.status === 'accepted');
  const pen = ds.filter((d) => d.status === 'pending');
  const unknownHosts = new Map<string, number>();
  for (const d of ds) for (const e of d.evidence) if (e.tier === 'unknown' && e.found) unknownHosts.set(e.host, (unknownHosts.get(e.host) ?? 0) + 1);

  const L: string[] = [];
  L.push(`# AI 建議驗證報告（${today()}）`, '');
  L.push(`- 自動通過：**${acc.length}** 項（證據已確認、${MIN_SOURCES} 個以上 AI 一致且信心 high）`);
  L.push(`- 待確認：**${pen.length}** 項`);
  L.push(`- 無效：**${invalid.length}** 筆（格式錯誤、找不到對象、分類代碼不存在）`, '');

  L.push('## 自動通過', '');
  if (!acc.length) L.push('（無）', '');
  else {
    L.push('| 對象 | 欄位 | 目前 | 建議 | AI |', '|---|---|---|---|---|');
    for (const d of acc) L.push(`| ${d.label} | ${d.field} | ${show(d.current)} | ${show(d.field === 'same_brand' ? `合併為 ${d.value}` : d.value)} | ${d.sources.join('、')} |`);
    L.push('', '<details><summary>證據</summary>', '');
    for (const d of acc) L.push(`- **${d.label}｜${d.field}**`, ...d.evidence.filter((e) => !e.issue).map(evLine));
    L.push('', '</details>', '');
  }

  L.push('## 待確認', '');
  if (!pen.length) L.push('（無）', '');
  for (const d of pen) {
    L.push(`### ${d.label}｜${d.field}`, '');
    L.push(`- 目前：${show(d.current)}`);
    for (const o of d.opinions) L.push(`- ${o.source}：${show(o.value)}（${o.verdict}，${o.confidence}）${o.note ? `— ${o.note}` : ''}`);
    L.push(`- **原因：** ${d.reasons.join('；')}`);
    if (d.evidence.length) L.push('- 證據：', ...d.evidence.map(evLine));
    L.push('');
  }

  if (invalid.length) {
    L.push('## 無效', '', '| 檔案 | AI | 對象 | 欄位 | 原因 |', '|---|---|---|---|---|');
    for (const x of invalid) L.push(`| ${x.file} | ${x.source} | ${show(x.target)} | ${x.field} | ${show(x.reason)} |`);
    L.push('');
  }
  if (unknownHosts.size) {
    L.push('## 不在白名單、但原文確實存在的網域', '', '如果是可靠的官方網站，可以加進 `data/ai/sources.yaml` 的 official，下次就會被接受。', '');
    for (const [h, c] of [...unknownHosts].sort((a, b) => b[1] - a[1])) L.push(`- ${h}（${c} 次）`);
    L.push('');
  }
  return L.join('\n');
}

main().catch(async (e) => {
  console.error(e);
  await closeBrowser();
  process.exit(1);
});
