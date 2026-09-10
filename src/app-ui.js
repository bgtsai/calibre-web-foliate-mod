;(async () => {
    const VIEWER_SELECTOR = '__VIEWER_SELECTOR__';
    const BOOK_ID = '__BOOK_ID__';
    const STORAGE_KEY = 'cwfm-settings';
    const POSITION_KEY = 'cwfm-position-' + BOOK_ID;

    // [cwfm] 儲存機制改用 Tampermonkey 的 GM_setValue/GM_getValue，不再用
    // localStorage（理由：GM 儲存跟著腳本走、方便備份與跨電腦同步，不像
    // localStorage 綁在網站網域上、容易被清瀏覽器資料時一併清掉）。
    //
    // 下面這兩個常數是外層有 @grant 的腳本，在插入這段程式碼「之前」就先
    // 用 GM_getValue 讀好、直接把值嵌進來的（外層程式碼會找到對應的宣告
    // 那一行整個替換掉，取代後這裡看到的就已經是真正的 JS 值，不是字串，
    // 不用再 JSON.parse 一次）。因為 GM_setValue/GM_getValue 只有外層有
    // 特權的腳本能呼叫，這段頁面環境的程式碼沒辦法直接呼叫，讀取用這種
    // 「先嵌好」的方式繞過去；寫入則用 gmSet() 發自訂事件，外層腳本監聽
    // 到才真的呼叫 GM_setValue（fire-and-forget，不需要同步等回應）。
    //
    // 注意：下面兩行宣告本身的確切文字（含等號、分號），外層腳本的
    // buildCombinedScriptSource() 會拿去精確比對取代，這份註解故意不要
    // 再重複打出跟宣告一模一樣的引號字串——先前這裡的說明文字曾經寫了
    // 一模一樣的字串，結果 replace() 找到的是「這段註解」而不是「真正
    // 的宣告」，替換整個失效，設定值/閱讀進度永遠讀不到剛存過的內容，
    // 是實測抓到的真實 bug，不是假設性的風險。
    const INITIAL_SETTINGS = "__INITIAL_SETTINGS__";
    const INITIAL_POSITION = "__INITIAL_POSITION__";

    function gmSet(key, value) {
        document.dispatchEvent(new CustomEvent('cwfm:gm-set', { detail: { key, value } }));
    }

    const viewerContainer = document.querySelector(VIEWER_SELECTOR);
    if (!viewerContainer) {
        console.error('[cwfm] 找不到 #viewer 容器');
        return;
    }

    // [cwfm] 這段一定要搶在 view.open() 之前執行，理由見上方說明。
    //
    // 做法：不維護「要隱藏哪些舊元件」的清單（那種做法本質上就是會漏東西——
    // 例如 #divider 這個 Calibre-Web 原本的分隔線元件，就是因為當初沒被
    // 手動列進清單裡才被漏掉，实测才發現）。改成反過來：#main 底下除了我們
    // 自己的 #viewer，其餘全部隱藏，不用管裡面實際上有什麼、叫什麼名字，
    // 徹底接管，之後也不會再有「又漏了一個」的狀況。
    function hideOldUI() {
        const style = document.createElement('style');
        style.textContent = [
            // Calibre-Web 原本的 main.css 把 #viewer 同時卡死在父層寬度與
            // 高度的 80%（width: 80%; height: 80%; margin: 0 auto;）。
            // 高度那條在更早之前的版本就修過了；寬度那條當時完全沒注意到，
            // 這次實測「左右留白調整完全沒反映在畫面上」才發現——不是
            // gap/max-inline-size 算錯，是 #viewer 本身寬度只有可用空間的
            // 80%，兩側各留 10% 完全在我們排版系統管轄外的死空間，
            // 不管怎麼調我們自己的設定都調不到它。這裡兩個維度一次覆蓋。
            // 現在有上下兩條固定工具列（新增了上方工具列），各佔約 44px，
            // 要一併從可用高度扣掉，不能只扣原本那一條。
            '#viewer { width: 100% !important; height: calc(100% - 88px) !important; margin: 0 !important; }',
        ].join('\n');
        document.head.appendChild(style);

        const main = document.querySelector('#main');
        if (main) {
            [...main.children].forEach((el) => {
                if (el.id !== 'viewer') {
                    el.style.setProperty('display', 'none', 'important');
                }
            });
        }
    }
    try { hideOldUI(); } catch (e) { console.error('[cwfm:hideOldUI]', e); }

    await customElements.whenDefined('foliate-view');

    const view = document.createElement('foliate-view');
    view.dataset.cwfmOwned = 'true';
    view.style.display = 'block';
    view.style.width = '100%';
    view.style.height = '100%';

    viewerContainer.innerHTML = '';
    viewerContainer.appendChild(view);

    // [cwfm] 進度相關的三個獨立功能共用的 key 產生方式，比照原版
    // reading/epub.js 的命名慣例："calibre.reader.position." + book.key()，
    // 我們換成自己的前綴、用 BOOK_ID 當識別碼（同一支腳本、同一本書，
    // 各自獨立記憶，不會互相覆蓋）。實際的 key 常數在檔案開頭已經宣告
    // 為 POSITION_KEY，這裡不重複宣告。

    function getCsrfToken() {
        const el = document.querySelector('input[name="csrf_token"]');
        return el ? el.value : '';
    }

    function wrapCfi(cfi) {
        if (!cfi) return null;
        return cfi.startsWith('epubcfi(') ? cfi : 'epubcfi(' + cfi + ')';
    }

    // 功能二：手動同步到伺服器（對應原版按書籤圖示的動作，同時只會有一個
    // 書籤，新的會覆蓋舊的——這點跟原版行為一致，不是我們自己發明的）。
    function postBookmarkValue(rawValue) {
        return fetch('/ajax/bookmark/' + BOOK_ID + '/epub', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': getCsrfToken(),
            },
            body: 'bookmark=' + encodeURIComponent(rawValue),
        }).then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
        });
    }

    function syncBookmarkToServer(cfi) {
        const wrapped = wrapCfi(cfi);
        if (!wrapped) return Promise.reject(new Error('沒有目前位置可以同步'));
        return postBookmarkValue(wrapped).then(() => {
            console.log('[cwfm:bookmark] 已同步到伺服器：', wrapped);
        });
    }

    // [cwfm] 移除伺服器書籤：查證原版 reading/epub.js 原始碼後確認，
    // updateBookmark(action, location) 這個函式，"add" 跟 "remove" 兩種
    // 動作都是走同一支 $.ajax POST，差別只在傳入的 bookmark 值——
    // "remove" 對應的 location 會是空值，程式碼寫的是
    // `data: { bookmark: location || "" }`，代表移除書籤的做法，就是對
    // 同一個端點送出空字串。這裡照同樣的方式實作。
    function removeServerBookmark() {
        return postBookmarkValue('').then(() => {
            console.log('[cwfm:bookmark] 已從伺服器移除書籤');
        });
    }

    let book;
    try {
        const res = await fetch('/show/' + BOOK_ID + '/epub/file.epub', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('下載 epub 失敗：HTTP ' + res.status);
        const blob = await res.blob();
        const file = new File([blob], BOOK_ID + '.epub', { type: 'application/epub+zip' });

        await view.open(file);
        book = view.book;

        // [cwfm] 進度還原優先順序：本機記錄優先（功能一存的，翻頁就即時
        // 記，通常比較新），本機沒有才看伺服器書籤（Calibre-Web 原本開書
        // 時會自動把上次位置放在網址列的 #epubcfi(...) 片段裡）。
        // 本機記錄要不要拿來用，要看使用者有沒有開啟功能一的開關；這裡
        // 讀的是外層腳本已經先嵌好的 INITIAL_SETTINGS/INITIAL_POSITION，
        // 不等 buildSettingsPanel 建好設定物件（那時已經太晚，開書一開始
        // 就要決定要不要還原位置）。
        let restored = false;
        try {
            const localRememberEnabled = INITIAL_SETTINGS ? INITIAL_SETTINGS.localAutoRemember !== false : true;
            if (localRememberEnabled && INITIAL_POSITION && INITIAL_POSITION.cfi) {
                await view.goTo(INITIAL_POSITION.cfi);
                restored = true;
                console.log('[cwfm:bookmark] 已還原本機記憶的閱讀位置：', INITIAL_POSITION.cfi);
            }
        } catch (e) {
            console.error('[cwfm:bookmark] 還原本機記憶位置失敗', e);
        }

        if (!restored) {
            const hash = location.hash;
            if (hash && hash.startsWith('#epubcfi(')) {
                try {
                    await view.goTo(decodeURIComponent(hash.slice(1)));
                    restored = true;
                    console.log('[cwfm:bookmark] 已還原伺服器書籤位置：', hash);
                } catch (e) {
                    console.error('[cwfm:bookmark] 還原伺服器書籤位置失敗，改從頭開始', e);
                }
            }
        }

        if (!restored) view.renderer.next();
    } catch (e) {
        console.error('[cwfm] 開啟書籍失敗：', e);
        viewerContainer.innerHTML = '';
        viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）書籍載入失敗，詳見主控台錯誤訊息。';
        return;
    }

    // ============================================================
    // 功能一：本機自動記憶（每次翻頁即時存，比照原版 reading/epub.js 用
    // "calibre.reader.position." + book.key() 的做法，換成我們自己的 key
    // 命名，改存進 GM 儲存）。開關讀 window.__cwfm.settings，但這個監聽器
    // 在設定選單建立之前就已經掛上，所以每次觸發時才即時讀目前設定值，
    // 不是掛上當下的快照。
    // ============================================================
    view.addEventListener('relocate', (e) => {
        const settings = window.__cwfm.settings;
        const enabled = settings ? settings.localAutoRemember : true; // 設定選單還沒建立好之前預設開啟
        if (!enabled) return;
        const cfi = e.detail?.cfi;
        const fraction = e.detail?.fraction;
        if (!cfi) return;
        try {
            gmSet(POSITION_KEY, { cfi, fraction });
        } catch (err) {
            console.error('[cwfm:bookmark] 本機記憶寫入失敗', err);
        }
    });

    // ============================================================
    // 功能三：停留超過 N 秒自動同步到伺服器。同一個位置（relocate 之後）
    // 沒有再變動、經過設定的秒數，才觸發同步；一旦位置又變了，計時器
    // 重新開始算，避免快速翻頁時每一頁都送出請求。
    // ============================================================
    let autoSyncTimer = null;
    view.addEventListener('relocate', (e) => {
        const settings = window.__cwfm.settings;
        clearTimeout(autoSyncTimer);
        if (!settings || !settings.autoSyncEnabled) return;
        const cfi = e.detail?.cfi;
        if (!cfi) return;
        const delayMs = Math.max(1, settings.autoSyncDelaySeconds || 5) * 1000;
        autoSyncTimer = setTimeout(() => {
            syncBookmarkToServer(cfi).catch((err) =>
                console.error('[cwfm:bookmark] 停留自動同步失敗', err)
            );
        }, delayMs);
    });

    // ============================================================
    // 鍵盤翻頁（含 iframe 內部文件的轉發，見 v0.8.0 沿革說明）
    // ============================================================
    function handleKeydown(e) {
        try {
            if (e.key === 'ArrowLeft') view.goLeft();
            else if (e.key === 'ArrowRight') view.goRight();
        } catch (err) {
            console.error('[cwfm:keydown] 翻頁失敗', err);
        }
    }
    document.addEventListener('keydown', handleKeydown);
    view.addEventListener('load', ({ detail }) => {
        detail.doc.addEventListener('keydown', handleKeydown);
    });

    // ============================================================
    // 除錯用的全域物件：Console 打 __cwfm 就能查目前狀態
    // window.__cwfm 這個容器本身在 entry.js（bundle 那邊）就已經建立，
    // 裡面掛著 shadowMap/blobMap/createTOCView/createMenu 這些內部機制，
    // 這裡用 Object.assign 合併進去，不要整個覆蓋掉，理由是所有全域變數
    // 統一收在同一個命名空間底下，不再各自散落成獨立的 __cwfmXxx 變數。
    // ============================================================
    Object.assign(window.__cwfm, {
        view,
        book,
        bookId: BOOK_ID,
        settings: null, // 稍後設定選單初始化時會填入
    });

    // ============================================================
    // 共用樣式
    // ============================================================
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = [
            '.cwfm-toolbar {',
            '  position: fixed; left: 0; right: 0; bottom: 0;',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 8px 14px; background: rgba(24,24,24,0.92);',
            '  color: #eee; font-family: sans-serif; font-size: 13px;',
            '  z-index: 999999; box-sizing: border-box;',
            '}',
            '.cwfm-toolbar button {',
            '  background: none; border: 1px solid #666; color: #eee;',
            '  border-radius: 4px; padding: 5px 12px; cursor: pointer;',
            '  font-size: 13px; flex: 0 0 auto;',
            '}',
            '.cwfm-toolbar button:hover { background: #3a3a3a; }',
            '.cwfm-progress-wrap { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; }',
            '.cwfm-progress-wrap input[type="range"] { flex: 1; }',
            '.cwfm-progress-label { flex: 0 0 auto; min-width: 3.5em; text-align: right; color: #aaa; font-size: 12px; }',
            // [cwfm] 上方工具列：目錄、書籤、設定、全螢幕，比照一般 EPUB
            // 閱讀器慣例放在上方（下方工具列只留翻頁跟進度條）。
            '.cwfm-toolbar-top {',
            '  position: fixed; left: 0; right: 0; top: 0;',
            '  display: flex; align-items: center; gap: 6px;',
            '  padding: 8px 14px; background: rgba(24,24,24,0.92);',
            '  color: #eee; font-family: sans-serif;',
            '  z-index: 999999; box-sizing: border-box;',
            '}',
            '.cwfm-toolbar-top-spacer { flex: 1 1 auto; }',
            '.cwfm-toolbar-top button {',
            '  background: none; border: none; color: #eee;',
            '  border-radius: 4px; padding: 6px; cursor: pointer;',
            '  display: flex; align-items: center; justify-content: center;',
            '}',
            '.cwfm-toolbar-top button:hover { background: #3a3a3a; }',
            '.cwfm-toolbar-top button svg { width: 20px; height: 20px; }',
            // [cwfm] 關閉數字輸入框（<input type="number">）瀏覽器原生的上下
            // 微調箭頭。查證過往 z-library_直接下載按鈕 專案用過的標準寫法
            // 直接沿用：WebKit 系瀏覽器（Chrome/Edge）用 -webkit-appearance
            // 隱藏內建的 spin button 偽元素；Firefox 用 -moz-appearance:
            // textfield 讓整個 input 表現得像一般文字框，不會再冒出箭頭。
            'input[type="number"]::-webkit-outer-spin-button,',
            'input[type="number"]::-webkit-inner-spin-button {',
            '  -webkit-appearance: none !important;',
            '  margin: 0;',
            '}',
            'input[type="number"] { -moz-appearance: textfield !important; }',
            '.cwfm-panel {',
            '  position: fixed; top: 0; bottom: 0; width: 320px; max-width: 85vw;',
            '  background: #1e1e1e; color: #eee; z-index: 1000000;',
            '  box-shadow: 0 0 24px rgba(0,0,0,0.6);',
            '  overflow-y: auto; padding: 18px; box-sizing: border-box;',
            '  font-family: sans-serif; font-size: 13px;',
            '  transition: transform 0.2s ease;',
            '}',
            // [cwfm] 標題列獨立成 header 區塊，永遠橫跨整個面板寬度，
            // 不會被下面欄位區塊的多欄排版影響。
            '.cwfm-panel-header {',
            '  display: flex; align-items: center; justify-content: space-between;',
            '  margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #444;',
            '}',
            '.cwfm-panel-header h3 { margin: 0; font-size: 15px; }',
            '.cwfm-fields-wrap { column-gap: 24px; }',
            // [cwfm] 多欄排版時，避免單一欄位（label + 對應的輸入元件）被
            // 欄與欄之間的斷點硬生生切成兩半。每個 addXxxField() 現在都會
            // 把自己的內容包進一個 .cwfm-field 容器，這裡統一套用。
            '.cwfm-field { break-inside: avoid; margin-bottom: 4px; }',
            '.cwfm-panel[data-side="left"] { left: 0; transform: translateX(-105%); }',
            '.cwfm-panel[data-side="left"].cwfm-open { transform: translateX(0); }',
            '.cwfm-panel[data-side="right"] { right: 0; transform: translateX(105%); }',
            '.cwfm-panel[data-side="right"].cwfm-open { transform: translateX(0); }',
            '.cwfm-panel label { display: block; margin: 14px 0 4px; font-size: 12px; color: #aaa; }',
            '.cwfm-panel input[type="text"], .cwfm-panel input[type="number"] {',
            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',
            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',
            '  font-size: 13px;',
            '}',
            '.cwfm-panel input[type="range"] { width: 100%; }',
            '.cwfm-value-input-wrap { display: flex; align-items: center; gap: 4px; color: #aaa; font-size: 12px; }',
            '.cwfm-value-input {',
            '  width: 4em; box-sizing: border-box; padding: 2px 4px;',
            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',
            '  font-size: 12px; text-align: right;',
            '}',
            '.cwfm-panel .cwfm-row { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 4px; }',
            '.cwfm-panel .cwfm-row label { margin: 0; }',
            '.cwfm-panel select {',
            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',
            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',
            '  font-size: 13px;',
            '}',
            '.cwfm-close-btn {',
            '  flex: 0 0 auto; background: none;',
            '  border: 1px solid #666; border-radius: 50%;',
            '  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;',
            '  color: #aaa; font-size: 14px; cursor: pointer; line-height: 1; padding: 0;',
            '}',
            '.cwfm-close-btn:hover { color: #fff; border-color: #999; }',
            // [cwfm] 色塊按鈕：取代原生 <input type="color">，點下去開啟
            // 自訂取色器。
            '.cwfm-color-swatch-btn {',
            '  width: 48px; height: 28px; border-radius: 4px;',
            '  border: 1px solid #666; cursor: pointer;',
            '}',
            // [cwfm] 取色器樣式：移植自 YouTube Channel Memory 的 ysc-cp，
            // 改名為 cwfm-cp。原版是亮色主題、另外用 html[dark] 屬性選擇器
            // 疊一套暗色 override；我們的設定面板本身就是深色的，直接用
            // 深色配色，不用像原版那樣準備兩套。
            '.cwfm-cp-wrap {',
            '  position: fixed; inset: 0; z-index: 1000010;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: rgba(0,0,0,0.55);',
            '}',
            '.cwfm-cp {',
            '  width: 233px; border-radius: 11px; overflow: hidden;',
            '  background: #262626; border: 1px solid rgba(255,255,255,0.13);',
            '  box-shadow: 0 8px 28px rgba(0,0,0,0.5); font-family: sans-serif;',
            '}',
            '.cwfm-cp .cp-grad-wrap { padding: 9px 9px 0; }',
            '.cwfm-cp .cp-grad-box { width:100%; height:140px; position:relative; cursor:crosshair; border-radius:5px; overflow:hidden; }',
            '.cwfm-cp .cp-grad-white { position:absolute;inset:0; background:linear-gradient(to right,#fff,transparent); }',
            '.cwfm-cp .cp-grad-black { position:absolute;inset:0; background:linear-gradient(to bottom,transparent,#000); }',
            '.cwfm-cp .cp-cursor {',
            '  position:absolute; width:12px; height:12px; border-radius:50%;',
            '  border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 1px 4px rgba(0,0,0,0.5);',
            '  top:28%; left:62%; transform:translate(-50%,-50%); pointer-events:none;',
            '}',
            '.cwfm-cp .cp-sliders { display:flex; align-items:center; gap:9px; padding: 9px 13px 7px; }',
            '.cwfm-cp .cp-preview { width:32px; height:32px; border-radius:50%; flex-shrink:0; border:2px solid rgba(255,255,255,0.2); }',
            '.cwfm-cp .cp-tracks { flex:1; display:flex; flex-direction:column; gap:7px; padding-right:4px; }',
            '.cwfm-cp .cp-track-row { display:flex; align-items:center; gap:14px; }',
            '.cwfm-cp .cp-track-lbl { width:10px; text-align:center; font-size:10px; font-weight:600; user-select:none; flex-shrink:0; }',
            '.cwfm-cp .cp-track-lbl.vis  { color:#999; }',
            '.cwfm-cp .cp-track-lbl.hide { color:transparent; }',
            '.cwfm-cp .cp-track { flex:1; height:12px; border-radius:6px; position:relative; cursor:pointer; }',
            '.cwfm-cp .cp-track.off { opacity:0.28; cursor:default; pointer-events:none; }',
            '.cwfm-cp .cp-thumb {',
            '  position:absolute; top:50%; transform:translate(-50%,-50%);',
            '  width:14px; height:14px; border-radius:50%; background:#fff;',
            '  border:1.5px solid rgba(0,0,0,0.35); box-shadow: 0 1px 3px rgba(0,0,0,0.4);',
            '  pointer-events:none;',
            '}',
            '.cwfm-cp .cp-track-hue { background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00); }',
            '.cwfm-cp .cp-track-off-bg { background:#444; }',
            '.cwfm-cp .cp-sep { height:1px; background:rgba(255,255,255,0.1); margin:0 13px; }',
            '.cwfm-cp .cp-mode-row { display:flex; gap:5px; padding:7px 13px 5px; }',
            '.cwfm-cp .cp-tab {',
            '  flex:1; padding:3px 0; border-radius:5px; border:1px solid transparent;',
            '  font-size:10px; font-weight:600; cursor:pointer; background:transparent;',
            '  color:#888; letter-spacing:0.03em;',
            '}',
            '.cwfm-cp .cp-tab.active { background:rgba(255,255,255,0.1); color:#eee; border-color:rgba(255,255,255,0.2); }',
            '.cwfm-cp .cp-summary-row { padding:0 13px 7px; }',
            '.cwfm-cp .cp-summary {',
            '  width:100%; box-sizing:border-box; padding:5px 8px; font-size:11px;',
            '  border:1px solid rgba(255,255,255,0.15); border-radius:6px; outline:none;',
            '  font-family:"Courier New",monospace; background:#333; color:#eee;',
            '  text-align:center;',
            '}',
            '.cwfm-cp .cp-summary:focus { border-color:rgba(200,60,60,0.5); background:#3a3a3a; }',
            '.cwfm-cp .cp-summary.off { opacity:0.32; pointer-events:none; }',
            '.cwfm-cp .cp-bottom { display:flex; gap:8px; padding:5px 13px 11px; align-items:flex-start; }',
            '.cwfm-cp .cp-steppers { width:105px; flex-shrink:0; flex-grow:0; display:flex; flex-direction:column; gap:9px; }',
            '.cwfm-cp .cp-ch-row { display:flex; align-items:center; gap:5px; }',
            '.cwfm-cp .cp-ch-lbl { width:12px; text-align:center; font-size:10px; font-weight:600; user-select:none; flex-shrink:0; }',
            '.cwfm-cp .cp-ch-lbl.vis  { color:#888; }',
            '.cwfm-cp .cp-ch-lbl.hide { color:transparent; }',
            '.cwfm-cp .cp-stepper {',
            '  display:flex; align-items:center; border:1px solid rgba(255,255,255,0.15);',
            '  border-radius:5px; overflow:hidden; height:22px; flex:1;',
            '}',
            '.cwfm-cp .cp-stepper.off { opacity:0.38; pointer-events:none; }',
            '.cwfm-cp .cp-s-btn {',
            '  width:22px; height:100%; border:none; background:transparent;',
            '  cursor:pointer; font-size:13px; color:#aaa; flex-shrink:0;',
            '  display:flex; align-items:center; justify-content:center; line-height:1;',
            '}',
            '.cwfm-cp .cp-s-btn:hover { background:rgba(255,255,255,0.1); }',
            '.cwfm-cp .cp-s-val {',
            '  flex:1; border:none; outline:none; text-align:center; font-size:11px;',
            '  background:transparent; color:#eee; width:0; min-width:0;',
            '  -moz-appearance:textfield;',
            '}',
            '.cwfm-cp .cp-s-val::-webkit-inner-spin-button,',
            '.cwfm-cp .cp-s-val::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }',
            '.cwfm-cp .cp-stepper.off .cp-s-val { color:transparent; }',
            '.cwfm-cp .cp-actions { flex:1; display:flex; flex-direction:column; gap:6px; justify-content:center; }',
            '.cwfm-cp .cp-btn { width:100%; padding:5px 0; border-radius:6px; border:none; font-size:11.5px; cursor:pointer; transition:opacity 0.1s; }',
            '.cwfm-cp .cp-btn:active { opacity:.82; }',
            '.cwfm-cp .cp-btn-cancel { background:#3a3a3a; border:1px solid rgba(255,255,255,0.12); color:#ccc; font-weight:500; }',
            '.cwfm-cp .cp-btn-cancel:hover { background:#444; }',
            '.cwfm-cp .cp-btn-ok { background:#cc0000; color:#fff; font-weight:600; }',
            '.cwfm-cp .cp-btn-ok:hover { opacity:.88; }',
            '.cwfm-toc-view { list-style: none; margin: 0; padding: 0; }',
            '.cwfm-toc-view ol { list-style: none; margin: 0; padding: 0; }',
            '.cwfm-toc-view [role="treeitem"] {',
            '  display: block; padding: 5px 0; color: #ccc; text-decoration: none; cursor: pointer;',
            '}',
            '.cwfm-toc-view [role="treeitem"]:hover { color: #fff; }',
            '.cwfm-toc-view [role="treeitem"][aria-current="page"] { color: #4ea1ff; font-weight: bold; }',
            '.cwfm-toc-view [aria-expanded="false"] ~ ol { display: none; }',
            '.cwfm-empty-hint { color: #888; font-size: 12px; }',
            '.cwfm-dimming {',
            '  position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 999998;',
            '  opacity: 0; pointer-events: none; transition: opacity 0.2s ease;',
            '}',
            '.cwfm-dimming.cwfm-show { opacity: 1; pointer-events: auto; }',
            // [cwfm] 分隔線：查證 Calibre-Web 原本 main.css 的 #divider 規則
            // 後確認，原版是 position: absolute、寫死 height: 80%／top: 10%，
            // 這兩個數字是配合原本 #viewer 固定 80% 高度、置中對齊湊出來的。
            // 我們已經把 #viewer 改成撐滿 100%，照搬這兩個寫死的數字位置會
            // 對不上；改成用 JS 動態算 top/height（對齊我們自己算好的上下
            // 留白），不寫死在 CSS 裡，這裡只定義不隨設定變動的部分
            // （寬度、顏色、透明度、陰影，這些直接沿用原版數值）。
            '.cwfm-divider {',
            '  position: absolute; width: 1px; left: 50%; margin-left: -0.5px;',
            '  border-right: 1px solid #000; opacity: 0.15; z-index: 1;',
            '  box-shadow: -2px 0 15px rgba(0, 0, 0, 1); pointer-events: none;',
            '  display: none;',
            '}',
            '.cwfm-divider.cwfm-show { display: block; }',
        ].join('\n');
        document.head.appendChild(style);
    }
    try { injectStyles(); } catch (e) { console.error('[cwfm:injectStyles]', e); }

    // [cwfm] 分隔線元素本身：插進 #viewer 裡面（#viewer 本身是
    // position: relative，這是 Calibre-Web 原本 main.css 就設定好的，
    // absolute 定位的子元素會依照 #viewer 的框定位，不用我們自己再設定）。
    // 只在兩欄模式（maxColumnCount >= 2）才顯示，一欄模式沒有「中間那條
    // 裝訂線」的意義。位置（top/height）在 applySettings 裡動態計算，
    // 對齊當下的上下留白設定，不寫死。
    const divider = document.createElement('div');
    divider.className = 'cwfm-divider';
    divider.dataset.cwfmOwned = 'true';
    try { viewerContainer.appendChild(divider); } catch (e) { console.error('[cwfm:divider] 建立分隔線失敗', e); }

    function updateDivider(settings) {
        try {
            const rendererRect = view.renderer.getBoundingClientRect();
            const viewerRect = viewerContainer.getBoundingClientRect();
            // [cwfm] 改用像素計算，不用百分比：divider 是 #viewer 的絕對
            // 定位子元素，絕對定位元素的百分比是相對於容器的「padding box」
            // （含我們自己加的 44px 工具列留白）計算，不是相對於 renderer
            // 實際內容高度，兩者對不上，會導致分隔線下緣多延伸進工具列的
            // 保留空間。改用像素直接量測、直接相加，不透過百分比換算，
            // 就不會有這個基準不一致的問題。
            const topOffsetPx = (rendererRect.top - viewerRect.top) + settings.topBottomPadding;
            const heightPx = rendererRect.height - settings.topBottomPadding * 2;
            divider.style.top = topOffsetPx + 'px';
            divider.style.height = Math.max(0, heightPx) + 'px';
            divider.classList.toggle('cwfm-show', settings.maxColumnCount >= 2 && settings.flow === 'paginated');
        } catch (e) {
            console.error('[cwfm:divider] 更新分隔線位置失敗', e);
        }
    }

    // 讓工具列/面板不要蓋住書本內容：#viewer 底部留一點空間
    try {
        viewerContainer.style.paddingTop = '44px';
        viewerContainer.style.paddingBottom = '44px';
    } catch (e) { console.error('[cwfm:layout]', e); }

    // 共用的遮罩，點擊可以關掉任何一個開著的面板
    let dimming;
    function ensureDimming() {
        if (dimming) return dimming;
        dimming = document.createElement('div');
        dimming.className = 'cwfm-dimming';
        document.body.appendChild(dimming);
        return dimming;
    }
    function closeAllPanels() {
        document.querySelectorAll('.cwfm-panel.cwfm-open').forEach(p => p.classList.remove('cwfm-open'));
        if (dimming) dimming.classList.remove('cwfm-show');
    }
    function openPanel(panel) {
        closeAllPanels();
        panel.classList.add('cwfm-open');
        ensureDimming().classList.add('cwfm-show');
    }

    // ============================================================
    // 設定選單：字體、字級、字距、行距、對齊、斷字、翻頁模式、上下/左右留白、欄數
    // ============================================================
    const DEFAULT_SETTINGS = {
        fontFamily: '',
        fontSize: 100,     // 百分比
        letterSpacing: 0,  // em
        lineSpacing: 1.4,
        justify: true,
        hyphenate: true,
        disableLigatures: false, // 關閉連字（含詞彙替換字型的 ccmp 替換）
        flow: 'paginated',
        topBottomPadding: 48,  // px，對應 renderer 的 margin 屬性
        leftRightPadding: 24,  // px，對應 renderer 的 gap 屬性（換算成百分比）
        maxColumnCount: 2,
        localAutoRemember: true,   // 功能一：本機自動記憶開關
        autoSyncEnabled: false,    // 功能三：停留自動同步開關（預設關閉，避免使用者沒注意到就一直送請求）
        autoSyncDelaySeconds: 5,   // 功能三：停留幾秒才觸發同步
        themeName: 'auto',         // 'auto'／'light'／'dark'／'sepia'／'custom'
        customTextColor: '#333333',
        customBackgroundColor: '#f5f0e6',
        preferOriginalTextColor: false, // 勾選後不強制覆蓋文字顏色，讓書本自己的排版樣式顯示出來
    };

    // [cwfm] 幾種常用配色，比照一般電子書閱讀器常見的預設主題：
    // auto（跟隨系統深色模式，不特別指定顏色，維持原本 color-scheme
    // 自動切換的行為）、light（亮色）、dark（暗色）、sepia（復古黃，
    // 長時間閱讀常見的護眼色調）。custom 則用下面兩個 customXxxColor
    // 設定值，讓使用者自己挑。
    const THEME_PRESETS = {
        light: { text: '#1a1a1a', background: '#ffffff' },
        dark: { text: '#e0e0e0', background: '#1a1a1a' },
        sepia: { text: '#4b3621', background: '#f4ecd8' },
    };

    function loadSettings() {
        try {
            if (!INITIAL_SETTINGS) {
                console.log('[cwfm:settings] GM 儲存沒有存過設定，使用預設值');
                return { ...DEFAULT_SETTINGS };
            }
            const parsed = { ...DEFAULT_SETTINGS, ...INITIAL_SETTINGS };
            console.log('[cwfm:settings] 從 GM 儲存讀回設定：', parsed);
            return parsed;
        } catch (e) {
            console.error('[cwfm:settings] 讀取設定失敗，改用預設值', e);
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings(settings) {
        try {
            gmSet(STORAGE_KEY, settings);
            console.log('[cwfm:settings] 已送出寫入請求（GM 儲存）：', settings);
        } catch (e) {
            console.error('[cwfm:settings] 儲存設定失敗', e);
        }
    }

    function getTypographyCSS(settings) {
        const fontFamilyRule = settings.fontFamily
            ? '  * { font-family: ' + JSON.stringify(settings.fontFamily) + ' !important; }'
            : '';

        // [cwfm] 佈景主題：auto 不特別指定顏色，維持原本 color-scheme
        // 跟隨系統深色模式自動切換的行為；light/dark/sepia 用預設配色；
        // custom 用使用者自己選的顏色。
        const theme = settings.themeName === 'custom'
            ? { text: settings.customTextColor, background: settings.customBackgroundColor }
            : THEME_PRESETS[settings.themeName];

        // [cwfm] 顏色規則獨立成單獨一條、用萬用選擇器（*）套用，不能跟
        // 字級/行距那條規則（只涵蓋 p/li/blockquote/dd/div）共用——實測
        // 發現標題（h1~h6）、連結（a）、span 這類標籤完全沒被那條規則
        // 涵蓋到，導致「少部分文字沒套用到顏色」；但也不能直接把顏色塞
        // 進那條規則裡，因為那樣會連帶把標題的字級也強制跟內文一樣大，
        // 破壞標題層次。用萬用選擇器確保涵蓋到任何標籤，同時獨立成
        // 自己一條規則，不影響字級/行距的套用範圍。
        //
        // 背景色跟文字色套用同一套邏輯（雙重覆蓋：html,body 一份、萬用
        // 選擇器一份），不能因為某本書這次沒事就假設每本書都不會撞到
        // 書本自己 CSS 的優先權衝突。
        //
        // preferOriginalTextColor：使用者可以選擇「優先套用書籍本身的
        // 文字樣式」，勾選後即使選了主題/自訂顏色，也不強制覆蓋文字
        // 顏色（背景色不受這個選項影響，仍然套用，因為背景色關係到
        // 「看不看得清楚」這個更基本的可用性問題，跟文字顏色的「排版
        // 美感選擇」性質不同）。
        const themeRule = theme
            ? 'html, body { background-color: ' + theme.background + ' !important; }'
            : '';
        const universalColorRule = theme
            ? '* {\n' +
              (settings.preferOriginalTextColor ? '' : '  color: ' + theme.text + ' !important;\n') +
              '  background-color: ' + theme.background + ' !important;\n' +
              '}'
            : '';

        return [
            '@namespace epub "http://www.idpf.org/2007/ops";',
            'html { color-scheme: light dark; }',
            themeRule,
            universalColorRule,
            fontFamilyRule,
            'p, li, blockquote, dd, div {',
            '  font-size: ' + settings.fontSize + '% !important;',
            '  letter-spacing: ' + settings.letterSpacing + 'em !important;',
            '  line-height: ' + settings.lineSpacing + ' !important;',
            '  text-align: ' + (settings.justify ? 'justify' : 'start') + ' !important;',
            '  -webkit-hyphens: ' + (settings.hyphenate ? 'auto' : 'manual') + ';',
            '  hyphens: ' + (settings.hyphenate ? 'auto' : 'manual') + ';',
            // [cwfm] 查證後確認：部分字型內建「字距微調（kerning）」資料表，
            // 只針對特定字元組合生效（不是每一對字都有），跟我們外加的
            // letter-spacing（均勻套用在所有字元）疊加後，命中 kerning 表
            // 的特定詞彙會被字型自己拉近一點，看起來比周圍文字擠——這正好
            // 解釋了為什麼只有特定詞彙（例如「症狀」「出現」）間距比較窄，
            // 而且跟兩端對齊無關（已實測確認關掉兩端對齊症狀依然存在，
            // 排除了 justify 相關機制）。明確關閉字型的 kerning，讓所有
            // 字元只依照我們設定的 letter-spacing 均勻分佈。
            '  font-kerning: none !important;',
            (settings.disableLigatures
                ? '  font-variant-ligatures: none !important; font-feature-settings: "liga" 0, "dlig" 0, "clig" 0, "ccmp" 0 !important;'
                : ''),
            '}',
            'pre { white-space: pre-wrap !important; }',
            // [cwfm] 查證 EPUB 封面圖片的業界標準做法（Pandoc/Calibre/Sigil
            // 實際採用的方案）後確認：標準包法是用 <svg> 包住 <image>，靠
            // SVG 自己內建的 viewBox + preserveAspectRatio（預設值就是
            // xMidYMid meet，會自動保持比例）機制縮放，不需要外部 CSS 介入。
            // 先前用 object-fit: contain 對內嵌 <svg> 標籤本來就不適用
            // （object-fit 只對 <img>/<video> 這類替換元素有效），方向選
            // 錯了。正確做法是「不要去干擾 SVG 原本正確的機制」——不強制
            // width/height: 100%（那樣會把 SVG 自己的方框硬拉伸變形，即使
            // 內部圖片透過 preserveAspectRatio 想維持比例，方框本身已經
            // 被拉走樣），改用 max-width/max-height 搭配 width/height: auto，
            // 讓瀏覽器依照圖片（不論是 img 還是內嵌 svg）原始比例自己決定
            // 顯示尺寸，只用「最大不超過容器」這個限制圈住它。
            'img, svg {',
            '  width: auto !important;',
            '  height: auto !important;',
            '  max-width: 100% !important;',
            '  max-height: 100% !important;',
            '  object-fit: contain;',
            '}',
        ].join('\n');
    }

    // [cwfm] 左右留白必須同時控制兩個屬性，缺一不可，理由是實測抓到的
    // 真實現象：
    // - 螢幕夠寬、內容有多餘空間可以分配時，留白大小由 max-inline-size
    //   主導（內容欄達到自己的寬度上限，剩下的空間才分給外側留白）。
    // - 螢幕不夠寬、內容欄撐不到自己想要的寬度時（例如視窗被設定選單
    //   面板擠壓過的情況），max-inline-size 完全不起作用，外側留白會被
    //   卡在 gap 屬性算出來的「保底最小值」（gap 的一半，換算成容器寬度
    //   的百分比）——這正是查證卡了好幾輪才抓到的關鍵：gap 的預設值是
    //   7%，換算成保底留白遠大於我們想要的像素值，之前只改
    //   max-inline-size 完全沒處理到這個保底機制，才會實測出留白數字
    //   對不上滑桿設定的狀況。
    // 所以這裡兩個屬性一起算：gap 負責「保底最小值」，max-inline-size
    // 負責「螢幕夠寬時不要讓內容把多餘空間占滿」，兩者算式殊途同歸，
    // 都是把使用者想要的像素值換算成對應的百分比/像素。
    function applyHorizontalPadding(desiredPx, columnCount) {
        const rect = view.renderer.getBoundingClientRect();
        const totalWidth = rect.width || 1;

        const gapPercent = (desiredPx * 2 / totalWidth) * 100;
        view.renderer.setAttribute('gap', gapPercent.toFixed(3) + '%');

        const contentWidth = Math.max(100, totalWidth - desiredPx * 2);
        view.renderer.setAttribute('max-inline-size', Math.round(contentWidth / (columnCount || 1)) + 'px');
    }

    // [cwfm] margin 這個屬性一定要帶 px 單位，這是上下留白怎麼調都沒反應
    // 的真正原因（查證 paginator.js 原始碼確認）：
    // - attributeChangedCallback 收到 margin 後，是把值「原封不動」塞進
    //   CSS 變數（setProperty('--_margin', value)），完全沒有補單位的處理。
    // - 這個變數用在 `minmax(var(--_margin), 1fr)` 與 `height: var(--_margin)`
    //   這兩個需要合法長度的地方；CSS 規格裡不帶單位的數字不是合法長度
    //   （唯一例外是 0），整條 grid-template-rows 宣告會被瀏覽器丟棄，
    //   格線退回自動排版，所以不管調 4 或 120 畫面完全一樣。
    // - 佐證：函式庫自己的預設值就寫成 48px（帶單位）。也解釋了為什麼
    //   最早期 margin=0 時上下真的變成 0（0 是唯一合法的無單位長度）。
    // 注意第 720 行有段 JS 會用 parseFloat 把這個變數讀回去做欄寬計算，
    // parseFloat('120px') 與 parseFloat('120') 結果相同，加上 px 不影響它。
    function applyVerticalPadding(desiredPx) {
        const rect = view.renderer.getBoundingClientRect();
        const totalHeight = rect.height || 1;
        view.renderer.setAttribute('margin', desiredPx + 'px');
        const contentHeight = Math.max(100, totalHeight - desiredPx * 2);
        view.renderer.setAttribute('max-block-size', Math.round(contentHeight) + 'px');
        view.renderer.render();
    }

    function applySettings(settings) {
        try {
            view.renderer.setStyles?.(getTypographyCSS(settings));
        } catch (e) { console.error('[cwfm:settings] 套用字體樣式失敗', e); }
        try {
            view.renderer.setAttribute('flow', settings.flow);
            view.renderer.setAttribute('max-column-count', settings.maxColumnCount);
            applyVerticalPadding(settings.topBottomPadding);
            applyHorizontalPadding(settings.leftRightPadding, settings.maxColumnCount);
            updateDivider(settings);
        } catch (e) { console.error('[cwfm:settings] 套用版面屬性失敗', e); }
        window.__cwfm.settings = settings;
    }

    // 視窗尺寸改變時，margin/max-block-size 與 gap/max-inline-size 都需要
    // 根據新的容器尺寸重新換算。
    window.addEventListener('resize', () => {
        if (window.__cwfm.settings) {
            try {
                applyVerticalPadding(window.__cwfm.settings.topBottomPadding);
                applyHorizontalPadding(window.__cwfm.settings.leftRightPadding, window.__cwfm.settings.maxColumnCount);
                updateDivider(window.__cwfm.settings);
            } catch (e) { console.error('[cwfm:settings] 視窗縮放後重新套用留白失敗', e); }
        }
    });

    // ============================================================
    // 自訂取色器：移植自 bgtsai/claude-knowledge-base 的
    // _scripts/youtube_channel_memory/YouTube_Channel_Memory.user.js，
    // 不用瀏覽器原生的 <input type="color">（原版叫 ysc-cp，這裡改名為
    // cwfm-cp 避免命名衝突；配色直接採用深色主題，因為我們的設定面板
    // 本身就是深色的，不像原版需要另外做亮/暗兩套）。
    // ── 色彩換算輔助函式：純數學運算，不牽涉 DOM ──
    function cwfmHsvToRgb(h, s, v) {
        const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
        let r = 0, g = 0, b = 0;
        if      (h < 60)  { r=c; g=x; b=0; }
        else if (h < 120) { r=x; g=c; b=0; }
        else if (h < 180) { r=0; g=c; b=x; }
        else if (h < 240) { r=0; g=x; b=c; }
        else if (h < 300) { r=x; g=0; b=c; }
        else              { r=c; g=0; b=x; }
        return { r: Math.round((r+m)*255), g: Math.round((g+m)*255), b: Math.round((b+m)*255) };
    }
    function cwfmRgbToHsv(r, g, b) {
        r/=255; g/=255; b/=255;
        const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
        let h=0, s=(max===0?0:d/max), v=max;
        if (d!==0) {
            if      (max===r) h = ((g-b)/d + (g<b?6:0)) / 6;
            else if (max===g) h = ((b-r)/d + 2) / 6;
            else              h = ((r-g)/d + 4) / 6;
        }
        return { h: h*360, s, v };
    }
    function cwfmRgbToHex(r, g, b) {
        return '#' + [r,g,b].map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
    }
    function cwfmHexToRgb(hex) {
        const m = hex.replace('#','').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (!m) return null;
        return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) };
    }
    function cwfmCssToHex(css) {
        try {
            const el = document.createElement('div');
            el.style.display = 'none';
            el.style.color = css;
            document.body.appendChild(el);
            const computed = getComputedStyle(el).color;
            el.remove();
            const m = computed.match(/rgba?\(([0-9]+),\s*([0-9]+),\s*([0-9]+)/);
            if (!m) return null;
            return cwfmRgbToHex(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));
        } catch { return null; }
    }

    // ── 開啟取色器，選好按 OK 後呼叫 onConfirm(hex) ──
    function openColorPicker(initialHex, onConfirm) {
        document.getElementById('cwfm-cp-wrap')?.remove();

        const initRgb = cwfmHexToRgb(initialHex) || { r: 204, g: 0, b: 0 };
        const initHsv = cwfmRgbToHsv(initRgb.r, initRgb.g, initRgb.b);
        const cpState = {
            h: initHsv.h, s: initHsv.s, v: initHsv.v,
            r: initRgb.r, g: initRgb.g, b: initRgb.b,
            mode: 'RGB',
        };
        function cpSyncFromHsv() {
            const rgb = cwfmHsvToRgb(cpState.h, cpState.s, cpState.v);
            cpState.r = rgb.r; cpState.g = rgb.g; cpState.b = rgb.b;
        }
        function cpSyncFromRgb() {
            const hsv = cwfmRgbToHsv(cpState.r, cpState.g, cpState.b);
            cpState.s = hsv.s; cpState.v = hsv.v;
            if (hsv.s > 0.02) cpState.h = hsv.h;
        }

        document.body.insertAdjacentHTML('beforeend', `
<div id="cwfm-cp-wrap" class="cwfm-cp-wrap" data-cwfm-owned="true">
  <div id="cwfm-cp" class="cwfm-cp">
    <div class="cp-grad-wrap">
      <div class="cp-grad-box">
        <div class="cp-grad-white"></div>
        <div class="cp-grad-black"></div>
        <div class="cp-cursor"></div>
      </div>
    </div>
    <div class="cp-sliders">
      <div class="cp-preview"></div>
      <div class="cp-tracks">
        <div class="cp-track-row">
          <span class="cp-track-lbl vis cp-lbl1">H</span>
          <div class="cp-track cp-track-hue cp-track1"><div class="cp-thumb"></div></div>
        </div>
        <div class="cp-track-row">
          <span class="cp-track-lbl hide cp-lbl2">\u00b7</span>
          <div class="cp-track cp-track-off-bg off cp-track2"><div class="cp-thumb"></div></div>
        </div>
        <div class="cp-track-row">
          <span class="cp-track-lbl hide cp-lbl3">\u00b7</span>
          <div class="cp-track cp-track-off-bg off cp-track3"><div class="cp-thumb"></div></div>
        </div>
      </div>
    </div>
    <div class="cp-sep"></div>
    <div class="cp-mode-row">
      <button class="cp-tab" data-mode="HEX">HEX</button>
      <button class="cp-tab active" data-mode="RGB">RGB</button>
      <button class="cp-tab" data-mode="HSV">HSV</button>
    </div>
    <div class="cp-summary-row">
      <input class="cp-summary" type="text" spellcheck="false">
    </div>
    <div class="cp-bottom">
      <div class="cp-steppers">
        <div class="cp-ch-row"><span class="cp-ch-lbl vis cp-lbl-ch1"></span>
          <div class="cp-stepper cp-stepper1"><button class="cp-s-btn cp-s-dec1">\u2212</button><input class="cp-s-val cp-val1" type="number"><button class="cp-s-btn cp-s-inc1">+</button></div>
        </div>
        <div class="cp-ch-row"><span class="cp-ch-lbl vis cp-lbl-ch2"></span>
          <div class="cp-stepper cp-stepper2"><button class="cp-s-btn cp-s-dec2">\u2212</button><input class="cp-s-val cp-val2" type="number"><button class="cp-s-btn cp-s-inc2">+</button></div>
        </div>
        <div class="cp-ch-row"><span class="cp-ch-lbl vis cp-lbl-ch3"></span>
          <div class="cp-stepper cp-stepper3"><button class="cp-s-btn cp-s-dec3">\u2212</button><input class="cp-s-val cp-val3" type="number"><button class="cp-s-btn cp-s-inc3">+</button></div>
        </div>
      </div>
      <div class="cp-actions">
        <button class="cp-btn cp-btn-cancel">\u53d6\u6d88</button>
        <button class="cp-btn cp-btn-ok">OK</button>
      </div>
    </div>
  </div>
</div>`);

        const cpOverlay = document.getElementById('cwfm-cp-wrap');
        const cp        = document.getElementById('cwfm-cp');
        const gradBox   = cp.querySelector('.cp-grad-box');
        const cpCursor  = cp.querySelector('.cp-cursor');
        const cpPreview = cp.querySelector('.cp-preview');
        const track1    = cp.querySelector('.cp-track1');
        const track2    = cp.querySelector('.cp-track2');
        const track3    = cp.querySelector('.cp-track3');
        const lbl1      = cp.querySelector('.cp-lbl1');
        const lbl2      = cp.querySelector('.cp-lbl2');
        const lbl3      = cp.querySelector('.cp-lbl3');
        const summary   = cp.querySelector('.cp-summary');
        const tabs      = cp.querySelectorAll('.cp-tab');
        const val1      = cp.querySelector('.cp-val1');
        const val2      = cp.querySelector('.cp-val2');
        const val3      = cp.querySelector('.cp-val3');
        const lblCh1    = cp.querySelector('.cp-lbl-ch1');
        const lblCh2    = cp.querySelector('.cp-lbl-ch2');
        const lblCh3    = cp.querySelector('.cp-lbl-ch3');
        const step1     = cp.querySelector('.cp-stepper1');
        const step2     = cp.querySelector('.cp-stepper2');
        const step3     = cp.querySelector('.cp-stepper3');

        function cpRender() {
            const { h, s, v, r, g, b, mode } = cpState;
            const hueRgb = cwfmHsvToRgb(h, 1, 1);
            gradBox.style.background = `rgb(${hueRgb.r},${hueRgb.g},${hueRgb.b})`;
            cpCursor.style.left = (s * 100) + '%';
            cpCursor.style.top  = ((1 - v) * 100) + '%';
            const hex = (mode === 'RGB') ? cwfmRgbToHex(r, g, b) : cwfmRgbToHex(...Object.values(cwfmHsvToRgb(h, s, v)));
            cpPreview.style.background = hex;

            if (mode === 'RGB') {
                track1.style.background = ''; track1.classList.remove('off','cp-track-off-bg'); track1.classList.add('cp-track-hue');
                track1.querySelector('.cp-thumb').style.left = (h / 360 * 100) + '%';
                lbl1.textContent = 'H'; lbl1.className = 'cp-track-lbl vis cp-lbl1';
                track2.classList.add('off','cp-track-off-bg'); track3.classList.add('off','cp-track-off-bg');
                lbl2.textContent = '\u00b7'; lbl2.className = 'cp-track-lbl hide cp-lbl2';
                lbl3.textContent = '\u00b7'; lbl3.className = 'cp-track-lbl hide cp-lbl3';
                lblCh1.textContent = 'R'; lblCh2.textContent = 'G'; lblCh3.textContent = 'B';
                step1.classList.remove('off'); step2.classList.remove('off'); step3.classList.remove('off');
                val1.value = r; val2.value = g; val3.value = b;
                summary.value = `${r}, ${g}, ${b}`;
            } else if (mode === 'HSV') {
                track1.style.background = ''; track1.classList.remove('off','cp-track-off-bg'); track1.classList.add('cp-track-hue');
                track1.querySelector('.cp-thumb').style.left = (h / 360 * 100) + '%';
                lbl1.textContent = 'H'; lbl1.className = 'cp-track-lbl vis cp-lbl1';
                const hFullSat = cwfmHsvToRgb(h, 1, v);
                const hNoSat   = cwfmHsvToRgb(h, 0, v);
                track2.style.background = `linear-gradient(to right, rgb(${hNoSat.r},${hNoSat.g},${hNoSat.b}), rgb(${hFullSat.r},${hFullSat.g},${hFullSat.b}))`;
                track2.querySelector('.cp-thumb').style.left = (s * 100) + '%';
                track2.classList.remove('off','cp-track-off-bg');
                lbl2.textContent = 'S'; lbl2.className = 'cp-track-lbl vis cp-lbl2';
                const hFullV = cwfmHsvToRgb(h, s, 1);
                track3.style.background = `linear-gradient(to right, #000, rgb(${hFullV.r},${hFullV.g},${hFullV.b}))`;
                track3.querySelector('.cp-thumb').style.left = (v * 100) + '%';
                track3.classList.remove('off','cp-track-off-bg');
                lbl3.textContent = 'V'; lbl3.className = 'cp-track-lbl vis cp-lbl3';
                lblCh1.textContent = 'H'; lblCh2.textContent = 'S'; lblCh3.textContent = 'V';
                step1.classList.remove('off'); step2.classList.remove('off'); step3.classList.remove('off');
                val1.value = Math.round(h); val2.value = Math.round(s * 100); val3.value = Math.round(v * 100);
                summary.value = `${Math.round(h)}, ${Math.round(s*100)}, ${Math.round(v*100)}`;
            } else { // HEX
                track1.style.background = ''; track1.classList.remove('off','cp-track-off-bg'); track1.classList.add('cp-track-hue');
                track1.querySelector('.cp-thumb').style.left = (h / 360 * 100) + '%';
                lbl1.textContent = 'H'; lbl1.className = 'cp-track-lbl vis cp-lbl1';
                track2.classList.add('off','cp-track-off-bg'); track3.classList.add('off','cp-track-off-bg');
                lbl2.textContent = '\u00b7'; lbl2.className = 'cp-track-lbl hide cp-lbl2';
                lbl3.textContent = '\u00b7'; lbl3.className = 'cp-track-lbl hide cp-lbl3';
                lblCh1.textContent = ''; lblCh2.textContent = ''; lblCh3.textContent = '';
                step1.classList.add('off'); step2.classList.add('off'); step3.classList.add('off');
                val1.value = ''; val2.value = ''; val3.value = '';
                summary.value = hex.toUpperCase();
            }
        }

        let _cpRafPending = false;
        function cpRenderRaf() {
            if (!_cpRafPending) {
                _cpRafPending = true;
                requestAnimationFrame(() => { cpRender(); _cpRafPending = false; });
            }
        }

        function cpTrackDrag(trackEl, onMove) {
            function move(e) {
                const rect = trackEl.getBoundingClientRect();
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                onMove(ratio);
                cpRenderRaf();
            }
            function up() {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup',  up);
                document.removeEventListener('touchmove', move);
                document.removeEventListener('touchend',  up);
            }
            trackEl.addEventListener('mousedown',  e => { e.preventDefault(); move(e); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
            trackEl.addEventListener('touchstart', e => { e.preventDefault(); move(e); document.addEventListener('touchmove', move); document.addEventListener('touchend', up); }, {passive:false});
        }
        cpTrackDrag(track1, ratio => { cpState.h = ratio * 360; cpSyncFromHsv(); });
        cpTrackDrag(track2, ratio => { if (cpState.mode === 'HSV') { cpState.s = ratio; cpSyncFromHsv(); } });
        cpTrackDrag(track3, ratio => { if (cpState.mode === 'HSV') { cpState.v = ratio; cpSyncFromHsv(); } });

        function gradMove(e) {
            e.preventDefault();
            const rect = gradBox.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            cpState.s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            cpState.v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
            cpSyncFromHsv();
            cpRenderRaf();
        }
        function gradUp() {
            document.removeEventListener('mousemove', gradMove);
            document.removeEventListener('mouseup',  gradUp);
            document.removeEventListener('touchmove', gradMove);
            document.removeEventListener('touchend',  gradUp);
        }
        gradBox.addEventListener('mousedown',  e => { gradMove(e); document.addEventListener('mousemove', gradMove); document.addEventListener('mouseup', gradUp); });
        gradBox.addEventListener('touchstart', e => { gradMove(e); document.addEventListener('touchmove', gradMove); document.addEventListener('touchend', gradUp); }, {passive:false});

        function cpStepperChange(idx, delta, rawVal) {
            const { mode } = cpState;
            if (mode === 'HEX') return;
            if (mode === 'RGB') {
                const keys = ['r','g','b'];
                const key = keys[idx-1];
                if (rawVal !== undefined) cpState[key] = Math.max(0, Math.min(255, parseInt(rawVal)||0));
                else cpState[key] = Math.max(0, Math.min(255, cpState[key] + delta));
                cpSyncFromRgb();
            } else if (mode === 'HSV') {
                const hsvVals = [Math.round(cpState.h), Math.round(cpState.s*100), Math.round(cpState.v*100)];
                if (rawVal !== undefined) hsvVals[idx-1] = parseFloat(rawVal)||0;
                else hsvVals[idx-1] += delta;
                hsvVals[0] = ((hsvVals[0] % 360) + 360) % 360;
                hsvVals[1] = Math.max(0, Math.min(100, hsvVals[1]));
                hsvVals[2] = Math.max(0, Math.min(100, hsvVals[2]));
                cpState.h = hsvVals[0]; cpState.s = hsvVals[1]/100; cpState.v = hsvVals[2]/100;
                cpSyncFromHsv();
            }
            cpRender();
        }
        function cpBindHold(btn, idx, delta) {
            let holdTimer = null, holdInterval = null;
            function start(e) {
                e.preventDefault();
                cpStepperChange(idx, delta);
                holdTimer = setTimeout(() => { holdInterval = setInterval(() => cpStepperChange(idx, delta), 60); }, 400);
            }
            function stop() { clearTimeout(holdTimer); clearInterval(holdInterval); holdTimer = null; holdInterval = null; }
            btn.addEventListener('mousedown',  start);
            btn.addEventListener('touchstart', start, {passive:false});
            btn.addEventListener('mouseup',    stop);
            btn.addEventListener('mouseleave', stop);
            btn.addEventListener('touchend',   stop);
            btn.addEventListener('touchcancel',stop);
            btn.addEventListener('click', e => e.preventDefault());
        }
        [[val1,step1,1],[val2,step2,2],[val3,step3,3]].forEach(([valEl, stepEl, idx]) => {
            cpBindHold(stepEl.querySelector('.cp-s-btn:first-child'), idx, -1);
            cpBindHold(stepEl.querySelector('.cp-s-btn:last-child'),  idx, +1);
            valEl.addEventListener('change', () => cpStepperChange(idx, 0, valEl.value));
            valEl.addEventListener('keydown', e => { if (e.key==='Enter') cpStepperChange(idx, 0, valEl.value); });
        });

        function cpSummaryCommit() {
            const raw = summary.value.trim();
            const mode = cpState.mode;
            function cpSetFromRgb(rgb) { cpState.r=rgb.r; cpState.g=rgb.g; cpState.b=rgb.b; cpSyncFromRgb(); cpRender(); }
            if (/^#?[0-9a-f]{6}$/i.test(raw.replace(/\s/g,''))) {
                const hex = raw.startsWith('#') ? raw : '#'+raw;
                const rgb = cwfmHexToRgb(hex);
                if (rgb) cpSetFromRgb(rgb);
                return;
            }
            const m3 = raw.match(/^([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)$/);
            if (m3) {
                if (mode === 'RGB') {
                    cpSetFromRgb({
                        r: Math.max(0,Math.min(255,parseInt(m3[1])||0)),
                        g: Math.max(0,Math.min(255,parseInt(m3[2])||0)),
                        b: Math.max(0,Math.min(255,parseInt(m3[3])||0)),
                    });
                } else if (mode === 'HSV') {
                    cpState.h = ((parseFloat(m3[1])%360)+360)%360;
                    cpState.s = Math.max(0,Math.min(100,parseFloat(m3[2])||0))/100;
                    cpState.v = Math.max(0,Math.min(100,parseFloat(m3[3])||0))/100;
                    cpSyncFromHsv(); cpRender();
                }
                return;
            }
            const hex = cwfmCssToHex(raw);
            if (hex) { const rgb = cwfmHexToRgb(hex); if (rgb) cpSetFromRgb(rgb); }
        }
        summary.addEventListener('change', cpSummaryCommit);
        summary.addEventListener('keydown', e => { if (e.key==='Enter') cpSummaryCommit(); });

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const newMode = tab.dataset.mode;
                if (cpState.mode === 'RGB') cpSyncFromRgb(); else cpSyncFromHsv();
                cpState.mode = newMode;
                cpRender();
            });
        });

        function cpClose() { cpOverlay.remove(); }
        function cpOK() {
            const rgbVal = (cpState.mode === 'RGB') ? { r: cpState.r, g: cpState.g, b: cpState.b } : cwfmHsvToRgb(cpState.h, cpState.s, cpState.v);
            const hex = cwfmRgbToHex(rgbVal.r, rgbVal.g, rgbVal.b);
            onConfirm(hex);
            cpOverlay.remove();
        }
        cp.querySelector('.cp-btn-cancel').addEventListener('click', cpClose);
        cp.querySelector('.cp-btn-ok').addEventListener('click', cpOK);

        cpRender();
    }

    function buildSettingsPanel() {
        const settings = loadSettings();

        const panel = document.createElement('div');
        panel.className = 'cwfm-panel';
        panel.dataset.side = 'right';
        panel.dataset.cwfmOwned = 'true';

        // [cwfm] 標題跟關閉按鈕獨立成一個 header 區塊，跟下面的欄位分開，
        // 這樣多欄排版只會套用在欄位區塊上，標題列永遠橫跨整個面板寬度、
        // 不會被欄斷點影響。header 用 flex + space-between，標題要先加、
        // 關閉按鈕後加，才會分別落在左右兩側。
        const header = document.createElement('div');
        header.className = 'cwfm-panel-header';

        const title = document.createElement('h3');
        title.textContent = '\u95B1\u8B80\u8A2D\u5B9A'; // 閱讀設定
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'cwfm-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', closeAllPanels);
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // 欄位都塞進這個容器，多欄排版（column-count）只套用在這個容器上。
        const fieldsWrap = document.createElement('div');
        fieldsWrap.className = 'cwfm-fields-wrap';
        panel.appendChild(fieldsWrap);
        const panelTarget = fieldsWrap; // add*Field() 系列函式改成往這裡塞

        function addTextField(labelText, key, placeholder) {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            const label = document.createElement('label');
            label.textContent = labelText;
            field.appendChild(label);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = settings[key] || '';
            if (placeholder) input.placeholder = placeholder;
            input.addEventListener('input', () => {
                settings[key] = input.value;
                saveSettings(settings);
                applySettings(settings);
            });
            field.appendChild(input);
            panelTarget.appendChild(field);
            return input;
        }

        function addRangeField(labelText, key, min, max, step, unitSuffix) {
            const field = document.createElement('div');
            field.className = 'cwfm-field';

            const row = document.createElement('div');
            row.className = 'cwfm-row';
            const label = document.createElement('label');
            label.textContent = labelText;
            row.appendChild(label);

            // [cwfm] 數值顯示改成可編輯的數字輸入框，不再是純顯示用的
            // <span>——使用者除了拖滑桿，也可以直接打數字調整。用一個小
            // 容器把輸入框跟單位文字包起來，維持原本的排版位置。
            const valueWrap = document.createElement('span');
            valueWrap.className = 'cwfm-value-input-wrap';
            const valueInput = document.createElement('input');
            valueInput.type = 'number';
            valueInput.className = 'cwfm-value-input';
            valueInput.min = String(min);
            valueInput.max = String(max);
            valueInput.step = String(step);
            valueInput.value = String(settings[key]);
            const unitSpan = document.createElement('span');
            unitSpan.textContent = unitSuffix || '';
            valueWrap.appendChild(valueInput);
            valueWrap.appendChild(unitSpan);
            row.appendChild(valueWrap);
            field.appendChild(row);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = String(min);
            slider.max = String(max);
            slider.step = String(step);
            slider.value = String(settings[key]);

            function commit(val) {
                // 夾在 min/max 範圍內，避免使用者手動輸入超出範圍的數字
                const clamped = Math.min(max, Math.max(min, val));
                settings[key] = clamped;
                slider.value = String(clamped);
                valueInput.value = String(clamped);
                saveSettings(settings);
                applySettings(settings);
            }

            slider.addEventListener('input', () => commit(parseFloat(slider.value)));
            valueInput.addEventListener('change', () => {
                const val = parseFloat(valueInput.value);
                if (Number.isNaN(val)) { valueInput.value = String(settings[key]); return; }
                commit(val);
            });

            field.appendChild(slider);
            panelTarget.appendChild(field);
            return slider;
        }

        function addCheckboxField(labelText, key) {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            const row = document.createElement('div');
            row.className = 'cwfm-row';
            const label = document.createElement('label');
            label.textContent = labelText;
            row.appendChild(label);
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!settings[key];
            input.addEventListener('change', () => {
                settings[key] = input.checked;
                saveSettings(settings);
                applySettings(settings);
            });
            row.appendChild(input);
            field.appendChild(row);
            panelTarget.appendChild(field);
            return input;
        }

        function addSelectField(labelText, key, options) {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            const label = document.createElement('label');
            label.textContent = labelText;
            field.appendChild(label);
            const select = document.createElement('select');
            options.forEach(([value, text]) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = text;
                if (settings[key] === value) opt.selected = true;
                select.appendChild(opt);
            });
            select.addEventListener('change', () => {
                settings[key] = select.value;
                saveSettings(settings);
                applySettings(settings);
            });
            field.appendChild(select);
            panelTarget.appendChild(field);
            return select;
        }

        function addColorField(labelText, key) {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            const row = document.createElement('div');
            row.className = 'cwfm-row';
            const label = document.createElement('label');
            label.textContent = labelText;
            row.appendChild(label);

            // [cwfm] 不用原生 <input type="color">，改成一個色塊按鈕，點下去
            // 開啟自訂取色器（openColorPicker，移植自 YouTube Channel Memory）。
            const swatchBtn = document.createElement('button');
            swatchBtn.type = 'button';
            swatchBtn.className = 'cwfm-color-swatch-btn';
            swatchBtn.style.background = settings[key];
            swatchBtn.addEventListener('click', () => {
                openColorPicker(settings[key], (hex) => {
                    settings[key] = hex;
                    swatchBtn.style.background = hex;
                    // 理由同前：自訂顏色欄位跟「佈景主題」下拉選單是分開的
                    // 兩個 UI 元件，只有選「自訂」時這兩個顏色才會真正套用，
                    // 選色時自動把 themeName 也一併切成 custom。
                    if (settings.themeName !== 'custom') {
                        settings.themeName = 'custom';
                        if (themeSelect) themeSelect.value = 'custom';
                    }
                    saveSettings(settings);
                    applySettings(settings);
                });
            });
            row.appendChild(swatchBtn);
            field.appendChild(row);
            panelTarget.appendChild(field);
            return swatchBtn;
        }

        // [cwfm] 佈景主題：先給幾個常用配色，auto 是預設值（跟隨系統深色
        // 模式，不特別指定顏色）。custom 選項另外顯示兩個顏色選擇器，讓
        // 使用者自訂文字/背景顏色。
        const themeSelect = addSelectField('\u4f48\u666f\u4e3b\u984c', 'themeName', [
            ['auto', '\u8ddf\u96a8\u7cfb\u7d71'],
            ['light', '\u4eae\u8272'],
            ['dark', '\u6697\u8272'],
            ['sepia', '\u5fa9\u53e4\u9ec3'],
            ['custom', '\u81ea\u8a02'],
        ]);
        addColorField('\u81ea\u8a02\u6587\u5b57\u984f\u8272', 'customTextColor');
        addColorField('\u81ea\u8a02\u80cc\u666f\u984f\u8272', 'customBackgroundColor');
        addCheckboxField('\u512a\u5148\u5957\u7528\u66f8\u7c4d\u539f\u59cb\u6587\u5b57\u6a23\u5f0f\uff08\u4e0d\u5f37\u5236\u8986\u84cb\u6587\u5b57\u984f\u8272\uff09', 'preferOriginalTextColor');

        addTextField('\u5B57\u9AD4\uFF08\u8F38\u5165\u672C\u6A5F\u5DF2\u5B89\u88DD\u7684\u5B57\u9AD4\u540D\u7A31\uFF09', 'fontFamily', '\u4F8B\u5982\uFF1ATC_JBMM_1111');
        addRangeField('\u5B57\u7D1A', 'fontSize', 70, 200, 5, '%');
        addRangeField('\u5B57\u8DDD', 'letterSpacing', -0.05, 0.3, 0.01, 'em');
        addRangeField('\u884C\u8DDD', 'lineSpacing', 1, 2.5, 0.1, '');
        addCheckboxField('\u5169\u7AEF\u5C0D\u9F4A', 'justify');
        addCheckboxField('\u81EA\u52D5\u65B7\u5B57', 'hyphenate');
        // [cwfm] 查證後確認：詞彙替換字型（用 ccmp 這個 OpenType 機制把
        // 簡體詞彙替換成繁體詞彙）跟一般裝飾用連字，在瀏覽器眼中是同一套
        // 機制，沒有天生的區分方式，只能整組一起開關。開著的話詞彙替換
        // 正常運作，但可能導致特定詞彙間距比周圍窄；關掉則間距完全均勻，
        // 但字型的詞彙替換功能也會一併失效。預設不關閉（保留詞彙替換），
        // 讓使用者自己決定要不要犧牲間距換取替換失效。
        addCheckboxField('\u95dc\u9589\u9023\u5b57\uff08\u53ef\u80fd\u4f7f\u8a5e\u5f59\u66ff\u63db\u5b57\u578b\u5931\u6548\uff09', 'disableLigatures');
        addSelectField('\u7FFB\u9801\u6A21\u5F0F', 'flow', [
            ['paginated', '\u5206\u9801'],
            ['scrolled', '\u6372\u52D5'],
        ]);
        // [cwfm] 上下留白最小值放回 0：先前一度鎖在 4，理由是「margin=0
        // 會導致上下貼邊、不對稱」，但後來查出 margin 因為缺少 px 單位
        // 從頭到尾就沒有真正生效過（唯一例外是 0，因為 0 是 CSS 裡合法的
        // 無單位長度）——當初觀察到的「只有 0 會貼邊」，其實是「只有 0
        // 有生效」的假象，那個結論的前提不成立，所以把限制放回來。
        //
        // 最大值改成動態計算：以 renderer 目前的實際尺寸的一半為上限，
        // 不再寫死 120——不同螢幕大小，「合理的最大留白」本來就不一樣，
        // 寫死的數字在小螢幕上可能太大、在大螢幕上可能太小。
        const rendererRect = view.renderer.getBoundingClientRect();
        const maxTopBottomPadding = Math.max(20, Math.floor(rendererRect.height / 2));
        const maxLeftRightPadding = Math.max(20, Math.floor(rendererRect.width / 2));
        addRangeField('\u4e0a\u4e0b\u7559\u767d', 'topBottomPadding', 0, maxTopBottomPadding, 1, 'px');
        addRangeField('\u5de6\u53f3\u7559\u767d', 'leftRightPadding', 0, maxLeftRightPadding, 1, 'px');
        addRangeField('\u6700\u5927\u6B04\u6578', 'maxColumnCount', 1, 4, 1, '');

        // [cwfm] 三個進度記憶功能各自獨立、各有各的開關，不要混在一起：
        // 功能一（本機自動記憶）、功能三（停留自動同步）都是設定選單裡的
        // 開關；功能二（手動同步）不需要開關，是工具列上的按鈕，使用者
        // 按下去才會觸發，本來就是主動行為，不需要另外開關控制。
        addCheckboxField('\u672c\u6a5f\u81ea\u52d5\u8a18\u61b6\u95b1\u8b80\u9032\u5ea6\uff08\u7ffb\u9801\u5373\u6642\u5b58\u9032\u9019\u53f0\u700f\u89bd\u5668\uff0c\u4e0d\u540c\u88dd\u7f6e\u4e0d\u6703\u540c\u6b65\uff09', 'localAutoRemember');
        addCheckboxField('\u505c\u7559\u5f8c\u81ea\u52d5\u540c\u6b65\u5230\u4f3a\u670d\u5668\uff08\u9700\u8981 CSRF token \u9001\u8acb\u6c42\uff0c\u8de8\u88dd\u7f6e\u53ef\u8b80\u5230\uff09', 'autoSyncEnabled');
        addRangeField('\u505c\u7559\u5e7e\u79d2\u5f8c\u540c\u6b65', 'autoSyncDelaySeconds', 1, 60, 1, '\u79d2');

        document.body.appendChild(panel);

        // [cwfm] 依可用高度自動決定欄數：用 CSS column-count 讓內容自然依序
        // 流入多欄，不用自己手動分配每個欄位該放哪些項目。套用在
        // fieldsWrap（不含標題列）上，標題列永遠維持橫跨整個面板寬度。
        // 迴圈不設欄數上限，量到「當下這個欄數配置」實際排出來的高度，
        // 還是超過可用高度就再加一欄，直到放得下為止（設一個防呆用的
        // 安全上限，避免極端情況下無限迴圈，不是刻意設計的欄數上限）。
        try {
            const headerHeight = header.getBoundingClientRect().height;
            const availableHeight = window.innerHeight - 88 - headerHeight - 36; // 36 是面板自己的上下 padding
            const COLUMN_WIDTH = 300;
            const SAFETY_MAX_COLUMNS = 8;
            let columnCount = 1;
            fieldsWrap.style.columnCount = '1';
            fieldsWrap.style.width = COLUMN_WIDTH + 'px';
            while (fieldsWrap.scrollHeight > availableHeight && columnCount < SAFETY_MAX_COLUMNS) {
                columnCount += 1;
                fieldsWrap.style.columnCount = String(columnCount);
                fieldsWrap.style.width = (COLUMN_WIDTH * columnCount) + 'px';
            }
            panel.style.width = (COLUMN_WIDTH * columnCount + 36) + 'px';
        } catch (e) {
            console.error('[cwfm:settings] 自動排版失敗', e);
        }

        applySettings(settings);
        return panel;
    }

    // ============================================================
    // 目錄側邊欄
    // ============================================================
    function buildTOCPanel() {
        const panel = document.createElement('div');
        panel.className = 'cwfm-panel';
        panel.dataset.side = 'left';
        panel.dataset.cwfmOwned = 'true';

        const header = document.createElement('div');
        header.className = 'cwfm-panel-header';

        const title = document.createElement('h3');
        title.textContent = '\u76EE\u9304'; // 目錄
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'cwfm-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', closeAllPanels);
        header.appendChild(closeBtn);

        panel.appendChild(header);

        const toc = book?.toc;
        if (!toc || !toc.length) {
            const hint = document.createElement('div');
            hint.className = 'cwfm-empty-hint';
            hint.textContent = '\u9019\u672C\u66F8\u6C92\u6709\u76EE\u9304\u8CC7\u6599';
            panel.appendChild(hint);
        } else {
            const onclick = (href) => {
                // [cwfm] 查證 view.js 原始碼後確認：view.goTo(target) 內部
                // 自己會呼叫 resolveNavigation()/book.resolveHref() 處理傳進去
                // 的原始 href 字串。這裡原本多此一舉先呼叫了一次
                // book.resolveHref(href)，把「已經解析過的物件」又傳給
                // goTo()，導致它把物件當成原始字串去呼叫不存在的 .split()
                // 而整個跳轉失敗（實測 Console 錯誤：t.split is not a
                // function）。改成直接把原始 href 字串交給 goTo()。
                try {
                    view.goTo(href);
                } catch (e) {
                    console.error('[cwfm:toc] 跳轉失敗', e);
                }
                closeAllPanels();
            };
            const { element, setCurrentHref } = window.__cwfm.createTOCView(toc, onclick);
            element.classList.add('cwfm-toc-view');
            panel.appendChild(element);

            view.addEventListener('relocate', (e) => {
                try { setCurrentHref(e.detail?.tocItem?.href); } catch (err) { /* 忽略，目錄高亮不是關鍵功能 */ }
            });
        }

        document.body.appendChild(panel);
        return panel;
    }

    // ============================================================
    // 底部工具列：上一頁 / 下一頁 / 進度條 / 目錄按鈕 / 設定按鈕
    // ============================================================
    // [cwfm] 圖示：取自 Feather Icons（MIT 授權的通用幾何圖示集，不是任何
    // 品牌商標），比純文字按鈕更符合一般操作介面的慣例。
    const ICONS = {
        list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        bookmarkOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
        bookmarkFilled: '<svg viewBox="0 0 24 24" fill="#e33" stroke="#e33" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
        maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
        minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    };

    function buildToolbar(tocPanel, settingsPanel) {
        const bar = document.createElement('div');
        bar.className = 'cwfm-toolbar';
        bar.dataset.cwfmOwned = 'true';

        const prevBtn = document.createElement('button');
        prevBtn.textContent = '\u2039';
        prevBtn.setAttribute('aria-label', 'Previous page');
        prevBtn.addEventListener('click', () => {
            try { view.goLeft(); } catch (e) { console.error('[cwfm:toolbar] goLeft 失敗', e); }
        });
        bar.appendChild(prevBtn);

        const progressWrap = document.createElement('div');
        progressWrap.className = 'cwfm-progress-wrap';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = 'any';
        slider.value = '0';
        const progressLabel = document.createElement('span');
        progressLabel.className = 'cwfm-progress-label';
        progressLabel.textContent = '0%';
        let sliderDragging = false;
        slider.addEventListener('input', () => {
            sliderDragging = true;
            progressLabel.textContent = Math.round(parseFloat(slider.value) * 100) + '%';
        });
        slider.addEventListener('change', () => {
            try { view.goToFraction(parseFloat(slider.value)); }
            catch (e) { console.error('[cwfm:toolbar] goToFraction 失敗', e); }
            sliderDragging = false;
        });
        progressWrap.appendChild(slider);
        progressWrap.appendChild(progressLabel);
        bar.appendChild(progressWrap);

        const nextBtn = document.createElement('button');
        nextBtn.textContent = '\u203A';
        nextBtn.setAttribute('aria-label', 'Next page');
        nextBtn.addEventListener('click', () => {
            try { view.goRight(); } catch (e) { console.error('[cwfm:toolbar] goRight 失敗', e); }
        });
        bar.appendChild(nextBtn);

        document.body.appendChild(bar);

        // 依 relocate 事件同步進度條與百分比顯示（使用者正在拖曳時不要被蓋過去）
        view.addEventListener('relocate', (e) => {
            if (sliderDragging) return;
            const fraction = e.detail?.fraction;
            if (typeof fraction === 'number') {
                slider.value = String(fraction);
                progressLabel.textContent = Math.round(fraction * 100) + '%';
            }
        });

        return bar;
    }

    // [cwfm] 上方工具列：目錄、設定、書籤、全螢幕，比照一般 EPUB 閱讀器
    // 的慣例（查證官方 reader.html 結構，這些操作型按鈕本來就是放在上方，
    // 進度條這種「顯示狀態」的元件才放下方）。
    function buildTopToolbar(tocPanel, settingsPanel) {
        const bar = document.createElement('div');
        bar.className = 'cwfm-toolbar-top';
        bar.dataset.cwfmOwned = 'true';

        const tocBtn = document.createElement('button');
        tocBtn.innerHTML = ICONS.list;
        tocBtn.setAttribute('aria-label', '\u76EE\u9304');
        tocBtn.addEventListener('click', () => openPanel(tocPanel));
        bar.appendChild(tocBtn);

        const spacer = document.createElement('div');
        spacer.className = 'cwfm-toolbar-top-spacer';
        bar.appendChild(spacer);

        // 書籤：查證原版 reading/epub.js 的慣例後確認，有存書籤是實心（這裡
        // 用紅色），沒有則是空心的鏤空圖示。
        //
        // [cwfm] 精確比對「目前顯示的位置」是不是剛好等於已存的伺服器書籤
        // ——不是「這本書有沒有存過書籤」這種粗略狀態。用
        // currentServerBookmarkCfi 記住目前伺服器書籤實際的 CFI 字串值
        // （不只是布林值），每次 relocate 都拿目前位置去精確比對：
        // 相符才顯示紅色，一旦翻頁離開（不再相符）就變回空心。
        // 初始值從網址列的 #epubcfi(...) 片段取得（Calibre-Web 開書時
        // 如果這本書已有伺服器書籤，會自動帶在網址上）。
        let currentServerBookmarkCfi = location.hash.startsWith('#epubcfi(')
            ? decodeURIComponent(location.hash.slice(1))
            : null;

        const bookmarkBtn = document.createElement('button');
        function isCurrentLocationBookmarked() {
            const cfi = view.lastLocation?.cfi;
            if (!cfi || !currentServerBookmarkCfi) return false;
            return wrapCfi(cfi) === currentServerBookmarkCfi;
        }
        function renderBookmarkIcon() {
            bookmarkBtn.innerHTML = isCurrentLocationBookmarked() ? ICONS.bookmarkFilled : ICONS.bookmarkOutline;
        }
        renderBookmarkIcon();
        bookmarkBtn.setAttribute('aria-label', '\u66f8\u7c64');
        bookmarkBtn.addEventListener('click', () => {
            const cfi = view.lastLocation?.cfi;
            if (!cfi) {
                console.warn('[cwfm:toolbar] 還沒有可同步的位置');
                return;
            }
            if (isCurrentLocationBookmarked()) {
                // (c) 已經是紅色書籤，按下去立刻取消
                removeServerBookmark()
                    .then(() => {
                        currentServerBookmarkCfi = null;
                        renderBookmarkIcon();
                    })
                    .catch((e) => console.error('[cwfm:toolbar] 移除書籤失敗', e));
            } else {
                // (b) 目前這頁沒有書籤，按下去立刻存成新書籤（同時只能有
                // 一個，這裡存了之後，原本別頁的書籤自然就不再相符、
                // 下次切過去會自動變回空心，不用另外處理）
                syncBookmarkToServer(cfi)
                    .then(() => {
                        currentServerBookmarkCfi = wrapCfi(cfi);
                        renderBookmarkIcon();
                    })
                    .catch((e) => console.error('[cwfm:toolbar] 書籤同步失敗', e));
            }
        });
        // (a) 翻頁時即時重新比對，離開已存書籤的那一頁就變回空心
        view.addEventListener('relocate', renderBookmarkIcon);
        bar.appendChild(bookmarkBtn);

        const settingsBtn = document.createElement('button');
        settingsBtn.innerHTML = ICONS.settings;
        settingsBtn.setAttribute('aria-label', '\u8A2D\u5B9A');
        settingsBtn.addEventListener('click', () => openPanel(settingsPanel));
        bar.appendChild(settingsBtn);

        const fullscreenBtn = document.createElement('button');
        function renderFullscreenIcon() {
            fullscreenBtn.innerHTML = document.fullscreenElement ? ICONS.minimize : ICONS.maximize;
        }
        renderFullscreenIcon();
        fullscreenBtn.setAttribute('aria-label', '\u5168\u87A2\u5E55');
        fullscreenBtn.addEventListener('click', () => {
            try {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    document.documentElement.requestFullscreen();
                }
            } catch (e) {
                console.error('[cwfm:toolbar] 全螢幕切換失敗', e);
            }
        });
        document.addEventListener('fullscreenchange', renderFullscreenIcon);
        bar.appendChild(fullscreenBtn);

        document.body.appendChild(bar);
        return bar;
    }

    let tocPanel, settingsPanel, toolbar, topToolbar;
    try { tocPanel = buildTOCPanel(); } catch (e) { console.error('[cwfm:toc] 建立目錄面板失敗', e); }
    try { settingsPanel = buildSettingsPanel(); } catch (e) { console.error('[cwfm:settings] 建立設定面板失敗', e); }
    try { toolbar = buildToolbar(tocPanel, settingsPanel); } catch (e) { console.error('[cwfm:toolbar] 建立工具列失敗', e); }
    try { topToolbar = buildTopToolbar(tocPanel, settingsPanel); } catch (e) { console.error('[cwfm:toolbar] 建立上方工具列失敗', e); }

    console.log('[cwfm] Calibre-Web Foliate Reader Mod 已接管閱讀器，書籍 ID：', BOOK_ID);
})();
