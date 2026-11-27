// 建置時讀取 data/ 下的 YAML，驗證後建立各種索引。只在伺服器端（建置）執行。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Agent, Brand, CategoryNode, Group, Mall, type Unit } from './schema';

const DATA = path.resolve(process.cwd(), 'data');

function loadDir<T>(dir: string, schema: { parse: (x: unknown) => T }): T[] {
  const full = path.join(DATA, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      try {
        return schema.parse(YAML.parse(fs.readFileSync(path.join(full, f), 'utf8')));
      } catch (e) {
        throw new Error(`data/${dir}/${f} 格式錯誤：${e}`);
      }
    });
}

export type Location = {
  mall: Mall;
  building: { id: string; name: string };
  floor: { id: string; label: string };
  unit: Unit;
};

function build() {
  const groups = loadDir('groups', Group);
  const malls = loadDir('malls', Mall).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  const brands = loadDir('brands', Brand);
  const agents = loadDir('agents', Agent);
  const categories = (YAML.parse(fs.readFileSync(path.join(DATA, 'taxonomy/categories.yaml'), 'utf8')) as unknown[]).map(
    (c) => CategoryNode.parse(c),
  );

  const brandById = new Map(brands.map((b) => [b.id, b]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const locationsByBrand = new Map<string, Location[]>();

  for (const mall of malls)
    for (const b of mall.buildings)
      for (const f of b.floors)
        for (const unit of f.units) {
          if (unit.closed_on) continue;
          for (const bid of unit.brands) {
            if (!brandById.has(bid)) throw new Error(`${mall.id} 的櫃位 ${unit.uid} 指向不存在的品牌 ${bid}`);
            const list = locationsByBrand.get(bid) ?? [];
            list.push({ mall, building: b, floor: f, unit });
            locationsByBrand.set(bid, list);
          }
        }

  const categoryName = new Map<string, { name: string; icon?: string }>();
  for (const c of categories) {
    categoryName.set(c.code, { name: c.name, icon: c.icon });
    for (const ch of c.children) categoryName.set(ch.code, { name: ch.name, icon: c.icon });
  }

  return { groups, groupById, malls, brands, brandById, agents, categories, categoryName, locationsByBrand };
}

let cache: ReturnType<typeof build> | null = null;
export const db = () => (cache ??= build());

export const openUnits = (mall: Mall) =>
  mall.buildings.flatMap((b) => b.floors.flatMap((f) => f.units.filter((u) => !u.closed_on)));

export const floorCount = (mall: Mall) =>
  mall.buildings.reduce((n, b) => n + b.floors.filter((f) => f.units.length > 0).length, 0);

export const MALL_TYPE: Record<Mall['type'], string> = {
  department_store: '百貨公司',
  shopping_mall: '購物中心',
  outlet: 'Outlet',
  arcade: '商店街',
  underground_mall: '地下街',
};

export const MALL_STATUS: Record<Mall['status'], string> = {
  open: '營業中',
  planned: '籌備中',
  closed: '已歇業',
  renovating: '整修中',
};

export const CITY_ORDER = [
  '基隆市', '台北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣',
  '雲林縣', '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣',
];

export const lastChecked = () =>
  db().malls.reduce((max, m) => (m.meta.last_checked > max ? m.meta.last_checked : max), '');

/** 字首分組：英文字母、數字或「中文」 */
export const initialOf = (name: string) => {
  const c = name.normalize('NFKC').trim()[0]?.toUpperCase() ?? '#';
  if (/[A-Z]/.test(c)) return c;
  if (/[0-9]/.test(c)) return '0-9';
  return '中文';
};

/** 業種大類的代表色（商場頁的業種組成長條圖用） */
export const CATEGORY_COLOR: Record<string, string> = {
  food: '#e0603f',
  fashion: '#4c7fd1',
  jewelry: '#8a5cc2',
  beauty: '#c2477a',
  sports: '#3f8f6b',
  kids: '#d99a2b',
  home: '#a0724a',
  tech: '#2f8c9a',
  grocery: '#7fa83a',
  entertainment: '#5b5fc7',
  service: '#8c8580',
};

/** 商場營業中櫃位的業種組成（依大類），由多到少；未分類的放最後 */
export function categoryMix(mall: Mall) {
  const { brandById, categories } = db();
  const counts = new Map<string, number>();
  const units = openUnits(mall);
  for (const u of units) {
    const top = brandById.get(u.brands[0])?.category?.split('.')[0] ?? '';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const rows = categories
    .filter((c) => counts.get(c.code))
    .map((c) => ({ code: c.code, name: c.name, icon: c.icon, n: counts.get(c.code)!, color: CATEGORY_COLOR[c.code] ?? '#999' }))
    .sort((a, b) => b.n - a.n);
  const other = counts.get('') ?? 0;
  return { rows, other, total: units.length };
}
