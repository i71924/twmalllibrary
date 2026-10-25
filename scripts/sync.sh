#!/usr/bin/env bash
# 本機同步：補跑本週還沒完成的組別（雲端被擋或失敗的），流程和 GitHub Actions 的每週更新相同：
# 擷取 → 比對 → 有變更就開 PR、有問題就開 Issue；補跑成功後，關掉這組本週的 ⚠ PR 與 Issue。
#
# 用法：
#   bash scripts/sync.sh                 只補本週還沒完成的組別（「立即同步」圖示就是跑這個）
#   bash scripts/sync.sh --force skm     不管狀態，重跑指定組別
#   bash scripts/sync.sh --auto          排程用：沒網路就安靜結束；週日 05:00 前不跑（讓雲端先跑）
#
# 一律在排程專用的 clone（~/twmalllibrary-weekly）裡執行：macOS 不讓背景工作在「桌面」資料夾執行 git，
# 而且不會動到你平常工作的資料夾。每次先拉最新的 main，程式有更新會自動以新版重跑。
set -euo pipefail
export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

AUTO=0
FORCE=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --force) shift; while [[ $# -gt 0 && "$1" != --* ]]; do FORCE+=("$1"); shift; done; continue ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done
say() { [[ $AUTO -eq 1 ]] || echo "$@"; }

# 1. 網路：排程模式最多等 30 秒（沒網路就下個小時再說）；手動模式等 2 分鐘
tries=$([[ $AUTO -eq 1 ]] && echo 3 || echo 12)
for i in $(seq 1 "$tries"); do
  git ls-remote -q origin HEAD >/dev/null 2>&1 && break
  if [[ $i -eq $tries ]]; then say "連不上 GitHub，請確認網路後再試一次。"; exit $([[ $AUTO -eq 1 ]] && echo 0 || echo 1); fi
  sleep 10
done

# 2. 排程專用的 clone：上次若中途中斷（例如斷網）留下的變更直接丟掉
if [[ "${WEEKLY_DEDICATED:-}" == "1" ]]; then
  git switch -q -f main
  git reset -q --hard
  git clean -fdq -- data
elif [[ -n "$(git status --porcelain -- . ':!raw')" ]]; then
  echo "工作目錄有未提交的變更，為避免混進 PR，這次不執行。" >&2
  exit 1
fi

# 3. 拉最新的 main；拉到新版程式就以新版重跑（bash 會繼續讀舊檔）
git switch -q main
before_pull=$(git rev-parse HEAD)
git pull -q --ff-only origin main
if [[ "$(git rev-parse HEAD)" != "$before_pull" && -z "${SYNC_REEXEC:-}" ]]; then
  export SYNC_REEXEC=1
  args=(); [[ $AUTO -eq 1 ]] && args+=(--auto); [[ ${#FORCE[@]} -gt 0 ]] && args+=(--force "${FORCE[@]}")
  exec bash "$0" ${args[@]+"${args[@]}"} # bash 3.2：空陣列不能直接展開
fi

# 4. 套件（只在 package-lock 變動時重裝）
lock_sha=$(shasum package-lock.json | cut -d' ' -f1)
if [[ ! -f node_modules/.lock-sha || "$(cat node_modules/.lock-sha)" != "$lock_sha" ]]; then
  say "安裝套件…"
  npm ci --silent --no-audit --no-fund
  echo "$lock_sha" > node_modules/.lock-sha
fi

# 5. 決定要跑哪些組別
if [[ ${#FORCE[@]} -gt 0 ]]; then
  TARGETS=("${FORCE[@]}")
else
  read -r -a TARGETS <<< "$(npx tsx scripts/week-status.ts $([[ $AUTO -eq 1 ]] && echo --auto))"
fi
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  say "本週 10 組都已完成（已合併或有待審的 PR），不需要同步。"
  exit 0
fi

TODAY=$(TZ=Asia/Taipei date +%F)
mkdir -p raw/weekly-logs
exec > >(tee -a "raw/weekly-logs/$TODAY.log") 2>&1
echo "=== $(date '+%F %T') 同步：${TARGETS[*]}$([[ $AUTO -eq 1 ]] && echo '（排程自動）')"
if [[ " ${TARGETS[*]} " =~ \ (feds|mitsui|gloria)\  ]]; then
  npx playwright install chromium >/dev/null
fi

for g in "${TARGETS[@]}"; do
  echo "--- $g"
  git switch -q main
  report="raw/weekly-$g.md"
  out="raw/weekly-$g.out"
  rm -f "$out"
  REPORT_FILE="$report" GITHUB_OUTPUT="$out" npx tsx scripts/weekly.ts "$g" | grep -E "個櫃位|個品牌|⚠|資料有變更" || true
  [[ -f "$out" ]] || { echo "$g：比對腳本沒有產生結果"; continue; }
  get() { grep -m1 "^$1=" "$out" | cut -d= -f2-; }
  problem=$(get has_problem)
  issue_title="[週更⚠] $g 擷取異常"
  issue=$(gh issue list --state open --search "in:title \"$issue_title\"" --json number -q '.[0].number')

  if [[ "$problem" == "true" ]]; then
    if [[ -n "$issue" ]]; then gh issue comment "$issue" --body-file "$report" >/dev/null; else gh issue create --title "$issue_title" --body-file "$report" >/dev/null; fi
    echo "⚠ $g 有問題，已開／更新 Issue"
  fi

  if [[ "$(get changed)" == "true" ]]; then
    title=$(get title)
    branch="weekly/$TODAY-$g"
    git switch -q -c "$branch"
    git add data
    git commit -q -m "$title"
    git push -q -f origin "$branch"
    gh label create weekly-update --color FDE9E1 --description "每週自動更新" --force >/dev/null
    url=$(gh pr create --base main --head "$branch" --title "$title" --body-file "$report" --label weekly-update 2>/dev/null \
          || gh pr view "$branch" --json url -q .url)
    echo "PR：$url"
    if [[ "$(get new_brands)" != "0" ]] && command -v claude >/dev/null; then
      npx tsx scripts/brand-review-prompt.ts "raw/weekly-$g-new-brands.txt" > "raw/weekly-$g-prompt.md"
      if claude -p "$(cat "raw/weekly-$g-prompt.md")" > "raw/weekly-$g-review.md"; then
        { echo "## 🤖 Claude 新品牌審閱"; echo; echo "僅供參考，資料沒有被修改。建議合併或分類的品牌，請在 M2 歸戶時處理。"; echo
          cat "raw/weekly-$g-review.md"; } > "raw/weekly-$g-comment.md"
        gh pr comment "$url" --body-file "raw/weekly-$g-comment.md" >/dev/null || true
      fi
    fi
  else
    git checkout -q -- data 2>/dev/null || true
  fi

  # 補跑成功：收掉這組本週較早的 ⚠ PR 與 Issue
  if [[ "$problem" != "true" ]]; then
    gh pr list --state open --label weekly-update --json number,headRefName,title \
      -q ".[] | select(.headRefName | test(\"^weekly/.*-$g\$\")) | select(.title | contains(\"⚠\")) | select(.headRefName != \"${branch:-}\") | .number" |
      while read -r n; do gh pr close "$n" --delete-branch --comment "已由本機同步重新擷取完整資料，改看新的 PR。" >/dev/null && echo "已關閉不完整的 PR #$n"; done
    [[ -n "$issue" ]] && gh issue close "$issue" --comment "本機同步已成功擷取，關閉。" >/dev/null && echo "已關閉 Issue #$issue"
  fi
  unset branch
done

git switch -q main
echo "=== 完成 $(date '+%F %T')"
