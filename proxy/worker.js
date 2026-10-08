/**
 * Kazumi Web —— 抓取 + 媒体转发代理
 *
 * 部署：Cloudflare Workers（免费额度每天 10 万次请求）
 *   1. dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. 把本文件全部内容覆盖进去 → Deploy
 *   3. 记下 https://<name>.<sub>.workers.dev，填进本站「设置 → 代理地址」
 *
 * 职责：
 *   - 给站点页面 / JSON API 加 CORS 头（浏览器直连会被 CORS 拦死）
 *   - 伪装 Referer / User-Agent，绕过防盗链
 *   - 透传 Range，支持 206（视频拖动进度条的关键）
 *   - 重写 m3u8 里的分片地址，把每个 .ts 也拉回本代理（否则分片跨域失败）
 *
 * 调用协议：
 *   GET {WORKER}/?url=<encodeURIComponent(目标URL)>&ref=<Referer>&ua=<User-Agent>
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

/* 这些头会阻止在 iframe/播放器里使用，转发时删掉 */
const STRIP_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy'
];

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json;charset=utf-8' }, CORS)
  });
}

function isM3U8(target, contentType) {
  if (/application\/(x-mpegurl|vnd\.apple\.mpegurl)/i.test(contentType || '')) return true;
  if (/(^|\/)mpegurl/i.test(contentType || '')) return true;
  return /\.m3u8(\?|#|$)/i.test(target);
}

function isMediaPath(path) {
  return /\.(ts|m4s|mp4|aac|m4a|key|vtt|jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(path);
}

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const target = reqUrl.searchParams.get('url');
    const referer = reqUrl.searchParams.get('ref') || '';
    const ua = reqUrl.searchParams.get('ua') || DEFAULT_UA;

    /* 健康检查 / 用法提示 */
    if (!target) {
      return json({
        ok: true,
        name: 'kazumi-web-proxy',
        usage: reqUrl.origin + '/?url=<encoded-target>&ref=<referer>&ua=<user-agent>'
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return json({ error: 'invalid url', target }, 400);
    }
    if (!/^https?:$/.test(targetUrl.protocol)) {
      return json({ error: 'only http/https allowed' }, 400);
    }

    /* 构造转发头 */
    const fwd = new Headers();
    fwd.set('User-Agent', ua);
    fwd.set('Accept', request.headers.get('Accept') || '*/*');
    fwd.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    if (referer) fwd.set('Referer', referer);
    const range = request.headers.get('Range');
    if (range) fwd.set('Range', range);
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch) fwd.set('If-None-Match', ifNoneMatch);

    /* 透传 POST 请求体（部分规则用 POST 搜索） */
    let body;
    if (request.method === 'POST' || request.method === 'PUT') {
      body = await request.arrayBuffer();
      const ct = request.headers.get('Content-Type');
      if (ct) fwd.set('Content-Type', ct);
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method === 'HEAD' ? 'HEAD' : (request.method === 'POST' ? 'POST' : 'GET'),
        headers: fwd,
        body,
        redirect: 'follow'
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
    }

    /* 组装响应头 */
    const out = new Headers();
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (STRIP_HEADERS.includes(lk)) return;
      if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
      out.set(k, v);
    });
    Object.keys(CORS).forEach((k) => out.set(k, CORS[k]));

    const contentType = upstream.headers.get('content-type') || '';

    /* m3u8 重写：把分片与密钥地址全部拉回本代理 */
    if (upstream.ok && isM3U8(targetUrl.toString(), contentType) && request.method === 'GET') {
      let text = await upstream.text();
      const base = targetUrl.toString();
      const proxyOf = (abs) =>
        reqUrl.origin + '/?url=' + encodeURIComponent(abs) + (referer ? '&ref=' + encodeURIComponent(referer) : '');

      text = text.split('\n').map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.charAt(0) === '#') {
          /* 处理 #EXT-X-KEY:URI="..." / #EXT-X-MAP:URI="..." 等 */
          return t.replace(/URI="([^"]+)"/g, (m, u) => {
            let abs;
            try { abs = new URL(u, base).toString(); } catch (e) { return m; }
            return 'URI="' + proxyOf(abs) + '"';
          });
        }
        let abs;
        try { abs = new URL(t, base).toString(); } catch (e) { return line; }
        return proxyOf(abs);
      }).join('\n');

      out.set('Content-Type', 'application/vnd.apple.mpegurl');
      return new Response(text, { status: 200, headers: out });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out
    });
  }
};
