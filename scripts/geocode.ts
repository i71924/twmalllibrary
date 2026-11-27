// 補商場座標（geo: [緯度, 經度]）：用 OpenStreetMap 的 Nominatim 查詢，只填目前是空的。
// 用商場名稱與地址查，只採用「商場、百貨、建築物」這類點位，且地址要和資料的縣市、行政區相符；
// 只對到路段中心的結果會偏差數百公尺，不採用。找不到的列出來人工處理
// （2026-11 的經驗：多數新光三越要在地址附近用 viewbox＋bounded=1 搜「新光三越」才找得到）。
// Nominatim 規定每秒最多 1 次查詢。
// 用法：npx tsx scripts/geocode.ts [--dry]
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Mall } from '../src/lib/schema.ts';

const DRY = process.argv.includes('--dry');
const DIR = path.resolve(import.meta.dirname, '../data/malls');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tw = (s: string) => s.replace(/臺/g, '台');

type Hit = { lat: string; lon: string; display_name: string; name?: string; category?: string; type?: string };
async function search(q: string): Promise<Hit[]> {
  await sleep(1100);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=tw&accept-language=zh-TW&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'twmalllibrary-geocoder/1.0' } });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  return (await r.json()) as Hit[];
}

const failed: string[] = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yaml')).sort()) {
  const file = path.join(DIR, f);
  const text = fs.readFileSync(file, 'utf8');
  const m = Mall.parse(YAML.parse(text));
  if (m.geo || m.status === 'planned' || !m.address) continue;
  // 結果的地址要含同一縣市，有行政區的話也要相符
  const place = (h: Hit) => ['shop', 'amenity', 'building', 'railway'].includes(h.category ?? '') || /mall|department_store/.test(h.type ?? '');
  const ok = (h: Hit) => place(h) && tw(h.display_name).includes(m.city) && (!m.district || tw(h.display_name).includes(m.district));
  // 地址查詢用不含樓層的路段門牌
  const addr = m.address.replace(/號.*$/, '號');
  let hit: Hit | undefined;
  let how = '';
  for (const [q, label] of [
    [m.name, '名稱'],
    [m.name.replace(/\s+/g, ''), '名稱'],
    [addr, '地址'],
  ] as const) {
    hit = (await search(q)).find(ok);
    if (hit) {
      how = label;
      break;
    }
  }
  if (!hit) {
    failed.push(`${m.id}（${m.name}，${m.address}）`);
    console.log(`✗ ${m.name}`);
    continue;
  }
  const geo: [number, number] = [Number(Number(hit.lat).toFixed(6)), Number(Number(hit.lon).toFixed(6))];
  console.log(`✓ ${m.name} ← ${how}：${geo.join(', ')}｜${hit.display_name}`);
  if (!DRY) fs.writeFileSync(file, text.replace(/^geo: null$/m, `geo:\n  - ${geo[0]}\n  - ${geo[1]}`));
}
if (failed.length) console.log(`\n找不到座標（${failed.length}）：\n- ${failed.join('\n- ')}`);
