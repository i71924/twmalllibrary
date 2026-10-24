// 資料結構定義（對應 SPEC.md 第 3 節）。所有 data/*.yaml 都會在建置時用這裡驗證。
import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const yearMonth = z.string().regex(/^\d{4}-\d{2}$/);
const review = z.enum(['confirmed', 'pending']);

export const Group = z.object({
  id: z.string(),
  name: z.string(),
  name_en: z.string().optional(),
  website: z.string().url().optional(),
  operator: z.string().optional(),
});

export const Unit = z.object({
  uid: z.string(),
  name_raw: z.string().min(1),
  brands: z.array(z.string()).min(1),
  unit_no: z.string().nullable().default(null),
  source_category: z.string().nullable().default(null),
  first_seen: date,
  last_seen: date,
  closed_on: date.nullable().default(null),
  source: z.enum(['scraper', 'manual', 'report']),
});

export const Floor = z.object({
  id: z.string(),
  label: z.string(),
  theme: z.string().nullable().default(null),
  units: z.array(Unit).default([]),
});

export const Building = z.object({
  id: z.string(),
  name: z.string(),
  floors: z.array(Floor),
});

export const Mall = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string().optional(),
  group: z.string(),
  type: z.enum(['department_store', 'shopping_mall', 'outlet', 'arcade', 'underground_mall']),
  status: z.enum(['open', 'planned', 'closed', 'renovating']),
  city: z.string(),
  district: z.string().nullable().default(null),
  address: z.string(),
  geo: z.tuple([z.number(), z.number()]).nullable().default(null),
  phone: z.string().nullable().default(null),
  website: z.string().url(),
  opened: yearMonth.nullable().default(null),
  floor_area_ping: z.number().nullable().default(null),
  parking: z
    .object({ car: z.number().nullable(), motorcycle: z.number().nullable(), fee_note: z.string().nullable() })
    .default({ car: null, motorcycle: null, fee_note: null }),
  hours: z.string().nullable().default(null),
  transit: z.string().nullable().default(null),
  operator: z.string().nullable().default(null),
  buildings: z.array(Building),
  meta: z.object({
    source_url: z.string().url(),
    last_checked: date,
    last_changed: date,
  }),
});

export const Brand = z.object({
  id: z.string(),
  name: z.string().min(1),
  name_zh: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
  category: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  agent: z.string().nullable().default(null),
  operation: z.enum(['direct', 'agency', 'franchise']).nullable().default(null),
  parent_company: z.string().nullable().default(null),
  website: z.string().url().nullable().default(null),
  review,
});

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['subsidiary', 'distributor', 'franchisor', 'local']),
  brands: z.array(z.string()),
  sources: z.array(z.object({ url: z.string().url(), note: z.string().optional() })).default([]),
  review,
});

export const CategoryNode = z.object({
  code: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  children: z.array(z.object({ code: z.string(), name: z.string() })).default([]),
});

export type Group = z.infer<typeof Group>;
export type Mall = z.infer<typeof Mall>;
export type Unit = z.infer<typeof Unit>;
export type Brand = z.infer<typeof Brand>;
export type Agent = z.infer<typeof Agent>;
export type CategoryNode = z.infer<typeof CategoryNode>;
