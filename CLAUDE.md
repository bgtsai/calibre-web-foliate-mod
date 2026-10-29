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

## 交接（2026-10-29，v1.85.0）
- **目前版本**：v1.85.0（v1.84.0 的圖片書／翻頁方向／插頁／內建設定檔之上，依使用者回饋調整）。v1.84.0 內容見 git log 與知識庫草稿。
  - **新書開啟時套用**（設定檔分組裡常駐的小區塊）：`settings.newBookProfile.{text,image}` ＝ `'builtin:text'`／`'builtin:image'`／`'theme:<id>'`；沒調整過的書（沒有 `bookSettings[書號]`）依類型套用；內建只管排版欄位、自訂設定檔套全部；指定的設定檔刪掉 → 退回內建。舊版開過的書一律當新書（使用者定案，不建「升級前的設定」）。v1.84.0 的 `lastImageValues` 不再使用。內建與自訂混在同一排（不再有分隔線）。
  - **內建「圖片書」**：文字書預設為底，留白優先、左右 0、上下＝工具列高度 48（工具列預設常駐，0 會蓋掉圖片）、欄間距 0，欄數依可用區域長寬比（寬 ≥ 高 → 2 欄，`cwfmImageDefaultCols`）。點擊區照常顯示（蓋到也照蓋，使用者自己關）。
  - **虛擬頁**（開始頁、插入的空白頁）：一張跟後面那頁畫出來一樣大的紙（`.cwfm-ib-paper`，ResizeObserver 依圖片長寬比算），貼書脊、細框，內容是古典扉頁（上下「線＋◆＋線」夾書名與「作者　著」，最下緣有出版社才放；不放「開始閱讀」按鈕，像按鈕會誤會）；紙色＝內頁抽樣的眾數（`cwfmImgPaperColor`，邊緣雜的頁不投票），存在 `bookSettings[書號].b.paperColor`。
  - **文字書插頁**：全書前面補一頁（書名頁）、在這頁前插入空白頁都能用：章節載入時插 `<cwfm-ins>`（CFI 過濾器略過），插入點存原書 CFI（`textInserts`）。
  - **面板**：「閱讀行為」改名「閱讀紀錄」；翻頁精準定位移到「翻頁設定」；翻頁設定分小標題「翻頁方式」（方向、反轉、精準定位）／「左右點擊區」（啟用、寬度、顯示、翻頁動畫）。
- **測試**：Docker repo `test/reader/ft184.py`、`ft185.py`（`CWFM_EPUB` 指定圖片書，預設 `/home/claude/testbook/manga30.epub`，新對話串要請使用者重新附檔）。
- **待使用者實機確認（iPad，Docker）**：動畫 E、圖片書兩欄／右翻、虛擬頁、文字書書名頁。
- **之後再議**：面板上顯示「這本書有自己的設定／還原」。
- **NAS 更新**：`bgtsai/synology-docker-update`（見知識庫 14 號第 11 節）。
- **知識庫**：未歸檔草稿 `_pending/20261029-1138_calibre-web-foliate-mod.md`。
