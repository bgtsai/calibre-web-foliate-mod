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
            // [cwfm] #main 原本(Calibre-Web 自己的 main.css)背景是純白色
            // （background:#fff），我們自己的程式碼從沒蓋過這個背景——查證
            // 用戶回報的「工具列上緣有一條白線」問題時發現：我們的工具列
            // 背景帶透明度（rgba(24,24,24,0.92)，不是純黑），只要跟深色
            // 內容之間有一絲縫隙（次像素誤差），底下這層白色就會透出來，
            // 形成那條線。改成深色，縫隙透出來的也是深色，不會再看到白線。
            //
            // [cwfm] #main 另外還帶了一圈原本(Calibre-Web 自己)就有的
            // 向內凹陷陰影（box-shadow: ... inset），我們從沒動過——這是
            // 使用者截圖回報「工具列自動隱藏後留下圓角灰色殘影」真正的
            // 根因：平常被我們近乎不透明的工具列蓋住看不到，工具列滑走
            // 之後第一次露出來。這裡一併明確歸零（動態版本在
            // applySettings() 裡，跟背景色一起用行內樣式更新；這條
            // 静態規則只當作還沒執行到動態版本之前的預設值）。
            '#main { background: #1a1a1a !important; box-shadow: none !important; }',
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

    // [cwfm] 關閉鈕用 SVG 畫叉叉，不用文字字元「✕」——文字字元置中位置會
    // 隨作業系統/瀏覽器的字型度量跑掉（實測在不同環境偏差明顯），SVG 用
    // 固定座標系統畫兩條交叉線，任何環境都精準置中。
    //
    // [cwfm] 線的端點內縮到 (3.5,3.5)~(10.5,10.5)（原本是幾乎頂到畫布邊緣
    // 的 (1,1)~(13,13)）：實測比對過新舊兩版截圖，原本文字字元「✕」在
    // 14px 字級下，墨跡本來就填不滿整個字級方框（一般字型字面通常只佔
    // 六七成），換成 SVG 後若线画到接近边缘，墨跡量會明顯變多、看起來
    // 變大——這裡縮小端點範圍，讓墨跡量貼近舊版文字字元的視覺大小，同時
    // 保留 SVG 不受字型影響、精準置中的好處。
    const CWFM_CLOSE_ICON_SVG = '<svg viewBox="0 0 14 14" width="14" height="14" style="display:block;pointer-events:none;">'
        + '<line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
        + '<line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
        + '</svg>';
    function createCloseBtn(onClick) {
        const btn = document.createElement('button');
        btn.className = 'cwfm-close-btn';
        btn.innerHTML = CWFM_CLOSE_ICON_SVG;
        btn.addEventListener('click', onClick);
        return btn;
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
            // [cwfm] 伺服器端的書籤 CFI 不在網址 hash 裡（location.hash 實測
            // 是空字串），是 Calibre-Web 用 Jinja2 模板注入的全域變數
            // `calibre.bookmark`。typeof 判斷是保險：我們是 document-start
            // 執行，理論上會排在頁面內嵌 script 之後才跑到這裡，但沒有
            // 100% 把握，讀不到就當作沒有伺服器書籤，不要整個掛掉。
            const serverBookmark = (typeof calibre !== 'undefined' && calibre && calibre.bookmark) || '';
            if (serverBookmark && serverBookmark.startsWith('epubcfi(')) {
                try {
                    await view.goTo(serverBookmark);
                    restored = true;
                    console.log('[cwfm:bookmark] 已還原伺服器書籤位置：', serverBookmark);
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
        // [cwfm] 定位點對齊操作進行中（搬走/接回原始內容那段期間），這裡
        // 先不寫入——那段期間算出來的 cfi 是資料量被動過手腳當下的暫時
        // 值，寫進去會存到錯的位置。等操作結束、真正確定的新位置出來，
        // 才會有下一次正常的 relocate 觸發寫入。
        if (cwfmAligningAnchor) return;
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
        // [cwfm] 同上，定位點對齊操作進行中不要用這個當下的 cfi 起算同步
        // 倒數，理由跟上面本機記憶那段一樣。
        if (cwfmAligningAnchor) return;
        const settings = window.__cwfm.settings;
        clearTimeout(autoSyncTimer);
        if (!settings || !settings.autoSyncEnabled) return;
        const cfi = e.detail?.cfi;
        if (!cfi) return;
        const delayMs = Math.max(1, settings.autoSyncDelaySeconds || 5) * 1000;
        autoSyncTimer = setTimeout(() => {
            syncBookmarkToServer(cfi)
                .then(() => {
                    // [cwfm] 同步成功後要通知書籤圖示重畫（空心→紅色），
                    // 但 currentServerBookmarkCfi/renderBookmarkIcon 是
                    // buildToolbar() 裡的區域變數，這裡碰不到，透過
                    // window.__cwfm 這個既有的共用空間搭一個窗口——
                    // buildToolbar() 建立時會把實際的更新函式塞進
                    // onBookmarkSynced，這裡呼叫之前先判斷存不存在（工具
                    // 列可能還沒建好，或建立失敗），避免噴錯。
                    window.__cwfm.onBookmarkSynced?.(cfi);
                })
                .catch((err) =>
                    console.error('[cwfm:bookmark] 停留自動同步失敗', err)
                );
        }, delayMs);
    });

    // ============================================================
    // 鍵盤翻頁（含 iframe 內部文件的轉發，見 v0.8.0 沿革說明）
    // ============================================================
    // [cwfm] 把一次按鍵事件轉成固定格式的字串（例如 'ArrowLeft'、
    // 'Ctrl+Shift+ArrowLeft'），錄製介面跟實際比對翻頁都共用這一個函式，
    // 保證格式一致。純按修飾鍵（還沒按到主鍵）回傳 null，呼叫端要自己
    // 判斷 null 代表「還沒按完，繼續等」，不是「這次按鍵無效」。
    function formatKeyCombo(e) {
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Meta');
        parts.push(e.key);
        return parts.join('+');
    }
    function handleKeydown(e) {
        try {
            const combo = formatKeyCombo(e);
            if (!combo) return;
            // [cwfm] 讀 window.__cwfm.settings 而不是直接讀某個外層變數：
            // 這個函式在 buildSettingsPanel() 建立、也就是 settings 這個
            // 物件真正存在之前就已經註冊監聽了，兩者不在同一個函式作用
            // 域裡，直接引用會找不到變數；用全域共用狀態才能保證讀到
            // 當下最新的設定，還沒套用完成前退回預設值，不會整個失效。
            const pagingKeys = (window.__cwfm && window.__cwfm.settings && window.__cwfm.settings.pagingKeys)
                || DEFAULT_SETTINGS.pagingKeys;
            if (pagingKeys.prev.includes(combo)) cwfmGoLeft();
            else if (pagingKeys.next.includes(combo)) cwfmGoRight();
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
            // ============================================================
            // [cwfm] 深/淺兩套配色，用 CSS 變數統一管理。原本想跟著系統的
            // prefers-color-scheme 自動切換，後來確認這樣不對——面板配色
            // 應該跟著「使用者最後套用的書籍背景色實際的深淺」走（見
            // cwfmUpdatePanelScheme()，套用設定時計算，設在 <html> 的
            // data-cwfm-scheme 屬性上），不是跟著作業系統。變數定義放在
            // :root，不只給設定/目錄面板用，工具列、進度條也要一起跟著
            // 換——原本工具列維持固定深色，跟面板配色對不起來（使用者
            // 截圖回報過這個不一致），這次一起接上同一套變數。色票查證
            // 自 Cal.com 官方設計規格（vibeui.top/design-md/cal），深色版
            // 直接沿用官方 dark 色票；淺色版沒有公開色票的部分（邊界、
            // 陰影），改用它「用陰影模擬邊界」這個手法本身的邏輯（淺色底
            // 用深色調的半透明陰影，跟深色版用淺色調半透明陰影的邏輯
            // 對稱）自己推算，不是憑空編的顏色。
            // ============================================================
            ':root {',
            // [cwfm] 明確告訴瀏覽器「現在是深色情境」——查證過，
            // accent-color 這個屬性實際渲染時會參考 color-scheme 這個
            // 屬性去判斷該用什麼樣的對比色呈現，我們自己的頁面原本完全
            // 沒設這個屬性，瀏覽器很可能還是照系統設定去猜，猜錯就會
            // 導致滑桿圓點看起來還是接近預設值、沒有明顯套用強調色的
            // 效果——這正是使用者回報「圓點顏色沒有變」的根因，不是
            // 顏色值本身沒套用進去。這裡明確跟 data-cwfm-scheme 同步，
            // 不讓瀏覽器自己用系統設定去猜。
            '  color-scheme: dark;',
            '  --cwfm-bg: #0a0a0a; --cwfm-surface: #141414;',
            '  --cwfm-surface-elevated: #1c1c1c; --cwfm-border: #2a2a2a;',
            '  --cwfm-border-light: #333333; --cwfm-text: #e8e8e8;',
            '  --cwfm-text-secondary: #898989; --cwfm-text-muted: #555555;',
            '  --cwfm-shadow-ring: rgba(255,255,255,0.06);',
            '  --cwfm-shadow-soft: rgba(0,0,0,0.3); --cwfm-accent: #0099ff;',
            '  --cwfm-accent-bg: rgba(0,153,255,0.16);',
            '  --cwfm-toolbar-bg: rgba(10,10,10,0.92);',
            '}',
            'html[data-cwfm-scheme="light"] {',
            '  color-scheme: light;',
            '  --cwfm-bg: #ffffff; --cwfm-surface: #ffffff;',
            '  --cwfm-surface-elevated: #f5f5f5; --cwfm-border: rgba(0,0,0,0.12);',
            '  --cwfm-border-light: rgba(0,0,0,0.08); --cwfm-text: #242424;',
            '  --cwfm-text-secondary: #898989; --cwfm-text-muted: #b0b0b0;',
            '  --cwfm-shadow-ring: rgba(0,0,0,0.08);',
            '  --cwfm-shadow-soft: rgba(0,0,0,0.08); --cwfm-accent: #0099ff;',
            '  --cwfm-accent-bg: rgba(0,153,255,0.12);',
            '  --cwfm-toolbar-bg: rgba(255,255,255,0.92);',
            '}',
            '.cwfm-toolbar {',
            '  position: fixed; left: 0; right: 0; bottom: 0;',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 8px 14px; background: var(--cwfm-toolbar-bg);',
            '  color: var(--cwfm-text); font-family: sans-serif; font-size: 13px;',
            '  z-index: 999999; box-sizing: border-box;',
            '  transition: transform 0.3s ease;',
            // [cwfm] 加一點立體感，跟設定面板的分組卡片同一套「陰影模擬
            // 邊界」邏輯——書本背景色是使用者自己選的，理論上有可能剛好
            // 跟工具列的底色很接近，加這層陰影確保不管背景色是什麼，
            // 工具列都能跟書本內容清楚分開，不會糊在一起。往上投影（工具
            // 列貼在畫面下緣），加一條細細的頂邊緣線加強邊界感。深淺兩套
            // 陰影變數本身已經對稱設計過（深色用淺色調陰影、淺色用深色
            // 調陰影），這裡直接沿用，不用另外處理。
            '  box-shadow: 0 -2px 10px var(--cwfm-shadow-soft), 0 -1px 0 var(--cwfm-shadow-ring);',
            '}',
            // [cwfm] 自動隱藏：滑動到邊緣外（不是 display:none，維持
            // transform 位移，這樣才能做滑入/滑出動畫）。上/下工具列各自
            // 往自己所在的那個邊滑出去。
            //
            // [cwfm] 隱藏時額外把 box-shadow 關掉——查了原因：陰影是跟著
            // 元素本身的 transform 一起位移的，工具列往自己所在的那個邊
            // 滑出去之後，原本往「反方向」投影的陰影，換算下來剛好會
            // 落在工具列原本所在的那個位置，變成殘留在原地的一層灰霧，
            // 使用者截圖看到的就是這個。隱藏之後已經沒有東西需要陰影
            // 幫忙跟背景分開，直接關掉最乾淨。
            '.cwfm-toolbar.cwfm-autohidden { transform: translateY(100%); box-shadow: none; }',
            '.cwfm-toolbar-top.cwfm-autohidden { transform: translateY(-100%); box-shadow: none; }',
            // [cwfm] 邊緣感應區：固定貼在螢幕上/下緣的透明區塊，跟工具列
            // 同高，工具列隱藏時仍然貼在原位，用來接住滑鼠移入/點擊喚醒。
            '.cwfm-autohide-zone {',
            '  position: fixed; left: 0; right: 0; height: 44px; z-index: 999998;',
            '}',
            '.cwfm-autohide-zone.cwfm-top { top: 0; }',
            '.cwfm-autohide-zone.cwfm-bottom { bottom: 0; }',
            '.cwfm-toolbar button {',
            '  background: none; border: 1px solid var(--cwfm-border-light); color: var(--cwfm-text);',
            '  border-radius: 4px; padding: 5px 12px; cursor: pointer;',
            '  font-size: 13px; flex: 0 0 auto;',
            '}',
            '.cwfm-toolbar button:hover { background: var(--cwfm-surface-elevated); }',
            '.cwfm-progress-wrap { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; }',
            // [cwfm] 進度條原本完全沒有自訂樣式，瀏覽器原生 <input type="range">
            // 預設外觀（一條顯眼的白色/淺色軌道）就這樣露出來，不是刻意畫的
            // 裝飾線。這裡蓋掉原生外觀，改成跟上方工具列一致、不額外畫線的
            // 樣式（軌道用跟工具列邊框相近的深色，thumb 保留可見即可）。
            '.cwfm-progress-wrap input[type="range"] {',
            '  flex: 1; -webkit-appearance: none; appearance: none; background: transparent; height: 16px;',
            '}',
            '.cwfm-progress-wrap input[type="range"]::-webkit-slider-runnable-track {',
            '  height: 3px; background: var(--cwfm-border-light); border-radius: 2px;',
            '}',
            // [cwfm] 圓點改用強調色，不是中性灰色——查了參考資料，這個
            // 元件（進度條/滑桿的位置指示器）確實沒有涵蓋到，是自己另外
            // 設計的。中性灰色在深淺兩種背景上視覺效果不對稱（深色底顯得
            // 亮、淺色底顯得重），業界代表「目前位置」的滑桿指示器慣例
            // 用強調色，不是灰階——強調色數值深淺模式完全相同，換掉之後
            // 兩種模式下的效果會一致，不會再有深色順眼、淺色卻顯得重的
            // 不對稱狀況。
            '.cwfm-progress-wrap input[type="range"]::-webkit-slider-thumb {',
            '  -webkit-appearance: none; margin-top: -5px;',
            '  width: 13px; height: 13px; border-radius: 50%; background: var(--cwfm-accent); border: none; cursor: pointer;',
            '}',
            '.cwfm-progress-wrap input[type="range"]::-moz-range-track {',
            '  height: 3px; background: var(--cwfm-border-light); border-radius: 2px;',
            '}',
            '.cwfm-progress-wrap input[type="range"]::-moz-range-thumb {',
            '  width: 13px; height: 13px; border-radius: 50%; background: var(--cwfm-accent); border: none; cursor: pointer;',
            '}',
            '.cwfm-progress-label { flex: 0 0 auto; min-width: 3.5em; text-align: right; color: var(--cwfm-text-secondary); font-size: 12px; }',
            // [cwfm] 上方工具列：目錄、書籤、設定、全螢幕，比照一般 EPUB
            // 閱讀器慣例放在上方（下方工具列只留翻頁跟進度條）。
            '.cwfm-toolbar-top {',
            '  position: fixed; left: 0; right: 0; top: 0;',
            '  display: flex; align-items: center; gap: 6px;',
            '  padding: 8px 14px; background: var(--cwfm-toolbar-bg);',
            '  color: var(--cwfm-text); font-family: sans-serif;',
            '  z-index: 999999; box-sizing: border-box;',
            '  transition: transform 0.3s ease;',
            // [cwfm] 跟下方工具列同一套邏輯，方向對稱：往下投影（貼在
            // 畫面上緣），加一條細細的底邊緣線。
            '  box-shadow: 0 2px 10px var(--cwfm-shadow-soft), 0 1px 0 var(--cwfm-shadow-ring);',
            '}',
            '.cwfm-toolbar-top-spacer { flex: 1 1 auto; }',
            '.cwfm-toolbar-top button {',
            '  background: none; border: none; color: var(--cwfm-text);',
            '  border-radius: 4px; padding: 6px; cursor: pointer;',
            '  display: flex; align-items: center; justify-content: center;',
            '}',
            '.cwfm-toolbar-top button:hover { background: var(--cwfm-surface-elevated); }',
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
            '  background: var(--cwfm-bg); color: var(--cwfm-text); z-index: 1000000;',
            '  box-shadow: 0 0 24px rgba(0,0,0,0.6);',
            // [cwfm] padding 從這裡整個拿掉，改分別放到標題列（自己上/左/
            // 右）跟下面的內容區塊（左/右/下）——position:sticky 的子
            // 元素跟「會捲動的容器自己帶 padding」搭在一起，捲動基準點
            // 容易對不齊，導致捲動時內容跑到標題列上面去（已由使用者
            // 截圖回報，這是這類排版已知會踩到的坑）。讓這層容器本身
            // 完全沒有 padding，sticky 的 top:0 才會精準對齊真正的頂端，
            // 沒有模糊地帶。
            '  overflow-y: auto; box-sizing: border-box;',
            '  font-family: sans-serif; font-size: 13px;',
            '  transition: transform 0.2s ease;',
            '}',
            // [cwfm] 標題列獨立成 header 區塊，永遠橫跨整個面板寬度，
            // 不會被下面欄位區塊的多欄排版影響。另外加上 position:sticky，
            // 讓標題列(含關閉按鈕)在面板內容往下捲動時固定在頂端不動——
            // 目錄面板的章節清單有時候很長，原本要關閉面板得先往上捲到
            // 最頂端才點得到關閉按鈕，現在關閉按鈕全程都在，隨時可以點。
            // background 明確設成跟面板本體一樣的顏色，蓋住底下捲動經過
            // 的內容，不會透出來。z-index 確保疊在清單內容之上。padding
            // 補回上/左/右（原本整層容器的 18px），不含下方——下面那條
            // margin-bottom/border-bottom 已經負責跟內容的間隔。
            '.cwfm-panel-header {',
            '  display: flex; align-items: center; justify-content: space-between;',
            '  margin-bottom: 12px; padding: 18px 18px 18px 18px;',
            '  border-bottom: 1px solid var(--cwfm-border);',
            '  position: sticky; top: 0; z-index: 1;',
            '  background: var(--cwfm-bg);',
            '}',
            '.cwfm-panel-header h3 {',
            '  margin: 0; font-size: 15px; line-height: 28px; height: 28px;',
            '  color: var(--cwfm-text);',
            '}',
            // [cwfm] 內容區塊補回左/右/下的 padding（上面已經被標題列自己
            // 的 padding 取代，這裡不用再補一次上）。設定面板的欄位區塊
            // 跟目錄面板的章節清單/空白提示，各自都要補。
            '.cwfm-fields-wrap { column-gap: 24px; padding: 0 18px 18px 18px; }',
            '.cwfm-toc-view { padding: 0 18px 18px 18px; }',
            '.cwfm-empty-hint { padding: 0 18px 18px 18px; }',
            // [cwfm] 分組卡片：把性質相同的欄位包在一起，用「陰影模擬
            // 邊界」取代一般的實線邊框——參考 Cal.com 設計規格
            // （vibeui.top/design-md/cal）裡這個做法：一層極細的環狀陰影
            // 當邊界、一層柔和擴散陰影營造立體感，比單純畫一條線更精緻，
            // 這次深淺兩套配色都用同一套陰影邏輯，只是深淺色調對調
            // （深色底用淺色調陰影、淺色底用深色調陰影）。break-inside:
            // avoid 讓整組盡量不被欄與欄之間的斷點切開；組跟組之間的
            // 間距（20px）明顯大於組內欄位間距（4px），對應 Cal.com
            // 間距階梯裡「一般間距／大區塊間距」的跳躍邏輯，只是數值
            // 等比例縮小到適合這種窄側邊面板的尺寸。
            '.cwfm-group {',
            '  break-inside: avoid; margin-bottom: 20px; padding: 14px;',
            '  border-radius: 10px; background: var(--cwfm-surface);',
            '  box-shadow: 0 0 0 1px var(--cwfm-shadow-ring), 0 1px 3px var(--cwfm-shadow-soft);',
            '}',
            '.cwfm-group:last-child { margin-bottom: 0; }',
            '.cwfm-group-title {',
            '  margin: 0 0 10px; font-size: 11px; font-weight: 600;',
            '  letter-spacing: 0.04em; text-transform: uppercase;',
            '  color: var(--cwfm-text-secondary);',
            '}',
            // [cwfm] 多欄排版時，避免單一欄位（label + 對應的輸入元件）被
            // 欄與欄之間的斷點硬生生切成兩半。每個 addXxxField() 現在都會
            // 把自己的內容包進一個 .cwfm-field 容器，這裡統一套用。
            '.cwfm-field { break-inside: avoid; margin-bottom: 4px; }',
            // [cwfm] 翻頁快速鍵錄製欄位（addKeyListField）：每組已錄製的
            // 按鍵組合顯示成一個小圓角標籤（chip），標籤上自帶一個小小的
            // 刪除按鈕；最後面永遠有一個「+ 新增」按鈕，點下去進入錄製
            // 狀態（樣式沿用同一顆按鈕，只是換文字＋disabled，不用另外
            // 做一個獨立的錄製中樣式）。
            '.cwfm-keylist { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
            '.cwfm-keychip {',
            '  display: inline-flex; align-items: center; gap: 4px;',
            '  background: var(--cwfm-surface-elevated); border: 1px solid var(--cwfm-border-light); border-radius: 4px;',
            '  padding: 3px 4px 3px 8px; font-size: 12px; color: var(--cwfm-text);',
            '}',
            // [cwfm] 上一輪誤以為是 Firefox 特有的焦點外框行為，後來查
            // 出真正原因是選擇器優先權（見 .cwfm-panel .cwfm-keychip-edit
            // 那條的說明），不是瀏覽器行為——這條規則其實不是必要的，
            // 但留著當一層額外的保險，無害。
            '.cwfm-keychip:focus-within { outline: none; box-shadow: none; }',
            '.cwfm-keychip-remove {',
            '  background: none; border: none; color: var(--cwfm-text-secondary); cursor: pointer;',
            '  font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 3px;',
            '}',
            '.cwfm-keychip-remove:hover { color: var(--cwfm-text); background: var(--cwfm-border); }',
            '.cwfm-keychip-add {',
            '  background: none; border: 1px dashed var(--cwfm-border-light); border-radius: 4px;',
            '  color: var(--cwfm-text-secondary); font-size: 12px; padding: 3px 8px; cursor: pointer;',
            '}',
            '.cwfm-keychip-add:hover { color: var(--cwfm-text); border-color: var(--cwfm-text-secondary); }',
            '.cwfm-keychip-add:disabled { color: var(--cwfm-accent); border-color: var(--cwfm-accent); cursor: default; }',
            '.cwfm-keylist-hint { color: #e0a030; font-size: 12px; margin-top: 4px; }',
            // [cwfm] 「藍色」現在統一只代表「目前選中」（見下面
            // .cwfm-keychip-selected），不再另外給上傳字型專屬的藍色
            // 底色——兩種意思疊在同一個顏色上會讓使用者分不清楚「這個
            // 藍色是選中了、還是這是上傳的」。是不是上傳字型，純粹靠
            // 下面的徽章圖示本身判斷。
            // [cwfm] 文字顏色改用跟著深淺模式換的變數，不要寫死白色——
            // 淺色模式下背景是很淺的淺藍色調，白字幾乎看不清楚，這正是
            // 使用者截圖回報的問題。深色模式下 var(--cwfm-text) 本身就是
            // 接近白色的淺灰，效果跟原本寫死的白色差不了多少。
            '.cwfm-keychip-selected { border-color: var(--cwfm-accent); background: var(--cwfm-accent-bg); color: var(--cwfm-text); }',
            // [cwfm] 「配色」是固定五選一的內建選項，不是使用者自己新增/
            // 命名/刪除的清單，用比較單純的標籤樣式（沒有叉叉、沒有改名
            // 圖示），但要明確標示「目前選的是哪一個」。
            '.cwfm-keychip-option { cursor: pointer; }',
            // [cwfm] 上傳字型的圖示做成小圓底徽章（外面一圈淡色填底 +
            // 對比色圖示），不是裸露的一個箭頭符號——現在是唯一用來
            // 判斷「這是不是上傳字型」的依據，要夠顯眼、不會被忽略。
            '.cwfm-keychip-icon {',
            '  display: inline-flex; align-items: center; justify-content: center;',
            '  width: 14px; height: 14px; border-radius: 50%;',
            '  background: rgba(78,161,255,0.25); color: var(--cwfm-accent);',
            '  font-size: 9px; line-height: 1; margin-right: 2px; flex-shrink: 0;',
            '}',
            '.cwfm-keychip-text { cursor: pointer; }',
            // [cwfm] 改名圖示平常隱藏，滑鼠移到整個標籤上面才淡入顯示——
            // 沒有 hover 的時候標籤保持乾淨，不會一堆小圖示擠在一起；
            // 位置排在文字後面、叉叉前面（業界常見清單項目「編輯」「刪除」
            // 排在一起、靠最後面的慣例，操作時滑鼠移動距離也比較短）。
            '.cwfm-keychip-rename {',
            '  background: none; border: none; color: var(--cwfm-text-secondary); cursor: pointer;',
            '  font-size: 11px; line-height: 1; padding: 2px 3px; border-radius: 3px;',
            '  opacity: 0; transition: opacity 0.15s ease;',
            '}',
            '.cwfm-keychip:hover .cwfm-keychip-rename { opacity: 1; }',
            '.cwfm-keychip-rename:hover { color: var(--cwfm-text); background: var(--cwfm-border); }',
            '.cwfm-panel .cwfm-keychip-edit[type="text"] {',
            // [cwfm] 這次真正的原因：.cwfm-panel input[type="text"] 這條
            // 套用在整個面板所有文字輸入框的通用規則，優先權比原本這裡
            // 寫的規則高，把想清掉的邊框/背景蓋回去了——不是瀏覽器自己
            // 的行為，選擇器故意寫得更具體，確保這裡的重置贏過那條通用
            // 規則。
            '  background: none; border: none; border-bottom: 1px solid var(--cwfm-accent);',
            '  border-radius: 0; color: var(--cwfm-text); font-size: 12px; padding: 1px 2px;',
            '  width: 90px; outline: none; box-shadow: none;',
            '  -webkit-appearance: none; -moz-appearance: none; appearance: none;',
            '}',
            // [cwfm] 刪除上傳字型的確認對話框，獨立蓋在整個畫面最上層。
            '.cwfm-confirm-overlay {',
            '  position: fixed; inset: 0; background: rgba(0,0,0,0.6);',
            '  z-index: 1000000; display: flex; align-items: center; justify-content: center;',
            '}',
            '.cwfm-confirm-box {',
            '  background: var(--cwfm-surface-elevated); border: 1px solid var(--cwfm-border-light); border-radius: 8px;',
            '  padding: 20px; max-width: 360px; box-shadow: 0 8px 28px rgba(0,0,0,0.5);',
            '  font-family: sans-serif;',
            '}',
            '.cwfm-confirm-box h4 { margin: 0 0 10px; color: var(--cwfm-text); font-size: 15px; }',
            '.cwfm-prompt-input {',
            '  width: 100%; box-sizing: border-box; background: var(--cwfm-surface);',
            '  border: 1px solid var(--cwfm-border-light); border-radius: 4px; color: var(--cwfm-text);',
            '  font-size: 13px; padding: 6px 8px; margin-bottom: 16px;',
            '}',
            '.cwfm-prompt-input:focus { border-color: var(--cwfm-accent); outline: none; }',
            // [cwfm] 字型輸入框的膠囊造型：輸入區 + 細分隔線 + 一顆代表
            // Enter 的小按鈕，按下去效果等同按鍵盤 Enter，讓「打完要確認」
            // 這件事看得見，不用使用者自己猜。
            '.cwfm-pill-input {',
            '  display: flex; align-items: stretch; background: var(--cwfm-surface);',
            '  border: 1px solid var(--cwfm-border-light); border-radius: 4px; overflow: hidden;',
            '}',
            '.cwfm-pill-input:focus-within { border-color: var(--cwfm-accent); }',
            '.cwfm-panel .cwfm-pill-input input[type="text"] {',
            // [cwfm] 選擇器故意寫得比 .cwfm-panel input[type="text"](下面
            // 那條套用在整個面板所有文字輸入框的通用規則)優先權更高——
            // 上面那條規則權重比這裡原本寫的規則高，會把這裡想清掉的
            // 邊框/背景蓋回去，這才是「嵌套」真正的原因，不是瀏覽器
            // 自己的行為。
            '  flex: 1; min-width: 0; background: none; border: none; color: var(--cwfm-text);',
            '  font-size: 13px; padding: 5px 8px; outline: none; box-shadow: none;',
            '  -webkit-appearance: none; -moz-appearance: none; appearance: none;',
            '  border-radius: 0;',
            '}',
            '.cwfm-pill-enter {',
            // [cwfm] 查了自己另一支腳本(route-rain/RouteRain.user.js)裡
            // 密碼輸入框旁邊那顆眼睛圖示按鈕，已經驗證能用的做法——按鈕
            // 背景是透明的，跟輸入區共用同一塊底色，只靠一條細分隔線
            // 區分，沒有另外畫一塊不同顏色的矩形。之前兩輪一直在修圓角，
            // 但真正的根因是背景色不同：只要按鈕跟輸入區顏色不一樣，
            // 不管圓角修得多準，視覺上都會像兩塊拼起來的矩形，圓角反而
            // 是次要問題。這裡改成跟輸入區同一個背景色。
            '  flex: 0 0 auto; background: none; border: none; border-left: 1px solid var(--cwfm-border-light);',
            '  border-radius: 0 4px 4px 0; margin: 0; color: var(--cwfm-text-secondary); padding: 0 10px; cursor: pointer;',
            '  display: flex; align-items: center; justify-content: center;',
            '  -webkit-appearance: none; -moz-appearance: none; appearance: none;',
            '  outline: none; box-shadow: none;',
            '}',
            '.cwfm-pill-enter svg { width: 14px; height: 14px; display: block; pointer-events: none; }',
            '.cwfm-pill-enter:hover { color: var(--cwfm-text); background: var(--cwfm-surface-elevated); }',
            '.cwfm-confirm-box p { margin: 0 0 16px; color: var(--cwfm-text-secondary); font-size: 13px; line-height: 1.6; }',
            '.cwfm-confirm-buttons { display: flex; justify-content: flex-end; gap: 8px; }',
            '.cwfm-confirm-cancel, .cwfm-confirm-ok {',
            '  border-radius: 4px; padding: 6px 14px; font-size: 13px; cursor: pointer;',
            '}',
            '.cwfm-confirm-cancel { background: none; border: 1px solid var(--cwfm-border-light); color: var(--cwfm-text-secondary); }',
            '.cwfm-confirm-cancel:hover { border-color: var(--cwfm-text-secondary); color: var(--cwfm-text); }',
            '.cwfm-confirm-ok { background: #b03030; border: 1px solid #d04040; color: #fff; }',
            '.cwfm-confirm-ok:hover { background: #c03838; }',
            '.cwfm-panel[data-side="left"] { left: 0; transform: translateX(-105%); }',
            '.cwfm-panel[data-side="left"].cwfm-open { transform: translateX(0); }',
            '.cwfm-panel[data-side="right"] { right: 0; transform: translateX(105%); }',
            '.cwfm-panel[data-side="right"].cwfm-open { transform: translateX(0); }',
            '.cwfm-panel label { display: block; margin: 14px 0 4px; font-size: 12px; color: var(--cwfm-text-secondary); }',
            '.cwfm-panel input[type="text"], .cwfm-panel input[type="number"] {',
            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',
            '  background: var(--cwfm-surface-elevated); border: 1px solid var(--cwfm-border-light); color: var(--cwfm-text); border-radius: 4px;',
            '  font-size: 13px;',
            '}',
            // [cwfm] 原本只有寬度設定，其餘完全是瀏覽器原生外觀——這正是
            // 使用者回報「圓點顏色太深、不協調」的根因：原生外觀不會跟著
            // 我們的深淺色配色變數走。
            // [cwfm] accent-color 這個做法查證過兩次、理論上都該有效，
            // 實測在使用者的環境裡完全沒有可見效果——不再繼續往這個
            // 方向猜，改用進度條那邊已經證實真的有效的做法：直接用
            // 偽元素明確畫出圓點顏色，不透過瀏覽器自己判斷的間接方式。
            // 代價是原生「拖到哪填到哪」的軌道填色效果會消失，但兩害
            // 相權，先求真的有效果。
            '.cwfm-panel input[type="range"] {',
            '  width: 100%; -webkit-appearance: none; appearance: none;',
            '  background: transparent; height: 16px; margin: 8px 0;',
            '}',
            '.cwfm-panel input[type="range"]::-webkit-slider-runnable-track {',
            // [cwfm] 跟開關軌道同一套陰影模擬邊界手法，統一視覺語言。
            '  height: 3px; background: var(--cwfm-border-light); border-radius: 2px;',
            '  box-shadow: 0 0 0 1px var(--cwfm-shadow-ring);',
            '}',
            '.cwfm-panel input[type="range"]::-webkit-slider-thumb {',
            // [cwfm] 加邊框+陰影，不是只有純色塊——查了業界常見做法，光
            // 一個純色圓點太單薄。邊框顏色用跟面板本身背景一樣的顏色
            // （不是隨便挑一個深或淺的顏色），效果是圓點跟軌道之間會有
            // 一圈「鏤空」的分隔感，深淺兩種模式都適用，不用另外寫兩套
            // 邊框顏色。陰影用現有的柔和陰影變數，讓圓點有一點浮起來的
            // 立體感。
            '  -webkit-appearance: none; margin-top: -6px;',
            '  width: 14px; height: 14px; border-radius: 50%; background: var(--cwfm-accent);',
            '  border: 2px solid var(--cwfm-surface); box-shadow: 0 1px 3px var(--cwfm-shadow-soft);',
            '  cursor: pointer;',
            '}',
            '.cwfm-panel input[type="range"]::-moz-range-track {',
            '  height: 3px; background: var(--cwfm-border-light); border-radius: 2px;',
            '  box-shadow: 0 0 0 1px var(--cwfm-shadow-ring);',
            '}',
            '.cwfm-panel input[type="range"]::-moz-range-thumb {',
            '  width: 14px; height: 14px; border-radius: 50%; background: var(--cwfm-accent);',
            '  border: 2px solid var(--cwfm-surface); box-shadow: 0 1px 3px var(--cwfm-shadow-soft);',
            '  cursor: pointer;',
            '}',
            '.cwfm-value-input-wrap { display: flex; align-items: center; gap: 4px; color: var(--cwfm-text-secondary); font-size: 12px; }',
            '.cwfm-value-input {',
            '  width: 4em; box-sizing: border-box; padding: 2px 4px;',
            '  background: var(--cwfm-surface-elevated); border: 1px solid var(--cwfm-border-light); color: var(--cwfm-text); border-radius: 4px;',
            '  font-size: 12px; text-align: right;',
            '}',
            // [cwfm] 單位文字（%、px、em、或空字串）長度不一樣，導致輸入框
            // 本身的右邊界跟著單位文字的寬度跑掉、參差不齊——輸入框自己
            // 雖然是固定 4em，但它是跟單位文字一起被 .cwfm-row 的
            // space-between 整包往右推，單位文字越寬，輸入框就被越往左
            // 擠。給單位文字一個固定寬度，不管實際字數多少都佔用同樣的
            // 水平空間，輸入框的右邊界才會在所有欄位間保持一致。
            '.cwfm-value-input-wrap span { display: inline-block; width: 1.6em; text-align: left; }',
            '.cwfm-panel .cwfm-row { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 4px; }',
            '.cwfm-panel .cwfm-row label { margin: 0; }',
            // [cwfm] 核取方塊改用獨立的排列方式，不跟範圍/顏色欄位共用
            // .cwfm-row 的排法——查了業界規範，開關這種元件多數規範建議
            // 「文字在左、開關在右」（螢幕報讀軟體先唸文字再唸到控制項，
            // 桌面/寬版面的情境也多半這樣排），改成兩端對齊，不用額外
            // 對齊每一列——每一列寬度本來就一樣，兩端對齊自然會讓所有
            // 開關的右邊界對齊在同一條線上。
            '.cwfm-panel .cwfm-checkbox-row {',
            // [cwfm] 原本 align-items:center 會把核取方塊對齊「整段文字
            // 的正中央」——文字只有一行時看不出差別，超過一行就會整個
            // 往下沉，跟第一行對不上。改成 baseline（跟文字基準線對齊，
            // 瀏覽器對齊文字用的標準做法，多行文字時瀏覽器自己會對齊
            // 第一行的基準線），不是我自己猜一個 margin 偏移量——上一輪
            // 用 flex-start + 自己猜的 margin-top: 2px，方向猜錯了，改用
            // 瀏覽器原生對齊機制比較可靠。
            '  display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 14px 0 4px;',
            '}',
            '.cwfm-panel .cwfm-checkbox-row label { margin: 0; }',
            // [cwfm] 滑動開關本身：膠囊軌道 + 圓形滑塊，關閉是中性灰色，
            // 開啟是強調色，跟現在整體配色一致。底層真正的 <input> 藏
            // 起來（opacity:0，但還是佔滿整個區域接收點擊/鍵盤操作），
            // 用 ::before 畫出滑塊本身，開關切換靠 :checked 這個原生
            // 狀態去驅動樣式變化，不用自己寫額外的 JS 去同步視覺狀態。
            // 開關這種小圖示元件用文字基準線對齊會顯得太低，改成
            // align-self: center，只針對這個元件覆蓋掉整行 baseline 的
            // 對齊方式。
            '.cwfm-switch {',
            '  position: relative; display: inline-block; width: 34px; height: 20px;',
            '  flex-shrink: 0; order: 1; cursor: pointer; align-self: center;',
            '}',
            '.cwfm-switch input {',
            '  position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer;',
            '}',
            // [cwfm] 改用 iOS/Material 這種公認的經典做法，不再自己發明：
            // 查了實際規格才發現，變色的是「軌道」，不是滑塊——滑塊
            // 不分開關狀態，永遠是白色（或接近白色），靠一圈陰影製造
            // 立體感；軌道關閉是中性灰、開啟是實心的強調色（不是淡色
            // 調的底），這樣滑塊在任何底色下都有穩定的對比，不會像
            // 上一輪那樣，白色邊框疊在同樣偏淡的軌道底色上糊成一片。
            // 滑塊顏色刻意用固定的白色（不接變數），不是深淺兩種模式
            // 各寫一份——這正是這個經典做法能同時適用深淺兩種底色的
            // 原因：白色滑塊在深色軌道（不管軌道本身是中性灰還是強調
            // 色）上天生就有穩定的對比，不需要跟著面板深淺模式換色。
            '.cwfm-switch-track {',
            // [cwfm] 加陰影模擬邊界——跟設定面板分組卡片同一套 Cal.com
            // 手法，一層極細的環狀陰影當邊界，讓軌道不是純色塊孤立
            // 存在，跟面板其他元件用同一套視覺語言。
            '  position: absolute; inset: 0; background: var(--cwfm-border-light);',
            '  border-radius: 10px; transition: background 0.15s ease;',
            '  box-shadow: 0 0 0 1px var(--cwfm-shadow-ring);',
            '}',
            '.cwfm-switch-track::before {',
            '  content: ""; position: absolute; top: 2px; left: 2px;',
            '  width: 16px; height: 16px; border-radius: 50%; background: #ffffff;',
            '  box-shadow: 0 1px 2px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.08);',
            '  transition: transform 0.15s ease;',
            '}',
            '.cwfm-switch input:checked + .cwfm-switch-track { background: var(--cwfm-accent); }',
            '.cwfm-switch input:checked + .cwfm-switch-track::before {',
            '  transform: translateX(14px);',
            '}',
            '.cwfm-switch input:focus-visible + .cwfm-switch-track {',
            '  outline: 2px solid var(--cwfm-accent); outline-offset: 2px;',
            '}',
            '.cwfm-panel select {',
            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',
            '  background: var(--cwfm-surface-elevated); border: 1px solid var(--cwfm-border-light); color: var(--cwfm-text); border-radius: 4px;',
            '  font-size: 13px;',
            '}',
            '.cwfm-close-btn {',
            '  flex: 0 0 auto; background: none;',
            '  border: 1px solid var(--cwfm-border-light); border-radius: 50%;',
            '  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;',
            '  color: var(--cwfm-text-secondary); font-size: 14px; cursor: pointer; line-height: 1; padding: 0;',
            '}',
            '.cwfm-close-btn:hover { color: var(--cwfm-text); border-color: var(--cwfm-text-secondary); }',
            // [cwfm] 色塊按鈕：取代原生 <input type="color">，點下去開啟
            // 自訂取色器。
            '.cwfm-color-swatch-btn {',
            // [cwfm] 原本 48×28px，長方形，比面板裡其他控制項(大約
            // 28~32px 高的方塊)明顯寬、比例不協調——改成正方形，跟其他
            // 控制項的視覺節奏一致。
            '  width: 32px; height: 32px; border-radius: 4px;',
            '  border: 1px solid var(--cwfm-border-light); cursor: pointer;',
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
            '  background: var(--cwfm-surface-elevated); border: 1px solid rgba(255,255,255,0.13);',
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
            '  color:var(--cwfm-text-secondary); letter-spacing:0.03em;',
            '}',
            '.cwfm-cp .cp-tab.active { background:rgba(255,255,255,0.1); color:#eee; border-color:rgba(255,255,255,0.2); }',
            '.cwfm-cp .cp-summary-row { padding:0 13px 7px; }',
            '.cwfm-cp .cp-summary {',
            '  width:100%; box-sizing:border-box; padding:5px 8px; font-size:11px;',
            '  border:1px solid rgba(255,255,255,0.15); border-radius:6px; outline:none;',
            '  font-family:"Courier New",monospace; background:var(--cwfm-surface-elevated); color:var(--cwfm-text);',
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
            '  cursor:pointer; font-size:13px; color:var(--cwfm-text-secondary); flex-shrink:0;',
            '  display:flex; align-items:center; justify-content:center; line-height:1;',
            '}',
            '.cwfm-cp .cp-s-btn:hover { background:rgba(255,255,255,0.1); }',
            '.cwfm-cp .cp-s-val {',
            '  flex:1; border:none; outline:none; text-align:center; font-size:11px;',
            '  background:transparent; color:var(--cwfm-text); width:0; min-width:0;',
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
            '  display: flex; align-items: center; padding: 5px 0; color: var(--cwfm-text-secondary); text-decoration: none; cursor: pointer;',
            '}',
            '.cwfm-toc-view [role="treeitem"]:hover { color: var(--cwfm-text); }',
            '.cwfm-toc-view [role="treeitem"][aria-current="page"] { color: var(--cwfm-accent); font-weight: bold; }',
            '.cwfm-toc-view [aria-expanded="false"] ~ ol { display: none; }',
            // [cwfm] 目錄展開三角形：foliate-js ui/tree.js 產生的 <svg><polygon>
            // 沒有設定 fill，SVG 規格預設黑色，在深色背景幾乎看不見；改成跟
            // 文字同色，hover 時比照文字變亮。跟文字的垂直置中改用 flex
            // （見上面 [role="treeitem"] 的 display:flex）取代 vertical-align:
            // middle——實測過 vertical-align:middle 對中文文字定位不準，有
            // 固定的幾 px 偏差，flex 置中才是準的。margin-right 是跟文字的間距。
            //
            // 方向：SVG 本身未旋轉時尖角朝下（polygon 座標畫的是下三角）。
            // 收合狀態要讓尖角指向文字（朝右），轉 -90 度；展開狀態維持
            // 原本朝下的樣子，不用轉。原本寫反了（在 expanded 時轉
            // +90 度，變成收合朝下、展開朝左，跟一般慣例相反），這裡修正。
            '.cwfm-toc-view [role="treeitem"] svg {',
            '  fill: var(--cwfm-text-secondary); margin-right: 6px; flex-shrink: 0;',
            '  transition: fill 0.15s ease, transform 0.15s ease;',
            '  transform: rotate(-90deg);',
            '}',
            '.cwfm-toc-view [role="treeitem"]:hover svg { fill: var(--cwfm-text); }',
            '.cwfm-toc-view [role="treeitem"][aria-expanded="true"] > svg { transform: rotate(0deg); }',
            '.cwfm-empty-hint { color: var(--cwfm-text-secondary); font-size: 12px; }',
            // [cwfm] 面板變暗遮罩：原本會把畫面調暗，但這個遮罩本身沒有接
            // 任何點擊關閉的事件（純視覺效果），使用者調整顏色設定時看不清
            // 預覽，拿掉變暗，遮罩只留著（openPanel/closeAllPanels 邏輯不動）。
            '.cwfm-dimming {',
            '  position: fixed; inset: 0; background: transparent; z-index: 999998;',
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
        // [cwfm] 點擊面板以外的區域（這個遮罩本來就只蓋在面板以外，
        // 面板自己的 z-index 比較高，疊在遮罩上面，點面板本身不會傳到
        // 這裡）直接關閉面板，不用非得點叉叉。
        dimming.addEventListener('click', () => closeAllPanels());
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
        // [cwfm] 字型名稱記憶：手動輸入過、確定生效的名稱（change 事件才
        // 記，不是每打一個字就存）。跟下面 uploadedFonts 分開存——這兩種
        // 名稱行為不一樣：手動輸入的只是純文字，刪除就單純刪一筆；
        // uploadedFonts 每一筆背後對應 IndexedDB 裡一個真正的字型檔案。
        fontNameHistory: [],
        // [cwfm] 使用者上傳的字型。id 是內部產生的識別碼，對應
        // IndexedDB 裡實際的檔案二進位資料。不收 .ttc（見下方
        // cwfmParseUploadedFontNames 的說明），只收天生「一個檔案一個
        // 字型」的 .ttf/.otf/.woff，所以一筆對應剛好一個名稱，不用像
        // 合集格式那樣處理一個檔案多個名稱的情況。format 存副檔名，
        // 套用時要組對應的 MIME type。
        uploadedFonts: [], // [{ id, fileName, format, name }]
        // [cwfm] 使用者自己另存的「主題」——只存排版/外觀相關那 13 個
        // 欄位（見 CWFM_THEME_FIELD_KEYS），不含快速鍵、自動隱藏這類
        // 裝置操作偏好，也不含字型記憶清單/上傳字型這個素材庫本身
        // （素材庫全部主題共用同一份，不會各存一份）。
        savedThemes: [], // [{ id, name, values: { ...13 個欄位 } }]
        // [cwfm] 使用者自己存的自訂配色組合，可以存不止一組——內建的
        // 跟隨系統/亮色/暗色/復古黃這四個是固定選項，不能刪、不能改名；
        // 這份清單專門放「自訂」類型的顏色組合，跟其他標籤清單（字型、
        // 佈景主題）用同一套邏輯：可以存多組、點選套用、改名、刪除。
        savedColorSchemes: [], // [{ id, name, textColor, backgroundColor }]
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
        colorPickerMode: 'RGB',    // 取色器上次使用的分頁（HEX／RGB／HSV），下次打開沿用
        autoHideToolbar: false,    // 工具列/進度條自動隱藏開關（3 秒無動作後滑出畫面）
        // [cwfm] 翻頁快速鍵：每個方向可以錄製不只一組（陣列），支援組合鍵
        // （例如 Ctrl+ArrowLeft），格式是 formatKeyCombo() 產生的字串，
        // 例如 'ArrowLeft'、'Ctrl+Shift+ArrowLeft'。預設維持跟改版前
        // 一樣的行為（左鍵往前、右鍵往後），使用者可以自己增減。
        pagingKeys: { prev: ['ArrowLeft'], next: ['ArrowRight'] },
        // [cwfm] 翻頁精準定位（原本叫「實驗性功能」，session-only、故意不
        // 存檔——當初這樣設計是因為功能還不穩定，怕存檔後下次開書直接
        // 卡住畫面沒辦法簡單復原。現在已經穩定到不會弄壞整個介面，改成
        // 正常存檔，跟其他設定一樣。
        preciseAnchorAlign: false,
    };

    // [cwfm] 幾種常用配色，比照一般電子書閱讀器常見的預設主題：
    // light（亮色）、dark（暗色）、sepia（復古黃，長時間閱讀常見的護眼
    // 色調）。custom 則用下面兩個 customXxxColor 設定值，讓使用者自己挑。
    // auto 沒有自己的一組固定配色——見下面 resolveThemeColors()。
    const THEME_PRESETS = {
        light: { text: '#1a1a1a', background: '#ffffff' },
        dark: { text: '#e0e0e0', background: '#1a1a1a' },
        sepia: { text: '#4b3621', background: '#f4ecd8' },
    };

    // [cwfm] 面板本身（工具列/設定/目錄）要不要用深色還是淺色配色，改成
    // 跟著「使用者最後套用的書籍背景色實際的深淺」決定，不是跟著作業
    // 系統的 prefers-color-scheme——不管使用者選的是內建配色（跟隨系統/
    // 亮色/暗色/復古黃）還是自訂顏色，一律用 resolveThemeColors() 算出
    // 來的背景色去判斷，跟書本內容顯示出來的顏色永遠對得起來。
    function cwfmParseHexToRgb(hex) {
        if (!hex) return null;
        const clean = hex.replace('#', '');
        if (clean.length === 3) {
            const r = parseInt(clean[0] + clean[0], 16);
            const g = parseInt(clean[1] + clean[1], 16);
            const b = parseInt(clean[2] + clean[2], 16);
            return { r, g, b };
        }
        if (clean.length === 6) {
            return {
                r: parseInt(clean.slice(0, 2), 16),
                g: parseInt(clean.slice(2, 4), 16),
                b: parseInt(clean.slice(4, 6), 16),
            };
        }
        return null;
    }
    function cwfmIsColorDark(hex) {
        const rgb = cwfmParseHexToRgb(hex);
        if (!rgb) return true; // 解析不出來，維持原本預設的深色
        // [cwfm] YIQ 感知亮度公式，常見的「這個顏色算深色還是淺色」判斷
        // 方式，比單純平均 RGB 更貼近人眼實際感受到的亮度。
        const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
        return brightness < 128;
    }
    function cwfmUpdatePanelScheme(settings) {
        try {
            const background = resolveThemeColors(settings).background;
            const isDark = cwfmIsColorDark(background);
            // [cwfm] 設在 <html> 上，不是設在面板元素本身——面板可能還沒
            // 建立（例如開書當下第一次套用設定時），設在 <html> 不用
            // 管面板存不存在，CSS 選擇器（html[data-cwfm-scheme] .cwfm-panel）
            // 之後面板一建立就會自動生效，不用另外處理時序。
            document.documentElement.dataset.cwfmScheme = isDark ? 'dark' : 'light';
        } catch (e) { console.error('[cwfm:theme] 判斷面板深淺色失敗', e); }
    }

    // [cwfm] auto 模式原本交給 CSS 的 color-scheme 屬性讓瀏覽器自己決定
    // 顏色，但實測查證過：瀏覽器實際怎麼畫這個「預設底色」，沒有辦法用
    // getComputedStyle 或任何 JS 讀出來——我們自己完全不知道畫面顯示的
    // 是什麼顏色，導致 #main 這類我們自己控制的元素沒有顏色可以對齊。
    //
    // 改成：auto 模式下，只問瀏覽器系統目前偏好深色還是淺色
    // （matchMedia），問到的結果直接對應到既有的 dark／light 這兩組
    // 固定配色——等於 auto 在這兩個主題之間自動選一個，書本內容跟
    // #main（見 applySettings 裡的用法）都呼叫這同一個函式拿顏色，
    // 保證兩邊查到的結果一致，不會分別查兩次、查到不同結果。
    function resolveThemeColors(settings) {
        if (settings.themeName === 'custom') {
            return { text: settings.customTextColor, background: settings.customBackgroundColor };
        }
        if (settings.themeName === 'auto') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            return prefersDark ? THEME_PRESETS.dark : THEME_PRESETS.light;
        }
        return THEME_PRESETS[settings.themeName];
    }

    // [cwfm] auto 模式下，使用者在看書當下切換作業系統的深色/淺色偏好，
    // 畫面要即時跟著變、不用重新整理頁面——只在目前真的是 auto 模式時
    // 才重新套用設定，避免使用者明明選的是 light/dark/sepia/custom，
    // 系統切換卻無謂觸發一次重排版。applySettings 定義在後面，這裡引用
    // 沒問題：函式宣告會 hoist，而且這個監聽器要等系統真的切換偏好才會
    // 觸發，那時候整支腳本早就載入完成。
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const currentSettings = window.__cwfm && window.__cwfm.settings;
        if (currentSettings && currentSettings.themeName === 'auto') {
            applySettings(currentSettings);
        }
    });

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

    // ============================================================
    // [cwfm] 使用者上傳字型：實際的字型二進位資料存進 IndexedDB（不用
    // GM_setValue，那套鍵值儲存不適合放大檔案），套用到書本內容時轉成
    // Base64 的 @font-face 規則字串——這個字串跟書本內容是同一份文件、
    // 不管在哪個 iframe 顯示都能直接生效，不用管理 Blob URL 的生命週期、
    // 也沒有跨文件存取限制的問題。
    // ============================================================
    const CWFM_FONT_DB_NAME = 'cwfm-fonts';
    const CWFM_FONT_STORE = 'fonts';
    function cwfmOpenFontDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(CWFM_FONT_DB_NAME, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(CWFM_FONT_STORE, { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function cwfmSaveFontBlob(id, arrayBuffer, format) {
        const db = await cwfmOpenFontDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CWFM_FONT_STORE, 'readwrite');
            tx.objectStore(CWFM_FONT_STORE).put({ id, data: arrayBuffer, format });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    async function cwfmLoadFontBlob(id) {
        const db = await cwfmOpenFontDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CWFM_FONT_STORE, 'readonly');
            const req = tx.objectStore(CWFM_FONT_STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }
    async function cwfmDeleteFontBlob(id) {
        const db = await cwfmOpenFontDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CWFM_FONT_STORE, 'readwrite');
            tx.objectStore(CWFM_FONT_STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // [cwfm] 解析 sfnt（.ttf/.otf/.ttc）格式裡的 'name' 表，讀出字型
    // 內部記錄的名稱。優先取 nameID=4（完整名稱），沒有才退回 nameID=1
    // （家族名稱）；平台 3（Windows/Unicode）跟 0（Unicode）用 UTF-16BE
    // 解碼，其餘（例如 Mac Roman）簡化當單位元組字串處理——這些是舊式
    // 平台編碼，現在的字型檔案絕大多數都會同時附上平台 3 的記錄，實務
    // 上不太會真的走到這個退回分支。
    function cwfmParseNameTable(dv, tableOffset) {
        const count = dv.getUint16(tableOffset + 2);
        const stringAreaOffset = tableOffset + dv.getUint16(tableOffset + 4);
        let best = null;
        let fallback = null;
        for (let i = 0; i < count; i++) {
            const recOffset = tableOffset + 6 + i * 12;
            const platformID = dv.getUint16(recOffset);
            const nameID = dv.getUint16(recOffset + 6);
            const length = dv.getUint16(recOffset + 8);
            const strOffset = dv.getUint16(recOffset + 10);
            if (nameID !== 4 && nameID !== 1) continue;
            let str;
            try {
                const bytes = [];
                if (platformID === 3 || platformID === 0) {
                    for (let j = 0; j < length; j += 2) bytes.push(dv.getUint16(stringAreaOffset + strOffset + j));
                } else {
                    for (let j = 0; j < length; j++) bytes.push(dv.getUint8(stringAreaOffset + strOffset + j));
                }
                str = String.fromCharCode.apply(null, bytes);
            } catch (e) { continue; }
            if (nameID === 4) { best = str; break; }
            if (nameID === 1 && !fallback) fallback = str;
        }
        return best || fallback;
    }
    function cwfmParseSfntName(dv, baseOffset) {
        const numTables = dv.getUint16(baseOffset + 4);
        for (let i = 0; i < numTables; i++) {
            const recOffset = baseOffset + 12 + i * 16;
            const tag = String.fromCharCode(dv.getUint8(recOffset), dv.getUint8(recOffset + 1), dv.getUint8(recOffset + 2), dv.getUint8(recOffset + 3));
            if (tag !== 'name') continue;
            const nameTableOffset = dv.getUint32(recOffset + 8);
            return cwfmParseNameTable(dv, nameTableOffset);
        }
        return null;
    }
    // [cwfm] .woff 內部表格用 zlib（RFC 1950）壓縮——查證過瀏覽器原生
    // DecompressionStream('deflate') 解壓縮的正是這個格式，不用自己實作
    // 解壓縮演算法、也不用額外的函式庫。
    async function cwfmParseWoffName(dv) {
        const numTables = dv.getUint16(12);
        for (let i = 0; i < numTables; i++) {
            const recOffset = 44 + i * 20;
            const tag = String.fromCharCode(dv.getUint8(recOffset), dv.getUint8(recOffset + 1), dv.getUint8(recOffset + 2), dv.getUint8(recOffset + 3));
            if (tag !== 'name') continue;
            const tableOffset = dv.getUint32(recOffset + 4);
            const compLength = dv.getUint32(recOffset + 8);
            const origLength = dv.getUint32(recOffset + 12);
            const raw = new Uint8Array(dv.buffer, dv.byteOffset + tableOffset, compLength);
            let bytes;
            if (compLength === origLength) {
                bytes = raw;
            } else {
                const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
                bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            }
            return cwfmParseNameTable(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
        }
        return null;
    }
    function cwfmStripExt(fileName) {
        return fileName.replace(/\.[^.]+$/, '');
    }

    // [cwfm] 共用的確認對話框，回傳一個 Promise，使用者按確定為 true、
    // 取消或點背景為 false。目前只有刪除上傳字型會用到（規則規定一律
    // 要跳確認，不看背後掛了幾個名稱），寫成共用函式方便之後其他地方
    // 需要「刪除前先確認」的時候重複使用。
    function cwfmConfirmDialog(title, message) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cwfm-confirm-overlay';
            const box = document.createElement('div');
            box.className = 'cwfm-confirm-box';
            const h = document.createElement('h4');
            h.textContent = title;
            const p = document.createElement('p');
            p.textContent = message;
            const btnRow = document.createElement('div');
            btnRow.className = 'cwfm-confirm-buttons';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '\u53d6\u6d88';
            cancelBtn.className = 'cwfm-confirm-cancel';
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.textContent = '\u78ba\u5b9a\u522a\u9664';
            okBtn.className = 'cwfm-confirm-ok';
            function close(result) {
                overlay.remove();
                resolve(result);
            }
            cancelBtn.addEventListener('click', () => close(false));
            okBtn.addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(okBtn);
            box.appendChild(h);
            box.appendChild(p);
            box.appendChild(btnRow);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
        });
    }

    // [cwfm] 自己畫的輸入文字對話框，取代瀏覽器原生 window.prompt()——
    // 查證過：Chrome 從第 61 版起，只要跳出原生 alert()/confirm()/
    // prompt() 這類對話框，就會自動把全螢幕模式關掉（刻意的安全設計，
    // 不是我們能關閉的行為），這是全螢幕底下按「另存新主題」看不到
    // 對話框的真正原因。自己畫的對話框（跟上面 cwfmConfirmDialog 同一
    // 套 overlay 樣式）不會觸發這個行為，全螢幕下操作也正常。回傳
    // Promise，使用者按確定回傳輸入的文字（trim 過），取消或空白回傳
    // null。
    function cwfmPromptDialog(title, placeholder) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cwfm-confirm-overlay';
            const box = document.createElement('div');
            box.className = 'cwfm-confirm-box';
            const h = document.createElement('h4');
            h.textContent = title;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'cwfm-prompt-input';
            if (placeholder) input.placeholder = placeholder;
            const btnRow = document.createElement('div');
            btnRow.className = 'cwfm-confirm-buttons';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '\u53d6\u6d88';
            cancelBtn.className = 'cwfm-confirm-cancel';
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.textContent = '\u78ba\u5b9a';
            okBtn.className = 'cwfm-confirm-ok';
            let done = false;
            function close(result) {
                if (done) return;
                done = true;
                overlay.remove();
                resolve(result);
            }
            cancelBtn.addEventListener('click', () => close(null));
            okBtn.addEventListener('click', () => close(input.value.trim() || null));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close(input.value.trim() || null);
                else if (e.key === 'Escape') close(null);
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(okBtn);
            box.appendChild(h);
            box.appendChild(input);
            box.appendChild(btnRow);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            input.focus();
        });
    }

    // [cwfm] 自己畫的單純提示對話框，取代原生 window.alert()——同一個
    // 全螢幕會被強制退出的問題，只是這裡不需要輸入、也不需要取消，
    // 只有一個「知道了」按鈕。不回傳有意義的值（呼叫端本來就不需要
    // 判斷使用者選了什麼，原生 alert() 也是同樣的單向通知性質）。
    function cwfmAlertDialog(title, message) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cwfm-confirm-overlay';
            const box = document.createElement('div');
            box.className = 'cwfm-confirm-box';
            const h = document.createElement('h4');
            h.textContent = title;
            const p = document.createElement('p');
            p.textContent = message;
            const btnRow = document.createElement('div');
            btnRow.className = 'cwfm-confirm-buttons';
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.textContent = '\u77e5\u9053\u4e86';
            okBtn.className = 'cwfm-confirm-ok';
            function close() { overlay.remove(); resolve(); }
            okBtn.addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            btnRow.appendChild(okBtn);
            box.appendChild(h);
            box.appendChild(p);
            box.appendChild(btnRow);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
        });
    }

    // [cwfm] 標籤(chip)改名共用邏輯：平常顯示純文字，呼叫這支函式把
    // 文字換成一個編輯用的輸入框，失焦或按 Enter 才真正提交、按 Esc
    // 取消——字型記憶清單、上傳字型、佈景主題這三處的改名都共用同一套，
    // 行為要完全一致。onCommit(newValue) 只在真的有變動（非空、跟原本
    // 不一樣）才會被呼叫；onDone() 不管有沒有真的改名都一定會呼叫，
    // 用來讓呼叫端重新畫一次清單（把編輯框換回正常的標籤顯示）。
    function cwfmStartChipRename(textEl, currentValue, onCommit, onDone) {
        // [cwfm] 改名的當下，先把改名圖示自己藏起來——編輯狀態下圖示、
        // 輸入框、叉叉全部擠在一起會顯得雜亂，先讓畫面只剩「圖示(如果
        // 有)+ 輸入框 + 叉叉」，減少視覺干擾。onDone() 觸發整個標籤清單
        // 重新畫過，藏起來的按鈕不用自己再顯示回來。
        const renameBtn = textEl.parentElement && textEl.parentElement.querySelector('.cwfm-keychip-rename');
        if (renameBtn) renameBtn.style.display = 'none';
        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.value = currentValue;
        editInput.className = 'cwfm-keychip-edit';
        editInput.addEventListener('click', (e) => e.stopPropagation());
        textEl.replaceWith(editInput);
        editInput.focus();
        editInput.select();
        let done = false;
        function commit() {
            if (done) return;
            done = true;
            const newValue = editInput.value.trim();
            if (newValue && newValue !== currentValue) onCommit(newValue);
            onDone();
        }
        editInput.addEventListener('blur', commit);
        editInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') editInput.blur();
            else if (e.key === 'Escape') { editInput.value = currentValue; editInput.blur(); }
        });
    }

    // [cwfm] 共用的標籤(chip)建構函式：字型記憶清單、上傳字型、佈景
    // 主題三處共用，外觀跟互動要完全一致。icon 是選用的小圖示（上傳
    // 字型用來跟手動輸入的名稱做區分）；onRename 是選用的（翻頁快速鍵
    // 的標籤不該有改名功能，那裡呼叫這支函式時不傳 onRename 就好）；
    // 改名圖示平常隱藏，只有滑鼠移到整個標籤上面才淡入顯示（CSS 處理，
    // 見 .cwfm-keychip:hover .cwfm-keychip-rename）。
    function cwfmBuildChip(text, opts) {
        const chip = document.createElement('span');
        chip.className = 'cwfm-keychip' + (opts.extraClass ? ' ' + opts.extraClass : '');
        if (opts.icon) {
            const icon = document.createElement('span');
            icon.className = 'cwfm-keychip-icon';
            icon.textContent = opts.icon;
            chip.appendChild(icon);
        }
        const textEl = document.createElement('span');
        textEl.className = 'cwfm-keychip-text';
        textEl.textContent = text;
        if (opts.onSelect) textEl.addEventListener('click', opts.onSelect);
        chip.appendChild(textEl);

        if (opts.onRename) {
            const renameBtn = document.createElement('button');
            renameBtn.type = 'button';
            renameBtn.className = 'cwfm-keychip-rename';
            renameBtn.textContent = '\u270e';
            renameBtn.setAttribute('aria-label', '\u91cd\u65b0\u547d\u540d');
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                cwfmStartChipRename(textEl, text, opts.onRename, opts.onRenameDone || (() => {}));
            });
            chip.appendChild(renameBtn);
        }

        if (opts.onUpdate) {
            // [cwfm] 「覆蓋更新」：用目前畫面上的設定值，直接覆蓋這個既有
            // 標籤的內容，不用先刪除再新增一個同名的。跟改名圖示共用
            // 同一套 hover 才淡入顯示的樣式（.cwfm-keychip-rename），
            // 只是圖示、動作不同。
            const updateBtn = document.createElement('button');
            updateBtn.type = 'button';
            updateBtn.className = 'cwfm-keychip-rename';
            updateBtn.textContent = '\u21bb';
            if (opts.updateLabel) updateBtn.setAttribute('aria-label', opts.updateLabel);
            updateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                opts.onUpdate();
            });
            chip.appendChild(updateBtn);
        }

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'cwfm-keychip-remove';
        removeBtn.textContent = '\u00d7';
        if (opts.removeLabel) removeBtn.setAttribute('aria-label', opts.removeLabel);
        removeBtn.addEventListener('click', (e) => { e.stopPropagation(); opts.onRemove(); });
        chip.appendChild(removeBtn);

        return chip;
    }

    // [cwfm] 「主題」只涵蓋排版/外觀相關的欄位——跟使用者一起確認過的
    // 分類：不含快速鍵、自動隱藏、自動同步這類裝置操作偏好，也不含
    // 字型記憶清單/上傳字型這個所有主題共用的素材庫本身。存主題、套用
    // 主題都只動這份清單裡列出的欄位，其餘設定不受影響。
    const CWFM_THEME_FIELD_KEYS = [
        'fontFamily', 'fontSize', 'letterSpacing', 'lineSpacing', 'justify',
        'hyphenate', 'disableLigatures', 'flow', 'topBottomPadding',
        'leftRightPadding', 'maxColumnCount', 'themeName', 'customTextColor',
        'customBackgroundColor', 'preferOriginalTextColor',
    ];
    function cwfmSaveCurrentAsTheme(settings, name) {
        const values = {};
        CWFM_THEME_FIELD_KEYS.forEach((key) => { values[key] = settings[key]; });
        // [cwfm] 存主題的當下，順便記一個布林值：目前這個字型名稱，是不
        // 是對應到「此刻」素材庫裡真的存在的一筆上傳字型——這樣套用時
        // 才分得出「是上傳字型、可以查存不存在」還是「是手動輸入的名稱、
        // 沒辦法查」，不用另外用字串內容去猜（猜不出來，兩種名稱長得
        // 一樣，只是來源不同）。
        const fontWasUpload = !!values.fontFamily && settings.uploadedFonts.some((f) => f.name === values.fontFamily);
        const id = 'cwfm-theme-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        settings.savedThemes.push({ id, name, values, fontWasUpload });
        saveSettings(settings);
        return id;
    }
    // [cwfm] 覆蓋更新既有主題：用目前畫面上的設定值，直接覆蓋這個主題
    // 原本存的 values，名稱、id 都不變——不用像之前那樣，只能先刪除
    // 再新增一個同名的。
    function cwfmUpdateTheme(settings, theme) {
        const values = {};
        CWFM_THEME_FIELD_KEYS.forEach((key) => { values[key] = settings[key]; });
        const fontWasUpload = !!values.fontFamily && settings.uploadedFonts.some((f) => f.name === values.fontFamily);
        theme.values = values;
        theme.fontWasUpload = fontWasUpload;
        saveSettings(settings);
    }
    function cwfmDeleteTheme(settings, id) {
        const idx = settings.savedThemes.findIndex((t) => t.id === id);
        if (idx >= 0) settings.savedThemes.splice(idx, 1);
        saveSettings(settings);
    }
    // [cwfm] 套用主題：上傳字型能百分之百確定存不存在（我們自己掌控的
    // 素材庫，直接查 uploadedFonts 有沒有這個名稱）；手動輸入、指望本機
    // 系統已安裝的字型名稱，瀏覽器基於隱私考量沒有提供查詢字型是否已
    // 安裝的正式方式，沒辦法事先確認，只能照原本名稱設定上去，套不套
    // 得到要使用者自己看畫面判斷。
    function cwfmApplyTheme(settings, theme) {
        const fontName = theme.values.fontFamily;
        CWFM_THEME_FIELD_KEYS.forEach((key) => { settings[key] = theme.values[key]; });
        if (theme.fontWasUpload && fontName && !settings.uploadedFonts.some((f) => f.name === fontName)) {
            settings.fontFamily = '';
            cwfmAlertDialog('\u4e0a\u50b3\u5b57\u578b\u5df2\u522a\u9664', '\u9019\u500b\u4e3b\u984c\u539f\u672c\u4f7f\u7528\u7684\u4e0a\u50b3\u5b57\u578b\u300c' + fontName + '\u300d\u5df2\u7d93\u88ab\u522a\u9664\uff0c\u9019\u6b21\u5957\u7528\u6539\u7528\u9810\u8a2d\u5b57\u578b\u3002');
        }
        saveSettings(settings);
        applySettings(settings);
    }
    // [cwfm] 上傳字型解析的統一入口。.woff2 內部用 Brotli 壓縮、資料排列
    // 方式也不一樣，沒有現成的簡單做法可以解出名稱——查證過、已跟使用者
    // 確認：.woff2 退回用檔名當預設名稱，不影響字型本身套用顯示（顯示
    // 是瀏覽器原生 @font-face 機制處理，跟這裡讀不讀得到名稱無關）。
    // [cwfm] 不收 .ttc（TrueType Collection，一個檔案包好幾個字型）：
    // 查證過 CSS 規格，@font-face 設計上就是「一條規則對應一個單一字型
    // 資源」，沒有標準化的方式指定「這個檔案裡要用第幾個」，實測踩坑
    // 回報也證實直接把 .ttc 丟進 src 會顯示錯的字型——這條路在瀏覽器
    // 規格層級就走不通，不是我們自己能解決的，乾脆不收這個格式，只收
    // 天生「一個檔案一個字型」的 .ttf/.otf/.woff，不會有這個歧義問題。
    async function cwfmParseUploadedFontNames(arrayBuffer, fileName) {
        try {
            const dv = new DataView(arrayBuffer);
            const sig = dv.getUint32(0);
            if (sig === 0x774F4646) { // 'wOFF'
                const name = await cwfmParseWoffName(dv);
                return name || cwfmStripExt(fileName);
            }
            if (sig === 0x774F4632) { // 'wOF2'，.woff2，解不開，退回檔名
                return cwfmStripExt(fileName);
            }
            // 其餘當作一般 .ttf/.otf
            const name = cwfmParseSfntName(dv, 0);
            return name || cwfmStripExt(fileName);
        } catch (e) {
            console.error('[cwfm:font] 解析字型名稱失敗，退回用檔名', e);
            return cwfmStripExt(fileName);
        }
    }

    // [cwfm] 目前實際套用中的上傳字型 @font-face CSS 快取——只有在選用
    // 的字型名稱真的換成不同的上傳字型時，才重新去 IndexedDB 讀取、轉
    // Base64（這兩步都是耗時的非同步操作），其餘設定變動（留白、字級
    // 這些）沿用同一份已經算好的字串，不會每次都重新處理一次大檔案。
    let cwfmActiveFontFaceCSS = '';
    let cwfmActiveFontFaceKey = null;
    const CWFM_FONT_MIME = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };
    async function cwfmRefreshActiveFontFace(settings) {
        const match = (settings.uploadedFonts || []).find((f) => f.name === settings.fontFamily);
        if (!match) {
            if (cwfmActiveFontFaceKey !== null) {
                cwfmActiveFontFaceCSS = '';
                cwfmActiveFontFaceKey = null;
                applySettings(settings);
            }
            return;
        }
        if (match.id === cwfmActiveFontFaceKey) return; // 已經是目前套用中的這個，不用重讀
        try {
            const record = await cwfmLoadFontBlob(match.id);
            if (!record) { console.error('[cwfm:font] IndexedDB 裡找不到這個上傳字型的資料', match.id); return; }
            const bytes = new Uint8Array(record.data);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            const base64 = btoa(binary);
            const mime = CWFM_FONT_MIME[record.format] || 'truetype';
            cwfmActiveFontFaceCSS = '@font-face { font-family: ' + JSON.stringify(settings.fontFamily) + '; src: url(data:font/' + mime + ';base64,' + base64 + ') format("' + mime + '"); }';
            cwfmActiveFontFaceKey = match.id;
            applySettings(settings); // 重新套用一次，這次帶著已經準備好的 @font-face
        } catch (e) {
            console.error('[cwfm:font] 套用上傳字型失敗', e);
        }
    }

    function getTypographyCSS(settings) {
        const fontFamilyRule = settings.fontFamily
            ? '  * { font-family: ' + JSON.stringify(settings.fontFamily) + ' !important; }'
            : '';

        // [cwfm] 佈景主題顏色統一從 resolveThemeColors() 拿（auto 模式在
        // 裡面會問系統深色/淺色偏好，換算成 dark/light 兩組固定配色之一）。
        const theme = resolveThemeColors(settings);

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
            cwfmActiveFontFaceCSS,
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
        console.log('[cwfm:align:t] applyHorizontalPadding() 開始 t=' + performance.now().toFixed(1));
        const rect = view.renderer.getBoundingClientRect();
        const totalWidth = rect.width || 1;

        const gapPercent = (desiredPx * 2 / totalWidth) * 100;
        view.renderer.setAttribute('gap', gapPercent.toFixed(3) + '%');

        const contentWidth = Math.max(100, totalWidth - desiredPx * 2);
        const maxInlineSizePx = Math.round(contentWidth / (columnCount || 1));
        console.log('[cwfm:node] applyHorizontalPadding() desiredPx=' + desiredPx + ' columnCount=' + columnCount + ' totalWidth=' + totalWidth + ' gapPercent=' + gapPercent.toFixed(3) + ' maxInlineSize=' + maxInlineSizePx);
        view.renderer.setAttribute('max-inline-size', maxInlineSizePx + 'px');
        console.log('[cwfm:align:t] applyHorizontalPadding() 結束 t=' + performance.now().toFixed(1));
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
        console.log('[cwfm:align:t] applyVerticalPadding() 開始 t=' + performance.now().toFixed(1));
        const rect = view.renderer.getBoundingClientRect();
        const totalHeight = rect.height || 1;
        view.renderer.setAttribute('margin', desiredPx + 'px');
        const contentHeight = Math.max(100, totalHeight - desiredPx * 2);
        const maxBlockSizePx = Math.round(contentHeight);
        console.log('[cwfm:node] applyVerticalPadding() desiredPx=' + desiredPx + ' totalHeight=' + totalHeight + ' maxBlockSize=' + maxBlockSizePx);
        view.renderer.setAttribute('max-block-size', maxBlockSizePx + 'px');
        view.renderer.render();
        console.log('[cwfm:align:t] applyVerticalPadding() 結束（render() 呼叫完，但 render() 內部不保證此刻已經跑完，見前面討論）t=' + performance.now().toFixed(1));
    }

    // [cwfm] 翻頁精準定位（原本叫「實驗性功能」）的存檔開關已經改到
    // DEFAULT_SETTINGS 裡的 preciseAnchorAlign（見上方定義處的說明），
    // 這裡不再需要獨立的 session-only 變數。

    // ============================================================
    // [cwfm][實驗性] 定位點精準對齊。核心原則：完全不碰排版引擎的計算
    // 邏輯本身（columnize/expand 這些完全不動），只調整「餵給引擎的原始
    // 資料量」——具體做法是把定位點文字前面的原始內容整批「暫時搬走」，
    // 排版引擎看到的資料變少了，定位點自然變成排出來的第一頁開頭，不用
    // 猜填充量、不用反覆試錯。搬走的內容不是丟棄，是先存在記憶體裡，
    // 等使用者真的翻到「前面沒有內容了」這個邊界（往回翻），才接回去，
    // 讓往回翻看到的資料一樣是完整、正確的。
    //
    // 已用真實 epubcfi.js 實測驗證過：extractContents() 在跨越多層巢狀
    // 結構時，瀏覽器會在邊界那幾層另外複製出對應的容器元素（不是把原本
    // 的容器搬走），插回去如果只是單純把搬走的內容塞回原位，會留下重複
    // 的容器、導致定位點之後的內容 CFI 跟著跑掉；下面 cwfmMergeCloneChain
    // 這支函式就是用來把這些邊界複製品合併回原本容器、消除這個副作用，
    // 已經用多層巢狀、含 span/b 混排的測試頁面驗證過搬走再接回去，前後
    // 算出來的 CFI（含定位點本身、定位點前面/後面的內容）完全一致。
    //
    // [cwfm] 上一輪曾經因為跟已放棄的「方向 A」（改動排版共用留白計算）
    // 同時開啟互相干擾，導致版面破碎——方向 A 那段已經從 paginator.js
    // 徹底清除（#Yd 方法、anchorOffsetPx 欄位、columnize() 的留白算式
    // 都已還原成原版），這次重新加回這套機制時不會再有那個干擾來源。
    // 但使用者另外回報過一次「畫面偏移、沒有置中」的殘留現象，那次還沒
    // 查到根因就被連同方向 A 一起整段刪除，這次補上 [cwfm:align:h]
    // 診斷紀錄，下次重現時才能實際比對留白/欄寬數字，不是用猜的。
    // ============================================================
    let cwfmAligningAnchor = false; // 重入鎖：操作進行中，暫停本機記憶/自動同步書籤寫入、進度條畫面更新，避免讀到資料量被動過手腳當下的錯誤瞬間值

    // [cwfm] 純粹的時間軸診斷，跟對齊功能開關無關（一律記錄，不受實驗性
    // 開關影響）：每一次 relocate 不分原因都記一筆時間點，方便事後比對
    // 「使用者翻頁的時間點」跟後面「resize/對齊開始執行的時間點」之間
    // 差多久，查時序問題時不用再去猜。掛在 view.renderer 這一層（不是
    // view 本身）——查證過 view 重新包裝 relocate 事件時，沒有把 reason
    // 這個欄位轉傳出來，只有排版引擎自己原始的事件才有。
    view.renderer.addEventListener('relocate', (e) => {
        console.log('[cwfm:align:t] relocate 事件 reason=' + e.detail?.reason + ' t=' + performance.now().toFixed(1));
    });
    let cwfmAnchorStash = null; // { originalChain, fragment, sectionIndex } 或 null——搬走、還沒接回去的內容

    // [cwfm] 目前鎖定要對齊的目標 cfi。只在真的「資料保證完整、沒被暫存
    // 動過手腳」的乾淨時機更新（翻頁、目錄跳轉、書本內部超連結跳轉、
    // 開書），resize/全螢幕切換這些時機完全不碰這個值，只是把它重新
    // 套用一次而已——這樣就不需要在暫存還沒接回去的當下去讀「現在畫面
    // 顯示什麼」，繞開了前面反覆查不出根因的那個 bug 類型（getVisibleRange
    // 抓到的即時節點，被 cwfmReinsertStash() 的 normalize() 影響，
    // isConnected 判斷不準）。
    let cwfmLockedAnchorCfi = null;
    view.renderer.addEventListener('relocate', (e) => {
        const reason = e.detail?.reason;
        // 只有「翻頁」「跳轉」這兩種代表使用者/書本內容真的換了位置的
        // 原因才更新；resize 造成的內部自動重新導覽（reason=anchor）
        // 不算，我們自己對齊操作觸發的那次也不算（cwfmAligningAnchor
        // 判斷），不然會變成自己追自己。
        if (cwfmAligningAnchor) return;
        if (reason !== 'page' && reason !== 'navigation') return;
        // [cwfm] 防呆：正常情況下，翻頁/跳轉一定會先經過 cwfmGoLeft()/
        // cwfmGoRight()（已經先接回暫存才真正翻頁），這裡不該再看到
        // cwfmAnchorStash 還存在。萬一還是看到了（已知的殘留缺口：書本
        // 內容內部的超連結點擊，不會經過我們包的翻頁函式），代表這次
        // 算出來的 cfi 可能是對著殘缺的樹算出來的、不可靠——寧可不更新，
        // 也不要記錄一個可能有問題的值進去。
        if (cwfmAnchorStash) {
            console.warn('[cwfm:align] relocate(reason=' + reason + ') 發生時仍有暫存未接回去，跳過更新鎖定的定位點（可能來自書內超連結等未包裝的跳轉路徑）');
            return;
        }
        const cfi = view.lastLocation?.cfi;
        if (cfi) cwfmLockedAnchorCfi = cfi;
    });

    function cwfmAncestorChain(node, stopAbove) {
        const chain = [];
        let cur = node;
        while (cur && cur !== stopAbove) {
            chain.unshift(cur);
            cur = cur.parentNode;
        }
        return chain;
    }

    // [cwfm] 把 extractContents() 在邊界複製出來的容器鏈，合併回原本沒被
    // 動過的容器——由外而內遞迴：先處理更深一層（真正卡在邊界的那條鏈），
    // 回來之後再把這一層複製品剩下的所有 children（通常是完全落在搬移
    // 範圍內、整段被搬走的兄弟節點，例如同一層前面的段落）依序插回原本
    // 容器最前面，最後把已經清空的複製容器本身移除。insertPoint 故意
    // 只在迴圈開始前抓一次、不要每次迴圈都重新讀 originalNode.firstChild
    // ——之前實測過，每次都重新讀會導致每一輪都插在上一輪剛插進去的
    // 東西前面，順序整個反過來。
    function cwfmMergeCloneChain(cloneNode, chain, level) {
        const originalNode = chain[level];
        if (level + 1 < chain.length) {
            let deeper = cloneNode.lastChild;
            while (deeper && deeper.nodeType !== 1) deeper = deeper.previousSibling;
            if (deeper) cwfmMergeCloneChain(deeper, chain, level + 1);
        }
        const insertPoint = originalNode.firstChild;
        while (cloneNode.firstChild) {
            originalNode.insertBefore(cloneNode.firstChild, insertPoint);
        }
        cloneNode.remove();
    }

    // [cwfm] 把暫存的內容接回去。呼叫時機有兩種：(1) 使用者往回翻頁翻到
    // 邊界；(2) 任何其他導覽動作（目錄跳轉、書籤還原、換章節）發生之前
    // 的安全網，避免暫存內容被晾在記憶體裡忘記接回去。
    function cwfmReinsertStash() {
        if (!cwfmAnchorStash) return;
        const { originalChain, fragment } = cwfmAnchorStash;
        cwfmAligningAnchor = true;
        try {
            const leaf = originalChain[originalChain.length - 1];
            const doc = leaf.ownerDocument;
            const body = doc.body;
            body.insertBefore(fragment, body.firstChild);
            // [cwfm] 找複製鏈頂層節點：不能假設剛插入的 body.firstChild
            // 就是它——原始檔案裡如果容器前面夾雜換行造成的空白文字
            // 節點，firstChild 會抓到那個空白節點，不是真正的容器。改成
            // 從還留在原地、沒被動過的最外層容器(originalChain[0])往前
            // 找 previousSibling，跳過文字節點直到找到元素為止，這個做法
            // 已經實測驗證過。
            let clonedTop = originalChain[0].previousSibling;
            while (clonedTop && clonedTop.nodeType !== 1) clonedTop = clonedTop.previousSibling;
            if (clonedTop) {
                cwfmMergeCloneChain(clonedTop, originalChain, 0);
                leaf.normalize();
            } else {
                console.error('[cwfm:align] 接回暫存內容時找不到複製容器，DOM 可能已經跟預期不一致');
            }
        } catch (e) {
            console.error('[cwfm:align] 接回暫存內容失敗', e);
        } finally {
            cwfmAnchorStash = null;
            cwfmAligningAnchor = false;
        }
    }

    // [cwfm] 定位點對齊本體：把 view.lastLocation.cfi（目前畫面顯示的
    // 第一個字元，這個記錄本來就有、見功能一）前面的原始內容整批搬走。
    // 呼叫時機：resize 防抖動計時器裡，版面留白套用完之後（見下方 resize
    // 監聽器）。
    // [cwfm] 診斷用：從某個節點/offset 開始，往後抓幾個字當作文字預覽，
    // 方便肉眼核對「這次抓到的到底是不是預期的那個位置」，不用自己在
    // Console 裡展開節點物件慢慢找。
    function cwfmTextPreview(container, offset, maxLen) {
        try {
            const text = container.nodeType === 3 ? container.nodeValue : (container.textContent || '');
            const start = container.nodeType === 3 ? offset : 0;
            return JSON.stringify(text.slice(start, start + (maxLen || 12)));
        } catch (e) {
            return '(\u7121\u6cd5\u9810\u89bd)';
        }
    }

    // [cwfm] 共用的「排版引擎是否真的穩定下來」偵測——量測 paginator.js
    // 新增的 cwfmLayoutChangedAt 這個時間戳（expand()/render() 真正被
    // 呼叫時就會更新），不是靠猜畫面內容或猜要等多久。requireTriggerFirst
    // 為 true 時，要先真的看到這個時間戳變動過一次，才會進入「安靜多久
    // 才算穩定」的判斷——避免呼叫這支函式時，剛好 ResizeObserver 還沒
    // 來得及觸發第一次，被誤判成「從頭到尾都沒變、早就穩定」。設有總
    // 等待時間上限，避免真的卡住（例如使用者自己一直在正常翻頁，這個
    // 時間戳本來就會持續更新，這種情況下等不到穩定是對的，不是機制壞了）。
    async function cwfmWaitForLayoutSettle(requireTriggerFirst) {
        const CWFM_SETTLE_QUIET_MS = 50;
        const CWFM_SETTLE_TIMEOUT_MS = 800;
        const settleStart = performance.now();
        let lastSeenChangedAt = view.renderer.cwfmLayoutChangedAt ?? 0;
        let sawTrigger = !requireTriggerFirst;
        let quietSince = performance.now();
        while (performance.now() - settleStart < CWFM_SETTLE_TIMEOUT_MS) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const changedAt = view.renderer.cwfmLayoutChangedAt ?? 0;
            const now = performance.now();
            if (changedAt !== lastSeenChangedAt) {
                lastSeenChangedAt = changedAt;
                quietSince = now;
                sawTrigger = true;
            } else if (sawTrigger && now - quietSince >= CWFM_SETTLE_QUIET_MS) {
                break;
            }
        }
        return { lastSeenChangedAt, elapsed: performance.now() - settleStart, sawTrigger };
    }

    function cwfmAlignAnchorToPageStart() {
        if (!window.__cwfm.settings?.preciseAnchorAlign) return;
        if (cwfmAligningAnchor) return;
        const t0 = performance.now();
        console.log('[cwfm:align:t] cwfmAlignAnchorToPageStart() 開始 t=' + t0.toFixed(1) + ' fullscreenElement=' + !!document.fullscreenElement);
        try {
            // [cwfm] 先把任何還沒接回去的暫存內容接回去，確保接下來解析
            // cwfmLockedAnchorCfi 的時候，文件是完整、沒被動過手腳的乾淨
            // 狀態——這是這次簡化設計的關鍵：resize/全螢幕切換完全不去
            // 讀「畫面現在顯示什麼」，只是把已經記錄好的目標重新套用一次。
            cwfmReinsertStash();

            const contents = view.renderer.getContents();
            if (!contents.length) { console.log('[cwfm:align:t] 沒有 contents，中止'); return; }
            const { doc, index } = contents[0];

            const targetCfi = cwfmLockedAnchorCfi;
            console.log('[cwfm:align:t] cwfmLockedAnchorCfi=' + targetCfi);
            if (!targetCfi) { console.log('[cwfm:align:t] 沒有鎖定的定位點，中止'); return; }
            const resolved = view.resolveCFI(targetCfi);
            if (!resolved || resolved.index !== index) { console.log('[cwfm:align:t] cfi 不在目前這一章，中止 resolved.index=' + resolved?.index + ' currentIndex=' + index); return; }
            const range = resolved.anchor(doc);
            if (!range) { console.log('[cwfm:align:t] anchor(doc) 拿不到 range，中止'); return; }

            const container = range.startContainer;
            const offset = range.startOffset;
            const anchorElement = container.nodeType === 3 ? container.parentNode : container;
            console.log('[cwfm:align:t] 解析到的位置 內容=' + cwfmTextPreview(container, offset));

            const body = doc.body;
            if (!anchorElement || anchorElement === body) { console.log('[cwfm:align:t] anchorElement 已經是最外層，中止'); return; }

            const originalChain = cwfmAncestorChain(anchorElement, body);

            const extractRange = doc.createRange();
            extractRange.setStart(body, 0);
            extractRange.setEnd(container, offset);
            if (extractRange.collapsed) { console.log('[cwfm:align:t] extractRange 是空的（前面本來就沒內容），中止'); return; }

            cwfmAligningAnchor = true;
            const extracted = extractRange.extractContents();
            cwfmAnchorStash = { originalChain, fragment: extracted, sectionIndex: index };
            console.log('[cwfm:align:t] extractContents() 完成 t=' + performance.now().toFixed(1));

            // [cwfm] 搬走之後，定位點文字現在是章節最前面的內容，原本卡在
            // 邊界的那個容器（originalChain 最底層）現在的 firstChild 就是
            // 精準對應到搬移前定位點所在的位置——不沿用搬移前那個 range
            // 物件本身（它的邊界節點在 extractContents() 過程中可能已經
            // 被瀏覽器內部重新指派，直接信任舊物件風險不明），改成重新
            // 建一個乾淨的 range。
            const leaf = originalChain[originalChain.length - 1];
            const expectedText = cwfmTextPreview(leaf.firstChild || leaf, 0);
            const freshRange = doc.createRange();
            if (leaf.firstChild) freshRange.setStart(leaf.firstChild, 0);
            else freshRange.setStart(leaf, 0);
            freshRange.collapse(true);
            console.log('[cwfm:align:t] 搬移後的定位點內容=' + expectedText);

            // [cwfm] 診斷紀錄：跟水平留白/欄寬有關的幾個數字記下來，
            // 下次重現時直接比對這些數字，不用再猜是不是留白算錯。
            console.log('[cwfm:align:h] 對齊前 maxInlineSize=' + view.renderer.getAttribute('max-inline-size')
                + ' gap=' + view.renderer.getAttribute('gap')
                + ' maxColumnCount=' + view.renderer.getAttribute('max-column-count'));

            view.renderer.scrollToAnchor(freshRange)
                .then(async () => {
                    const firstVisible = view.renderer.getVisibleRange?.();
                    const firstText = firstVisible ? cwfmTextPreview(firstVisible.startContainer, firstVisible.startOffset) : '(null)';
                    console.log('[cwfm:align:t] scrollToAnchor() 第一次完成 t=' + performance.now().toFixed(1)
                        + ' 內容=' + firstText);

                    // [cwfm] 排版引擎自己內部有一個 ResizeObserver 監看書本
                    // 內容尺寸，一變就呼叫 expand()；我們搬移/接回內容本身
                    // 就會觸發它，而 expand() 調整容器尺寸的動作，可能又
                    // 讓內容跟著微調、再度觸發同一個監看器，形成一個會自己
                    // 反覆修正好幾輪才穩定下來的回饋迴圈，把畫面帶離我們
                    // 剛剛才對齊好的位置。用共用的 cwfmWaitForLayoutSettle()
                    // 直接量測 cwfmLayoutChangedAt 時間戳，不是猜畫面內容
                    // 或猜要等多久。
                    const { lastSeenChangedAt, elapsed: settleElapsed } = await cwfmWaitForLayoutSettle(true);
                    console.log('[cwfm:align:t] 排版引擎穩定偵測結束 t=' + performance.now().toFixed(1)
                        + ' 耗時=' + settleElapsed.toFixed(1) + 'ms cwfmLayoutChangedAt=' + lastSeenChangedAt);

                    // [cwfm] 不管穩定與否，都強制校正一次——穩定的情況下這
                    // 次呼叫應該幾乎沒有變化（本來就在對的位置）；等到上限
                    // 還沒穩定的情況下，這是最後一道防線，把畫面拉回我們
                    // 原本要鎖住的目標。
                    await view.renderer.scrollToAnchor(freshRange);

                    const finalVisible = view.renderer.getVisibleRange?.();
                    const actualText = finalVisible ? cwfmTextPreview(finalVisible.startContainer, finalVisible.startOffset) : '(null)';
                    const matched = actualText === expectedText;
                    console.log('[cwfm:align:t] 最終校正完成 t=' + performance.now().toFixed(1)
                        + ' 對齊後實際第一個可見內容=' + actualText
                        + ' | 校對結果：' + (matched ? '一致 ✓' : '不一致 ✗'));
                    if (!matched) {
                        console.warn('[cwfm:align] 校對不一致！預期=' + expectedText + ' 實際=' + actualText);
                    }
                    console.log('[cwfm:align:h] 對齊後 maxInlineSize=' + view.renderer.getAttribute('max-inline-size')
                        + ' gap=' + view.renderer.getAttribute('gap')
                        + ' rendererRect.left=' + view.renderer.getBoundingClientRect().left
                        + ' viewerRect.left=' + viewerContainer.getBoundingClientRect().left);
                })
                .catch((e) => console.error('[cwfm:align] 對齊後導覽失敗', e))
                .finally(() => { cwfmAligningAnchor = false; console.log('[cwfm:align:t] cwfmAlignAnchorToPageStart() 全部結束 t=' + performance.now().toFixed(1) + '（總耗時 ' + (performance.now() - t0).toFixed(1) + 'ms）'); });
        } catch (e) {
            console.error('[cwfm:align] 定位點對齊失敗', e);
            cwfmAligningAnchor = false;
        }
    }

    // [cwfm] 往前/往後翻頁的包裝：不管有沒有翻到邊界、暫存屬於哪個章節，
    // 只要還有暫存沒接回去，一律先接回去、確保文件是完整的，才真正
    // 執行翻頁——這樣「真正翻頁」這個動作發生的當下，文件保證完整，
    // relocate 事件算出來的 cfi 自然是對的，不需要再另外判斷邊界、比對
    // 章節，範圍反而比原本兩層判斷更寬，涵蓋原本想擋的情況。這是修正
    // 「全螢幕裡翻頁後鎖定失效」那個 DOMException 根因用的（翻頁當下
    // 如果暫存還沒接回去，relocate 算出來的 cfi 是對著殘缺的樹算的，
    // 之後拿去解析會撞到 Range 邊界超出範圍的例外）。
    async function cwfmGoLeft() {
        // [cwfm] 對齊操作（含連鎖反應偵測+最後校正）進行中的這一小段
        // 空檔，先等它結束，避免翻頁跟校正動作前後重疊、其中一個結果
        // 被另一個蓋掉。等待有次數上限，不會真的卡死。
        for (let i = 0; i < 60 && cwfmAligningAnchor; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        try {
            // [cwfm] 這裡曾經加過一行 view.renderer.expand()，想強制立刻
            // 重算頁數，解決接回內容後翻頁卡在頁碼 0 不動的問題——但已經
            // 實測確認：關掉這個功能就不會複現「往前翻跨章節、卻落在
            // 新章節開頭而不是結尾」這個問題，開啟才會，代表就是這行
            // expand() 造成的副作用（很可能干擾了引擎自己判斷『跨章節
            // 要落在哪個 anchor 分數』的計算），已經移除，不要再加回來。
            // 改成不自己插手呼叫 expand()，接回內容之後，用共用的
            // cwfmWaitForLayoutSettle() 等瀏覽器自己的 ResizeObserver
            // 按照它原本的方式、原本的時機把頁數重算完，才繼續判斷翻頁
            // ——比自己直接呼叫更保守，理論上不會有插手時機不對的副作用。
            if (cwfmAnchorStash) {
                cwfmReinsertStash();
                await cwfmWaitForLayoutSettle(true);
            }
        } catch (e) {
            console.error('[cwfm:align] 往前翻頁時處理暫存內容失敗', e);
        }
        await view.goLeft();
    }
    async function cwfmGoRight() {
        for (let i = 0; i < 60 && cwfmAligningAnchor; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        try {
            if (cwfmAnchorStash) {
                cwfmReinsertStash();
                await cwfmWaitForLayoutSettle(true);
            }
        } catch (e) {
            console.error('[cwfm:align] 往後翻頁時處理暫存內容失敗', e);
        }
        await view.goRight();
    }

    function applySettings(settings) {
        cwfmUpdatePanelScheme(settings);
        try {
            view.renderer.setStyles?.(getTypographyCSS(settings));
        } catch (e) { console.error('[cwfm:settings] 套用字體樣式失敗', e); }
        // [cwfm] 非同步、不 await——applySettings() 本身是同步函式，這裡
        // 只負責「檢查目前選用的字型是不是換成了不同的上傳字型，是的話
        // 去讀取、準備好之後再重新呼叫一次 applySettings()」。cwfmRefreshActiveFontFace
        // 內部自己會判斷要不要真的重讀（同一個字型不重複讀 IndexedDB），
        // 這裡每次呼叫的成本很低。
        cwfmRefreshActiveFontFace(settings).catch((e) => console.error('[cwfm:font] 檢查上傳字型失敗', e));
        try {
            view.renderer.setAttribute('flow', settings.flow);
            view.renderer.setAttribute('max-column-count', settings.maxColumnCount);
            applyVerticalPadding(settings.topBottomPadding);
            applyHorizontalPadding(settings.leftRightPadding, settings.maxColumnCount);
            updateDivider(settings);
        } catch (e) { console.error('[cwfm:settings] 套用版面屬性失敗', e); }
        try {
            updateAutoHideEnabled(settings.autoHideToolbar);
        } catch (e) { console.error('[cwfm:settings] 套用自動隱藏開關失敗', e); }
        // [cwfm] #main 是 Calibre-Web 原本介面最底層的容器，原本背景色是
        // 寫死的白色（Calibre-Web 自己的 main.css），我們自己的工具列背景
        // 帶透明度（rgba(24,24,24,0.92)），縫隙會透出底下這層顏色，變成
        // 一條白線。這裡跟書本內容用同一個 resolveThemeColors() 結果，
        // 用行內樣式蓋掉，每次換主題/自訂顏色都會一起更新，不會再對不
        // 上；hideOldUI() 裡另外有一條寫死的深色 CSS 規則，只當作這裡
        // 還沒執行到之前的預設值，不衝突（行內樣式優先權比較高）。
        try {
            const theme = resolveThemeColors(settings);
            const main = document.querySelector('#main');
            if (main && theme) {
                main.style.setProperty('background', theme.background, 'important');
                // [cwfm] #main 原本(Calibre-Web 自己的樣式)帶了一圈向內
                // 凹陷的陰影(box-shadow: ... inset)，我們從沒動過——查了
                // 才發現，工具列自動隱藏之後，這圈原本一直存在、但被
                // 我們近乎不透明的工具列蓋住的陰影，第一次露出來，就是
                // 使用者截圖回報的那個灰色殘影。這裡一併蓋掉。
                main.style.setProperty('box-shadow', 'none', 'important');
            }
        } catch (e) { console.error('[cwfm:settings] 套用 #main 背景色失敗', e); }
        window.__cwfm.settings = settings;
    }

    // 視窗尺寸改變時，margin/max-block-size 與 gap/max-inline-size 都需要
    // 根據新的容器尺寸重新換算。
    //
    // [cwfm] 防抖動：實測（全螢幕切換）發現瀏覽器轉場過程會連續密集發出
    // 好幾次 resize 通知，原本這裡收到一次就立刻完整重跑一次「重新排版
    // + 對齊定位點」，會對著轉場途中還沒定案的中間尺寸算出錯誤的平移量，
    // 導致畫面瘋狂跳動、版面跑掉。改成收到通知先不動作，等一小段時間
    // （CWFM_RESIZE_DEBOUNCE_MS）確定沒有新通知再進來，才真正執行一次；
    // 這段期間內又收到新通知，就把等待時間重新算過。
    const CWFM_RESIZE_DEBOUNCE_MS = 300;
    let resizeDebounceTimer = null;
    let resizeRawCount = 0; // 診斷用：原始通知總共進來幾次
    let resizeExecCount = 0; // 診斷用：防抖動後實際執行了幾次
    window.addEventListener('resize', () => {
        resizeRawCount++;
        console.log('[cwfm:resize] 收到原始 resize 通知，累計=' + resizeRawCount + ' t=' + performance.now().toFixed(1));
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            resizeExecCount++;
            console.log('[cwfm:resize] 防抖動後真正執行，累計=' + resizeExecCount + ' t=' + performance.now().toFixed(1));
            if (window.__cwfm.settings) {
                try {
                    applyVerticalPadding(window.__cwfm.settings.topBottomPadding);
                    applyHorizontalPadding(window.__cwfm.settings.leftRightPadding, window.__cwfm.settings.maxColumnCount);
                    updateDivider(window.__cwfm.settings);
                } catch (e) { console.error('[cwfm:settings] 視窗縮放後重新套用留白失敗', e); }
                // [cwfm] 定位點對齊要排在留白套用之後——對齊過程要用到的
                // this.size（頁面尺寸）必須是新版面留白套用完之後的正確值。
                try {
                    cwfmAlignAnchorToPageStart();
                } catch (e) { console.error('[cwfm:align] resize 後定位點對齊失敗', e); }
            }
        }, CWFM_RESIZE_DEBOUNCE_MS);
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
            // [cwfm] 沿用使用者上次選過的分頁，不寫死 'RGB'
            mode: window.__cwfm.settings?.colorPickerMode || 'RGB',
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
      <button class="cp-tab" data-mode="RGB">RGB</button>
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

        // [cwfm] 不再寫死哪個分頁 active，改成依 cpState.mode（已經讀了使用
        // 者上次選過的值）動態標記初始分頁。
        tabs.forEach(t => t.classList.toggle('active', t.dataset.mode === cpState.mode));
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const newMode = tab.dataset.mode;
                if (cpState.mode === 'RGB') cpSyncFromRgb(); else cpSyncFromHsv();
                cpState.mode = newMode;
                // [cwfm] 記住這次選的分頁，下次打開取色器沿用
                if (window.__cwfm.settings) {
                    window.__cwfm.settings.colorPickerMode = newMode;
                    saveSettings(window.__cwfm.settings);
                }
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

        const closeBtn = createCloseBtn(closeAllPanels);
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // 欄位都塞進這個容器，多欄排版（column-count）只套用在這個容器上。
        const fieldsWrap = document.createElement('div');
        fieldsWrap.className = 'cwfm-fields-wrap';
        panel.appendChild(fieldsWrap);
        // [cwfm] panelTarget 改成可以依組別切換——beginGroup() 建立一個
        // 新的分組卡片（見上面 .cwfm-group CSS），並把 panelTarget 重新
        // 指向這個卡片內部的容器，接下來呼叫的 addXxxField() 就會塞進
        // 這一組，不用每個函式各自多傳一個「要塞去哪裡」的參數。
        let panelTarget = fieldsWrap; // add*Field() 系列函式改成往這裡塞
        function beginGroup(title) {
            const group = document.createElement('div');
            group.className = 'cwfm-group';
            const heading = document.createElement('div');
            heading.className = 'cwfm-group-title';
            heading.textContent = title;
            group.appendChild(heading);
            fieldsWrap.appendChild(group);
            panelTarget = group;
        }

        // [cwfm] 主題功能，先做最陽春堪用的介面（下拉選單 + 三個按鈕），
        // 核心機制（存/套用/刪除）確認邏輯沒問題之後，再回頭處理介面
        // 分區、群組這類排版問題——跟使用者討論過，故意先分開，避免
        // 機制邏輯的問題跟排版調整的問題混在一起，難以分辨是哪邊出錯。
        beginGroup('\u4f48\u666f\u4e3b\u984c');
        (function buildThemeUI() {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            // [cwfm] 這裡原本自己有一個 <label>「佈景主題」，現在改成
            // beginGroup() 建立的組標題已經寫了同樣的字，拿掉避免重複。
            const wrap = document.createElement('div');
            wrap.className = 'cwfm-keylist';
            field.appendChild(wrap);

            function render() {
                wrap.innerHTML = '';
                settings.savedThemes.forEach((theme) => {
                    const chip = cwfmBuildChip(theme.name, {
                        onSelect: () => cwfmApplyTheme(settings, theme),
                        onRename: (newName) => { theme.name = newName; saveSettings(settings); },
                        onRenameDone: render,
                        onUpdate: async () => {
                            const confirmed = await cwfmConfirmDialog(
                                '\u8986\u84cb\u66f4\u65b0\u4f48\u666f\u4e3b\u984c',
                                '\u78ba\u5b9a\u8981\u7528\u76ee\u524d\u756b\u9762\u4e0a\u7684\u8a2d\u5b9a\uff0c\u8986\u84cb\u300c' + theme.name + '\u300d\u9019\u500b\u4f48\u666f\u4e3b\u984c\u539f\u672c\u5132\u5b58\u7684\u5167\u5bb9\u55ce\uff1f\u540d\u7a31\u4e0d\u6703\u6539\u8b8a\uff0c\u4f46\u539f\u672c\u5132\u5b58\u7684\u8a2d\u5b9a\u503c\u6703\u88ab\u53d6\u4ee3\u3001\u7121\u6cd5\u5f80\u56de\u3002'
                            );
                            if (!confirmed) return;
                            cwfmUpdateTheme(settings, theme);
                            await cwfmAlertDialog('\u5df2\u66f4\u65b0', '\u300c' + theme.name + '\u300d\u5df2\u7d93\u66f4\u65b0\u6210\u76ee\u524d\u7684\u8a2d\u5b9a\u3002');
                        },
                        updateLabel: '\u7528\u76ee\u524d\u8a2d\u5b9a\u8986\u84cb\u66f4\u65b0\u9019\u500b\u4f48\u666f\u4e3b\u984c',
                        onRemove: async () => {
                            const confirmed = await cwfmConfirmDialog(
                                '\u522a\u9664\u4f48\u666f\u4e3b\u984c',
                                '\u78ba\u5b9a\u8981\u522a\u9664\u300c' + theme.name + '\u300d\u9019\u500b\u4f48\u666f\u4e3b\u984c\u55ce\uff1f\u9019\u53ea\u6703\u522a\u9664\u4e3b\u984c\u8a18\u9304\u672c\u8eab\uff0c\u4e0d\u6703\u5f71\u97ff\u76ee\u524d\u756b\u9762\u4e0a\u5df2\u7d93\u5957\u7528\u7684\u8a2d\u5b9a\u3002'
                            );
                            if (!confirmed) return;
                            cwfmDeleteTheme(settings, theme.id);
                            render();
                        },
                        removeLabel: '\u522a\u9664\u9019\u500b\u4f48\u666f\u4e3b\u984c',
                    });
                    wrap.appendChild(chip);
                });
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'cwfm-keychip-add';
                addBtn.textContent = '+ \u65b0\u589e\uff0f\u53e6\u5b58\u4e3b\u984c';
                addBtn.addEventListener('click', async () => {
                    const name = await cwfmPromptDialog('\u9019\u500b\u4f48\u666f\u4e3b\u984c\u8981\u53eb\u4ec0\u9ebc\u540d\u5b57\uff1f', '\u4f8b\u5982\uff1a\u8b80\u5c0f\u8aaa\u7528');
                    if (!name) return;
                    cwfmSaveCurrentAsTheme(settings, name);
                    render();
                });
                wrap.appendChild(addBtn);
            }

            panelTarget.appendChild(field);
            render();
        })();


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
            row.className = 'cwfm-checkbox-row';
            const label = document.createElement('label');
            label.textContent = labelText;
            row.appendChild(label);
            // [cwfm] 改成滑動開關（膠囊軌道 + 圓形滑塊），不是原生核取
            // 方塊——底層還是用真正的 <input type="checkbox">（螢幕閱讀器、
            // 鍵盤操作、表單語意都靠它），只是把它原生的視覺外觀藏起來，
            // 用旁邊一個 <span> 畫出開關的樣子，這是業界做這種開關最常見
            // 的做法，不是重新發明一個假的控制項。
            const switchWrap = document.createElement('label');
            switchWrap.className = 'cwfm-switch';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!settings[key];
            input.addEventListener('change', () => {
                settings[key] = input.checked;
                saveSettings(settings);
                applySettings(settings);
            });
            const track = document.createElement('span');
            track.className = 'cwfm-switch-track';
            switchWrap.appendChild(input);
            switchWrap.appendChild(track);
            row.appendChild(switchWrap);
            field.appendChild(row);
            panelTarget.appendChild(field);
            return input;
        }

        // [cwfm] 翻頁快速鍵錄製欄位。list 直接傳 settings.pagingKeys.prev
        // 或 .next 這個陣列的參照，就地新增/刪除，不用另外組裝物件再存
        // 回去；otherList 是另一個方向的陣列，錄製完成、真的要存進 list
        // 之前，要檢查新錄到的組合鍵有沒有跟 list 自己、或 otherList
        // 重複（同一組鍵不能同時是「往前」又是「往後」，也不能在同一個
        // 方向裡重複收兩次）。
        function addKeyListField(labelText, list, otherList) {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            const label = document.createElement('label');
            label.textContent = labelText;
            field.appendChild(label);
            const listEl = document.createElement('div');
            listEl.className = 'cwfm-keylist';
            const hintEl = document.createElement('div');
            hintEl.className = 'cwfm-keylist-hint';
            hintEl.style.display = 'none';

            function render() {
                listEl.innerHTML = '';
                list.forEach((combo, idx) => {
                    const chip = document.createElement('span');
                    chip.className = 'cwfm-keychip';
                    chip.textContent = combo;
                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.className = 'cwfm-keychip-remove';
                    removeBtn.textContent = '\u00d7';
                    removeBtn.setAttribute('aria-label', '\u522a\u9664\u9019\u7d44\u5feb\u901f\u9375');
                    removeBtn.addEventListener('click', () => {
                        list.splice(idx, 1);
                        saveSettings(settings);
                        render();
                    });
                    chip.appendChild(removeBtn);
                    listEl.appendChild(chip);
                });
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'cwfm-keychip-add';
                addBtn.textContent = '+ \u65b0\u589e';
                addBtn.addEventListener('click', () => startRecording(addBtn));
                listEl.appendChild(addBtn);
            }

            function startRecording(addBtn) {
                const originalText = addBtn.textContent;
                addBtn.textContent = '\u8acb\u6309\u4e0b\u6309\u9375\u2026\uff08Esc \u53d6\u6d88\uff09';
                addBtn.disabled = true;
                hintEl.style.display = 'none';

                function cleanup() {
                    document.removeEventListener('keydown', onKeydown, true);
                    addBtn.textContent = originalText;
                    addBtn.disabled = false;
                }
                function onKeydown(e) {
                    // capture 階段擋下，不要讓這次錄製過程中按到的鍵，
                    // 又被其他地方（例如翻頁本身）當作正常操作處理掉。
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === 'Escape') { cleanup(); return; }
                    const combo = formatKeyCombo(e);
                    if (!combo) return; // 還在按修飾鍵，繼續等下一次 keydown
                    if (list.includes(combo) || otherList.includes(combo)) {
                        hintEl.textContent = '\u300c' + combo + '\u300d\u5df2\u7d93\u88ab\u4f7f\u7528\u4e86\uff0c\u63db\u4e00\u7d44\u770b\u770b';
                        hintEl.style.display = 'block';
                        cleanup();
                        return;
                    }
                    list.push(combo);
                    saveSettings(settings);
                    cleanup();
                    render();
                }
                document.addEventListener('keydown', onKeydown, true);
            }

            render();
            field.appendChild(listEl);
            field.appendChild(hintEl);
            panelTarget.appendChild(field);
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
                        colorSchemeState.setValue('custom');
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
        // [cwfm] 「配色」改成跟其他標籤清單一致的視覺語言，但這五個是
        // 固定的內建選項，不是使用者自己管理的清單——不做叉叉/改名，
        // 只做「點選套用 + 標示目前選中哪一個」。colorSchemeState 提供
        // 一個 setValue()，讓下面 addColorField 的 change 事件（使用者
        // 自己調整顏色時，要自動切成「自訂」這個選項）可以呼叫。
        beginGroup('\u914d\u8272');
        const colorSchemeState = (function buildColorSchemeUI() {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            // [cwfm] 同上，這裡原本的 <label>「配色」拿掉，避免跟組標題
            // 重複。
            const wrap = document.createElement('div');
            wrap.className = 'cwfm-keylist';
            field.appendChild(wrap);

            // [cwfm] 只有這四個是固定的內建選項，不能刪、不能改名——
            // 「自訂」不再是這裡的固定第五個選項，改成下面 savedColorSchemes
            // 那份使用者自己管理的清單，可以存不止一組。
            const builtinOptions = [
                ['auto', '\u8ddf\u96a8\u7cfb\u7d71'],
                ['light', '\u4eae\u8272'],
                ['dark', '\u6697\u8272'],
                ['sepia', '\u5fa9\u53e4\u9ec3'],
            ];

            function applyBuiltin(value) {
                settings.themeName = value;
                saveSettings(settings);
                applySettings(settings);
                render();
            }

            function applyCustomScheme(scheme) {
                settings.themeName = 'custom';
                settings.customTextColor = scheme.textColor;
                settings.customBackgroundColor = scheme.backgroundColor;
                saveSettings(settings);
                applySettings(settings);
                // [cwfm] 顏色欄位(下面 addColorField 建立的取色器色塊)要
                // 跟著同步更新顯示——這兩個按鈕變數在這個函式定義的當下
                // 還沒宣告(addColorField 排在後面才呼叫)，但這個函式只
                // 會在使用者點擊標籤時才真正執行，那時候變數早就指派好
                // 了，安全，跟這份程式碼裡其他地方引用「稍後才宣告的
                // 變數」的做法一致。
                textColorSwatchBtn.style.background = scheme.textColor;
                bgColorSwatchBtn.style.background = scheme.backgroundColor;
                render();
            }

            function render() {
                wrap.innerHTML = '';
                builtinOptions.forEach(([value, labelText]) => {
                    const chip = document.createElement('span');
                    chip.className = 'cwfm-keychip cwfm-keychip-option'
                        + (settings.themeName === value ? ' cwfm-keychip-selected' : '');
                    chip.textContent = labelText;
                    chip.addEventListener('click', () => applyBuiltin(value));
                    wrap.appendChild(chip);
                });
                (settings.savedColorSchemes || []).forEach((scheme) => {
                    const isActive = settings.themeName === 'custom'
                        && settings.customTextColor === scheme.textColor
                        && settings.customBackgroundColor === scheme.backgroundColor;
                    const chip = cwfmBuildChip(scheme.name, {
                        extraClass: 'cwfm-keychip-option' + (isActive ? ' cwfm-keychip-selected' : ''),
                        onSelect: () => applyCustomScheme(scheme),
                        onRename: (newName) => { scheme.name = newName; saveSettings(settings); },
                        onRenameDone: render,
                        onRemove: async () => {
                            const confirmed = await cwfmConfirmDialog(
                                '\u522a\u9664\u81ea\u8a02\u914d\u8272',
                                '\u78ba\u5b9a\u8981\u522a\u9664\u300c' + scheme.name + '\u300d\u9019\u7d44\u81ea\u8a02\u914d\u8272\u55ce\uff1f'
                            );
                            if (!confirmed) return;
                            const idx = settings.savedColorSchemes.findIndex((s) => s.id === scheme.id);
                            if (idx >= 0) settings.savedColorSchemes.splice(idx, 1);
                            saveSettings(settings);
                            render();
                        },
                        removeLabel: '\u522a\u9664\u9019\u7d44\u81ea\u8a02\u914d\u8272',
                    });
                    wrap.appendChild(chip);
                });
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'cwfm-keychip-add';
                addBtn.textContent = '+ \u5132\u5b58\u76ee\u524d\u81ea\u8a02\u914d\u8272';
                addBtn.addEventListener('click', async () => {
                    const name = await cwfmPromptDialog('\u9019\u7d44\u81ea\u8a02\u914d\u8272\u8981\u53eb\u4ec0\u9ebc\u540d\u5b57\uff1f', '\u4f8b\u5982\uff1a\u591c\u9592\u95b1\u8b80');
                    if (!name) return;
                    const id = 'cwfm-scheme-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                    settings.savedColorSchemes.push({
                        id, name,
                        textColor: settings.customTextColor,
                        backgroundColor: settings.customBackgroundColor,
                    });
                    saveSettings(settings);
                    render();
                });
                wrap.appendChild(addBtn);
            }

            panelTarget.appendChild(field);
            render();
            return {
                setValue(value) {
                    settings.themeName = value;
                    render();
                },
            };
        })();
        const textColorSwatchBtn = addColorField('\u81ea\u8a02\u6587\u5b57\u984f\u8272', 'customTextColor');
        const bgColorSwatchBtn = addColorField('\u81ea\u8a02\u80cc\u666f\u984f\u8272', 'customBackgroundColor');
        addCheckboxField('\u512a\u5148\u5957\u7528\u66f8\u7c4d\u539f\u59cb\u6587\u5b57\u6a23\u5f0f\uff08\u4e0d\u5f37\u5236\u8986\u84cb\u6587\u5b57\u984f\u8272\uff09', 'preferOriginalTextColor');

        // [cwfm] 字型名稱記憶 + 上傳字型清單。settings.fontNameHistory
        // （手動輸入過的名稱）跟 settings.uploadedFonts（上傳字型，實際
        // 檔案存在 IndexedDB，這裡只放中繼資料）共用同一排標籤顯示。
        // 不再用一個常駐的文字輸入框讓使用者打字——跟其他標籤清單
        // （佈景主題、配色）用同一套介面語言：點「+」跳出對話框輸入
        // 名稱，輸入完直接變成一個新標籤並套用，不用另外留一個輸入框。
        beginGroup('\u5b57\u9ad4');
        (function buildFontChipsUI() {
            const field = document.createElement('div');
            field.className = 'cwfm-field';
            // [cwfm] 同上，拿掉重複的 <label>「字體」。
            const wrap = document.createElement('div');
            wrap.className = 'cwfm-keylist';
            field.appendChild(wrap);
            panelTarget.appendChild(field);

            const uploadInput = document.createElement('input');
            uploadInput.type = 'file';
            uploadInput.accept = '.ttf,.otf,.woff';
            uploadInput.style.display = 'none';
            panelTarget.appendChild(uploadInput);

            function selectFont(name) {
                settings.fontFamily = name;
                saveSettings(settings);
                applySettings(settings);
            }

            function removeHistoryName(name) {
                const idx = settings.fontNameHistory.indexOf(name);
                if (idx >= 0) { settings.fontNameHistory.splice(idx, 1); saveSettings(settings); render(); }
            }

            async function removeUploadedFont(entry) {
                // [cwfm] 規則：上傳字型的刪除一律先跳確認視窗，不管這個
                // 檔案背後掛著幾個名稱（現在固定是 1 個，但這個規則本身
                // 跟數量無關，是「上傳字型」這個類型整體的規則）。
                const confirmed = await cwfmConfirmDialog(
                    '\u522a\u9664\u4e0a\u50b3\u5b57\u578b',
                    '\u78ba\u5b9a\u8981\u522a\u9664\u300c' + entry.name + '\u300d\u55ce\uff1f\u522a\u9664\u5f8c\uff0c\u9019\u500b\u5b57\u578b\u6703\u5f9e\u6e05\u55ae\u4e2d\u79fb\u9664\uff0c\u76ee\u524d\u82e5\u6b63\u5728\u4f7f\u7528\u9019\u500b\u5b57\u578b\uff0c\u6703\u6539\u56de\u4f7f\u7528\u9810\u8a2d\u5b57\u578b\u3002'
                );
                if (!confirmed) return;
                try { await cwfmDeleteFontBlob(entry.id); } catch (e) { console.error('[cwfm:font] 刪除字型資料失敗', e); }
                const idx = settings.uploadedFonts.findIndex((f) => f.id === entry.id);
                if (idx >= 0) settings.uploadedFonts.splice(idx, 1);
                if (settings.fontFamily === entry.name) settings.fontFamily = '';
                saveSettings(settings);
                applySettings(settings);
                render();
            }

            function render() {
                wrap.innerHTML = '';
                (settings.fontNameHistory || []).forEach((name) => {
                    const chip = cwfmBuildChip(name, {
                        extraClass: settings.fontFamily === name ? 'cwfm-keychip-selected' : '',
                        onSelect: () => selectFont(name),
                        onRename: (newName) => {
                            const idx = settings.fontNameHistory.indexOf(name);
                            if (idx >= 0) settings.fontNameHistory[idx] = newName;
                            if (settings.fontFamily === name) selectFont(newName);
                            else saveSettings(settings);
                        },
                        onRemove: () => removeHistoryName(name),
                        removeLabel: '\u522a\u9664\u9019\u7b46\u8a18\u61b6',
                        onRenameDone: render,
                    });
                    wrap.appendChild(chip);
                });
                (settings.uploadedFonts || []).forEach((entry) => {
                    const chip = cwfmBuildChip(entry.name, {
                        icon: '\u2191',
                        // [cwfm] 「藍色」在其他標籤清單(佈景主題、配色)裡
                        // 代表「目前選中」，這個標籤不管有沒有被選中都是
                        // 藍色，會混淆——拿掉專屬色，套用中的時候一樣用
                        // 通用的 cwfm-keychip-selected，是不是上傳字型
                        // 純粹靠圖示本身分辨。
                        extraClass: settings.fontFamily === entry.name ? 'cwfm-keychip-selected' : '',
                        onSelect: () => selectFont(entry.name),
                        onRename: (newName) => {
                            const wasActive = settings.fontFamily === entry.name;
                            entry.name = newName;
                            if (wasActive) selectFont(newName);
                            else saveSettings(settings);
                        },
                        onRemove: () => removeUploadedFont(entry),
                        removeLabel: '\u522a\u9664\u9019\u500b\u4e0a\u50b3\u5b57\u578b',
                        onRenameDone: render,
                    });
                    wrap.appendChild(chip);
                });
                const addNameBtn = document.createElement('button');
                addNameBtn.type = 'button';
                addNameBtn.className = 'cwfm-keychip-add';
                addNameBtn.textContent = '+ \u65b0\u589e\u5b57\u578b\u540d\u7a31';
                addNameBtn.addEventListener('click', async () => {
                    const name = await cwfmPromptDialog(
                        '\u8f38\u5165\u5b57\u578b\u540d\u7a31',
                        '\u672c\u6a5f\u5df2\u5b89\u88dd\u7684\u5b57\u578b\u540d\u7a31\uff0c\u4f8b\u5982\uff1aTC_JBMM_1011'
                    );
                    if (!name) return;
                    if (!settings.fontNameHistory.includes(name) && !settings.uploadedFonts.some((f) => f.name === name)) {
                        settings.fontNameHistory.push(name);
                    }
                    selectFont(name);
                    render();
                });
                wrap.appendChild(addNameBtn);
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'cwfm-keychip-add';
                addBtn.textContent = '+ \u4e0a\u50b3\u5b57\u578b';
                addBtn.addEventListener('click', () => uploadInput.click());
                wrap.appendChild(addBtn);
            }

            uploadInput.addEventListener('change', async () => {
                const file = uploadInput.files[0];
                uploadInput.value = '';
                if (!file) return;
                const CWFM_MAX_FONT_SIZE = 200 * 1024 * 1024;
                if (file.size > CWFM_MAX_FONT_SIZE) {
                    await cwfmAlertDialog('\u6a94\u6848\u904e\u5927', '\u9019\u500b\u5b57\u578b\u6a94\u6848\u8d85\u904e 200MB \u7684\u4e0a\u9650\uff0c\u6c92\u6709\u4e0a\u50b3\u3002');
                    return;
                }
                const ext = (file.name.split('.').pop() || '').toLowerCase();
                if (!['ttf', 'otf', 'woff'].includes(ext)) {
                    await cwfmAlertDialog('\u4e0d\u652f\u63f4\u7684\u683c\u5f0f', '\u53ea\u652f\u63f4 .ttf / .otf / .woff \u6a94\u6848\u3002');
                    return;
                }
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const name = await cwfmParseUploadedFontNames(arrayBuffer, file.name);
                    const id = 'cwfm-font-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                    await cwfmSaveFontBlob(id, arrayBuffer, ext);
                    settings.uploadedFonts.push({ id, fileName: file.name, format: ext, name });
                    saveSettings(settings);
                    render();
                } catch (e) {
                    console.error('[cwfm:font] 上傳字型失敗', e);
                    await cwfmAlertDialog('\u4e0a\u50b3\u5931\u6557', '\u4e0a\u50b3\u5931\u6557\uff0c\u8acb\u67e5\u770b\u4e3b\u63a7\u53f0\u932f\u8aa4\u8a0a\u606f\u3002');
                }
            });

            render();
        })();
        beginGroup('\u6587\u5b57\u6392\u7248');
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
        beginGroup('\u7248\u9762\u914d\u7f6e');
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

        beginGroup('\u7ffb\u9801\u5feb\u901f\u9375');
        addKeyListField('\u5F80\u524D\u7FFB\u9801\u5FEB\u901F\u9375', settings.pagingKeys.prev, settings.pagingKeys.next);
        addKeyListField('\u5F80\u5F8C\u7FFB\u9801\u5FEB\u901F\u9375', settings.pagingKeys.next, settings.pagingKeys.prev);

        beginGroup('\u95b1\u8b80\u884c\u70ba');
        // [cwfm] 翻頁精準定位（原本叫「實驗性功能」，session-only 不存檔
        // ——現在已經穩定到不會弄壞整個介面，改用一般的 addCheckboxField()，
        // 跟其他設定一樣正常存檔，不用每次重新整理都要重新勾選。
        addCheckboxField('\u7ffb\u9801\u7cbe\u6e96\u5b9a\u4f4d\uff1a\u7e2e\u653e\u002f\u9084\u539f\u66f8\u7c64\u6642\u5617\u8a66\u7cbe\u6e96\u5c0d\u9f4a\u5b9a\u4f4d\u9ede', 'preciseAnchorAlign');

        // [cwfm] 三個進度記憶功能各自獨立、各有各的開關，不要混在一起：
        // 功能一（本機自動記憶）、功能三（停留自動同步）都是設定選單裡的
        // 開關；功能二（手動同步）不需要開關，是工具列上的按鈕，使用者
        // 按下去才會觸發，本來就是主動行為，不需要另外開關控制。
        addCheckboxField('\u672c\u6a5f\u81ea\u52d5\u8a18\u61b6\u95b1\u8b80\u9032\u5ea6\uff08\u7ffb\u9801\u5373\u6642\u5b58\u9032\u9019\u53f0\u700f\u89bd\u5668\uff0c\u4e0d\u540c\u88dd\u7f6e\u4e0d\u6703\u540c\u6b65\uff09', 'localAutoRemember');
        addCheckboxField('\u505c\u7559\u5f8c\u81ea\u52d5\u540c\u6b65\u5230\u4f3a\u670d\u5668\uff08\u9700\u8981 CSRF token \u9001\u8acb\u6c42\uff0c\u8de8\u88dd\u7f6e\u53ef\u8b80\u5230\uff09', 'autoSyncEnabled');
        addRangeField('\u505c\u7559\u5e7e\u79d2\u5f8c\u540c\u6b65', 'autoSyncDelaySeconds', 1, 60, 1, '\u79d2');
        addCheckboxField('\u81EA\u52D5\u96B1\u85CF\u5DE5\u5177\u5217\uff083 \u79D2\u7121\u52D5\u4F5C\u5F8C\u6ED1\u5165\u908A\u7DE3\uff0c\u6ED1\u9F20\u79FB\u5230\u908A\u7DE3\u6216\u9EDE\u64CA\u539F\u4F4D\u7F6E\u55DA\u9192\uff09', 'autoHideToolbar');

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

        const closeBtn = createCloseBtn(closeAllPanels);
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
                    // [cwfm] 目錄跳轉是使用者主動導覽到別的地方，如果目前
                    // 這一章還有定位點對齊搬走、還沒接回去的內容，要先接
                    // 回去，不要讓它繼續晾在記憶體裡——不然使用者之後如果
                    // 又跳回這一章，會對到一份少了一截內容的舊暫存。
                    cwfmReinsertStash();
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
            try { cwfmGoLeft(); } catch (e) { console.error('[cwfm:toolbar] goLeft 失敗', e); }
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
            try { cwfmGoRight(); } catch (e) { console.error('[cwfm:toolbar] goRight 失敗', e); }
        });
        bar.appendChild(nextBtn);

        document.body.appendChild(bar);

        // 依 relocate 事件同步進度條與百分比顯示（使用者正在拖曳時不要被蓋過去）
        view.addEventListener('relocate', (e) => {
            if (sliderDragging) return;
            // [cwfm] 定位點對齊操作進行中，這一章的內容量暫時被動過手腳，
            // 這段期間算出來的百分比會不準（本章總頁數暫時變少，比例會
            // 偏高）。操作期間維持顯示操作前的最後一個正確數字不動，不
            // 要更新畫面；操作結束後，真正確定的新位置那次 relocate 才
            // 會讓畫面更新，使用者完全不會看到任何中間閃爍的錯誤數字。
            if (cwfmAligningAnchor) return;
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
        // 初始值從 Calibre-Web 自己注入的全域變數 calibre.bookmark 取得
        // （不是網址 hash——查證過 location.hash 實測是空字串，伺服器書籤
        // 是透過 Jinja2 模板寫進這個全域變數，不在網址上）。typeof 判斷
        // 是保險：讀不到就當這本書沒有伺服器書籤，不要整個掛掉。
        let currentServerBookmarkCfi = (typeof calibre !== 'undefined' && calibre && calibre.bookmark)
            ? wrapCfi(calibre.bookmark)
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
        // [cwfm] 給停留自動同步（見上面 view.addEventListener('relocate', ...)
        // 那段功能三的程式碼，跟這裡不在同一個函式作用域）呼叫的窗口，
        // 同步成功後更新這裡的區域變數並重畫圖示，行為要跟手動按書籤
        // 按鈕成功後完全一樣。
        window.__cwfm.onBookmarkSynced = (cfi) => {
            currentServerBookmarkCfi = wrapCfi(cfi);
            renderBookmarkIcon();
        };
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
        // [cwfm] 全螢幕切換時要順便喚醒自動隱藏的工具列（原本是靠
        // relocate 事件附帶觸發，但那一行已經拿掉——見下面 relocate
        // 監聽器移除處的說明——這裡改成明確掛在 fullscreenchange 上，
        // 不用再靠巧合。
        document.addEventListener('fullscreenchange', () => {
            console.log('[cwfm:align:t] fullscreenchange 事件 t=' + performance.now().toFixed(1) + ' fullscreenElement=' + !!document.fullscreenElement);
            renderFullscreenIcon();
            cwfmWakeBars();
        });
        bar.appendChild(fullscreenBtn);

        document.body.appendChild(bar);
        return bar;
    }

    let tocPanel, settingsPanel, toolbar, topToolbar;

    // [cwfm] 這幾個狀態變數（CWFM_AUTOHIDE_DELAY_MS 跟下面三個 let，還有
    // 緊接著的幾個函式）故意放在 buildSettingsPanel() 被呼叫之前：
    // buildSettingsPanel() 結尾會呼叫 applySettings() →
    // updateAutoHideEnabled()，會讀寫這幾個變數；原本這段宣告寫在
    // buildSettingsPanel() 呼叫「之後」，第一次開書那次呼叫會踩到 let 的
    // TDZ（宣告那行還沒執行到，提前存取會丟 ReferenceError），因為包在
    // try/catch 裡，錯誤被靜靜吞掉、只印在 console，導致自動隱藏第一次
    // 永遠不會真的啟動，要手動把設定關掉再開一次（那次呼叫已經晚於這裡
    // 的宣告）才會生效。這裡只是搬移宣告位置，函式邏輯本身不用動；
    // toolbar/topToolbar 這時候都還是 undefined，但函式內容要等真正被
    // 呼叫時才會用到它們（透過 ?. 安全存取），不影響現在先定義函式本身。
    const CWFM_AUTOHIDE_DELAY_MS = 3000;
    let cwfmAutoHideEnabled = false;
    let cwfmAutoHideTimer = null;
    let cwfmAutoHideHoveringBar = false;
    function cwfmShowBars() {
        toolbar?.classList.remove('cwfm-autohidden');
        topToolbar?.classList.remove('cwfm-autohidden');
    }
    function cwfmHideBars() {
        if (cwfmAutoHideHoveringBar) return;
        toolbar?.classList.add('cwfm-autohidden');
        topToolbar?.classList.add('cwfm-autohidden');
    }
    function cwfmScheduleAutoHide() {
        clearTimeout(cwfmAutoHideTimer);
        if (!cwfmAutoHideEnabled) return;
        cwfmAutoHideTimer = setTimeout(cwfmHideBars, CWFM_AUTOHIDE_DELAY_MS);
    }
    function cwfmWakeBars() {
        if (!cwfmAutoHideEnabled) return;
        cwfmShowBars();
        cwfmScheduleAutoHide();
    }
    function updateAutoHideEnabled(enabled) {
        cwfmAutoHideEnabled = !!enabled;
        clearTimeout(cwfmAutoHideTimer);
        if (cwfmAutoHideEnabled) cwfmWakeBars();
        else cwfmShowBars();
    }

    try { tocPanel = buildTOCPanel(); } catch (e) { console.error('[cwfm:toc] 建立目錄面板失敗', e); }
    try { settingsPanel = buildSettingsPanel(); } catch (e) { console.error('[cwfm:settings] 建立設定面板失敗', e); }
    try { toolbar = buildToolbar(tocPanel, settingsPanel); } catch (e) { console.error('[cwfm:toolbar] 建立工具列失敗', e); }
    try { topToolbar = buildTopToolbar(tocPanel, settingsPanel); } catch (e) { console.error('[cwfm:toolbar] 建立上方工具列失敗', e); }

    try {
        const topZone = document.createElement('div');
        topZone.className = 'cwfm-autohide-zone cwfm-top';
        topZone.dataset.cwfmOwned = 'true';
        const bottomZone = document.createElement('div');
        bottomZone.className = 'cwfm-autohide-zone cwfm-bottom';
        bottomZone.dataset.cwfmOwned = 'true';
        document.body.appendChild(topZone);
        document.body.appendChild(bottomZone);
        [topZone, bottomZone].forEach(zone => {
            zone.addEventListener('mouseenter', cwfmWakeBars);
            zone.addEventListener('click', cwfmWakeBars);
        });
        [toolbar, topToolbar].forEach(bar => {
            if (!bar) return;
            bar.addEventListener('mouseenter', () => { cwfmAutoHideHoveringBar = true; clearTimeout(cwfmAutoHideTimer); });
            bar.addEventListener('mouseleave', () => { cwfmAutoHideHoveringBar = false; cwfmScheduleAutoHide(); });
        });
        // [cwfm] 原本這裡掛 view.addEventListener('relocate', cwfmWakeBars)
        // ——翻頁（不分滑鼠或鍵盤）都會觸發 relocate，導致鍵盤連續翻頁時
        // 每按一次都會把已經隱藏的工具列重新叫醒、3 秒後才又收回去，不
        // 符合預期（翻頁本身不該被視為「操作工具列」）。改成只靠滑鼠
        // 移到邊緣感應區/點擊感應區（上面 topZone/bottomZone 那兩行），
        // 加上全螢幕切換（見上面 fullscreenchange 監聽器）這兩種明確的
        // 方式喚醒，翻頁不會再誤觸。
    } catch (e) { console.error('[cwfm:autohide] 初始化自動隱藏失敗', e); }

    // [cwfm] 定位點對齊：開書流程走到這裡，位置已經還原完成（本機記憶／
    // 伺服器書籤／或從頭開始），明確地把當下位置存一次當作起始的鎖定
    // 目標——不能只靠上面那個 relocate 監聽器（reason 過濾條件只認
    // page/navigation，開書還原位置這次的 reason 很可能是 anchor，會被
    // 擋掉，不會自動記錄到，這裡要另外補一次）。
    try {
        const initialCfi = view.lastLocation?.cfi;
        if (initialCfi) {
            cwfmLockedAnchorCfi = initialCfi;
            console.log('[cwfm:align:t] 開書完成，初始鎖定定位點=' + initialCfi);
        }
    } catch (e) { console.error('[cwfm:align] 初始鎖定定位點失敗', e); }

    console.log('[cwfm] Calibre-Web Foliate Reader Mod 已接管閱讀器，書籍 ID：', BOOK_ID);
})();
