# 代理部署指南

## ⚡ 当前状态：已部署，可直接使用

```
站点：https://kazumi-web-5zj.pages.dev
代理：https://kazumi-web-5zj.pages.dev/proxy   （与站点同域，前端自动探测）
```

**前端不需要任何配置** —— `js/net.js` 启动时会探测同源的 `/proxy`，探测成功就自动启用。
打开站点直接搜索即可。

如果你要自己重新部署，看第 1 节（Cloudflare Pages，已跑通）；下面第 2 节起是部署到别处的备选方案。

---

## 0.5 为什么最终选了 Cloudflare Pages 而不是 Workers

| | Workers (`*.workers.dev`) | Pages (`*.pages.dev`) |
|---|---|---|
| DNS | **被污染到 Facebook IP** | 正常解析 |
| TLS SNI | **被阻断**（`http=000`） | 正常（`http=403` 握手成功） |
| 结论 | 部署成功但**完全无法访问** | **可用** |

实测证据（同一个 Cloudflare 边缘 IP `104.19.192.174`，只改 SNI）：

```
probe12345.pages.dev                          http=403   ← 握手成功
kazumi-proxy.wangsen200822.workers.dev        http=000   ← 阻断
api.cloudflare.com                            http=301   ← 正常
```

`Worker` 脚本本身部署是成功的（API 可查、修改时间正常），纯粹是域名被封。

Pages 还有一个额外好处：**静态站点和代理同域**，前端调 `/proxy` 不产生任何跨域，
连 CORS 头都不需要。

---

## 1. 部署到 Cloudflare Pages（推荐）

用仓库里的 `deploy_pages.py`，逆向了 wrangler 的上传协议，纯 stdlib + `blake3`。

```bash
pip install blake3
CF_TOKEN=<你的Token> python3 deploy_pages.py <ACCOUNT_ID> kazumi-web .
```

需要 Token 权限：`Account → Cloudflare Pages → Edit`。

### 协议细节（官方文档没写全，踩了四个坑）

1. **资产哈希是 BLAKE3，不是 SHA-256**
   ```js
   hash = blake3( base64(文件内容) + 扩展名 ).hex().slice(0, 32)
   ```
   算法错了不会报错，而是**部署成功但全站 500**。这是最坑的一个。

2. **上传分五步**，文件内容不在 deployment 那一步：
   ```
   GET  /accounts/{acc}/pages/projects/{proj}/upload-token     → jwt（注意是 GET）
   POST /pages/assets/check-missing   {hashes:[...]}           （Bearer jwt）
   POST /pages/assets/upload          [{key,value,metadata}]   （Bearer jwt，value 是 base64）
   POST /pages/assets/upsert-hashes   {hashes:[...]}           （Bearer jwt）
   POST /accounts/{acc}/pages/projects/{proj}/deployments      （Bearer CF_TOKEN，只传 manifest）
   ```

3. **`_worker.js` 必须以 `_worker.bundle` 字段上传**，不能放进 manifest。
   而且它的内容是一个**嵌套的 multipart 表单**（Workers 标准上传格式），不是裸脚本。

4. **Cloudflare 的 fetch 会吞掉 Range 头**（见第 4 节）。

---

## 2. 为什么必须部署代理

浏览器有同源策略。本站需要读取源站的 HTML 才能解析番剧列表和分集，而源站不返回 `Access-Control-Allow-Origin` 头，浏览器会直接拦掉这个请求。

实测证据（同一个搜索 URL）：

| 通道 | 结果 |
|---|---|
| curl 直接抓 | **HTTP 200，22.7 KB，2.3 秒** ✅ |
| 浏览器 fetch | `Load failed`（CORS 拦截） ❌ |
| allorigins | **522 超时**（20 秒） ❌ |
| codetabs | 522 超时 ❌ |
| corsproxy.io | 401，要 API key ❌ |
| thingproxy | 已停止服务 ❌ |

源站很快，是浏览器和公共代理不行。所以必须在服务端放一个中转。

**没有代理**：能搜索、能看分集列表，但点播放就是「解析失败」。

---

## 1. 方案 A：Cloudflare Workers（推荐）

免费、不用信用卡、每天 10 万次请求。

### 1.1 注册

1. 打开 https://dash.cloudflare.com/sign-up
2. 填邮箱 + 密码，点 `Sign Up`
3. 去邮箱点验证链接
4. 登录后如果弹出 `Add a site`，**关掉它**，不用加站点
5. 在左侧栏找 `Workers & Pages`（新版界面在 `Compute (Workers)` 下面），点进去

### 1.2 设置账号子域名（首次会被要求）

进入 Workers 后如果提示要先设置一个子域名：

1. 点 `Set up a subdomain` 或 `Choose a subdomain`
2. 填一个你喜欢的名字，比如 `yourname`（就是 `yourname.workers.dev`）
3. 保存

