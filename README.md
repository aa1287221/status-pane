# status-pane

Claude Code 的 function-hooks mod，用來取代原生的 `statusLine`（cc-statusline 的 `statusline.js`）：

- **右側 pane**：卡片式儀表板。卡片用引擎畫的 `Box`，進度條用 truecolor 的 `Raster`。卡片包括 PROGRESS（NOW 列：目前的工具與經過時間；BG 列：背景 shell、排程等了多久；權限對話框：-p 下 PermissionRequest 沒有觸發、TUI 還沒驗，PERM 列固定印 `n/a（原因）`）、CONTEXT、5H、7D、COST、GIT、ACTIVITY、SYSTEM，依寬度自動排成 1、2 或 3 欄，超出高度時用滑鼠捲動。
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
- WAITING 卡預設開啟（見 #28）：讀 `~/.claude/projects/-project/references/side-files/waiting.<host>.json`，列出所有機器尚未關閉的等待項目（超過 7 天標 DUE）；最多讀 16 個機器檔（依檔名排序），超過的不讀，卡片與提示行也都不提示（已知限制）；沒有項目時顯示「沒有登記」；提示行前面加 `WAIT N`。卡片只讀、不寫入；`"waiting": false` 關閉卡片與提示段。
- 加上 `"fixture": true`（只認布林 true，`1`、`"yes"` 不算）會多出一張 FIXTURE 卡，讀 `$TMPDIR/claude-side/fixture.json`（side file 契約的示範，預設關閉）；檔案缺少、過期或損毀時，卡片顯示 `n/a（原因）`。

## 開發

```
claude plugin validate .
claude plugin test .
```

測試是 `hooks/*.test.ts`，跑在 `claude-code/testing` 測試套件上，不需要 fs、process 或網路。
