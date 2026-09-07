// ==UserScript==
// @name         Calibre-Web Foliate Reader (mod)
// @namespace    https://github.com/bgtsai/calibre-web-foliate-mod
// @version      0.3.0
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

    // 產生要塞進「頁面本身環境」執行的應用邏輯（開書、翻頁）。
    // 刻意寫成字串、透過 GM_addElement 當一般（非沙盒）inline script 插入，
    // 不要在這支沙盒化的主腳本裡直接操作 foliate-view，理由見檔案開頭的沿革說明。
    function buildAppScriptSource(bookId) {
        return `
(async () => {
    const viewerContainer = document.querySelector(${JSON.stringify(VIEWER_SELECTOR)});
    if (!viewerContainer) {
        console.error('[cwfm] 找不到 #viewer 容器');
        return;
    }

    // 兩段注入的執行先後順序不保證（type="module" 是延遲執行的），
    // 保險起見等自訂元素真的註冊完成再動手。
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

            // 第一段注入：foliate-js 本體，負責註冊 <foliate-view> 等自訂元素
            GM_addElement('script', {
                type: 'module',
                textContent: bundleCode,
            });

            // 第二段注入：我們自己的應用邏輯，在頁面本身環境執行（不經過沙盒）
            GM_addElement('script', {
                textContent: buildAppScriptSource(bookId),
            });
        } catch (e) {
            console.error('[cwfm] 初始化失敗：', e);
            viewerContainer.innerHTML = '';
            viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）初始化失敗，詳見主控台錯誤訊息。';
        } finally {
            stopClearing();
        }
    }

    main();
})();