这一步只是给你的 Worker 分配 URL 前缀，随便填，之后改不了但也不影响使用。

### 1.3 创建 Worker

1. 点 `Create`，或 `Create application`
2. 选 `Create Worker`（**不要**选 Pages、不要选模板）
3. 名称填 `kazumi-proxy`（随便，但记住它）
4. 点 `Deploy`

到这一步 Cloudflare 已经给你生成了一个返回 "Hello World" 的 Worker。

### 1.4 粘贴代理代码

1. 部署完点 `Edit code`（或右上角 `Edit code` 按钮）
2. 左边编辑器里全选（Ctrl/Cmd + A）→ 删除
3. 粘贴下面任一来源的**全部内容**：

   - 仓库原文：https://github.com/ws200822/kazumi-web/blob/main/proxy/worker.js
   - 纯文本（打开即复制）：https://ws200822.github.io/kazumi-web/proxy/worker.js
   - 或本地文件 `proxy/worker.js`

4. 点右上角 `Deploy`（按钮会变成 `Save and Deploy`）
5. 等 5～10 秒，提示 `Deployed`

> ⚠️ 必须整段替换，包括开头的 `export default {` 和结尾的 `}`。少一层大括号都会部署报错。

### 1.5 拿到地址

部署后页面上会显示你的 Worker 地址，形如：

```
https://kazumi-proxy.<你的子域名>.workers.dev
```

在 `Settings` → `Domains & Routes` 里也能看到，点 `Copy` 复制。

---

## 2. 验证代理是否工作

### 2.1 健康检查

浏览器新开标签，直接访问（**末尾那个斜杠要带上**）：

```
https://kazumi-proxy.你的子域名.workers.dev/
```

应该看到类似这样的 JSON：

```json
{
  "ok": true,
  "name": "kazumi-web-proxy",
  "usage": "https://kazumi-proxy.xxx.workers.dev/?url=<encoded-target>&ref=<referer>&ua=<user-agent>"
}
```

看到 `"ok": true` 就说明 Worker 活着。

如果看到 404、1101、`Worker threw exception`，回到 1.4 检查代码是否粘贴完整。

### 2.2 真实抓取测试

再访问这个地址（把域名换成你自己的）：

```
https://kazumi-proxy.你的子域名.workers.dev/?url=https%3A%2F%2Fwww.7sefun.top%2F
```

应该返回一大段 HTML 源码（约 34 KB，以 `<!DOCTYPE html>` 开头）。

**这一步是关键**：它证明 Worker 能真正抓到源站内容。如果这里失败，站点的搜索功能也不会工作。

---

## 3. 填进站点

1. 打开 https://ws200822.github.io/kazumi-web/
2. 左滑或点右上角 `☰` → `设置`
3. 在「代理地址」里填入你的 Worker 地址，**末尾不要带斜杠**：
   ```
   https://kazumi-proxy.你的子域名.workers.dev
   ```
4. 点 `保存设置`
5. 回首页搜索任意番剧名，比如「巨人」

搜到结果 → 点进详情 → 看到分集列表 → 点一集 → 播放。

---

## 4. 【重要】workers.dev 在国内可能连不上

`*.workers.dev` 这个域名在部分地区和网络环境下会被阻断。**部署成功不等于你能访问。**

判断方法：

- 用手机移动数据（关掉 WiFi）打开上面的健康检查地址
- 或者换一个网络环境再试

如果连不上，三条路：

### 4.1 绑定自己的域名（最稳）

前提：你自己有一个域名，并且已经托管在 Cloudflare（在 Cloudflare 里加了站点、改了 NS）。

1. Worker 页面 → `Settings` → `Domains & Routes`
2. 点 `Add` → `Custom Domain`
3. 填入一个子域名，比如 `kz.你的域名.com`
4. Cloudflare 会自动加一条 DNS 记录，等状态变成 `Active`
5. 之后用 `https://kz.你的域名.com` 作为代理地址

### 4.2 换 Deno Deploy

见方案 B，域名是 `*.deno.dev`，国内可达性通常更好。

### 4.3 放在自己的服务器上

见方案 D，用自己的 IP，最可控。

---

## 5. 方案 B：Deno Deploy

1. 打开 https://dash.deno.com ，用 GitHub 账号登录
2. 点 `New Playground`（或 `New Project`）
3. 把仓库里 `proxy/deno.ts` 的内容全部粘贴进去
4. 点 `Save & Deploy`，拿到 `https://xxx.deno.dev` 地址
5. 同样填进站点设置

免费额度每天 10 万次请求，逻辑与 Cloudflare 版本完全一致。

---

## 6. 方案 C：Vercel

适合已经有 Vercel 账号的人：

1. Fork 本仓库
2. 在 Vercel 里 `Import` 这个仓库
3. 新建 `api/proxy.js`，导出默认的 handler：

