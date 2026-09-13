# 交接文件：書籤/定位點精準對齊功能（實驗性）

最後更新對應版本：**v1.19.0**（calibre-web-foliate-mod.user.js）

## 一、目標（务必先確認這個框架，不要跳過）

書籤存的是「文字本身的位置」（第幾章、第幾個字），不是「畫面上第幾頁」。
「一頁能放多少字」取決於當下視窗尺寸——正常模式跟全螢幕模式尺寸不同，
同一份內容重新排版後，分頁位置會跟著變。

**具體目標：** 切換視窗尺寸（正常 ↔ 全螢幕，或任何尺寸改變）時，即時算出
「需要在定位點文字前面塞多少暫時性的空白內容」，讓切換過去之後，新尺寸下
畫面顯示的第一個字，跟切換前畫面顯示的第一個字，是同一個字。這個計算
**每次尺寸改變都要重新做一次**，不限方向（正常→全螢幕、全螢幕→正常都一樣），
且**完全不能動到排版系統本身**，只能透過「暫時插入一段內容」讓既有、
完全沒改過的排版邏輯自然算出正確結果。

## 二、已查證、確定為真的事實

1. **書籤記錄本身沒有問題**：存的是一個 CFI *範圍*（從當頁第一個看得到的字，
   到最後一個看得到的字），還原時抓的是這個範圍最前面那個點（查證
   `foliate-js/view.js` 的 `#onRelocate` → `getCFI(index, range)` →
   `CFI.fromRange(range)`；還原端 `#scrollToAnchor` 用
   `uncollapse(anchor).getClientRects()` 取第一個非零大小的 rect）。
   **記錄的字元本身沒有記錯。**

2. **舊有機制的限制（這是本來就有、不是新 bug）**：還原邏輯是「找到裝著
   目標字元的那一頁 → 跳到那一頁的開頭」。如果排版尺寸沒變，那一頁的開頭
   剛好就是目標字元；如果尺寸變了（例如切全螢幕），目標字元很可能已經
   不是任何一頁的開頭，會被夾在某一頁中間，而「跳到那一頁開頭」只會跳到
   新分頁下的頁首，不是目標字元本身。**這正是本次功能要解決的根本問題。**

3. **本書寫作方向**：使用者已澄清是「一列列由上而下、列內由左而右」的
   普通橫式書寫（不是傳統中文直式），排除了先前誤判的「vertical 分支」
   假說。

## 三、已經嘗試過、確認失敗/有問題的方向

### 方向 A（目前 v1.19.0 現狀，**已確認方向錯誤，準備放棄**）
直接修改 `foliate-js/paginator.js` 的 `columnize()`，在共用的排版留白
（padding）計算裡加一個 `anchorOffsetPx` 平移量，對齊完後再捲動過去。

**已知問題（按時間序，每個都有實際 log/截圖佐證，不是猜測）：**
1. 造成同步無窮遞迴（render → onExpand → #scrollToAnchor → 又觸發對齊）
   → 已用重入鎖 `#aligningAnchor` 擋住。
2. 重入鎖擋下時漏掉 `return`，導致每次對齊過程仍會真的多次捲動畫面（用
   中途、還沒算完的座標）→ 已修正加上 `return`。
3. **核心問題，導致放棄這個方向**：`columnize()` 是排版系統本身、每次
   正常翻頁都會用到的共用函式，不是獨立於書籤還原之外的東西。這次的
   `anchorOffsetPx` 直接改動這個共用函式的留白設定，一旦算出不合理的值，
   受影響的不只是書籤還原那一頁，是整個排版系統（`expand()` 會把
   `documentElement` 寬度鎖死成一頁寬，`columnize()` 沒有重設寬度，
   留白疊加在被鎖死的寬度上）都可能跟著壞掉。實測畫面出現「同一欄裡
   上面一段文字、中間空白、下面又冒出另一段文字」的破碎版面（見使用者
   上傳的截圖，多次重現）。

   **使用者原話總結這個問題：**「理論上你都已經界定排版，不是 CSS
   確定這個頁面裡面哪邊要跑出資料。其實應該分兩部分：1. 要跑出來的資料
   是什麼 2. 這個資料要顯示在頁面的哪個地方」——目前的做法混淆了這兩件事，
   直接動了「資料要顯示在哪裡」的排版系統本身。

