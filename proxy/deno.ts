/**
 * Kazumi Web —— 代理（Deno Deploy 版本）
 *
 * 部署：dash.deno.com → New Playground → 粘贴全文 → Save & Deploy
 * 调用协议与 Cloudflare 版本完全一致：
 *   GET {WORKER}/?url=<encoded>&ref=<referer>&ua=<ua>
 *
 * 与 worker.js 的区别只有入口：Deno.serve 替代 export default { fetch }。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CORS: Record<string, string> = {
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

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json;charset=utf-8', ...CORS }
  });
}

function isM3U8(target: string, contentType: string): boolean {
  if (/application\/(x-mpegurl|vnd\.apple\.mpegurl)/i.test(contentType)) return true;
  if (/(^|\/)mpegurl/i.test(contentType)) return true;
  return /\.m3u8(\?|#|$)/i.test(target);
}

Deno.serve(async (request: Request): Promise<Response> => {
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
      name: 'kazumi-web-proxy',
      runtime: 'deno',
      usage: reqUrl.origin + '/?url=<encoded-target>&ref=<referer>&ua=<user-agent>'
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return json({ error: 'invalid url', target }, 400);
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

  let body: ArrayBuffer | undefined;
  if (request.method === 'POST' || request.method === 'PUT') {
    body = await request.arrayBuffer();
    const ct = request.headers.get('Content-Type');
    if (ct) fwd.set('Content-Type', ct);
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : request.method === 'POST' ? 'POST' : 'GET',
      headers: fwd,
      body,
      redirect: 'follow'
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.includes(lk)) return;
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
    out.set(k, v);
  });
  for (const k of Object.keys(CORS)) out.set(k, CORS[k]);

  const contentType = upstream.headers.get('content-type') || '';

  if (upstream.ok && isM3U8(targetUrl.toString(), contentType) && request.method === 'GET') {
    let text = await upstream.text();
    const base = targetUrl.toString();
    const proxyOf = (abs: string) =>
      reqUrl.origin + '/?url=' + encodeURIComponent(abs) +
      (referer ? '&ref=' + encodeURIComponent(referer) : '');

    text = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') {
        return t.replace(/URI="([^"]+)"/g, (m, u) => {
          let abs: string;
          try { abs = new URL(u, base).toString(); } catch { return m; }
          return 'URI="' + proxyOf(abs) + '"';
        });
      }
      let abs: string;
      try { abs = new URL(t, base).toString(); } catch { return line; }
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
});
