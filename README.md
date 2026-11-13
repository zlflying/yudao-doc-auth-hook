鉴权回调拦截脚本

油猴脚本说明文档，对应文件：[iocoder-auth-hook.user.js](./iocoder-auth-hook.user.js)

## 用途

在浏览器端拦截 iocoder 文档站的鉴权回调请求，使页面跳过付费/订阅校验直接按“已授权”渲染，并在缺少登录态时自动追加 `signature` 参数重载页面。

- 拦截 `XMLHttpRequest` 与 `fetch` 发往指定路径的请求，直接返回伪造响应 `true`（HTTP 200）。
- 阻止 `doc-access-worker-*` 类型的 Web Worker 创建。
- 页面 URL 无 `signature` 且 Cookie 无 `expire_time` 时，`location.replace` 追加 `signature=true`。

## 安装

1. 浏览器安装 Tampermonkey（或 Violentmonkey）。
2. Tampermonkey 面板 → 导入文件 / 新建脚本后整体粘贴 `iocoder-auth-hook.user.js` 内容并保存。
3. 刷新目标页面；控制台出现 `[XHR Hook] ...` 或 `[Fetch Hook] ...` 即生效。

## 头部字段说明

| 字段 | 值 | 作用 |
| --- | --- | --- |
| `@match` | `cloud.iocoder.cn` / `doc.iocoder.cn` / `svip.iocoder.cn` / `vip.iocoder.cn` | `vip` 与 `svip` 是不同 host，请求实际发往哪个就要匹配哪个，缺一不命中 |
| `@run-at` | `document-start` | 必须在页面脚本之前挂钩子 |
| `@grant` | `none` | 关键。脚本运行在页面上下文，钩子才能被页面看到；换成沙箱模式（如 `@grant unsafeWindow`）后页面拿到的是未被替换的 window |

不要添加 `@noframes`——脚本需要在每个匹配到的 frame 内各跑一遍。

## 配置项

```javascript
const TARGET_PATHS = ['/zsxq/auth-callback', '/zsxq/auth'];  // 需要拦截的路径（按 pathname 结尾匹配）
const MOCK_RESPONSE = 'true';                                // 伪造的响应体
```

`matchTarget()` 只比较 `URL.pathname`，与 host、query 无关；命中条件为 `pathname === tp || pathname.endsWith(tp)`。

## 工作流程

1. **重复注入守卫**：`window.__hooked` 标记，每个 frame 各一份。
2. **XHR 钩子**：替换 `window.XMLHttpRequest` 为工厂函数，实例的 `send()` 命中目标路径时不发真实请求，异步改写 `readyState/status/responseText/...` 并派发 `readystatechange`/`load`/`loadend`。
3. **fetch 钩子**：命中时返回 `Promise.resolve(new Response(...))`。
4. **Worker 钩子**：URL 含 `doc-access-worker-` 时返回空壳实例，不创建真实 Worker。
5. **realm 补丁**：见下节。
6. **签名重定向**：`DOMContentLoaded` 或已就绪时立即执行。

## realm 补丁（重点）

站点侧的反检测代码会创建一个不写 `src` 的隐藏 iframe（文档为 `about:blank`，与父页同源但属于**独立全局对象**），再从 `r.contentWindow.XMLHttpRequest` 取“干净的”原生构造函数来发请求。油猴默认不注入 `about:blank`，因此这类请求会绕过前面所有钩子。

脚本的应对方式是在**读取时机**给新 realm 补钩子，而不是尝试拦截请求本身：

- 包装 `HTMLIFrameElement.prototype.contentWindow` / `contentDocument` 的 getter，以及 `Document.prototype.defaultView` 的 getter，读到 window 时把已钩住的 `XMLHttpRequest`、`fetch`、`Worker` 写入该 realm。
- `window.open()` 返回的窗口同样补一次，并在 `0ms`/`200ms` 重试，覆盖导航后 realm 重建的情况。
- 初始化时遍历已存在的 `<iframe>` 补一遍。
- getter 方式天然覆盖 `srcdoc`/`src` 异步导航产生的新 realm；跨域 iframe 写入会抛 `SecurityError`，由 `try/catch` 吞掉，交给注入到该 frame 的同一份脚本处理。

> 提示：`OriginalXHR.prototype.open` 打日志只能看到当前 realm 的调用。iframe realm 有自己的 `XMLHttpRequest.prototype`，所以先补 realm，原型层面的观测/钩子才有意义。

## 已知限制

- `about:blank` iframe 不会单独计入 Tampermonkey 的注入数，图标显示正常不代表子 frame 已注入，判断依据看控制台日志。
- 被拦截的 Worker 分支返回的是没有真实后台线程的空壳实例；若页面依赖它的 `onmessage` 回信将永远不触发，需要响应时改用脚本内注释的 Blob 空 Worker 方案。
- Worker、`WebSocket`、`navigator.sendBeacon` 未针对 iframe realm 之外的入口做二次校验。
- 页面若改用其它绕过手段（如 `Object.getOwnPropertyDescriptor` 还原原生描述符、`<iframe src="javascript:...">`、Service Worker 转发），需要相应扩展补丁。

## 排障清单

| 现象 | 排查 |
| --- | --- |
| 完全没有 `[XHR Hook]` 日志 | Network 面板看请求真实 host，确认 `@match` 覆盖到该 host；确认 `@grant` 是 `none` |
| 有日志但页面仍提示未授权 | `MOCK_RESPONSE` 与接口约定的返回体不一致（如需要 JSON） |
| 日志缺失但 Network 中能看到目标请求 | 请求由未被注入的 frame 发出，或 realm 补丁未覆盖新的绕过写法 |
| 页面反复重载 | `signature=true` 后服务端仍不下发 `expire_time` Cookie，检查 Cookie 是否被浏览器拦截 |

## 免责说明

仅用于本地学习与接口拦截机制研究，请在获得授权的前提下使用。
