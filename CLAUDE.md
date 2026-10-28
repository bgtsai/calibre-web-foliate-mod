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

## 交接（2026-10-28，v1.82.2）
- **目前版本**：v1.82.2，Docker 已指向（`CWFM_MOD_REF` = 37e4a6a）。
  - v1.82.0：「佈景主題」改名「設定檔」（Profile），存面板上除了語言、錯誤紀錄以外的全部設定；套用後面板控制項全部重讀（`window.__cwfm.refreshSettingsPanel`）；分組為 版面配置 → 翻頁設定 → 介面隱藏 → 閱讀行為 → 快速鍵 → 語言 → 錯誤紀錄。Docker 錯誤面板加〔忽略〕。
  - v1.82.1：標籤上的改名／覆蓋更新／刪除、上傳徽章、步進器 − ＋ 全改 Lucide SVG，垂直置中。
  - v1.82.2：快速鍵與滾輪補掛到已載入章節（`cwfmAttachDocInput()`）；焦點在進度條上時快速鍵照常、擋掉原生推滑桿。
- **測試**（Docker repo `test/reader/`，見該資料夾 README）：v1.82 起新增 `ft182.py`（設定檔／分組／忽略）、`ft_icons.py`（圖示置中，±0.5px）、`ft_keys.py`（16 種情境的快速鍵，測試書要有閱讀進度）。流程：改 src → `pack.py` → `build.sh`（pack 沒過會靜默沿用舊 dr.js，要看到「OK →」）→ 三瀏覽器跑。2026-10-28 起三瀏覽器全數通過（原本兩項已知失敗是測試過時／無頭 Firefox 的 screen 不跟視窗走，已修測試）。
- **待使用者實機確認（iPad）**：v1.82.2 快速鍵（開書後直接按、手指點內文後按、拖過進度條後按）；v1.82.1 圖示樣子；設定檔套用後面板更新；錯誤面板〔忽略〕。另有 v1.81 以前留下的：跨章節點擊翻頁、編輯書籤後自動回全螢幕、載入提示在黑底的可讀性、全螢幕工具列讓出 64px 是否足夠、藍牙鍵盤 Esc 只關對話框、白底上摘錄 hover 淡色、TM 版「關於」。
- **沒有進行中的功能**；下一步等使用者提出。
- **NAS 更新**：`bgtsai/synology-docker-update`。排程指令已改成帶 `FRESH=$OK`（見知識庫 14 號第 11 節），DSM 7 通知改用 `DSMSupportFormCustomMessage／CustomFailure`；三則階段通知在整支腳本實際跑時是否都出現，使用者尚未回報。
- **知識庫**：本階段經驗已歸檔（03 ⑯、14 v1.7～v1.9、29 ㉔、30 ⑳、31 v1.16），沒有未歸檔草稿。尚待處理（屬於 01，要先歸因、經使用者同意）：結之後分數沒歸零／算錯（③ 的執行問題）；「回答前先確認使用者真正要解決哪個症狀」。