```js
export default async function handler(req, res) {
  const { url, ref } = req.query;
  if (!url) return res.json({ ok: true, name: 'kazumi-web-proxy' });
  const upstream = await fetch(url, {
    headers: {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      ...(ref ? { Referer: ref } : {}),
      ...(req.headers.range ? { Range: req.headers.range } : {})
    }
  });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.status(upstream.status);
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
}
```

4. 部署后地址形如 `https://xxx.vercel.app/api/proxy`
5. 填进站点设置

> Vercel 免费版有 4.5 MB 响应体上限，m3u8 分片可能被截断，**播放可能不稳定**，仅作备选。

---

## 7. 方案 D：自己的服务器

用 Caddy 最省事，自带 HTTPS。`Caddyfile`：

```
kz.你的域名.com {
    reverse_proxy / 127.0.0.1:8787
}
```

搭配 `proxy/worker.js` 的逻辑改写成一个 Node 服务（`worker.js` 里的转发逻辑直接可用，把 `export default { fetch }` 换成 `http.createServer` 即可）。

好处：完全可控，不受 workers.dev 阻断影响，可以放在离源站更近的机房。

---

## 8. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 访问 Worker 报 1101 / Worker threw exception | 代码没粘完整 | 回 1.4 重新整段替换 |
| 健康检查正常，但抓取测试返回 403 | 源站封了 Cloudflare 的 IP | 换 Deno Deploy 或自建服务器 |
| 搜索一直转圈、最后说「全部通道失败」 | 代理地址填错，或末尾多了斜杠 | 检查设置里的地址 |
| 能搜到结果，点播放报「未在页面中找到播放地址」 | 该源的分集页不是 MacCMS 结构 | 换一个线路，或换别的规则源 |
| 视频能解析但播放器黑屏 | MP4 直连被防盗链拦了 | 正常会自动回退到代理，若仍失败检查 Referer |
| 只有 16 个源能搜 | 规则仓库 86 条里有 70 条已标记弃用 | 正常。可在「规则」页手动启用其它源试试 |
| No 'Access-Control-Allow-Origin' | 请求没走代理 | 确认代理地址已保存且刷新过页面 |

---

## 9. 成本

全部方案都在免费额度内：

| 平台 | 免费额度 |
|---|---|
| Cloudflare Workers | 10 万次请求/天 |
| Deno Deploy | 10 万次请求/天 |
| Vercel | 100 GB 带宽/月 |
| 自己的 VPS | 看你的机器 |

视频流量走 MP4 直连（不经代理），所以代理只承担 HTML 和 JSON 请求，日常个人使用远远用不完。

---

## 10. Range 头与播放（最重要的一个坑）

**Cloudflare 的 fetch 会剥离 Range 头。**

实测链路：

| 环节 | 结果 |
|---|---|
| 浏览器发给 Worker 的 Range | `"range": "bytes=0-1023"` ✅ **到达了** |
| Worker 转发到源站 | 302 → 手动跟随 → **200 + 全量 1.83 GB**，`content-range: null` ❌ |

即使显式写 `headers: { Range: 'bytes=0-1023' }` 也一样被吞。

**影响**：MP4 走代理时无法拖动进度条（每次 seek 都要从头下整个文件）。

**对策**：`<video>` 元素**不受 CORS 限制**（只有 fetch/XHR/Canvas 受限），
所以 MP4 一律**直连 CDN**，Range 交给浏览器自己处理。`js/net.js` 已经这么做了：

```js
function mediaUrl(target, referer, format) {
  var isHls = format === 'hls' || /\.m3u8(\?|#|$)/i.test(target);
  if (isHls) return viaProxy(target, referer) || target;  // HLS 必须走代理
  return target;                                          // MP4 直连，Range 由浏览器处理
}
```

直连若被拦，播放器的 `onerror` 会自动回退到代理 URL（能播，但不能拖进度条）。

**HLS 是例外**：m3u8 与 .ts 分片都是独立小文件，不需要 Range，所以走代理没问题
——而且必须走，因为 hls.js 用 XHR/fetch 加载，受 CORS 限制。

**防盗链实测**：目标 CDN 不检查 Referer。无 Referer / 正确 Referer / pages.dev Referer
三种情况都返回 `206 + 1024 字节`，`Content-Range: bytes 0-1023/1834237486`。所以 MP4 直连可行。

---

## 11. 环境限制说明

**iSH 内置浏览器不支持视频播放**，实测连 w3schools / MDN 的公开测试视频都返回
`NETWORK_NO_SOURCE`（`networkState=3`）。所以在这个沙箱里只能验证到：

- ✅ 页面加载、模块初始化
- ✅ 搜索（12 条结果，2.5 秒）
- ✅ 章节解析（1 条线路）
- ✅ 播放地址解码（mp4 直链）
- ✅ CDN 可达（curl 拿到 206 + 合法 MP4 头）
- ❌ 实际播放 —— 必须在真机 Safari / Chrome 上测

