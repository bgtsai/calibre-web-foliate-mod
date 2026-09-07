// ==UserScript==
// @name         Calibre-Web Foliate Reader (mod)
// @namespace    https://github.com/bgtsai/calibre-web-foliate-mod
// @version      0.2.0
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

    // v0.1.0 原本用注入 <script type="module"> 去 import cdn.jsdelivr.net 的 view.js，
    // 但被 Calibre-Web 頁面自己的 CSP（default-src 'self'）擋下，任何我們插入的 <script>
    // 標籤（不論 inline 或外部來源）都受頁面 CSP 管轄，這點跟一般網站的 CSP 繼承限制是同一類問題
    // （見知識庫 10_CSP與跨分頁內容渲染）。
    //
    // 改法：先把 foliate-js 的 view.js 連同它動態載入的相依模組，自己用 rollup 打包成
    // 一份不含外部 import 的單一檔案（build 腳本在 calibre-web-foliate-mod repo 之外，
    // 產物 vendor 進這個 repo 的 vendor/ 底下），再用兩支 Tampermonkey 特權 API 組合注入：
    //   1. GM_xmlhttpRequest 抓取檔案內容 —— 完全不受頁面 CSP／CORS 管轄（特權網路請求）
    //   2. GM_addElement 把抓到的內容當成 inline 內容建立 <script> 元素 —— 這支 API
    //      官方文件明確説明存在目的就是在網站有嚴格 CSP 時，繞過去加入 script/link/style 元素
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

    // 用 GM_xmlhttpRequest 抓取自己打包好的單一檔案（不受頁面 CSP／CORS 管轄），
    // 再用 GM_addElement 以 inline 內容的方式插入 <script type="module">
    // （GM_addElement 官方文件明確說明，就是設計來在頁面 CSP 擋掉一般 script 標籤時繞過去用的）。
    // 產物本身在被 import 的當下，內部就會自己呼叫 customElements.define('foliate-view', ...)，
    // 所以這裡只需要負責「把程式碼弄進頁面、等自訂元素註冊完成」，不用自己再呼叫一次 define。
    function loadFoliateModule() {
        return new Promise((resolve, reject) => {
            if (customElements.get('foliate-view')) { resolve(); return; }

            GM_xmlhttpRequest({
                method: 'GET',
                url: BUNDLE_URL,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`foliate-js bundle 下載失敗：HTTP ${res.status}`));
                        return;
                    }
                    try {
                        GM_addElement('script', {
                            type: 'module',
                            textContent: res.responseText,
                        });
                    } catch (e) {
                        reject(new Error('GM_addElement 注入失敗：' + e.message));
                        return;
                    }
                    customElements.whenDefined('foliate-view').then(resolve, reject);
                },
                onerror: () => reject(new Error('foliate-js bundle 下載失敗（網路錯誤）')),
            });
        });
    }

    // 抓書籍檔案本體。同網域、同 session，credentials 明確寫 same-origin
    // 確保就算未來瀏覽器預設值改變，也一定會帶上登入用的 cookie。
    async function fetchBookFile(bookId) {
        const url = `/show/${bookId}/epub/file.epub`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`下載 epub 失敗：HTTP ${res.status}`);
        return res.blob();
    }

    // 持續清空 #viewer 容器，直到呼叫 stop() 為止。
    // 用來防止 epub.js 自己的初始化時機比我們晚，把它塞進來的 iframe 又擠掉我們的 foliate-view。
    // 這是「跨分頁狀態與執行時機」裡提過的競爭狀況的防護，不是靠猜時機先後賭運氣。
    function keepContainerClearUntilReady(container) {
        const observer = new MutationObserver(() => {
            // 只清掉不是我們自己加的節點（沒有這個標記的）
            [...container.children].forEach((child) => {
                if (!child.dataset || child.dataset.cwfmOwned !== 'true') {
                    child.remove();
                }
            });
        });
        observer.observe(container, { childList: true });
        return () => observer.disconnect();
    }

    async function main() {
        const bookId = getBookId();
        if (!bookId) {
            console.warn('[cwfm] 無法從網址解析書籍 ID，腳本不啟動');
            return;
        }

        const viewerContainer = await waitForElement(VIEWER_SELECTOR);
        const stopClearing = keepContainerClearUntilReady(viewerContainer);

        let view;
        try {
            await loadFoliateModule();

            view = document.createElement('foliate-view');
            view.dataset.cwfmOwned = 'true';
            view.style.display = 'block';
            view.style.width = '100%';
            view.style.height = '100%';

            // 先清空一次容器（可能已經被 epub.js 塞了東西），再放進我們的元素
            viewerContainer.innerHTML = '';
            viewerContainer.appendChild(view);

            const blob = await fetchBookFile(bookId);
            const file = new File([blob], `${bookId}.epub`, { type: 'application/epub+zip' });
            await view.open(file);
        } catch (e) {
            console.error('[cwfm] 初始化失敗：', e);
            viewerContainer.innerHTML = '';
            viewerContainer.textContent = '（Calibre-Web Foliate Reader Mod）書籍載入失敗，詳見主控台錯誤訊息。';
            stopClearing();
            return;
        } finally {
            // 不管成功失敗，我們已經完成一次接管動作，之後不需要再持續清空監看
            stopClearing();
        }

        // 最基本的鍵盤翻頁，之後可以再加畫面上的按鈕
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') view.goLeft();
            else if (e.key === 'ArrowRight') view.goRight();
        });

        console.log('[cwfm] Calibre-Web Foliate Reader Mod 已接管閱讀器，書籍 ID：', bookId);
    }

    main();
})();
