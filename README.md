# status-pane

Claude Code 的 function-hooks mod，用來取代原生的 `statusLine`（cc-statusline 的 `statusline.js`）：

- **右側 pane**：卡片式儀表板。卡片用引擎畫的 `Box`，進度條用 truecolor 的 `Raster`。卡片包括 PROGRESS（NOW 列：目前的工具與經過時間；BG 列：背景 shell、排程等了多久；權限對話框：-p 下 PermissionRequest 沒有觸發、TUI 還沒驗，PERM 列固定印 `n/a（原因）`）、CONTEXT、5H、7D、COST、GIT、ACTIVITY、SYSTEM、SYNC，依寬度自動排成 1、2 或 3 欄，超出高度時用滑鼠捲動。
- **prompt 下方提示行的尾巴**：一行精簡資訊，例如 `ctx 4% · 5h 20% · 7d 74% · $0.33 · 21:09`，被 `/diff` 或其他 pane 擋住時仍看得到。

詳細規格、資料對應與測試路徑矩陣在 [`hooks/SPEC.md`](hooks/SPEC.md)。

## 需求

- Claude Code 2.1.294 以上，環境變數 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`（可放在 `~/.claude/settings.json` 的 `env`）。
- 全螢幕介面（settings 的 `"tui": "fullscreen"`），pane 才會貼在右側；主畫面模式下它會出現在 prompt 上方。
- 部分欄位讀的是 cc-statusline tracker hook 寫在 `/tmp/claude-*-<sid>.*` 的檔案：`subagent-tracker`、`file-tracker`、`message-tracker`、`summary-updater`、`compact-monitor`，加上 `~/.claude/hooks/mcp-status-refresh.js`。缺少的話，對應的列會顯示 `n/a (… hook not configured)`。

## 安裝

**同一台機器只能選一種方式。** 兩種都用的話，mod 會跑兩份：出現兩個 pane 分頁、提示行重複，修改行數也會被算兩次，寫進共用的統計檔。作者的機器已經透過同步的 settings 用第二種方式（`CLAUDE_CODE_PLUGIN_DIRS`）載入，所以不要再用 marketplace 安裝。要改用 marketplace，先從 `settings.json` 拿掉 `CLAUDE_CODE_PLUGIN_DIRS`。

用 marketplace 安裝（適合沒有同步這份 settings 的機器）。這是 private repo，該機器要有可以讀取它的 `gh`／git 認證。在 Claude Code 的 prompt 輸入：

```
/plugin install status-pane --marketplace aa1287221/status-pane
```

或直接從資料夾載入，在 `~/.claude/settings.json` 加上：

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/plugins/status-pane" } }
```

這種方式下，資料夾內容有修改就會自動重新載入。

## 使用

- session 開始時 pane 會自動打開：終端機至少 144 欄才會打開；手動開過一次、而且之後沒有手動關掉的話，降到 110 欄。
- 手動打開或叫回來，輸入 `/status-pane`。
- `/progress`：回合進行中也立即印出目前的工具與經過時間，以及背景工作（來源是上一次回合結束的快照）（和 PROGRESS 卡同一份資料，不經模型）；資料缺失時印 `n/a（原因）`。
- `~/.claude/cc-statusline-rows.json` 可以逐列關閉；設成 `"enabled": false` 會整個停用，什麼都不收集、不寫入。
- CONTEXT 卡永遠顯示 `/compact` 門檻提示（取不到用量時只顯示原因）：用量未達時是淡色的 `達 60% 建議 /compact`（卡片太窄時會換行），達到門檻（預設 60%，`STATUS_PANE_CTX_AT`，1–99）起轉成警示色。門檻取自引擎實際 auto-compact 的視窗，不是模型的完整視窗：依序是環境變數 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、settings 的 `modelSettings.<模型>.autoCompactWindow`、`autoCompactWindow`，都沒設才用模型的視窗；視窗比模型小時，提示會多帶門檻的 token 數，例如 `(240.0K)`。預設 observe：只計算與顯示，不碰輸入框；`STATUS_PANE_CTX_SUGGEST=1` 才會把 `/compact …` 預填進輸入框（不自動執行），`=0` 停用建議、保留提示。
- 加上 `"fixture": true`（只認布林 true，`1`、`"yes"` 不算）會多出一張 FIXTURE 卡，讀 `$TMPDIR/claude-side/fixture.json`（side file 契約的示範，預設關閉）；檔案缺少、過期或損毀時，卡片顯示 `n/a（原因）`。
- SYNC 卡（claude-memory 與 `origin/sync-data-v2` 的領先／落後、上次 push 與 fetch 時間）預設開啟，提示列也會先顯示 `SYNC -N PULL`。資料來自 `~/.claude/scripts/hooks/sync-status.py`，只讀本地 ref，不連網。沒有這支 producer 的機器上，卡片顯示 `n/a（缺檔）`；超過 15 分鐘沒有重寫（producer 只在 hook 執行時寫檔）則顯示 `n/a（過期 …）`。這兩種是預期中的狀態，只顯示、不算錯誤；其他 n/a（收集失敗、格式錯誤、檔案損毀等）算 SYSTEM 的一個錯誤。要關掉就在 `~/.claude/cc-statusline-rows.json` 加上 `"sync": false`，卡片、提示列的 SYNC 段與可能有的錯誤都會一起消失。

## 開發

```
claude plugin validate .
claude plugin test .
```

測試是 `hooks/*.test.ts`，跑在 `claude-code/testing` 測試套件上，不需要 fs、process 或網路。
