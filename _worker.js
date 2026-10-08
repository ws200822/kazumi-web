/**
 * Cloudflare Pages —— 高级模式 Worker（_worker.js）
 *
 * 一个文件搞定两件事：
 *   /proxy?url=...  → 抓取 / 媒体转发（伪装 Referer、透传 Range、重写 m3u8）
 *   其它路径         → 交给 Pages 静态资源（env.ASSETS）
 *
 * 站点与代理同域，前端调 /proxy 不产生任何跨域问题。
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

/* 手动跟随重定向。
 * Cloudflare 的 fetch 在 redirect:'follow' 时会在跨主机跳转中丢掉 Range 头，
 * 结果是视频永远返回 200 + 完整文件，进度条拖不动（实测 1.83 GB 全量下载）。
 * 这里自己跟，保证 Range 一路带到底。 */
async function fetchFollow(url, init, depth) {
  depth = depth || 0;
  const res = await fetch(url, Object.assign({}, init, { redirect: 'manual' }));
  if (depth < 5 && [301, 302, 303, 307, 308].indexOf(res.status) >= 0) {
    const loc = res.headers.get('Location');
    if (loc) {
      let next;
      try { next = new URL(loc, url).toString(); } catch (e) { return res; }
      const init2 = Object.assign({}, init);
      if (res.status === 303) init2.method = 'GET';
      return fetchFollow(next, init2, depth + 1);
    }
  }
  return res;
}

/* ---------- 访问控制 ----------
 * 站点是公开的（Pages / GitHub Pages 都能被任何人打开），
 * 但代理不该被陌生人白嫖 —— 会烧掉你每天 10 万次的免费额度。
 *
 * 两道闸门，都在下面这个配置块里：
 *   1. CHECK_REFERER：只接受来自本站页面的请求（默认开）
 *   2. ACCESS_KEY：填了之后，请求必须带 &key=xxx（默认空 = 不启用）
 *
 * 想更严就把 ACCESS_KEY 填上一串随机字符，然后告诉朋友站点「设置」里也要填同样的值。
 */
const CHECK_REFERER = true;
const ACCESS_KEY = '';
const ALLOWED_REFERERS = [
  'kazumi-web-5zj.pages.dev',
  'ws200822.github.io',
  'localhost',
  '127.0.0.1'
];

function checkAccess(request, reqUrl) {
  const key = reqUrl.searchParams.get('key') || '';

  if (ACCESS_KEY) {
    if (key !== ACCESS_KEY) {
      return json({ error: 'forbidden', hint: '需要在设置里填写正确的访问口令' }, 403);
    }
    return null;
  }

  if (!CHECK_REFERER) return null;

  const ref = request.headers.get('Referer') || '';

  /* 允许本站页面发起的请求 */
  for (let i = 0; i < ALLOWED_REFERERS.length; i++) {
    if (ref.indexOf(ALLOWED_REFERERS[i]) >= 0) return null;
  }

  /* 同源请求（部分浏览器对某些资源不带 Referer） */
  const sfs = request.headers.get('Sec-Fetch-Site');
  if (sfs === 'same-origin') return null;

  return json({
    error: 'forbidden',
    hint: '这个代理只服务本站页面。如果你是站点主人，改 ALLOWED_REFERERS；' +
          '想用 curl 测试，加 -e https://kazumi-web-5zj.pages.dev/'
  }, 403);
}

async function handleProxy(request, origin) {
  const reqUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const target = reqUrl.searchParams.get('url');
  const referer = reqUrl.searchParams.get('ref') || '';
  const ua = reqUrl.searchParams.get('ua') || DEFAULT_UA;

  if (!target) {
    return json({
      ok: true,
      name: 'kazumi-web-pages-proxy',
      runtime: 'cloudflare-pages',
      usage: origin + '/proxy?url=<encoded-target>&ref=<referer>&ua=<user-agent>'
    });
  }

  /* 调试端点：回显 Worker 实际收到的请求头（排查 Range 被谁吞了） */
  if (target === 'debug') {
    const hdrs = {};
    request.headers.forEach(function (v, k) { hdrs[k] = v; });
    return json({ ok: true, method: request.method, headers: hdrs });
  }

  /* 访问控制：健康检查与调试端点已在上方放行，其余必须来自本站 */
  const denied = checkAccess(request, reqUrl);
  if (denied) return denied;

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return json({ error: 'invalid url', target: target }, 400);
  }
  if (!/^https?:$/.test(targetUrl.protocol)) {
    return json({ error: 'only http/https allowed' }, 400);
  }

  const fwd = new Headers();
  fwd.set('User-Agent', ua);
  fwd.set('Accept', request.headers.get('Accept') || '*/*');
  fwd.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
  if (referer) fwd.set('Referer', referer);
  const range = request.headers.get('Range');
  if (range) fwd.set('Range', range);
  const inm = request.headers.get('If-None-Match');
  if (inm) fwd.set('If-None-Match', inm);

  let body;
  if (request.method === 'POST' || request.method === 'PUT') {
    body = await request.arrayBuffer();
    const ct = request.headers.get('Content-Type');
    if (ct) fwd.set('Content-Type', ct);
  }

  let upstream;
  try {
    upstream = await fetchFollow(targetUrl.toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : (request.method === 'POST' ? 'POST' : 'GET'),
      headers: fwd,
      body: body
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }

  const out = new Headers();
  upstream.headers.forEach(function (v, k) {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.indexOf(lk) >= 0) return;
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
    out.set(k, v);
  });
  Object.keys(CORS).forEach(function (k) { out.set(k, CORS[k]); });

  const contentType = upstream.headers.get('content-type') || '';

  if (upstream.ok && isM3U8(targetUrl.toString(), contentType) && request.method === 'GET') {
    let text = await upstream.text();
    const base = targetUrl.toString();
    const proxyOf = function (abs) {
      return origin + '/proxy?url=' + encodeURIComponent(abs) +
        (referer ? '&ref=' + encodeURIComponent(referer) : '');
    };

    text = text.split('\n').map(function (line) {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') {
        return t.replace(/URI="([^"]+)"/g, function (m, u) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/proxy' || url.pathname === '/proxy/') {
      return handleProxy(request, url.origin);
    }

    /* 其余走静态资源 */
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  }
};
