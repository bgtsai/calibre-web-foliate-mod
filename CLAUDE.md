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

## 交接（2026-10-29，v1.84.0）
- **目前版本**：v1.84.0（原「下一階段待做」A～D 全部完成）。
  - A「上一步」存檔動畫改方案 E：箭頭放大 1.15 倍 0.3 秒＋數字位置換成「+1」（`.cwfm-nav-plus`，原地放大不飄，0.7 秒）；減少動態效果只淡入淡出。書籤鈕維持填滿動畫。
  - B 純圖片書多欄並排（`cwfmImg*`，app-ui.js「v1.84.0 翻頁方向＋純圖片書」段落）：bundle 的 `View.open` 開書前呼叫 `window.__cwfm.transformBook`；相鄰單張圖片頁合成分段章節（`cwfm-seg-<序>-<首頁>`，每段＝欄數倍數、約 12 頁），頁面用背景圖（`<img>` 會被引擎加「欄高−留白×2」的限制）。位置只在 `view.getCFI`（出：`epubcfi(原章節!/4)`）與 `book.resolveCFI／resolveHref`（入）換算，書籤／進度／跳轉都是原書座標。欄數、插頁改變 → `cwfmImgBuildSections()` 就地換 `book.sections`＋`view.cwfmRefreshSections()`＋`renderer.cwfmInvalidate()` 重排回同一頁。前兩頁同圖略過封面；圖片書不插換欄標記、不留頁間緩衝。
  - C 翻頁方向（左翻／右翻，`book.dir`）：右翻時文件 `<html dir=rtl>`＋`body{direction:rtl}`（根元素方向取自 body，只改 html 分欄照樣由左排起）＋`body>*{direction:ltr}`。反轉點擊區 `reverseTapZones`（點擊區與 ← → 一起對調）。快速鍵改名「往左／往右」。插頁：全書前面補一頁（顯示書名頁＋「開始閱讀」）、在這頁前插入／移除空白頁。翻頁方向與插頁存在 `settings.bookSettings[書號].b`，不進設定檔。
  - D 內建設定檔「文字書／圖片書」（只管排版欄位 `CWFM_BUILTIN_PROFILE_KEYS`，覆蓋值存 `settings.builtinProfiles`，可恢復預設值）；內建標籤（含配色）加 Lucide 圖示、沒有刪除／改名、與自訂之間有分隔線。設定跟著書：`cwfmApplyBookSettings`／`cwfmPrepareSettingsForSave`——這次開書後設定有變才記住這本書並更新「最後一次的設定」（文字書＝全域、圖片書＝`lastImageValues` 分開記）。
- **測試**：Docker repo `test/reader/ft184.py`（圖片書分段、原書座標、欄數變化、右翻、反轉、插頁、開始頁、記住設定、文字書不受影響、內建設定檔、動畫 E；`CWFM_EPUB` 指定圖片書，預設 `/home/claude/testbook/manga30.epub`，新對話串要請使用者重新附檔）；ft182、ft183 已同步更新。
- **待使用者實機確認（iPad，Docker）**：動畫 E 與書籤動畫觀感、圖片書兩欄／右翻、開始頁樣式。
- **這批沒做（之後再議）**：文字書兩欄從右頁開始時的開始頁（目前只有圖片書有插頁／開始頁）；每本書記住的設定要不要在面板上顯示「這本書有自己的設定／還原」。
- **NAS 更新**：`bgtsai/synology-docker-update`（見知識庫 14 號第 11 節）。
- **知識庫**：未歸檔草稿 `_pending/20261029-1138_calibre-web-foliate-mod.md`。
