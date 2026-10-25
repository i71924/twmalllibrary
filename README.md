# 台灣商場一站查（twmalllibrary）

全台百貨、購物中心、Outlet 的樓層與品牌資料庫。規格見 [SPEC.md](SPEC.md)。

## 常用指令

```bash
npm install            # 安裝套件（Node 20 以上）
npx playwright install chromium   # 第一次使用：遠百、三井、華泰需要瀏覽器
npm run scrape:all     # 依序執行全部擷取程式 → data/malls、data/brands（約 20 分鐘）
npm run check:data     # 資料品質報告（Markdown）
npm run weekly -- feds # 跑一組擷取並比對異動（每週流程，見 SPEC 第 7 節）
bash scripts/sync.sh   # 補跑本週還沒完成的組別並開 PR（＝雙擊「立即同步.command」）
npm run build          # 建置靜態網站＋搜尋索引 → dist/
npm run preview        # 本機預覽 http://localhost:4321
```

## 目錄

| 路徑 | 內容 |
|---|---|
| `data/` | 唯一的資料來源（YAML）：groups／malls／brands／agents／taxonomy |
| `raw/` | 最近一次擷取的原始資料（不進版控） |
| `scrapers/` | 各集團擷取程式；`lib/store.ts` 負責品牌歸戶與合併 |
| `src/` | Astro 網站；`lib/schema.ts` 是資料結構定義 |

> 這是公開的程式碼 repo，供作品展示。商場與品牌資料不在此 repo 中。
