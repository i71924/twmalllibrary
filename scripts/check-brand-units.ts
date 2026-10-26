// 找出「櫃位名稱和它掛的品牌對不上」的櫃位（擷取歸戶誤掛，例如「新馬辣Plus+」被掛到「迷客夏Plus」）。
// 判斷：櫃位原始名稱和品牌名稱（含別名）沒有任何共用的有辨識力字詞，就列出來。
// 用法：npx tsx scripts/check-brand-units.ts [--all]（預設只列營業中的櫃位）
import { brandKey } from '../scrapers/lib/store.ts';
import { loadBrands, loadMalls } from './lib/brands.ts';

const ALL = process.argv.includes('--all');
// 太常見、不能當作同一品牌依據的英文字
const GENERIC = new Set(
  'PLUS SIGNATURE CAFE COFFEE SHOP STORE SELECT HOME KIDS BABY STUDIO LIFE STYLE THE AND NEW CLUB HOUSE LAB MARKET KITCHEN BAR TEA GOLF SPORT SPORTS OUTLET COLLECTION DESIGN BEAUTY TAIWAN TOKYO PARIS'.split(' '),
);

const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toUpperCase();
function tokens(name: string) {
  const n = norm(name);
  const latin = (n.match(/[A-Z0-9]+(?:['’.&][A-Z0-9]+)*/g) ?? []).map((w) => w.replace(/['’.&]/g, '')).filter((w) => w.length >= 2 && !GENERIC.has(w));
  const cjk = (n.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []).filter((w) => w.length >= 2);
  return { latin, cjk, key: brandKey(name) };
}
function overlaps(a: string, b: string) {
  const x = tokens(a), y = tokens(b);
  if (x.key && x.key === y.key) return true;
  if (x.key.length >= 2 && y.key.length >= 2 && (x.key.includes(y.key) || y.key.includes(x.key))) {
    // 包含關係要排除只靠通用字成立的情況（「迷客夏PLUS」包含「PLUS」）
    const short = x.key.length <= y.key.length ? x.key : y.key;
    if (!GENERIC.has(short)) return true;
  }
  if (x.latin.some((w) => y.latin.includes(w))) return true;
  for (const p of x.cjk) for (const q of y.cjk) if (p.includes(q) || q.includes(p)) return true;
  // 中文名稱常被拆字（「點點心」vs「點心」），共用 2 個以上漢字也算
  const hx = new Set(norm(a).match(/\p{Script=Han}/gu) ?? []);
  const hy = norm(b).match(/\p{Script=Han}/gu) ?? [];
  return hy.filter((c) => hx.has(c)).length >= 2;
}

const brands = loadBrands();
const rows: string[] = [];
for (const { m } of loadMalls())
  for (const bd of m.buildings)
    for (const f of bd.floors)
      for (const u of f.units) {
        if (u.closed_on && !ALL) continue;
        for (const id of u.brands) {
          const b = brands.get(id)?.b;
          if (!b) continue;
          if (![b.name, ...b.aliases].some((n) => overlaps(u.name_raw, n)))
            rows.push(`${u.uid}\t${m.short_name ?? m.name} ${f.label}\t「${u.name_raw}」→ ${b.name}（${id}）`);
        }
      }
console.log(rows.join('\n'));
console.log(`\n共 ${rows.length} 個櫃位的名稱和品牌對不上`);
