;(async () => {
    const VIEWER_SELECTOR = '__VIEWER_SELECTOR__';
    const BOOK_ID = '__BOOK_ID__';
    const STORAGE_KEY = 'cwfm-settings';

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
            // Calibre-Web 原本的 main.css 把 #viewer 卡死在父層高度的 80%
            // （是原本 epub.js 版面上下保留給其他元件的空間），我們的新工具列
            // 改用 fixed 定位、不使用那預留的 20%，變成整塊空白。覆蓋成真正
            // 撐滿可用空間，扣掉我們自己保留給工具列的高度。
            '#viewer { height: calc(100% - 44px) !important; }',
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

    let book;
    try {
        const res = await fetch('/show/' + BOOK_ID + '/epub/file.epub', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('下載 epub 失敗：HTTP ' + res.status);
        const blob = await res.blob();
        const file = new File([blob], BOOK_ID + '.epub', { type: 'application/epub+zip' });

        await view.open(file);
        view.renderer.next();
        book = view.book;
    } catch (e) {
        console.error('[cwfm] 開啟書籍失敗：', e);
        viewerContainer.innerHTML = '';
        viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）書籍載入失敗，詳見主控台錯誤訊息。';
        return;
    }

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
        ].join('\n');
        document.head.appendChild(style);
    }
    try { injectStyles(); } catch (e) { console.error('[cwfm:injectStyles]', e); }

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
        flow: 'paginated',
        topBottomPadding: 48,  // px，對應 renderer 的 margin 屬性
        leftRightPadding: 24,  // px，對應 renderer 的 gap 屬性（換算成百分比）
        maxColumnCount: 2,
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULT_SETTINGS };
            return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        } catch (e) {
            console.error('[cwfm:settings] 讀取設定失敗，改用預設值', e);
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
            '}',
            'pre { white-space: pre-wrap !important; }',
            // [cwfm] 有些書的封面圖片本身沒有設定保持長寬比（直接整張拉伸
            // 填滿容器），容器尺寸只要因為邊界調整而改變一點點，圖片就會
            // 明顯變形。強制用 object-fit: contain，保持原始比例、多餘
            // 空間留白，不再整張硬拉伸。
            'img, svg {',
            '  object-fit: contain !important;',
            '  max-width: 100% !important;',
            '  max-height: 100% !important;',
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

    function applySettings(settings) {
        try {
            view.renderer.setStyles?.(getTypographyCSS(settings));
        } catch (e) { console.error('[cwfm:settings] 套用字體樣式失敗', e); }
        try {
            view.renderer.setAttribute('flow', settings.flow);
            view.renderer.setAttribute('margin', settings.topBottomPadding);
            view.renderer.setAttribute('max-column-count', settings.maxColumnCount);
            applyHorizontalPadding(settings.leftRightPadding, settings.maxColumnCount);
        } catch (e) { console.error('[cwfm:settings] 套用版面屬性失敗', e); }
        window.__cwfm.settings = settings;
    }

    // 視窗尺寸改變時，gap／max-inline-size 都需要根據新的容器寬度重新
    // 換算，否則實際留白像素值會跟著視窗大小漂移。
    window.addEventListener('resize', () => {
        if (window.__cwfm.settings) {
            try {
                applyHorizontalPadding(window.__cwfm.settings.leftRightPadding, window.__cwfm.settings.maxColumnCount);
            } catch (e) { console.error('[cwfm:settings] 視窗縮放後重新套用左右留白失敗', e); }
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
        addSelectField('\u7FFB\u9801\u6A21\u5F0F', 'flow', [
            ['paginated', '\u5206\u9801'],
            ['scrolled', '\u6372\u52D5'],
        ]);
        addRangeField('\u4e0a\u4e0b\u7559\u767d', 'topBottomPadding', 4, 120, 1, 'px');
        addRangeField('\u5de6\u53f3\u7559\u767d', 'leftRightPadding', 4, 120, 1, 'px');
        addRangeField('\u6700\u5927\u6B04\u6578', 'maxColumnCount', 1, 4, 1, '');

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
