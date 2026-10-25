// 本週每組的更新狀態：哪幾組還需要（在本機）補跑。
// 「本週」從台灣時間週日 00:00 起算。一組算完成，只要符合其一：
//   1. 已合併：這組所有營業中商場的 last_checked 都在本週
//   2. 待審：有本週開的週更 PR（分支 weekly/<日期>-<組別>），且標題沒有 ⚠
// 用法：npx tsx scripts/week-status.ts [--auto] [--json] [--table]
//   --auto：排程自動補跑用。週日 05:00 前（雲端 02:00 才開跑）一律不回報，避免和雲端重複
//   輸出：需要補跑的組別，以空白分隔（沒有就輸出空字串）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Mall } from '../src/lib/schema.ts';
import { JOBS } from './lib/jobs.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLOUD_GRACE_HOURS = 5; // 週日 05:00 前不補跑

// 台灣時間的現在，與本週日的日期
const nowTpe = new Date(Date.now() + 8 * 3600_000);
const sunday = new Date(nowTpe);
sunday.setUTCDate(nowTpe.getUTCDate() - nowTpe.getUTCDay());
const weekStart = sunday.toISOString().slice(0, 10);
const hoursIntoWeek = (nowTpe.getTime() - Date.parse(`${weekStart}T00:00:00Z`)) / 3600_000;

const malls = fs
  .readdirSync(path.join(ROOT, 'data/malls'))
  .map((f) => Mall.parse(YAML.parse(fs.readFileSync(path.join(ROOT, 'data/malls', f), 'utf8'))))
  .filter((m) => m.status === 'open');

type Pr = { headRefName: string; title: string; url: string };
const prs: Pr[] = JSON.parse(
  execFileSync('gh', ['pr', 'list', '--state', 'open', '--label', 'weekly-update', '--limit', '100', '--json', 'headRefName,title,url'], {
    cwd: ROOT,
    encoding: 'utf8',
  }),
);

const status = Object.entries(JOBS).map(([group, job]) => {
  const own = malls.filter((m) => job.hosts.includes(new URL(m.meta.source_url).host));
  const merged = own.length > 0 && own.every((m) => m.meta.last_checked >= weekStart);
  const pr = prs.find((p) => {
    const m = p.headRefName.match(/^weekly\/(\d{4}-\d{2}-\d{2})-(.+)$/);
    return m && m[2] === group && m[1] >= weekStart && !p.title.includes('⚠');
  });
  const state = merged ? '已合併' : pr ? '待審 PR' : '未完成';
  return { group, title: job.title, state, url: pr?.url ?? null, need: !merged && !pr };
});

if (process.argv.includes('--table')) {
  const icon: Record<string, string> = { 已合併: '✅', '待審 PR': '📝', 未完成: '⏳' };
  console.log(`本週（${weekStart} 起）各組狀態：`);
  for (const s of status) console.log(`  ${icon[s.state]} ${s.state.padEnd(5, '　')} ${s.title}${s.url ? `  ${s.url}` : ''}`);
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ weekStart, status }, null, 2));
} else if (process.argv.includes('--auto') && hoursIntoWeek < CLOUD_GRACE_HOURS) {
  console.log('');
} else {
  console.log(status.filter((s) => s.need).map((s) => s.group).join(' '));
}
