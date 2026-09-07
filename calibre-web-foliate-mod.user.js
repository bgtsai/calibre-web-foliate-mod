// ==UserScript==
// @name         Calibre-Web Foliate Reader (mod)
// @namespace    https://github.com/bgtsai/calibre-web-foliate-mod
// @version      0.1.0
// @description  Replace Calibre-Web's built-in epub.js reader with a foliate-js based reader for better pagination and layout control.
// @author       bgtsai
// @match        *://*/read/*/epub*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // foliate-js 是純 ES Module 寫的，沒有打包版本，不能用 @require 引入，
    // 改用注入 <script type="module"> 讓瀏覽器自己 import。
    // jsDelivr 對 GitHub repo 提供正確的 Content-Type 與 CORS header，可以直接當模組來源用。
    const FOLIATE_JS_URL = 'https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@main/view.js';

    const VIEWER_SELECTOR = '#viewer';
    const READY_EVENT = 'cwfm:foliate-ready';

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

    // 把 foliate-js 的 view.js 當成頁面模組載入，讓它自己註冊 <foliate-view> 這個自訂元素。
    // 這段是用注入的 <script type="module">，執行在「頁面本身」的環境，
    // 跟目前這支 @grant none 的 userscript 是同一個環境，所以不會有沙盒隔離的問題（見 05_連結處理層級指南）。
    function loadFoliateModule() {
        return new Promise((resolve, reject) => {
            if (customElements.get('foliate-view')) { resolve(); return; }

            document.addEventListener(READY_EVENT, () => resolve(), { once: true });

            const script = document.createElement('script');
            script.type = 'module';
            script.textContent = `
                import { View } from '${FOLIATE_JS_URL}';
                if (!customElements.get('foliate-view')) {
                    customElements.define('foliate-view', View);
                }
                document.dispatchEvent(new CustomEvent('${READY_EVENT}'));
            `;
            script.onerror = () => reject(new Error('foliate-js 模組載入失敗（網址、CORS 或網路問題）'));

            // document-start 階段 head 不一定存在，這裡保守一點掛在 documentElement 上。
            (document.head || document.documentElement).appendChild(script);
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