### 已加入、但只在方向 A 下有意義、方向 B 應該可以整個移除的東西
- `#aligningAnchor` 重入鎖 + 延遲解鎖（`#unlockTimer`, `CWFM_UNLOCK_DELAY_MS`）
- `anchorOffsetPx`（View 類別公開欄位）
- `cwfmAlignAnchor` 開關（Paginator 類別公開欄位）
- `#blockedReentryCount` 診斷計數器
- app-ui.js 的 `cwfmExperimentalAnchorAlignSession`（session-only、故意
  不存進 GM 儲存的開關變數，這個設計本身是對的，**方向 B 應該沿用**）
- 兩個 `#scrollToRect` 呼叫點、`resize` 防抖動的診斷 log（`[cwfm:resize]`,
  `[cwfm:align]`, `[cwfm:scroll]`）
- **v1.19.0 新增的全節點診斷 log（`[cwfm:node]`，共 16 處）**：涵蓋
  `View.render()`、`columnize()`、`expand()`、`attributeChangedCallback`、
  `#beforeRender()`、`Paginator.render()`、`#scrollToRect`、`#scrollTo`、
  `#scrollToPage`、`#scrollToAnchor`，以及 app-ui.js 的
  `applyHorizontalPadding`/`applyVerticalPadding`。**這批 log 這次沒有
  直接抓到破碎版面當下的畫面狀態（因為使用者是事後才重現破碎版面，
  當時的 log 只涵蓋了正常運作的部分），但架構具參考價值，方向 B 若也
  需要診斷，可以考慮沿用同樣的 log 風格。**

### 另一個查過的細節（不確定是否為真正成因，未驗證，方向 B 下可能不再相關）
`expand()` 會用 `Math.floor(offset/this.size) + (rtl?-1:1)` 決定捲動頁碼，
`this.pages` 比正文頁數多 2（推測是前後各一頁空白墊片頁，用於 scroll-snap）。
推演後認為這個「+1」與墊片頁邏輯自洽，不是 bug，但**這個推演沒有透過實際
瀏覽器測試驗證過**，方向 B 如果不需要理解這段，可以不用深究。

## 四、下一步設計方向（方向 B，尚未開始實作）

**核心原則：完全不修改 `foliate-js/paginator.js` 排版系統本身**
（`columnize`、`expand`、`#beforeRender`、`#scrollToRect` 等全部維持
未修改的原始版本）。

**做法：** 在真正排版之前，於定位點文字前方插入一段「暫時性、不可見但
佔真實排版空間」的填充內容，跟書本原有文字一起交給引擎排版。引擎看到的
是一份「多了一小塊空白內容」的普通內容，用完全沒改過的排版邏輯去排，
定位點自然會被推到某一頁的開頭。

**需要確認/設計的細節（部分已與使用者確認，部分還沒）：**
1. ✅ 填充內容必須是暫時性的（使用者已確認：「這個資料一定是暫時性的」）。
   需求：算出定位點後，用完就要能乾淨移除，不能留著影響之後的正常翻頁
   （尤其是往回翻到定位點之前的內容時，不能翻到填充內容）。
2. ✅ 填充量必須每次尺寸改變都重新計算，不是綁定「全螢幕」或「正常模式」
   其中一種固定情境（使用者一開始以為是綁定情境，已在對話中釐清並非如此，
   使用者最後也認同這個框架）。
3. ❓ 尚未設計：填充內容具體要插在 DOM 的哪裡、用什麼元素/寫法讓它「不可見
   但佔真實空間」、且不會被引擎的內容解析/CFI 定位邏輯誤認成正文的一部分
   （避免書籤 CFI 因為填充內容的存在而跑位）。
4. ❓ 尚未設計：怎麼算出「需要塞多大的填充內容」——概念上跟舊方向 A 的
   `remainder`/`offset` 算法類似（量出定位點在完全沒有填充時的自然位置，
   算出離頁面邊界差多少），但這次算出來的差值，要轉換成「插入內容的量」
   （例如插入多少個空白字元、或一個固定高度的空 `<div>`），而不是轉換成
   CSS padding 數值。這個換算，尤其是「用什麼單位量測填充內容大小最準」
   （字元數？像素高度的空白區塊？），還沒有討論過，需要在新對話串從頭
   設計。
