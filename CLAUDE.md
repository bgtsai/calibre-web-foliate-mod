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
- **知識庫**：v1.84～v1.86 已歸檔（03 v1.46 第 ⑰ 節、29 v1.11 第 ㉕～㉗ 節、31 v1.18），沒有未歸檔草稿。

## 下一階段待做（2026-10-29 晚，使用者已全部定案：照做到完，卡住或發現會改變預期才問）
一個版本一起做（**v1.87.0**），全部改完、三瀏覽器測過後 **Tampermonkey 與 Docker 同時推送**。測試要用純圖片 EPUB：**新對話串請使用者重新附檔**（日本兄弟修剪版，放到 `/home/claude/testbook/manga30.epub`）。

**設定檔改成「目前使用中的那一組，調整自動存回」**（類似瀏覽器使用者設定檔）
1. **自動儲存**：選中的設定檔，面板上任何調整直接存回該設定檔；標籤上的磁碟（覆蓋更新）鈕全部拿掉（內建與自訂都拿）。`cwfmUpdateTheme`／內建的 `onUpdate`、`onRestore`（恢復預設值）、`builtinProfiles` 相關 UI 一併移除。
2. **內建「文字書／圖片書」唯讀、內容完整**：不再只管排版（`CWFM_BUILTIN_PROFILE_KEYS`），改成跟自訂一樣存全部 `CWFM_THEME_FIELD_KEYS`——排版用現在的內建值，其他欄位用程式初始預設（DEFAULT_SETTINGS／`CWFM_EARLY_BUILTIN`）。選中內建時第一次調整 → 自動複製成自訂設定檔「圖片書（已調整）」（同名依序「（已調整 2）」…）並切過去，之後調整都存進這份。**舊的 `settings.builtinProfiles` 覆蓋值直接丟掉**（使用者定案），回到程式預設。
3. **每本書記住「用哪個設定檔」**（取代 v1.84～86 的「每本書一份設定值」）：`bookSettings[書].profile = 'builtin:text'|'builtin:image'|'theme:<id>'`；同一個設定檔的書共用調整（使用者定案）；某本書要特殊設定就自己另建設定檔。書本身的屬性（`b`：插頁、紙色、舊版方向）照舊。新書（沒有紀錄）用「新書開啟時套用」。被指定的設定檔刪掉 → 退回新書預設。舊資料相容：v1.84～86 的 `bookSettings[書].v` 怎麼轉要先想清楚再做（建議：有 v 的書第一次開時，若 v 跟某個設定檔完全相同就指向它，否則轉成一個自訂設定檔「〈書名〉」並指向它——**這點未跟使用者確認，做之前先問**）。
4. **還原這次調整**：每次打開設定面板記下目前設定檔的值當起點（面板開著時切換設定檔 → 起點改成切換當下）。跟起點不同時顯示〔還原〕；按下回到起點並存回、按鈕消失；關面板後就沒有，下次打開重記。若目前的設定檔是本次從內建自動建立的「（已調整）」，還原＝切回該內建並刪掉這份副本。
5. **設定檔納入的範圍（最大程度包含）**：除了現有欄位，另納入介面狀態（`groupCollapsedState`、`colorPickerModeByKey`、`tocFilter`）。**素材庫共用、不跟設定檔切換**（使用者選「合併」）：`savedColorSchemes`、`fontNameHistory`、`uploadedFonts`。**只留在這台裝置**：`uiLanguage`、`errlogUpload`。存在外層（不能放進設定檔，會遞迴）：`savedThemes` 本身、`newBookProfile`。
6. **標出目前使用中的設定檔**：選中樣式（跟配色選中同一套藍框 `.cwfm-keychip-selected`）。
7. **標籤前置圖示 14px**（現在 12px 看不清楚；設定檔與配色的內建標籤都改，`cwfmBuildChip` 的 `leadIcon` 與配色那段 `cwfmChipIcon(..., 12)`）。改完跑 ft_icons（±0.5px）、確認標籤高度沒被撐高。
8. **還原放兩處**（使用者定案：兩個都做）：(a) 設定檔區塊、標籤列**下方**一行淡橘狀態列：「我的小說：這次有調整（已自動儲存）」〔還原〕／從內建建立時「已從圖片書建立『圖片書（已調整）』」〔還原〕；選中標籤名稱後加橘點。(b) 面板標題列、關閉鈕左邊〔還原這次調整〕（面板捲到哪都按得到）。沒有調整時兩個都不顯示。方案圖：上一對話串【59_圖】的 ② 與 ④（橘色沿用注意類顏色，表示有變動、可處理，不是錯誤）。
9. **內建「圖片書」的翻頁動畫顏色預設黑色**（`pageFlipAnimColor: '#000000'`，不用 AUTO）。圖片書預設顯示點擊區視覺提示，動畫要使用者關掉提示才看得到——使用者確認沒關係。

**測試**：新增 ft187（自動儲存、內建唯讀→自動建立「（已調整）」與編號、書指向設定檔且共用、還原（含刪副本）、介面狀態跟著設定檔、素材庫共用、語言不跟、選中樣式、標題列與區塊兩處還原、圖示 14px、圖片書動畫黑色）；ft182／ft184～186 裡「覆蓋更新」「恢復預設值」「每本書一份設定值」相關的斷言要跟著改。
