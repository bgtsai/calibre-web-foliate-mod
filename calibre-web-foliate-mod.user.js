// ==UserScript==
// @name         Calibre-Web Foliate Reader (mod)
// @namespace    https://github.com/bgtsai/calibre-web-foliate-mod
// @version      0.6.0
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
    function fetchBundleText() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: BUNDLE_URL,
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

    // 產生要一起塞進頁面的完整程式碼：foliate-js 本體 + 我們自己的應用邏輯，
    // 合併成同一段、用同一次 GM_addElement 呼叫插入 —— 這樣不管 GM_addElement
    // 插入的程式碼實際上跑在哪種環境，至少「本體」跟「使用本體的程式碼」
    // 一定在同一個執行環境裡，排除跨腳本邊界不一致這個變數。
    function buildCombinedScriptSource(bundleCode, bookId) {
        return bundleCode + `
;(async () => {
    const viewerContainer = document.querySelector(${JSON.stringify(VIEWER_SELECTOR)});
    if (!viewerContainer) {
        console.error('[cwfm] 找不到 #viewer 容器');
        return;
    }

    await customElements.whenDefined('foliate-view');

    const view = document.createElement('foliate-view');
    view.dataset.cwfmOwned = 'true';
    view.style.display = 'block';
    view.style.width = '100%';
    view.style.height = '100%';

    viewerContainer.innerHTML = '';
    viewerContainer.appendChild(view);

    try {
        const res = await fetch(${JSON.stringify(`/show/${bookId}/epub/file.epub`)}, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('下載 epub 失敗：HTTP ' + res.status);
        const blob = await res.blob();
        const file = new File([blob], ${JSON.stringify(`${bookId}.epub`)}, { type: 'application/epub+zip' });

        await view.open(file);

        // 查證 foliate-js 官方範例（reader.js）後確認：view.open() 只負責
        // 解析書籍、把 renderer 骨架建好，並「不會」自動觸發顯示第一頁 ——
        // 這一步要另外呼叫 view.renderer.next() 才會真的把內容渲染進去
        // （對照官方範例：await this.view.open(file); this.view.renderer.next();）。
        view.renderer.next();
    } catch (e) {
        console.error('[cwfm] 開啟書籍失敗：', e);
        viewerContainer.innerHTML = '';
        viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）書籍載入失敗，詳見主控台錯誤訊息。';
        return;
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') view.goLeft();
        else if (e.key === 'ArrowRight') view.goRight();
    });

    console.log('[cwfm] Calibre-Web Foliate Reader Mod 已接管閱讀器，書籍 ID：', ${JSON.stringify(bookId)});
})();
`;
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
