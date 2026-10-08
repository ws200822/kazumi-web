# Kazumi Web

[Kazumi](https://github.com/Predidit/Kazumi) 的**纯静态网页版**。规则的浏览器端实现，零构建、零依赖包管理器，丢到 GitHub Pages 就能跑。

## 为什么需要自建代理

站点页面和 JSON API 不返回 `Access-Control-Allow-Origin`，浏览器直连会被 CORS 拦死；视频流还需要伪装 `Referer` 绕过防盗链，并透传 `Range` 才能拖动进度条。这三件事只能由服务端代理完成。

**没有代理 = 能搜索、能看分集列表，但没法播放。**

部署 Cloudflare Worker（免费，每天 10 万次请求）：

> 📖 **完整图文步骤见 [DEPLOY.md](DEPLOY.md)**，含验证方法、workers.dev 被阻断的应对、以及 Deno / Vercel / 自建服务器三种备选方案。

1. 打开 https://dash.cloudflare.com ，注册免费账号
2. `Workers & Pages` → `Create` → `Worker`
3. 把本仓库 `proxy/worker.js` 的全部内容粘进去 → `Deploy`
4. 复制分配到的 `https://xxx.workers.dev` 地址
5. 打开本应用 → `设置` → 填入「代理地址」→ 保存

Worker 负责四件事：

- 补 CORS 头
- 伪装 `Referer` / `User-Agent`
- 透传 `Range` / `206`（进度条拖动）
- **重写 m3u8 里的分片地址**，把每个 `.ts` 也拉回代理（否则分片跨域必失败）

## 部署到 GitHub Pages

```bash
git clone https://github.com/<你的用户名>/kazumi-web.git
cd kazumi-web
git add -A && git commit -m "init"
git push
```

仓库 `Settings` → `Pages` → Source 选 `Deploy from a branch` → 分支 `main` / 目录 `/ (root)` → Save。
等一两分钟，访问 `https://<你的用户名>.github.io/kazumi-web/`。

不需要构建步骤，不需要 Node，不需要 Actions。

## 功能

| 功能 | 状态 |
|---|---|
| 多源并发搜索 | ✅ 默认并发 4，可在设置里调 |
| 番剧详情 / 分集列表 | ✅ 含多线路切换 |
| 在线播放 | ✅ HLS（hls.js / iOS 原生）+ MP4 |
| 弹幕 | ✅ dandanplay，需自填 AppId/Secret |
| 追番列表 | ✅ |
| 观看历史 | ✅ 含续播进度 |
| 规则管理 | ✅ 编辑 / 导入 / 导出 / 从 GitHub 同步 |
| 数据备份 | ✅ 全量导出导入 JSON |

## 播放地址怎么来的

这是整个项目最关键的发现。以 MacCMS（苹果CMS）系站点为例，分集页的 HTML 里**没有** `m3u8`、没有 `mp4`、也没有 iframe `src`——播放地址以 base64 藏在页面里的一个 JSON 变量中：

```js
var player_aaaa = {"flag":"play","encrypt":2,"from":"ndx","url":"JTY4JTc0JTc0JTcw..."}
```

解码链是两步：

```
"JTY4JTc0JTc0JTcw..."  →  base64  →  "%68%74%74%70%73%3A%2F%2F..."
                       →  decodeURIComponent  →  "https://mao6.jxdunrui.top/..."
```

`encrypt` 的取值：

| 值 | 含义 |
|---|---|
| 0 | 明文 |
| 1 | base64 |
| 2 | base64 → URL 解码 |

`js/source.js` 里的 `decodeAddress()` 会把三种情况全试一遍，哪个能解出 `http(s)://` 就用哪个。因此**纯 HTTP 就能拿到播放地址，不需要 WebView**。

Kazumi 之所以走 WebView，是为了兼容那些用 JS 动态解析 / 加密的少数站点（它注入脚本劫持 `fetch`、`XMLHttpRequest`、`Response.prototype.text` 来做嗅探）。本项目不做这层兼容，代价是少数源不可用，收益是整个应用变成纯静态网页。

## 规则兼容性

规则来自 [Predidit/KazumiRules](https://github.com/Predidit/KazumiRules)（MIT），内置 86 条快照（`rules/bundle.json`），其中 **16 条存活**，其余标记为已弃用。

XPath 语义与 Kazumi 的 `xpath_selector` 包对齐：规则里的 `//div[2]` 在节点上下文里是**相对查找**，而浏览器的 `document.evaluate` 把它当绝对路径。`js/xpath.js` 通过给表达式加 `.` 前缀解决：

```
//div[2]/text()   →   .//div[2]/text()
```

在 `document` 上 `.//div[2]` 与 `//div[2]` 结果一致（document 自身不是元素），所以这条改写对根节点查询同样安全。

规则里用到的 XPath 特性全部落在 1.0 范围内（只有 `text()`、`position()` 和 `::` 轴），浏览器原生支持，无需引入 XPath 库。

## 目录结构

```
index.html            单页外壳
css/app.css           样式
js/store.js           本地持久化（追番/历史/设置）
js/xpath.js           XPath 引擎（相对语义改写）
js/net.js             网络层（代理调度）
js/rules.js           规则模型 + 导入导出 + 远程同步
js/source.js          采集引擎（搜索/章节/播放地址解码）
js/danmaku.js         弹幕解析 + 渲染引擎
js/danmaku_api.js     dandanplay 客户端（内置纯 JS SHA-256）
js/player.js          HLS / MP4 播放器
js/app.js             UI 与路由
rules/bundle.json     内置规则快照
proxy/worker.js       Cloudflare Worker 代理
```

## 已知限制

1. **必须自建代理**，公共代理只够抓页面，撑不起视频流。
2. **依赖 JS 动态解析的源播不了**，这类源在存活规则里占少数。
3. **无封面图**。规则的 XPath 字段里没有封面选择器，Kazumi 也是靠别的接口补的。
4. **弹幕需要 dandanplay 凭据**。Kazumi 的 AppId/Secret 是 CI 注入的编译常量，源码里没有明文，所以无法复用，得自己注册。
5. **源站随时会失效**。规则仓库本身有 70/86 已弃用，这是这类项目的结构性问题。

## 许可

规则数据来自 KazumiRules（MIT）。本项目代码同样 MIT。
