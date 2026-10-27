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

## 交接（2026-10-27，v1.81.1）
- **目前版本**：v1.81.1（mod 本次 commit；Docker 仍指向 v1.81.0 `ebb4bda`）。v1.80.7＝書籤對話框 Esc 只關最上層、匯出頁首「備註＋摘錄」兩邊計入；v1.80.8＝書籤列 hover 只亮指到的那塊（類型淡色）；v1.81.0＝設定面板「關於」分組；v1.81.1＝「關於」簡化（版本、發布日期、安裝方式、說明頁（GitHub）、TM 版檢查更新點下去才加時間戳記），字級對齊其他分組。
- **測試**：功能測試放在 Docker repo 的 `test/reader/`（見該資料夾 README）。環境要先 `npm install`（build/legacy）與 `playwright install webkit firefox`，沒裝齊會跑出 0 項而不報錯。已知失敗：`feat_test`「縮放後重算…標題固定」（v1.79 起）、Firefox「電腦首次預設 540×648」（此環境視窗尺寸差 12px，v1.80.6 也失敗）。
- **待使用者實機確認**：iPad 跨章節點擊翻頁、編輯書籤後自動回全螢幕、載入提示在黑底的可讀性、開啟速度、iPad 全螢幕時工具列左側讓出 64px 是否足夠、iPad 藍牙鍵盤按 Esc 只關對話框、白底上摘錄（琥珀）hover 淡色看不看得出來、Tampermonkey 版「關於」的內容與檢查更新。
- 經驗已歸檔進知識庫（03 ⑮、27 ⑰、29 ㉒、31 v1.12）；v1.80.8 的經驗在未歸檔草稿 `_pending/20261027-1627_calibre-web-foliate-mod.md`。
