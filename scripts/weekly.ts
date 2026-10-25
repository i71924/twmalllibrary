// 每週更新：執行一組擷取程式，和上次提交的資料（git HEAD）比對，套用異動規則，輸出 PR 用的 Markdown 報告。
// 用法：npx tsx scripts/weekly.ts <組別>   例如 skm、feds（組別見下方 JOBS）
//
// 規則（SPEC 第 7 節）：
// - 新進：這次才出現的櫃位
// - 移櫃：同一商場同一品牌，舊位置不見、新位置出現 → 舊櫃位直接標記撤櫃，報告列為移櫃
// - 撤櫃：連續 2 次每週檢查都沒出現才標記 closed_on；第 1 次沒出現只列為「待確認」
// - 健康檢查：這次看到的櫃位少於上次的 70%、或完全沒更新 → 視為官網改版或擷取失敗，
//   這個商場的檔案還原成上次的版本，不產生異動，報告裡標示需要處理
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Brand, Mall, type Unit } from '../src/lib/schema.ts';
import { today } from '../scrapers/lib/store.ts';
import { JOBS } from './lib/jobs.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIN_SEEN_RATIO = 0.7;

const job = process.argv[2];
const conf = JOBS[job];
if (!conf) {
  console.error(`未知的組別「${job}」，可用：${Object.keys(JOBS).join(', ')}`);
  process.exit(2);
}

const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: ROOT, encoding: 'utf8' });
const fromHead = (rel: string) => {
  try {
    return git('show', `HEAD:${rel}`);
  } catch {
    return null;
  }
};
const dump = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });
const loc = (b: { name: string }, f: { label: string }, multi: boolean) => (multi ? `${b.name} ${f.label}` : f.label);

// 這組負責的商場（以 HEAD 的資料為準，籌備中的不算）
const mallFiles = git('ls-files', 'data/malls')
  .split('\n')
  .filter((f) => f.endsWith('.yaml'))
  .map((rel) => ({ rel, old: Mall.parse(YAML.parse(fromHead(rel) ?? '')) }))
  .filter(({ old }) => old.status === 'open' && conf.hosts.includes(new URL(old.meta.source_url).host));

