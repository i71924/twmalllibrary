# 部署：Cloudflare Workers（靜態資產）

網站從**私有 repo `i71924/twmalllibrary-data`** 建置，部署成一個 Cloudflare Worker。
Cloudflare 新版的建立流程預設就是 Worker，它的功能已經涵蓋 Pages，這個專案沿用 Worker。

- 正式網址：<https://twmalllibrary.i71924.workers.dev>
- 預覽網址：`*-twmalllibrary.i71924.workers.dev`（每個版本或分支各有一個）
- 公開 repo `i71924/twmalllibrary` 只作展示，不接部署。

## 目前設定（Cloudflare 後台 → Workers & Pages → twmalllibrary → Settings → Build）

| 欄位 | 值 |
|---|---|
| Git repository | `i71924/twmalllibrary-data` |
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy`（Cloudflare 自動偵測 Astro，把 `dist/` 當成靜態資產部署） |

## 運作方式

- **推到 `main`：** 自動建置並部署到正式網址。
- **推到其他分支或開 PR：** 要先在 **Domains** 分頁打開 **Preview** URL，非正式分支才會產生預覽網址。之後審每週更新的 PR 時，可以先用預覽網址看效果。
- 建置紀錄在 **Deployments** 分頁。

## 網址規則

- 網站所有內部連結都以 `/` 結尾（`astro.config.mjs` 設定了 `trailingSlash: 'always'`），避免每次換頁多一次 307 轉址。
- 自訂的 404 頁面在 `src/pages/404.astro`。

## 防爬蟲設定（買網域之後才能啟用）

Bot Fight Mode、WAF、流量限制都是綁在**自己的網域**上的功能，`*.workers.dev` 設定不了。
買好網域之後：

1. 把網域加到 Cloudflare，在這個 Worker 的 **Domains** 分頁按 **Add Domain** 接上。
2. **Security → Bots**：開啟 Bot Fight Mode。
3. **Security → WAF → Rate limiting rules**：同一個 IP 每分鐘超過 60 個請求就要求驗證。
4. 在 **Domains** 分頁關掉 workers.dev 網址，讓網站只能從正式網域進入。
