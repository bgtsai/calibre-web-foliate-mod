;(async () => {
    const VIEWER_SELECTOR = '__VIEWER_SELECTOR__';
    const BOOK_ID = '__BOOK_ID__';
    const STORAGE_KEY = 'cwfm-settings';
    const POSITION_KEY = 'cwfm-position-' + BOOK_ID;

    // [cwfm] 儲存機制改用 Tampermonkey 的 GM_setValue/GM_getValue，不再用
    // localStorage（理由：GM 儲存跟著腳本走、方便備份與跨電腦同步，不像
    // localStorage 綁在網站網域上、容易被清瀏覽器資料時一併清掉）。
    //
    // 這兩個常數是外層有 @grant 的腳本，在插入這段程式碼「之前」就先用
    // GM_getValue 讀好、直接把值嵌進來的（外層程式碼用字串取代
    // "__INITIAL_SETTINGS__"／"__INITIAL_POSITION__" 這兩個佔位字串，
    // 取代後這裡看到的就已經是真正的 JS 值，不是字串，不用再 JSON.parse
    // 一次）。因為 GM_setValue/GM_getValue 只有外層有特權的腳本能呼叫，
    // 這段頁面環境的程式碼沒辦法直接呼叫，讀取用這種「先嵌好」的方式
    // 繞過去；寫入則用 gmSet() 發自訂事件，外層腳本監聽到才真的呼叫
    // GM_setValue（fire-and-forget，不需要同步等回應）。
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
            '#viewer { width: 100% !important; height: calc(100% - 44px) !important; margin: 0 !important; }',
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
    function syncBookmarkToServer(cfi) {
        const wrapped = wrapCfi(cfi);
        if (!wrapped) return Promise.reject(new Error('沒有目前位置可以同步'));
        return fetch('/ajax/bookmark/' + BOOK_ID + '/epub', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': getCsrfToken(),
            },
            body: 'bookmark=' + encodeURIComponent(wrapped),
        }).then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            console.log('[cwfm:bookmark] 已同步到伺服器：', wrapped);
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
            '.cwfm-panel {',
            '  position: fixed; top: 0; bottom: 0; width: 320px; max-width: 85vw;',
            '  background: #1e1e1e; color: #eee; z-index: 1000000;',
            '  box-shadow: 0 0 24px rgba(0,0,0,0.6);',
            '  overflow-y: auto; padding: 18px; box-sizing: border-box;',
            '  font-family: sans-serif; font-size: 13px;',
            '  transition: transform 0.2s ease;',
            '}',
            '.cwfm-panel[data-side="left"] { left: 0; transform: translateX(-105%); }',
            '.cwfm-panel[data-side="left"].cwfm-open { transform: translateX(0); }',
            '.cwfm-panel[data-side="right"] { right: 0; transform: translateX(105%); }',
            '.cwfm-panel[data-side="right"].cwfm-open { transform: translateX(0); }',
            '.cwfm-panel h3 { margin: 0 0 12px; font-size: 15px; border-bottom: 1px solid #444; padding-bottom: 8px; }',
            '.cwfm-panel label { display: block; margin: 14px 0 4px; font-size: 12px; color: #aaa; }',
            '.cwfm-panel input[type="text"], .cwfm-panel input[type="number"] {',
            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',
            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',
            '  font-size: 13px;',
            '}',
            '.cwfm-panel input[type="range"] { width: 100%; }',
            '.cwfm-panel .cwfm-row { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 4px; }',
            '.cwfm-panel .cwfm-row label { margin: 0; }',
            '.cwfm-panel select {',
            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',
            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',
            '  font-size: 13px;',
            '}',
            '.cwfm-close-btn {',
            '  position: absolute; top: 12px; right: 12px; background: none; border: none;',
            '  color: #aaa; font-size: 18px; cursor: pointer; line-height: 1;',
            '}',
            '.cwfm-close-btn:hover { color: #fff; }',
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
            const totalHeight = rendererRect.height || 1;
            const topPercent = (settings.topBottomPadding / totalHeight) * 100;
            divider.style.top = topPercent + '%';
            divider.style.height = (100 - topPercent * 2) + '%';
            divider.classList.toggle('cwfm-show', settings.maxColumnCount >= 2 && settings.flow === 'paginated');
        } catch (e) {
            console.error('[cwfm:divider] 更新分隔線位置失敗', e);
        }
    }

    // 讓工具列/面板不要蓋住書本內容：#viewer 底部留一點空間
    try { viewerContainer.style.paddingBottom = '44px'; } catch (e) { console.error('[cwfm:layout]', e); }

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
        return [
            '@namespace epub "http://www.idpf.org/2007/ops";',
            'html { color-scheme: light dark; }',
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

    function buildSettingsPanel() {
        const settings = loadSettings();

        const panel = document.createElement('div');
        panel.className = 'cwfm-panel';
        panel.dataset.side = 'right';
        panel.dataset.cwfmOwned = 'true';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'cwfm-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', closeAllPanels);
        panel.appendChild(closeBtn);

        const title = document.createElement('h3');
        title.textContent = '\u95B1\u8B80\u8A2D\u5B9A'; // 閱讀設定
        panel.appendChild(title);

        function addTextField(labelText, key, placeholder) {
            const label = document.createElement('label');
            label.textContent = labelText;
            panel.appendChild(label);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = settings[key] || '';
            if (placeholder) input.placeholder = placeholder;
            input.addEventListener('input', () => {
                settings[key] = input.value;
                saveSettings(settings);
                applySettings(settings);
            });
            panel.appendChild(input);
            return input;
        }

        function addRangeField(labelText, key, min, max, step, unitSuffix) {
            const row = document.createElement('div');
            row.className = 'cwfm-row';
            const label = document.createElement('label');
            label.textContent = labelText;
            const valueSpan = document.createElement('span');
            valueSpan.textContent = settings[key] + (unitSuffix || '');
            row.appendChild(label);
            row.appendChild(valueSpan);
            panel.appendChild(row);

            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(settings[key]);
            input.addEventListener('input', () => {
                const val = parseFloat(input.value);
                settings[key] = val;
                valueSpan.textContent = val + (unitSuffix || '');
                saveSettings(settings);
                applySettings(settings);
            });
            panel.appendChild(input);
            return input;
        }

        function addCheckboxField(labelText, key) {
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
            panel.appendChild(row);
            return input;
        }

        function addSelectField(labelText, key, options) {
            const label = document.createElement('label');
            label.textContent = labelText;
            panel.appendChild(label);
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
            panel.appendChild(select);
            return select;
        }

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

        const closeBtn = document.createElement('button');
        closeBtn.className = 'cwfm-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', closeAllPanels);
        panel.appendChild(closeBtn);

        const title = document.createElement('h3');
        title.textContent = '\u76EE\u9304'; // 目錄
        panel.appendChild(title);

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
    function buildToolbar(tocPanel, settingsPanel) {
        const bar = document.createElement('div');
        bar.className = 'cwfm-toolbar';
        bar.dataset.cwfmOwned = 'true';

        const tocBtn = document.createElement('button');
        tocBtn.textContent = '\u76EE\u9304'; // 目錄
        tocBtn.addEventListener('click', () => openPanel(tocPanel));
        bar.appendChild(tocBtn);

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

        const settingsBtn = document.createElement('button');
        settingsBtn.textContent = '\u8A2D\u5B9A'; // 設定
        settingsBtn.addEventListener('click', () => openPanel(settingsPanel));
        bar.appendChild(settingsBtn);

        // 功能二：手動同步到伺服器。不需要開關，按下去才會觸發，本來就是
        // 主動行為。用 view.lastLocation（公開屬性）取得目前位置，不用
        // 另外自己追蹤一份重複的狀態。
        const syncBtn = document.createElement('button');
        syncBtn.textContent = '\u5b58\u5230\u4f3a\u670d\u5668'; // 存到伺服器
        syncBtn.addEventListener('click', () => {
            const cfi = view.lastLocation?.cfi;
            if (!cfi) {
                console.warn('[cwfm:toolbar] 還沒有可同步的位置');
                return;
            }
            const original = syncBtn.textContent;
            syncBookmarkToServer(cfi)
                .then(() => {
                    syncBtn.textContent = '\u5df2\u5b58\u5165 \u2713';
                    setTimeout(() => { syncBtn.textContent = original; }, 1500);
                })
                .catch((e) => {
                    console.error('[cwfm:toolbar] 手動同步失敗', e);
                    syncBtn.textContent = '\u5931\u6557';
                    setTimeout(() => { syncBtn.textContent = original; }, 1500);
                });
        });
        bar.appendChild(syncBtn);

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

    let tocPanel, settingsPanel, toolbar;
    try { tocPanel = buildTOCPanel(); } catch (e) { console.error('[cwfm:toc] 建立目錄面板失敗', e); }
    try { settingsPanel = buildSettingsPanel(); } catch (e) { console.error('[cwfm:settings] 建立設定面板失敗', e); }
    try { toolbar = buildToolbar(tocPanel, settingsPanel); } catch (e) { console.error('[cwfm:toolbar] 建立工具列失敗', e); }

    console.log('[cwfm] Calibre-Web Foliate Reader Mod 已接管閱讀器，書籍 ID：', BOOK_ID);
})();
