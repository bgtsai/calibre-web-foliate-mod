# CLAUDE.md — calibre-web-foliate-mod 工作守則

給 Claude 看的：在這個 repo 工作前先讀完。互動原則另見 `bgtsai/claude-knowledge-base` 的 `01_與我互動的原則.html`。

## 原始碼在哪裡
- **唯一來源**：`src/app-ui.js`（閱讀器介面與設定）、`foliate-src/bundle.js`（foliate-js 引擎）。
- `calibre-web-foliate-mod.user.js` 是**產生出來的**：
  - 第 133 行 `BUNDLE_SOURCE`、第 138 行 `APP_SCRIPT_TEMPLATE` 是整份原始碼轉成的超長字串。
  - **絕對不要讀、grep、cat、手改這兩行**（太大，會塞爆對話，手改也會跟原始碼不同步）。
  - 其餘標頭（`@version` 等）可以正常編輯。

## 改版流程
1. 改 `src/app-ui.js` 或 `foliate-src/bundle.js`
2. `calibre-web-foliate-mod.user.js` 第 4 行 `@version` 往上跳（功能 → 次版號，修正 → 修訂號）
3. `python3 tools/pack.py`（只改介面可用 `pack.py app`）——@version 跟原始碼記的版本不同時，會自動把台北時間當天寫進 `src/app-ui.js` 的 `CWFM_RELEASE`（設定面板「關於」的發布日期），不要手改
4. `python3 tools/pack.py --check` 確認同步（同時會跑 `node --check`）
5. 原始碼與 user.js **一起** commit、push
6. 回報格式：【commit】、【版本】舊 → 新、raw 連結（`?v=<短SHA>&t=<日期>`）、blob 連結

## 這份程式也被 Docker 版使用
`bgtsai/calibre-web-foliate-docker` 在建置時抓這個 repo 的指定 commit 組裝閱讀器（不另存副本）。
每次在這裡改版後，要到 Docker repo 把 `Dockerfile` 的 `CWFM_MOD_REF` 改成新的完整 SHA 並推送，
流程、iOS 15 相容轉換與測試方式見該 repo 的 `CLAUDE.md`。
寫程式時留意：Docker 版會用 esbuild 轉成 safari15，並在 iPad（iOS 15.3）上執行。

## 佔位字串（外層腳本／Docker 開機段落替換）
`BOOK_ID`、`INITIAL_SETTINGS`、`INITIAL_POSITION`、`INITIAL_BOOKDATA`（v1.79，書籤＋跳轉紀錄）、`CWFM_VERSION`。
新增佔位字串時，user.js 外層的 `buildCombinedScriptSource()` 與 Docker repo 的 `build/make_reader.py` 都要一起改。

## 規格文件
大功能先寫在 `docs/`（例如 `docs/spec-v1.79.md`：閱讀進度、預覽網址、書籤、搜尋、匯出、跳轉紀錄保存）。

## 已知陷阱
- 開書流程中途若有 `await`，期間引擎的 relocate 等事件會先觸發；監聽器裡用到後面才宣告的 let/const 就會 TDZ。
  新的非同步讀取要放在「還沒掛任何監聽器」的位置（v1.79 的書籤資料是跟書檔一起下載、在還原位置前 await）。
- 函式裡用到「稍後才宣告的 let/const」要注意 TDZ：開書流程中提早觸發會丟錯（v1.76.26 修過點擊區那一處）。
- 換章節時 foliate 會重新呼叫套用設定、shadow root 裡可能同時有新舊 iframe——取目前章節一律用
  `getBookIframeDocument()`（優先走 `renderer.getContents()`）。

## 已知陷阱（補）
- 「每章掛一次」的監聽（view 的 load 事件）一定要補掛已載入的章節：有閱讀進度時開書先還原位置，第一章在掛監聽前就載入完（v1.82.2 快速鍵、v1.80 觸控都踩過）。新增前先 grep 所有 `view.addEventListener('load'`。
- 設定面板新增設定時，要一併加進 `CWFM_THEME_FIELD_KEYS`，否則存不進「設定檔」。
- 標籤小按鈕、步進器等圖示一律用 `cwfmChipIcon()`（Lucide SVG、線寬 2），不要用文字符號。

## 交接（2026-10-29，v1.86.0）
- **目前版本**：v1.86.0（v1.85.0 之上依使用者回饋）。
  - **翻頁方向改成一般設定**：`pageDirection`＋新開關 `preferBookDirection`（優先套用書籍標示，預設開；開著且書有標示時選單停用、提示「依書籍標示」）。都進設定檔與 `CWFM_BUILTIN_PROFILE_KEYS`。開書前的值由 `cwfmEarlySetting()` 讀 INITIAL_SETTINGS（不能碰 DEFAULT_SETTINGS：TDZ），內建值在 `CWFM_EARLY_BUILTIN`；改了由 `applySettings` → `cwfmDirOnSettings` 重排。v1.84～85 記在 `bookSettings[書].b.pageDirection` 的照舊（＝不看書的標示）。
  - **內建「圖片書」**：右翻、反轉點擊區、上下左右留白 0（工具列蓋到圖片沒關係，使用者定案）。
  - **虛擬頁紙色**：`.cwfm-ib-paper` 用更具體的選擇器＋!important 蓋過閱讀配色的 `* { … !important }`；沒有統一紙色＝白紙黑字。
  - **扉頁方案甲**：`.cwfm-tp-grp` 整組（含出版社）中心在 44%（版心 1/9:2/9），沒有出版社時隱藏該行、位置不變；字級以 486px 紙寬為準（書名 60px）依 `--tp` 等比（`cwfmTpScale`），`CWFM_TP_CSS` 圖片書與文字書共用。
  - **面板**：「是否插頁」→「插頁設定」；補一頁與插入空白頁之間有分隔線；〔清除〕跳轉紀錄紅框；「新書開啟時套用」名稱一行、選單一行（只有兩項之間有分隔線）；自動隱藏工具列說明補觸控。
  - **滑桿不卡**：拖動中數字立刻更新、重排只排最新值且最多每 `CWFM_SLIDER_APPLY_MS`（觸控 250／滑鼠 120ms）一次，放開（change）才套用最終值並存檔。原本每格同步整本重排（桌機 WebKit 50～115ms／格）。
  - 不做：升級後保留舊全域字級（使用者自己逐本調整）。v1.85 的內容見 git log。
- **測試**：Docker repo `test/reader/ft184.py`、`ft185.py`、`ft186.py`（`CWFM_EPUB` 指定圖片書，預設 `/home/claude/testbook/manga30.epub`，新對話串要請使用者重新附檔）。
- **待使用者實機確認（iPad，Docker）**：動畫 E、圖片書兩欄／右翻、虛擬頁、文字書書名頁。
- **之後再議**：面板上顯示「這本書有自己的設定／還原」。
- **NAS 更新**：`bgtsai/synology-docker-update`（見知識庫 14 號第 11 節）。
- **知識庫**：未歸檔草稿 `_pending/20261029-1138_calibre-web-foliate-mod.md`。