5. ❓ 尚未確認：填充內容插入/移除的時機，要掛在哪個生命週期節點上（例如
   `goTo(cfi)` 呼叫前先插入、拿到正確頁碼後在下一個 tick 移除？還是有
   更適合的掛勾點？）。

## 五、環境與檔案位置

- 主 repo：`bgtsai/calibre-web-foliate-mod`
  - 組合後單一檔案：`calibre-web-foliate-mod.user.js`（BUNDLE_SOURCE 常數
    內嵌整個 foliate-js 打包後的 bundle；APP_SCRIPT_TEMPLATE 常數內嵌
    `src/app-ui.js` 的內容）
  - `src/app-ui.js`：應用邏輯原始碼
- 本地開發路徑（沙盒環境，重開對話會消失，新對話需要重新從 repo 拉取）：
  - `/home/claude/foliate-js/`：foliate-js 原始碼（`git clone` 下來的），
    `paginator.js` 目前有大量方向 A 的修改（見上方 diff stat），**新對話
    若要走方向 B，建議先 `git checkout -- paginator.js` 清乾淨，只保留
    `#aligningAnchor` 相關的診斷框架看要不要留（大概率不需要）**
  - `/home/claude/app-ui-full.js`：`src/app-ui.js` 的本地副本
  - `/home/claude/calibre-web-foliate-mod.user.js`：組合後的完整檔案
  - `foliate-js/rollup.bundle.config.js`：重新打包 bundle 用的設定
  - GitHub Token：不要把 token 明碼存進這份文件（會被 GitHub 密鑰掃描擋下，
    親身經歷過一次）。Token 已經存在這個 Claude Project 的專案檔案裡
    （檔名類似 `bgtsai_GitHub_token_all-repos.txt`），新對話串直接從專案
    檔案讀取即可。

## 六、重新組裝/推送的固定流程（避免重蹈覆轍）

過程中發生過兩次因為字串邊界抓錯導致檔案損毀的事故，**組裝 BUNDLE_SOURCE
/ APP_SCRIPT_TEMPLATE 這兩個常數時，一律用逐字元掃描、正確處理跳脫字元的
方式找字串結尾，不要用固定字串（如 `";`）去猜結尾位置**：

```python
def find_string_literal_end(content, start_idx):
    assert content[start_idx] == '"'
    i = start_idx + 1
    escaped = False
    while True:
        ch = content[i]
        if escaped: escaped = False
        elif ch == '\\': escaped = True
        elif ch == '"': break
        i += 1
    return i + 1  # 含結尾引號
```

每次替換後，一定要做完整驗證再推送：
1. `node --check paginator.js`（引擎原始碼語法）
2. 組裝後對 `calibre-web-foliate-mod.user.js` 整體做 `acorn.parse`
3. 額外抽取 `buildCombinedScriptSource(...)` 實際執行結果再 parse 一次
   （確保 BUNDLE_SOURCE / APP_SCRIPT_TEMPLATE 兩個字串本身也是合法內容）
4. 用關鍵字 grep 確認新增/應保留的功能字串都還在（例如 `srcdoc`、
   `cwfmAlignAnchor` 等）

## 七、使用者的工作習慣與期待（給新對話串參考）

- **任何動到程式碼的動作，一律先提出方案、講清楚邏輯/風險/遺漏，等使用者
  明確同意（"可以動手"之類的明確授權）才實際修改檔案，更不能未經同意就
  推送到 GitHub。** 這條規則在本次對話中被違反過兩次，使用者都直接點名
  糾正，務必記取。
- 使用者會要求「檢查你的方案：邏輯對不對、有沒有風險、有沒有遺漏，如果
  中途發現問題就停下來討論」——這個檢查流程要認真做，不要走過場，本次
  對話中認真做這個檢查時，確實多次抓到自己方案裡的實質問題（不是形式
  上補一句「風險很低」而已）。
- 使用者非常重視「先查證、再回答」，不接受「應該是」「可能是」這種
  沒有實際查過程式碼或記錄就給的答案；如果不確定，要老實說不確定，
  並提出打算怎麼查證，而不是用推演硬給結論。
- 每次程式修改都要做語法檢查跟邏輯核對，不能只做表面的 grep 確認。
- 使用者能看得懂技術細節，也會自己去追程式碼邏輯、提出質疑，不是只能
  被動接受回報——回報時要給實際的技術理由/證據，不要用模糊的話帶過去。
