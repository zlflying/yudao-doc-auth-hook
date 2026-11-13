// ==UserScript==
// @name         拦截 iocoder 鉴权回调（多路径 + iframe XHR + fetch + 签名重定向）
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  拦截多个鉴权回调路径
// @match        *://cloud.iocoder.cn/*
// @match        *://doc.iocoder.cn/*
// @match        *://svip.iocoder.cn/*
// @run-at       document-start
// @grant        none
// @license MIT
// @downloadURL  https://raw.githubusercontent.com/zlflying/yudao-doc-auth-hook/iocoder-auth-hook.user.js
// @updateURL    https://raw.githubusercontent.com/zlflying/yudao-doc-auth-hook/iocoder-auth-hook.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 👇 在这里添加所有需要拦截的路径
    const TARGET_PATHS = [
        '/zsxq/auth-callback',
        '/zsxq/auth',
    ];

    const MOCK_RESPONSE = 'true';
    const isIframe = window !== window.top;

    if (window.__hooked) return;
    window.__hooked = true;

    function matchTarget(input) {
        if (!input) return false;
        let urlStr = '';
        try {
            if (typeof input === 'string') {
                urlStr = input;
            } else if (input instanceof Request) {
                urlStr = input.url;
            } else if (input.url) {
                urlStr = input.url;
            } else {
                urlStr = String(input);
            }
            const u = new URL(urlStr, window.location.href);
            const p = u.pathname;
            return TARGET_PATHS.some(tp => p === tp || p.endsWith(tp));
        } catch (e) {
            return false;
        }
    }

    // ---- XHR 拦截 ----
    const OriginalXHR = window.XMLHttpRequest;
    if (typeof OriginalXHR === 'function') {
        const HookedXHR = function () {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;
            const originalSend = xhr.send;

            xhr.open = function (method, url, ...rest) {
                xhr._hookUrl = url;
                return originalOpen.apply(xhr, [method, url, ...rest]);
            };

            xhr.send = function (body) {
                if (matchTarget(xhr._hookUrl)) {
                    console.log('[XHR Hook]', isIframe ? 'iframe' : 'top', xhr._hookUrl);

                    setTimeout(() => {
                        Object.defineProperties(xhr, {
                            readyState:   { value: 4, writable: true, configurable: true },
                            status:       { value: 200, writable: true, configurable: true },
                            statusText:   { value: 'OK', writable: true, configurable: true },
                            responseText: { value: MOCK_RESPONSE, writable: true, configurable: true },
                            response:     { value: MOCK_RESPONSE, writable: true, configurable: true }
                        });

                        xhr.dispatchEvent(new Event('readystatechange'));
                        xhr.dispatchEvent(new Event('load'));
                        xhr.dispatchEvent(new Event('loadend'));
                    }, 50);

                    return;
                }
                return originalSend.apply(xhr, arguments);
            };

            return xhr;
        };

        HookedXHR.prototype = OriginalXHR.prototype;
        HookedXHR.UNSENT = OriginalXHR.UNSENT;
        HookedXHR.OPENED = OriginalXHR.OPENED;
        HookedXHR.HEADERS_RECEIVED = OriginalXHR.HEADERS_RECEIVED;
        HookedXHR.LOADING = OriginalXHR.LOADING;
        HookedXHR.DONE = OriginalXHR.DONE;

        window.XMLHttpRequest = HookedXHR;
    }

    // ---- fetch 拦截 ----
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
        window.fetch = function (input, init) {
            if (matchTarget(input)) {
                console.log('[Fetch Hook]', isIframe ? 'iframe' : 'top', input);
                return Promise.resolve(new Response(MOCK_RESPONSE, {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'text/plain' }
                }));
            }
            return originalFetch.apply(this, arguments);
        };
    }

    // ---- Worker 拦截 ----
    const RealWorker = window.Worker;
    if (typeof RealWorker === 'function') {
        const StubWorker = function () { return undefined; };
        StubWorker.prototype = RealWorker.prototype;

        window.Worker = function (url, options) {
            const urlString = String(url);

            if (urlString.includes('doc-access-worker-')) {
                console.log('[BlockWorker] blocked:', urlString);

                // 方式一：返回一个空壳，不真正创建 Worker
                return new StubWorker();

                // 方式二：如果希望页面不报错，可以返回一个空 Worker
                // const blob = new Blob(['self.onmessage = () => {};'], {
                //     type: 'application/javascript'
                // });
                // return new RealWorker(URL.createObjectURL(blob), options);
            }

            return new RealWorker(url, options);
        };

        window.Worker.prototype = RealWorker.prototype;
    }

    // ---- realm 补丁：堵住“隐藏 iframe 取原生 XHR”的绕过 ----
    // 必须在上面的钩子全部装好之后再捕获引用
    const myXMLHttpRequest = window.XMLHttpRequest;
    const myFetch = window.fetch;
    const myWorker = window.Worker;

    function patchRealm(w) {
        if (!w) return w;
        try {
            if (w.XMLHttpRequest !== myXMLHttpRequest) w.XMLHttpRequest = myXMLHttpRequest;
            if (w.fetch !== myFetch) w.fetch = myFetch;
            if (w.Worker !== myWorker) w.Worker = myWorker;
        } catch (e) { /* 跨域 iframe 改不了，由注入到该 frame 的本脚本负责 */ }
        return w;
    }

    function hookGetter(proto, prop, afterGet) {
        if (!proto) return;
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (!d || !d.get) return;
        const origGet = d.get;
        Object.defineProperty(proto, prop, {
            configurable: true,
            enumerable: d.enumerable,
            get() {
                return afterGet(origGet.call(this));
            }
        });
    }

    hookGetter(HTMLIFrameElement.prototype, 'contentWindow', w => patchRealm(w));
    hookGetter(HTMLIFrameElement.prototype, 'contentDocument', doc => {
        if (doc) patchRealm(doc.defaultView);
        return doc;
    });
    hookGetter(Document.prototype, 'defaultView', w => patchRealm(w));

    // window.open 出来的新窗口：导航会重建 realm，读到时的 getter 已覆盖，这里再补两次兜底
    const myOpen = window.open;
    if (typeof myOpen === 'function') {
        window.open = function (...args) {
            const w = myOpen.apply(this, args);
            patchRealm(w);
            setTimeout(() => patchRealm(w), 0);
            setTimeout(() => patchRealm(w), 200);
            return w;
        };
    }

    // 脚本注入前就已存在的 iframe 补一遍
    try {
        document.querySelectorAll('iframe').forEach(f => {
            try { patchRealm(f.contentWindow); } catch (e) {}
        });
    } catch (e) {}

    // ---- 签名重定向逻辑 ----
    function checkSignature() {
        try {
            const url = new URL(window.location.href);
            if (!document.cookie.includes('expire_time') && !url.searchParams.has('signature')) {
                url.searchParams.append('signature', 'true');
                window.location.replace(url.href);
            }
        } catch (e) {
            console.warn('[Signature] 检查失败:', e);
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        checkSignature();
    } else {
        document.addEventListener('DOMContentLoaded', checkSignature);
    }
})();
