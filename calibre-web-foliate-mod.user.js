// ==UserScript==
// @name         Calibre-Web Foliate Reader (mod)
// @namespace    https://github.com/bgtsai/calibre-web-foliate-mod
// @version      0.9.3
// @description  Replace Calibre-Web's built-in epub.js reader with a foliate-js based reader for better pagination and layout control.
// @author       bgtsai
// @match        *://*/read/*/epub*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @connect      raw.githubusercontent.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // === 沿革（重要，之後改動前先讀） ===
    // v0.1.0：注入 <script type="module"> 去 import cdn.jsdelivr.net 的 view.js，
    //   被 Calibre-Web 頁面自己的 CSP（default-src 'self'）擋下——我們插入的任何
    //   <script> 標籤（不論 inline 或外部來源）都受頁面 CSP 管轄。
    // v0.2.0：改把 foliate-js 打包成單一無外部 import 的檔案，用 GM_xmlhttpRequest
    //   （不受 CSP/CORS 管轄）抓取，再用 GM_addElement（Tampermonkey 官方就是設計
    //   來繞過嚴格 CSP 加入 script 元素的 API）插入。CSP 問題解決，但緊接著在
    //   view.open() 內部丟出 "this.renderer.open is not a function"。
    // v0.3.0（這版）：查出真正原因是 Firefox 的 Xray Vision——腳本一旦宣告任何
    //   @grant 就會被放進特權沙盒執行，沙盒去呼叫「頁面上自訂元素透過 prototype
    //   加上去的方法」時，Xray Vision 會把這些方法藏起來（只留瀏覽器原生 DOM
    //   介面），導致 view.open 這類方法在沙盒裡呼叫失敗。更麻煩的是，一旦有
    //   @grant，連原本該用來繞過這層限制的 window.wrappedJSObject 本身也會失效
    //   （Violentmonkey 專案有相同回報），所以沒辦法用「多解一層包裝」來修。
    //   解法是架構上分工：這支腳本（沙盒化）只做兩件需要特權的事——抓檔案、
    //   繞過 CSP 插入東西；實際去操作 foliate-view（開書、翻頁）的邏輯，
    //   包裝成另一段程式碼，一樣用 GM_addElement 插入，但那段程式碼本身在
    //   「頁面本身的環境」執行，完全不會經過沙盒，也就不會撞到 Xray Vision。
    // v0.4.0（這版）：v0.3.0 的兩段式分工，實測後同樣的錯誤還是出現在第二段
    //   （理論上該在頁面環境跑的）程式碼裡，代表問題可能不是（單純）Xray
    //   Vision，也可能是 GM_addElement 插入的內容本身就帶著某種跟 Tampermonkey
    //   有關的執行環境，不是乾淨的頁面環境——這部分還沒有查證到明確定論。
    //   這版先收斂成「只用一次 GM_addElement，把 foliate-js 本體跟我們自己的
    //   應用邏輯合併成同一段程式碼」，排除「兩段程式碼分屬不同執行環境」
    //   這個變數，並在關鍵呼叫前加了診斷輸出，方便下一輪直接看到當下環境的
    //   實際狀態，不用再猜。
    // v0.4.1（這版）：v0.4.0 實測後 renderer.open 的錯誤消失了，診斷輸出證實
    //   foliate-paginator 正確升級，view.open() 也成功執行——但出現新症狀：
    //   內容先正常顯示，過一下子又消失。原因是 main() 裡的清空監看在送出
    //   GM_addElement 呼叫後就立刻停止，這段時間差讓沒被真正攔下來的 epub.js
    //   晚一步完成自己的初始化，把 #viewer 的內容蓋掉。改成成功路徑不再主動
    //   停止監看，讓它永久持續（只會清掉非我們標記的節點，不影響 foliate-view
    //   元素內部自己的渲染內容，留著跑沒有副作用）。
    // v0.5.0（這版）：v0.4.1 之後畫面仍然完全空白（連閃一下都沒有）。用檢查器
    //   直接看 foliate-paginator 內部（它用 closed shadow DOM，JS 完全存取
    //   不到，只能用檢查器的特殊權限看），發現外層骨架（top/header/footer）
    //   都正常建立，但放內容的 #container 是空的。回頭查證 foliate-js 官方
    //   範例 reader.js 的原始碼，確認 view.open() 只負責解析書籍、建好 renderer
    //   骨架，並不會自動觸發顯示第一頁 —— 官方範例在 open() 之後另外呼叫了
    //   view.renderer.next()，這一步我們的程式碼漏掉了。補上後應該就能真正
    //   顯示內容；移除已經確認過的診斷探測。
    // v0.6.0（這版）：v0.5.0 之後畫面終於顯示出來，但 Console 又冒出新的 CSP
    //   違規——這次是 frame-src，因為 foliate-paginator 內部用 blob: 網址
    //   當 iframe 的 src 顯示每一頁內容，而頁面 CSP 不允許 blob: 當 frame
    //   來源。回頭查證知識庫 10_CSP與跨分頁內容渲染，裡面記載 Calibre-Web
    //   原本的 epub.js 用的是 srcdoc（不是 src），而 srcdoc 在這個網站上已經
    //   實測過不會被擋。既然我們自己打包 foliate-js，直接動手 patch 了
    //   paginator.js 與 fixed-layout.js 的原始碼：blob: 網址改用 fetch() 讀出
    //   內容文字（blob: 的 fetch 屬於本地記憶體讀取，不受 CSP 管轄），再用
    //   srcdoc 塞給 iframe，並補上 <base href> 保留原本的相對路徑解析。
    //   這個 patch 只存在於我們自己 vendor 的打包版本裡，不影響上游 foliate-js。
    // v0.7.0（這版）：v0.6.0 實測後，改用 fetch(blob網址) 讀內容那段本身也被
    //   CSP 擋下（connect-src），先前判斷「blob: 的 fetch 屬於本地讀取、不受
    //   CSP 管轄」是錯的，這裡更正。改成在 entry.js 攔截 URL.createObjectURL，
    //   建立「blob 網址 → 原始 Blob 物件」的全域對照表，之後要讀內容直接對
    //   原始 Blob 物件呼叫 .text()，真正做到純記憶體操作、完全不經過網路層，
    //   不會被任何 CSP 指令管轄。
    // v0.8.0（這版）：v0.7.0 之後畫面終於正常顯示（看到封面），但鍵盤/畫面
    //   按鈕都沒反應。畫面上的按鈕是 Calibre-Web 原本的 UI，接的是舊版
    //   epub.js 物件，我們沒建立那個物件，這部分不works 是預期中的（還沒做
    //   我們自己的操作介面）。但鍵盤也沒反應則是漏了一步：完整讀過官方
    //   README 與 reader.js 範例後確認，書本內容顯示在獨立 iframe 裡，鍵盤
    //   事件預設不會從 iframe 往外傳到上層頁面，官方範例除了在外層 document
    //   掛鍵盤監聽器，還會在每次 'load' 事件（章節載入完成）時，額外把同一個
    //   處理函式掛到當次載入的 iframe 內部文件上。這版補上這個機制。
    // v0.9.0（這版）：確認基本閱讀（開書、翻頁）穩定後，這版是大改版——加上
    //   完整的操作介面：底部工具列（上一頁/下一頁/進度條/目錄/設定按鈕）、
    //   目錄側邊欄（沿用官方 ui/tree.js 的樹狀展開邏輯，含鍵盤操作）、設定
    //   選單（字體名稱、字級、字距、行距、對齊、斷字、翻頁模式、邊界、
    //   欄數，即時套用並寫入 localStorage）。同時隱藏 Calibre-Web 原本已經
    //   失效的舊介面元件（#titlebar/#prev/#next/#settings-modal）。
    //   應用程式邏輯獨立寫成 app-ui-full.js 開發、驗證語法後，用 JSON 安全
    //   編碼嵌入這支腳本，避免手動處理巢狀模板字串的跳脫符號出錯。
    //   新元件一律用 cwfm- 前綴命名，避免跟 Calibre-Web 原本的樣式撞名；
    //   四個功能模組（工具列/目錄/設定/整合）各自獨立 try/catch 隔開，
    //   一個壞掉不會拖累其他；關鍵物件掛在 window.__cwfm 方便用 Console 除錯。
    // v0.9.1（這版）：實測後目錄點擊完全沒反應，Console 顯示
    //   "TypeError: t.split is not a function"，呼叫鏈 resolveHref →
    //   resolveNavigation → goTo。查證 view.js 原始碼後確認：view.goTo(target)
    //   內部自己就會呼叫 resolveNavigation()/book.resolveHref() 處理原始 href
    //   字串，我們的目錄點擊邏輯卻多此一舉先手動呼叫了一次
    //   book.resolveHref(href)，把已經解析過的物件又傳給 goTo()，導致它把
    //   物件當成字串去呼叫不存在的 .split()。改成直接把原始 href 字串交給
    //   goTo()。同時幫工具列的翻頁按鈕、進度條跳轉都補上錯誤攔截與記錄，
    //   如果還有其他翻頁相關的問題，下次能直接從 Console 看到，不用再猜。
    // v0.9.2（這版）：新增的 attachShadow 攔截機制（window.__cwfmShadowMap）
    //   實測完全不存在，即使 bundle 原始碼裡確實有這段，追查後發現是
    //   raw.githubusercontent.com 本身有快取，這幾輪改動速度比快取過期時間
    //   還快，導致抓到的其實是舊版 bundle。改成抓取網址加上時間戳記當快取
    //   破壞參數，確保開發階段每次都拿到最新內容。這支腳本還在頻繁修改，
    //   等穩定後可以拿掉這個參數，改吃正常快取。
    // v0.9.3（這版）：追查「上下沒有置中、留白過大」的問題，一路查了 CSS
    //   Grid 的 1fr 分配規則、甚至一度誤判成 FixedLayout 的置中邏輯（後來
    //   查證 renderer tagName 其實是 FOLIATE-PAGINATOR，不是 foliate-fxl，
    //   是我方向查錯了），最後用實測數據抓到真正原因：問題根本不在
    //   foliate-js 內部，是 Calibre-Web 原本的 main.css 把 #viewer 卡死在
    //   父層高度的 80%（是原本 epub.js 版面上下保留給其他元件的空間），
    //   我們的新工具列改用 fixed 定位、不使用那預留的 20%，變成整塊空白
    //   （實測：#main 1000px、#viewer 卡在 800px，剩 200px 完全沒用到）。
    //   在 hideOldUI() 一併加上覆蓋規則，讓 #viewer 真正撐滿視窗扣掉工具列
    //   高度後的可用空間。

    const BUNDLE_URL = 'https://raw.githubusercontent.com/bgtsai/calibre-web-foliate-mod/main/vendor/foliate-view.bundle.js';
    const VIEWER_SELECTOR = '#viewer';

    function getBookId() {
        const m = location.pathname.match(/\/read\/(\d+)\/epub/i);
        return m ? m[1] : null;
    }

    // 等待某個選擇器對應的元素出現，用 MutationObserver 而非輪詢。
    // 因為 @run-at document-start 執行時，body 甚至還沒建立，#viewer 也不一定存在。
    function waitForElement(selector, root = document.documentElement) {
        return new Promise((resolve) => {
            const existing = document.querySelector(selector);
            if (existing) { resolve(existing); return; }

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    resolve(el);
                }
            });
            observer.observe(root, { childList: true, subtree: true });
        });
    }

    // 持續清空 #viewer 容器，直到呼叫回傳的 stop() 為止。
    // 用來防止 epub.js 自己的初始化時機比我們晚，把它塞進來的 iframe 又擠掉我們的元素。
    function keepContainerClearUntilReady(container) {
        const observer = new MutationObserver(() => {
            [...container.children].forEach((child) => {
                if (!child.dataset || child.dataset.cwfmOwned !== 'true') {
                    child.remove();
                }
            });
        });
        observer.observe(container, { childList: true });
        return () => observer.disconnect();
    }

    // 用 GM_xmlhttpRequest 抓取自己打包好的 foliate-js 單一檔案文字內容。
    //
    // [cwfm] 開發階段加上時間戳記當作快取破壞參數（cache-busting）：
    // 曾經實測過，raw.githubusercontent.com 本身會快取內容一段時間，導致
    // 明明已經推送了新版 bundle，實際抓到的還是舊版（症狀：新加的攔截機制
    // window.__cwfmShadowMap 完全不存在，即使 bundle 原始碼裡確實有這段）。
    // 這支腳本還在頻繁修改階段，寧可每次都重新抓一份，等穩定之後可以拿掉
    // 這個查詢參數，改吃正常快取。
    function fetchBundleText() {
        return new Promise((resolve, reject) => {
            const url = BUNDLE_URL + '?_=' + Date.now();
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`foliate-js bundle 下載失敗：HTTP ${res.status}`));
                        return;
                    }
                    resolve(res.responseText);
                },
                onerror: () => reject(new Error('foliate-js bundle 下載失敗（網路錯誤）')),
            });
        });
    }

    // 應用程式邏輯（開書、翻頁、工具列、目錄側邊欄、設定選單、整合）獨立寫成
    // app-ui-full.js 這份檔案，開發時用佔位字串 __VIEWER_SELECTOR__／__BOOK_ID__
    // 取代動態值、方便直接驗證語法，這裡在建置階段用程式安全編碼成 JSON 字串常數，
    // 避免手動處理巢狀模板字串的跳脫符號出錯。
    const APP_SCRIPT_TEMPLATE = ";(async () => {\n    const VIEWER_SELECTOR = '__VIEWER_SELECTOR__';\n    const BOOK_ID = '__BOOK_ID__';\n    const STORAGE_KEY = 'cwfm-settings';\n\n    const viewerContainer = document.querySelector(VIEWER_SELECTOR);\n    if (!viewerContainer) {\n        console.error('[cwfm] 找不到 #viewer 容器');\n        return;\n    }\n\n    await customElements.whenDefined('foliate-view');\n\n    const view = document.createElement('foliate-view');\n    view.dataset.cwfmOwned = 'true';\n    view.style.display = 'block';\n    view.style.width = '100%';\n    view.style.height = '100%';\n\n    viewerContainer.innerHTML = '';\n    viewerContainer.appendChild(view);\n\n    let book;\n    try {\n        const res = await fetch('/show/' + BOOK_ID + '/epub/file.epub', { credentials: 'same-origin' });\n        if (!res.ok) throw new Error('下載 epub 失敗：HTTP ' + res.status);\n        const blob = await res.blob();\n        const file = new File([blob], BOOK_ID + '.epub', { type: 'application/epub+zip' });\n\n        await view.open(file);\n        view.renderer.next();\n        book = view.book;\n    } catch (e) {\n        console.error('[cwfm] 開啟書籍失敗：', e);\n        viewerContainer.innerHTML = '';\n        viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）書籍載入失敗，詳見主控台錯誤訊息。';\n        return;\n    }\n\n    // ============================================================\n    // 鍵盤翻頁（含 iframe 內部文件的轉發，見 v0.8.0 沿革說明）\n    // ============================================================\n    function handleKeydown(e) {\n        try {\n            if (e.key === 'ArrowLeft') view.goLeft();\n            else if (e.key === 'ArrowRight') view.goRight();\n        } catch (err) {\n            console.error('[cwfm:keydown] 翻頁失敗', err);\n        }\n    }\n    document.addEventListener('keydown', handleKeydown);\n    view.addEventListener('load', ({ detail }) => {\n        detail.doc.addEventListener('keydown', handleKeydown);\n    });\n\n    // ============================================================\n    // 除錯用的全域物件：Console 打 __cwfm 就能查目前狀態\n    // ============================================================\n    window.__cwfm = {\n        view,\n        book,\n        bookId: BOOK_ID,\n        settings: null, // 稍後設定選單初始化時會填入\n    };\n\n    // ============================================================\n    // 隱藏 Calibre-Web 原本已經失效的介面元件\n    // ============================================================\n    function hideOldUI() {\n        const style = document.createElement('style');\n        style.textContent = [\n            '#titlebar, #prev, #next, .read-footer, #settings-modal { display: none !important; }',\n            // [cwfm] Calibre-Web 原本的 main.css 把 #viewer 卡死在父層的 80%\n            // 高度（是為了原本 epub.js 版面上下還有別的元件保留的空間），\n            // 我們的新工具列改用 fixed 定位、不佔用 #viewer 自己的版面，這條\n            // 舊規則留下來的另外 20% 完全沒人用，變成畫面下方一大塊空白\n            // （實測驗證：#main 1000px、#viewer 卡在 800px，剩 200px 空著）。\n            // 這裡覆蓋成真正撐滿可用空間，扣掉我們自己保留給工具列的高度。\n            '#viewer { height: calc(100% - 44px) !important; }',\n        ].join('\\n');\n        document.head.appendChild(style);\n    }\n    try { hideOldUI(); } catch (e) { console.error('[cwfm:hideOldUI]', e); }\n\n    // ============================================================\n    // 共用樣式\n    // ============================================================\n    function injectStyles() {\n        const style = document.createElement('style');\n        style.textContent = [\n            '.cwfm-toolbar {',\n            '  position: fixed; left: 0; right: 0; bottom: 0;',\n            '  display: flex; align-items: center; gap: 10px;',\n            '  padding: 8px 14px; background: rgba(24,24,24,0.92);',\n            '  color: #eee; font-family: sans-serif; font-size: 13px;',\n            '  z-index: 999999; box-sizing: border-box;',\n            '}',\n            '.cwfm-toolbar button {',\n            '  background: none; border: 1px solid #666; color: #eee;',\n            '  border-radius: 4px; padding: 5px 12px; cursor: pointer;',\n            '  font-size: 13px; flex: 0 0 auto;',\n            '}',\n            '.cwfm-toolbar button:hover { background: #3a3a3a; }',\n            '.cwfm-progress-wrap { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; }',\n            '.cwfm-progress-wrap input[type=\"range\"] { flex: 1; }',\n            '.cwfm-progress-label { flex: 0 0 auto; min-width: 3.5em; text-align: right; color: #aaa; font-size: 12px; }',\n            '.cwfm-panel {',\n            '  position: fixed; top: 0; bottom: 0; width: 320px; max-width: 85vw;',\n            '  background: #1e1e1e; color: #eee; z-index: 1000000;',\n            '  box-shadow: 0 0 24px rgba(0,0,0,0.6);',\n            '  overflow-y: auto; padding: 18px; box-sizing: border-box;',\n            '  font-family: sans-serif; font-size: 13px;',\n            '  transition: transform 0.2s ease;',\n            '}',\n            '.cwfm-panel[data-side=\"left\"] { left: 0; transform: translateX(-105%); }',\n            '.cwfm-panel[data-side=\"left\"].cwfm-open { transform: translateX(0); }',\n            '.cwfm-panel[data-side=\"right\"] { right: 0; transform: translateX(105%); }',\n            '.cwfm-panel[data-side=\"right\"].cwfm-open { transform: translateX(0); }',\n            '.cwfm-panel h3 { margin: 0 0 12px; font-size: 15px; border-bottom: 1px solid #444; padding-bottom: 8px; }',\n            '.cwfm-panel label { display: block; margin: 14px 0 4px; font-size: 12px; color: #aaa; }',\n            '.cwfm-panel input[type=\"text\"], .cwfm-panel input[type=\"number\"] {',\n            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',\n            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',\n            '  font-size: 13px;',\n            '}',\n            '.cwfm-panel input[type=\"range\"] { width: 100%; }',\n            '.cwfm-panel .cwfm-row { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 4px; }',\n            '.cwfm-panel .cwfm-row label { margin: 0; }',\n            '.cwfm-panel select {',\n            '  width: 100%; box-sizing: border-box; padding: 5px 8px;',\n            '  background: #333; border: 1px solid #555; color: #eee; border-radius: 4px;',\n            '  font-size: 13px;',\n            '}',\n            '.cwfm-close-btn {',\n            '  position: absolute; top: 12px; right: 12px; background: none; border: none;',\n            '  color: #aaa; font-size: 18px; cursor: pointer; line-height: 1;',\n            '}',\n            '.cwfm-close-btn:hover { color: #fff; }',\n            '.cwfm-toc-view { list-style: none; margin: 0; padding: 0; }',\n            '.cwfm-toc-view ol { list-style: none; margin: 0; padding: 0; }',\n            '.cwfm-toc-view [role=\"treeitem\"] {',\n            '  display: block; padding: 5px 0; color: #ccc; text-decoration: none; cursor: pointer;',\n            '}',\n            '.cwfm-toc-view [role=\"treeitem\"]:hover { color: #fff; }',\n            '.cwfm-toc-view [role=\"treeitem\"][aria-current=\"page\"] { color: #4ea1ff; font-weight: bold; }',\n            '.cwfm-toc-view [aria-expanded=\"false\"] ~ ol { display: none; }',\n            '.cwfm-empty-hint { color: #888; font-size: 12px; }',\n            '.cwfm-dimming {',\n            '  position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 999998;',\n            '  opacity: 0; pointer-events: none; transition: opacity 0.2s ease;',\n            '}',\n            '.cwfm-dimming.cwfm-show { opacity: 1; pointer-events: auto; }',\n        ].join('\\n');\n        document.head.appendChild(style);\n    }\n    try { injectStyles(); } catch (e) { console.error('[cwfm:injectStyles]', e); }\n\n    // 讓工具列/面板不要蓋住書本內容：#viewer 底部留一點空間\n    try { viewerContainer.style.paddingBottom = '44px'; } catch (e) { console.error('[cwfm:layout]', e); }\n\n    // 共用的遮罩，點擊可以關掉任何一個開著的面板\n    let dimming;\n    function ensureDimming() {\n        if (dimming) return dimming;\n        dimming = document.createElement('div');\n        dimming.className = 'cwfm-dimming';\n        document.body.appendChild(dimming);\n        return dimming;\n    }\n    function closeAllPanels() {\n        document.querySelectorAll('.cwfm-panel.cwfm-open').forEach(p => p.classList.remove('cwfm-open'));\n        if (dimming) dimming.classList.remove('cwfm-show');\n    }\n    function openPanel(panel) {\n        closeAllPanels();\n        panel.classList.add('cwfm-open');\n        ensureDimming().classList.add('cwfm-show');\n    }\n\n    // ============================================================\n    // 設定選單：字體、字級、字距、行距、對齊、斷字、翻頁模式、邊界、欄數\n    // ============================================================\n    const DEFAULT_SETTINGS = {\n        fontFamily: '',\n        fontSize: 100,     // 百分比\n        letterSpacing: 0,  // em\n        lineSpacing: 1.4,\n        justify: true,\n        hyphenate: true,\n        flow: 'paginated',\n        margin: 48,        // px\n        maxColumnCount: 2,\n    };\n\n    function loadSettings() {\n        try {\n            const raw = localStorage.getItem(STORAGE_KEY);\n            if (!raw) return { ...DEFAULT_SETTINGS };\n            return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };\n        } catch (e) {\n            console.error('[cwfm:settings] 讀取設定失敗，改用預設值', e);\n            return { ...DEFAULT_SETTINGS };\n        }\n    }\n\n    function saveSettings(settings) {\n        try {\n            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));\n        } catch (e) {\n            console.error('[cwfm:settings] 儲存設定失敗', e);\n        }\n    }\n\n    function getTypographyCSS(settings) {\n        const fontFamilyRule = settings.fontFamily\n            ? '  * { font-family: ' + JSON.stringify(settings.fontFamily) + ' !important; }'\n            : '';\n        return [\n            '@namespace epub \"http://www.idpf.org/2007/ops\";',\n            'html { color-scheme: light dark; }',\n            fontFamilyRule,\n            'p, li, blockquote, dd, div {',\n            '  font-size: ' + settings.fontSize + '% !important;',\n            '  letter-spacing: ' + settings.letterSpacing + 'em !important;',\n            '  line-height: ' + settings.lineSpacing + ' !important;',\n            '  text-align: ' + (settings.justify ? 'justify' : 'start') + ' !important;',\n            '  -webkit-hyphens: ' + (settings.hyphenate ? 'auto' : 'manual') + ';',\n            '  hyphens: ' + (settings.hyphenate ? 'auto' : 'manual') + ';',\n            '}',\n            'pre { white-space: pre-wrap !important; }',\n        ].join('\\n');\n    }\n\n    function applySettings(settings) {\n        try {\n            view.renderer.setStyles?.(getTypographyCSS(settings));\n        } catch (e) { console.error('[cwfm:settings] 套用字體樣式失敗', e); }\n        try {\n            view.renderer.setAttribute('flow', settings.flow);\n            view.renderer.setAttribute('margin', settings.margin);\n            view.renderer.setAttribute('max-column-count', settings.maxColumnCount);\n        } catch (e) { console.error('[cwfm:settings] 套用版面屬性失敗', e); }\n        window.__cwfm.settings = settings;\n    }\n\n    function buildSettingsPanel() {\n        const settings = loadSettings();\n\n        const panel = document.createElement('div');\n        panel.className = 'cwfm-panel';\n        panel.dataset.side = 'right';\n        panel.dataset.cwfmOwned = 'true';\n\n        const closeBtn = document.createElement('button');\n        closeBtn.className = 'cwfm-close-btn';\n        closeBtn.textContent = '\\u2715';\n        closeBtn.addEventListener('click', closeAllPanels);\n        panel.appendChild(closeBtn);\n\n        const title = document.createElement('h3');\n        title.textContent = '\\u95B1\\u8B80\\u8A2D\\u5B9A'; // 閱讀設定\n        panel.appendChild(title);\n\n        function addTextField(labelText, key, placeholder) {\n            const label = document.createElement('label');\n            label.textContent = labelText;\n            panel.appendChild(label);\n            const input = document.createElement('input');\n            input.type = 'text';\n            input.value = settings[key] || '';\n            if (placeholder) input.placeholder = placeholder;\n            input.addEventListener('input', () => {\n                settings[key] = input.value;\n                saveSettings(settings);\n                applySettings(settings);\n            });\n            panel.appendChild(input);\n            return input;\n        }\n\n        function addRangeField(labelText, key, min, max, step, unitSuffix) {\n            const row = document.createElement('div');\n            row.className = 'cwfm-row';\n            const label = document.createElement('label');\n            label.textContent = labelText;\n            const valueSpan = document.createElement('span');\n            valueSpan.textContent = settings[key] + (unitSuffix || '');\n            row.appendChild(label);\n            row.appendChild(valueSpan);\n            panel.appendChild(row);\n\n            const input = document.createElement('input');\n            input.type = 'range';\n            input.min = String(min);\n            input.max = String(max);\n            input.step = String(step);\n            input.value = String(settings[key]);\n            input.addEventListener('input', () => {\n                const val = parseFloat(input.value);\n                settings[key] = val;\n                valueSpan.textContent = val + (unitSuffix || '');\n                saveSettings(settings);\n                applySettings(settings);\n            });\n            panel.appendChild(input);\n            return input;\n        }\n\n        function addCheckboxField(labelText, key) {\n            const row = document.createElement('div');\n            row.className = 'cwfm-row';\n            const label = document.createElement('label');\n            label.textContent = labelText;\n            row.appendChild(label);\n            const input = document.createElement('input');\n            input.type = 'checkbox';\n            input.checked = !!settings[key];\n            input.addEventListener('change', () => {\n                settings[key] = input.checked;\n                saveSettings(settings);\n                applySettings(settings);\n            });\n            row.appendChild(input);\n            panel.appendChild(row);\n            return input;\n        }\n\n        function addSelectField(labelText, key, options) {\n            const label = document.createElement('label');\n            label.textContent = labelText;\n            panel.appendChild(label);\n            const select = document.createElement('select');\n            options.forEach(([value, text]) => {\n                const opt = document.createElement('option');\n                opt.value = value;\n                opt.textContent = text;\n                if (settings[key] === value) opt.selected = true;\n                select.appendChild(opt);\n            });\n            select.addEventListener('change', () => {\n                settings[key] = select.value;\n                saveSettings(settings);\n                applySettings(settings);\n            });\n            panel.appendChild(select);\n            return select;\n        }\n\n        addTextField('\\u5B57\\u9AD4\\uFF08\\u8F38\\u5165\\u672C\\u6A5F\\u5DF2\\u5B89\\u88DD\\u7684\\u5B57\\u9AD4\\u540D\\u7A31\\uFF09', 'fontFamily', '\\u4F8B\\u5982\\uFF1ATC_JBMM_1111');\n        addRangeField('\\u5B57\\u7D1A', 'fontSize', 70, 200, 5, '%');\n        addRangeField('\\u5B57\\u8DDD', 'letterSpacing', -0.05, 0.3, 0.01, 'em');\n        addRangeField('\\u884C\\u8DDD', 'lineSpacing', 1, 2.5, 0.1, '');\n        addCheckboxField('\\u5169\\u7AEF\\u5C0D\\u9F4A', 'justify');\n        addCheckboxField('\\u81EA\\u52D5\\u65B7\\u5B57', 'hyphenate');\n        addSelectField('\\u7FFB\\u9801\\u6A21\\u5F0F', 'flow', [\n            ['paginated', '\\u5206\\u9801'],\n            ['scrolled', '\\u6372\\u52D5'],\n        ]);\n        addRangeField('\\u908A\\u754C\\u5BEC\\u5EA6', 'margin', 0, 120, 4, 'px');\n        addRangeField('\\u6700\\u5927\\u6B04\\u6578', 'maxColumnCount', 1, 4, 1, '');\n\n        document.body.appendChild(panel);\n        applySettings(settings);\n        return panel;\n    }\n\n    // ============================================================\n    // 目錄側邊欄\n    // ============================================================\n    function buildTOCPanel() {\n        const panel = document.createElement('div');\n        panel.className = 'cwfm-panel';\n        panel.dataset.side = 'left';\n        panel.dataset.cwfmOwned = 'true';\n\n        const closeBtn = document.createElement('button');\n        closeBtn.className = 'cwfm-close-btn';\n        closeBtn.textContent = '\\u2715';\n        closeBtn.addEventListener('click', closeAllPanels);\n        panel.appendChild(closeBtn);\n\n        const title = document.createElement('h3');\n        title.textContent = '\\u76EE\\u9304'; // 目錄\n        panel.appendChild(title);\n\n        const toc = book?.toc;\n        if (!toc || !toc.length) {\n            const hint = document.createElement('div');\n            hint.className = 'cwfm-empty-hint';\n            hint.textContent = '\\u9019\\u672C\\u66F8\\u6C92\\u6709\\u76EE\\u9304\\u8CC7\\u6599';\n            panel.appendChild(hint);\n        } else {\n            const onclick = (href) => {\n                // [cwfm] 查證 view.js 原始碼後確認：view.goTo(target) 內部\n                // 自己會呼叫 resolveNavigation()/book.resolveHref() 處理傳進去\n                // 的原始 href 字串。這裡原本多此一舉先呼叫了一次\n                // book.resolveHref(href)，把「已經解析過的物件」又傳給\n                // goTo()，導致它把物件當成原始字串去呼叫不存在的 .split()\n                // 而整個跳轉失敗（實測 Console 錯誤：t.split is not a\n                // function）。改成直接把原始 href 字串交給 goTo()。\n                try {\n                    view.goTo(href);\n                } catch (e) {\n                    console.error('[cwfm:toc] 跳轉失敗', e);\n                }\n                closeAllPanels();\n            };\n            const { element, setCurrentHref } = window.__cwfmCreateTOCView(toc, onclick);\n            element.classList.add('cwfm-toc-view');\n            panel.appendChild(element);\n\n            view.addEventListener('relocate', (e) => {\n                try { setCurrentHref(e.detail?.tocItem?.href); } catch (err) { /* 忽略，目錄高亮不是關鍵功能 */ }\n            });\n        }\n\n        document.body.appendChild(panel);\n        return panel;\n    }\n\n    // ============================================================\n    // 底部工具列：上一頁 / 下一頁 / 進度條 / 目錄按鈕 / 設定按鈕\n    // ============================================================\n    function buildToolbar(tocPanel, settingsPanel) {\n        const bar = document.createElement('div');\n        bar.className = 'cwfm-toolbar';\n        bar.dataset.cwfmOwned = 'true';\n\n        const tocBtn = document.createElement('button');\n        tocBtn.textContent = '\\u76EE\\u9304'; // 目錄\n        tocBtn.addEventListener('click', () => openPanel(tocPanel));\n        bar.appendChild(tocBtn);\n\n        const prevBtn = document.createElement('button');\n        prevBtn.textContent = '\\u2039';\n        prevBtn.setAttribute('aria-label', 'Previous page');\n        prevBtn.addEventListener('click', () => {\n            try { view.goLeft(); } catch (e) { console.error('[cwfm:toolbar] goLeft 失敗', e); }\n        });\n        bar.appendChild(prevBtn);\n\n        const progressWrap = document.createElement('div');\n        progressWrap.className = 'cwfm-progress-wrap';\n        const slider = document.createElement('input');\n        slider.type = 'range';\n        slider.min = '0';\n        slider.max = '1';\n        slider.step = 'any';\n        slider.value = '0';\n        const progressLabel = document.createElement('span');\n        progressLabel.className = 'cwfm-progress-label';\n        progressLabel.textContent = '0%';\n        let sliderDragging = false;\n        slider.addEventListener('input', () => {\n            sliderDragging = true;\n            progressLabel.textContent = Math.round(parseFloat(slider.value) * 100) + '%';\n        });\n        slider.addEventListener('change', () => {\n            try { view.goToFraction(parseFloat(slider.value)); }\n            catch (e) { console.error('[cwfm:toolbar] goToFraction 失敗', e); }\n            sliderDragging = false;\n        });\n        progressWrap.appendChild(slider);\n        progressWrap.appendChild(progressLabel);\n        bar.appendChild(progressWrap);\n\n        const nextBtn = document.createElement('button');\n        nextBtn.textContent = '\\u203A';\n        nextBtn.setAttribute('aria-label', 'Next page');\n        nextBtn.addEventListener('click', () => {\n            try { view.goRight(); } catch (e) { console.error('[cwfm:toolbar] goRight 失敗', e); }\n        });\n        bar.appendChild(nextBtn);\n\n        const settingsBtn = document.createElement('button');\n        settingsBtn.textContent = '\\u8A2D\\u5B9A'; // 設定\n        settingsBtn.addEventListener('click', () => openPanel(settingsPanel));\n        bar.appendChild(settingsBtn);\n\n        document.body.appendChild(bar);\n\n        // 依 relocate 事件同步進度條與百分比顯示（使用者正在拖曳時不要被蓋過去）\n        view.addEventListener('relocate', (e) => {\n            if (sliderDragging) return;\n            const fraction = e.detail?.fraction;\n            if (typeof fraction === 'number') {\n                slider.value = String(fraction);\n                progressLabel.textContent = Math.round(fraction * 100) + '%';\n            }\n        });\n\n        return bar;\n    }\n\n    let tocPanel, settingsPanel, toolbar;\n    try { tocPanel = buildTOCPanel(); } catch (e) { console.error('[cwfm:toc] 建立目錄面板失敗', e); }\n    try { settingsPanel = buildSettingsPanel(); } catch (e) { console.error('[cwfm:settings] 建立設定面板失敗', e); }\n    try { toolbar = buildToolbar(tocPanel, settingsPanel); } catch (e) { console.error('[cwfm:toolbar] 建立工具列失敗', e); }\n\n    console.log('[cwfm] Calibre-Web Foliate Reader Mod 已接管閱讀器，書籍 ID：', BOOK_ID);\n})();\n"

    // 產生要一起塞進頁面的完整程式碼：foliate-js 本體 + 我們自己的應用邏輯，
    // 合併成同一段、用同一次 GM_addElement 呼叫插入 —— 這樣不管 GM_addElement
    // 插入的程式碼實際上跑在哪種環境，至少「本體」跟「使用本體的程式碼」
    // 一定在同一個執行環境裡，排除跨腳本邊界不一致這個變數。
    function buildCombinedScriptSource(bundleCode, bookId) {
        const appCode = APP_SCRIPT_TEMPLATE
            .replace(/__VIEWER_SELECTOR__/g, VIEWER_SELECTOR)
            .replace(/__BOOK_ID__/g, bookId);
        return bundleCode + '\n' + appCode;
    }

    async function main() {
        const bookId = getBookId();
        if (!bookId) {
            console.warn('[cwfm] 無法從網址解析書籍 ID，腳本不啟動');
            return;
        }

        const viewerContainer = await waitForElement(VIEWER_SELECTOR);
        const stopClearing = keepContainerClearUntilReady(viewerContainer);

        try {
            const bundleCode = await fetchBundleText();

            // 合併成單一段程式碼、單一次 GM_addElement 呼叫插入，
            // 排除「兩段各自環境不一致」這個變數（見檔案開頭沿革說明）。
            GM_addElement('script', {
                type: 'module',
                textContent: buildCombinedScriptSource(bundleCode, bookId),
            });
        } catch (e) {
            console.error('[cwfm] 初始化失敗：', e);
            viewerContainer.innerHTML = '';
            viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）初始化失敗，詳見主控台錯誤訊息。';
            stopClearing();
        }
        // 注意：成功的情況下「不」呼叫 stopClearing()，讓監看永久持續。
        // 原本以為注入動作送出後就能安全停止監看，但實測發現這段時間差
        // 剛好讓沒被真正攔下來的 epub.js 晚一步完成初始化、把畫面蓋回去
        // （症狀是內容先正常顯示，過一下子又消失）。永久監看只會持續清掉
        // 「不是我們自己標記過的節點」，不會動到 foliate-view 元素內部自己
        // 的渲染內容（那些是包在 foliate-view 元素裡面，不是 #viewer 的
        // 直接子節點），所以留著跑不會有副作用。
    }

    main();
})();
