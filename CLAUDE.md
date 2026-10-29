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

## 交接（2026-10-29 晚，v1.87.1）
- **v1.87.1**：文字書在段落中間插空白頁，CFI 偏移落在文字節點切口時解析成「前半段結尾」（空白頁前一頁底部），Firefox 跳頁／重開停在前一頁（v1.86 就有）。`cwfmTransformBook` 包 `bk.resolveCFI`，切口位置改到空白頁後面（`cwfmSkipInsertAtCut`）。ft185 加「重開回到插入點那頁」。
- **v1.87.0**：設定檔改成「目前使用中的那一組，調整自動存回」（類似瀏覽器使用者設定檔）。
  - **自動儲存**：`cwfmPrepareSettingsForSave` 跟 `cwfmBookTrack.baseline` 比對，有差就寫回 `cwfmBookTrack.ref` 指的設定檔。磁碟（覆蓋更新）鈕、內建的恢復預設值都拿掉。
  - **內建唯讀、內容完整**：`cwfmBuiltinProfileValues(id)` 每次重算全部 `CWFM_THEME_FIELD_KEYS`（DEFAULT_SETTINGS＋首次預設＋跟隨系統配色＋內建排版；圖片書另加 `CWFM_IMAGE_PROFILE_OVERRIDES`，含動畫黑色 `#000000`）。選中內建時第一次調整 → 自動建「〈內建名〉（已調整）」（重名「（已調整 2）」…）並切過去。`settings.builtinProfiles` 開書與存檔時刪掉。
  - **書指向設定檔**：`bookSettings[書] = { profile, b, t }`，同一個設定檔的書共用調整；舊的 `v` 直接丟掉（使用者定案，這些書回到「新書開啟時套用」）。指向的設定檔被刪 → 退回新書預設；刪的是使用中的 → 當場切到新書預設（`cwfmDeleteTheme`）。
  - **v1.84～85 記在書上的方向**（`b.pageDirection`）：不再寫進設定值（會污染共用的設定檔），只在 `cwfmDirOnSettings`／開書時優先；使用者在面板改翻頁方向就清掉。
  - **還原這次調整**：`openPanel` 打開設定面板 → `cwfmProfMarkStart` 記起點；面板開著時切換設定檔 → 起點改成切換當下；關面板清掉。有調整時兩處顯示：設定檔區塊標籤列下方淡橘狀態列〔還原〕＋選中標籤橘點、標題列關閉鈕左邊〔還原這次調整〕。從內建自動建立的副本 → 還原＝切回內建並刪副本（`cwfmRestoreProfileSession`）。
  - **介面狀態不納入設定檔**（使用者定案）：分組收合、取色器模式、目錄篩選維持全域；素材庫（自訂配色、字型記憶、上傳字型）共用；語言、錯誤紀錄只留在這台裝置。
  - **標籤前置圖示 14px**（設定檔與配色的內建標籤）；選中＝`.cwfm-keychip-selected` 藍框。
- **測試**：Docker repo `test/reader/ft187.py`（新）；ft182、ft184、ft186 已改成新語意。圖片書改用 `test/reader/make_image_epub.py` 現場產生（ft184～187 預設，`CWFM_EPUB` 仍可指定真書）。
- **待使用者實機確認（iPad，Docker）**：動畫 E、圖片書兩欄／右翻、虛擬頁、文字書書名頁（v1.86 留下）；v1.87 的自動存回與還原。
- **之後再議**：面板上顯示「這本書有自己的設定／還原」（v1.87 已有「這次調整」的還原，跨開書的還原仍未做）。
- **NAS 更新**：`bgtsai/synology-docker-update`（見知識庫 14 號第 11 節）。
- **知識庫**：v1.87.0 的經驗在草稿檔，待歸檔；handoff 分支的 `handoff/20261029_cwfm/` 去留待使用者決定。