// 1. 執行擷取程式。先記下檔案修改時間，之後用來判斷擷取程式這次有沒有真的寫入該商場
//    （不能只看 last_checked：同一天重跑時日期本來就一樣）
const mtime = (rel: string) => fs.statSync(path.join(ROOT, rel)).mtimeMs;
const before = new Map(mallFiles.map(({ rel }) => [rel, mtime(rel)]));
const failures: string[] = [];
for (const s of conf.scripts) {
  const r = spawnSync('npx', ['tsx', `scrapers/${s}.ts`], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failures.push(`\`scrapers/${s}.ts\` 執行失敗（exit ${r.status}）`);
}

// 2. 逐一比對商場
const d = today();
type Row = { mall: string; name: string; where: string; to?: string };
const added: Row[] = [];
const moved: Row[] = [];
const closed: Row[] = [];
const pending: Row[] = [];
const broken: string[] = [];
const summary: string[] = [];

for (const { rel, old } of mallFiles) {
  const file = path.join(ROOT, rel);
  const cur = Mall.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
  const restore = (why: string) => {
    fs.writeFileSync(file, fromHead(rel)!);
    broken.push(`- **${old.name}**：${why}，本週不更新，資料維持上次版本`);
  };
  if (mtime(rel) === before.get(rel) || cur.meta.last_checked !== d) {
    restore('擷取程式沒有更新這個商場');
    continue;
  }
  const oldUids = new Set(old.buildings.flatMap((b) => b.floors.flatMap((f) => f.units.map((u) => u.uid))));
  const oldUnit = new Map(old.buildings.flatMap((b) => b.floors.flatMap((f) => f.units.map((u) => [u.uid, u] as const))));
  const oldOpen = [...oldUnit.values()].filter((u) => !u.closed_on).length;
  const multi = cur.buildings.length > 1;
  const all = cur.buildings.flatMap((b) => b.floors.flatMap((f) => f.units.map((u) => ({ u, b, f }))));
  const seen = all.filter(({ u }) => !u.closed_on && u.last_seen === d).length;
  if (seen === 0 || seen < oldOpen * MIN_SEEN_RATIO) {
    restore(`這次只看到 ${seen} 個櫃位（上次 ${oldOpen} 個），可能是官網改版或擷取不完整`);
    continue;
  }

  const fresh = all.filter(({ u }) => !oldUids.has(u.uid));
  const missing = all.filter(({ u }) => oldUids.has(u.uid) && !u.closed_on && u.last_seen < d);
  const counts = { added: 0, moved: 0, closed: 0, pending: 0 };

  // 移櫃：同品牌一邊不見、一邊新出現
  for (const n of [...fresh]) {
    const i = missing.findIndex((m) => m.u.brands.some((id) => n.u.brands.includes(id)));
    if (i < 0) continue;
    const [m] = missing.splice(i, 1);
    fresh.splice(fresh.indexOf(n), 1);
    m.u.closed_on = d;
    moved.push({ mall: cur.name, name: n.u.name_raw, where: loc(m.b, m.f, multi), to: loc(n.b, n.f, multi) });
    counts.moved++;
  }
  for (const n of fresh) {
    added.push({ mall: cur.name, name: n.u.name_raw, where: loc(n.b, n.f, multi) });
    counts.added++;
  }
  for (const m of missing) {
    const before = oldUnit.get(m.u.uid) as Unit;
    // 上次檢查時就已經沒看到（last_seen 早於上次檢查日）→ 連續第 2 次不見，確定撤櫃
    if (before.last_seen < old.meta.last_checked) {
      m.u.closed_on = d;
      closed.push({ mall: cur.name, name: m.u.name_raw, where: loc(m.b, m.f, multi) });
      counts.closed++;
    } else {
      pending.push({ mall: cur.name, name: m.u.name_raw, where: loc(m.b, m.f, multi) });
      counts.pending++;
    }
  }
  if (counts.moved || counts.closed) {
    cur.meta.last_changed = d;
    fs.writeFileSync(file, dump(cur));
  }
  summary.push(`| ${cur.name} | ${seen} | ${counts.added} | ${counts.moved} | ${counts.closed} | ${counts.pending} |`);
}

// 3. 新品牌：這次新建、且仍被櫃位引用的；沒被引用的（例如所屬商場被還原）刪掉
const headBrands = new Set(git('ls-files', 'data/brands').split('\n'));
const referenced = new Set(
  fs
    .readdirSync(path.join(ROOT, 'data/malls'))
    .flatMap((f) => Mall.parse(YAML.parse(fs.readFileSync(path.join(ROOT, 'data/malls', f), 'utf8'))).buildings)
    .flatMap((b) => b.floors.flatMap((f) => f.units.flatMap((u) => u.brands))),
);
const newBrands: string[] = [];
for (const f of fs.readdirSync(path.join(ROOT, 'data/brands'))) {
  const rel = `data/brands/${f}`;
  if (headBrands.has(rel)) continue;
  const b = Brand.parse(YAML.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  if (referenced.has(b.id)) newBrands.push(b.name);
  else fs.unlinkSync(path.join(ROOT, rel));
}

// 4. 報告
const table = (rows: Row[], head: string, cols: (r: Row) => string) =>
  rows.length ? [head, ...rows.map(cols)].join('\n') : '無';
const report = [
  `## ${conf.title}：${d} 每週更新`,
  ``,
  `| 商場 | 本次看到 | 新進 | 移櫃 | 撤櫃 | 待確認 |`,
  `|---|---:|---:|---:|---:|---:|`,
  ...summary,
  ``,
  ...(failures.length || broken.length ? ['### ⚠ 需要處理', '', ...failures.map((f) => `- ${f}`), ...broken, ''] : []),
  `### 🎉 新進（${added.length}）`,
  ``,
  table(added, '| 商場 | 品牌 | 位置 |\n|---|---|---|', (r) => `| ${r.mall} | ${r.name} | ${r.where} |`),
  ``,
  `### 🔀 移櫃（${moved.length}）`,
  ``,
  table(moved, '| 商場 | 品牌 | 從 | 到 |\n|---|---|---|---|', (r) => `| ${r.mall} | ${r.name} | ${r.where} | ${r.to} |`),
  ``,
  `### 👋 撤櫃（${closed.length}）`,
  ``,
  `連續 2 次每週檢查都沒出現。`,
  ``,
  table(closed, '| 商場 | 品牌 | 原位置 |\n|---|---|---|', (r) => `| ${r.mall} | ${r.name} | ${r.where} |`),
  ``,
  `### ⏳ 本週沒出現，下週再確認（${pending.length}）`,
  ``,
  `可能是官網暫時漏列。下週還是沒出現才會標記撤櫃；這次資料不變。`,
  ``,
  table(pending, '| 商場 | 品牌 | 位置 |\n|---|---|---|', (r) => `| ${r.mall} | ${r.name} | ${r.where} |`),
  ``,
  `### 🆕 新建立的品牌（${newBrands.length}）`,
  ``,
  newBrands.length ? `${newBrands.join('、')}\n\n狀態都是「待審核」，可能是既有品牌的別名。` : '無',
].join('\n');

const changed = git('status', '--porcelain', '--', 'data').trim().length > 0;
const out = process.env.REPORT_FILE ?? path.join(ROOT, 'raw', `weekly-${job}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, report);
fs.writeFileSync(out.replace(/\.md$/, '-new-brands.txt'), newBrands.join('\n'));
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${changed}\nhas_problem=${failures.length + broken.length > 0}\nnew_brands=${newBrands.length}\n` +
      `title=[週更] ${conf.title} ${d}：新進 ${added.length}／移櫃 ${moved.length}／撤櫃 ${closed.length}${broken.length || failures.length ? '／⚠' : ''}\n`,
  );
console.log(`\n${report}\n\n資料有變更：${changed}`);
