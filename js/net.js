/* 网络层 —— 站点抓取 + 视频流
 *
 * 为什么必须有代理：
 *   站点页面与 JSON API 不返回 Access-Control-Allow-Origin，浏览器直连会被 CORS 拦死。
 *   视频流还需要伪装 Referer / UA 才能过防盗链。这两件事都只能由服务端代理完成。
 *
 * 代理协议（自建 Cloudflare Worker，见 proxy/worker.js）：
 *   {PROXY}/?url=<encodeURIComponent(目标URL)>&ref=<encodeURIComponent(Referer)>
 *   Worker 转发并回写 CORS 头，透传 Range / 206。
 *
 * 公共代理仅用于 HTML / JSON 抓取（勉强够用），**不要用于视频流**：
 *   公共代理普遍不支持 Range 透传与自定义 Referer，播放会失败或无法拖动。
 */
(function (g) {
  'use strict';

  var STORE_KEY = 'kz.net';

  /* 公共代理池：仅作无自建代理时的降级方案
   * 顺序即优先级 —— allorigins 实测最稳；codetabs 常挂，放最后设短超时。 */
  var PUBLIC = [
    { id: 'allorigins', tpl: 'https://api.allorigins.win/raw?url={URL}', timeout: 15000 },
    { id: 'corsproxy', tpl: 'https://corsproxy.io/?url={URL}', timeout: 10000 },
    { id: 'codetabs', tpl: 'https://api.codetabs.com/v1/proxy?quest={URL}', timeout: 8000 }
  ];

  var cfg = {
    proxy: '',              // 自建代理基址，例如 https://kz-proxy.xxx.workers.dev
    publicFallback: true,   // 无自建代理时是否用公共代理
    directFirst: true,      // 先直连试一次
    timeout: 20000
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* ignore */ }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  function enc(u) { return encodeURIComponent(u); }

  /* 构造经代理的 URL */
  function viaProxy(target, referer, proxyBase) {
    var base = (proxyBase || cfg.proxy || '').replace(/\/+$/, '');
    if (!base) return null;
    var u = base + '/?url=' + enc(target);
    if (referer) u += '&ref=' + enc(referer);
    return u;
  }

  function viaPublic(target, idx) {
    var p = PUBLIC[idx || 0];
    if (!p) return null;
    return { url: p.tpl.replace('{URL}', enc(target)), timeout: p.timeout };
  }

  /* 带超时的 fetch */
  function timedFetch(url, opts, ms) {
    opts = opts || {};
    if (!opts.signal && typeof AbortController !== 'undefined') {
      var ac = new AbortController();
      opts.signal = ac.signal;
      var t = setTimeout(function () { ac.abort(); }, ms || cfg.timeout);
      return fetch(url, opts).finally(function () { clearTimeout(t); });
    }
    return fetch(url, opts);
  }

  /* 抓取文本（HTML / JSON）—— 依次尝试：直连 → 自建代理 → 公共代理 */
  async function text(target, opt) {
    opt = opt || {};
    var referer = opt.referer || '';
    var attempts = [];

    if (cfg.directFirst) attempts.push({ tag: 'direct', url: target, ref: null });
    var p = viaProxy(target, referer);
    if (p) attempts.push({ tag: 'proxy', url: p, ref: null });
    if (cfg.publicFallback) {
      for (var pi = 0; pi < PUBLIC.length; pi++) {
        var pub = viaPublic(target, pi);
        if (pub) attempts.push({ tag: 'public:' + PUBLIC[pi].id, url: pub.url, ref: null, timeout: pub.timeout });
      }
    }
    if (!attempts.length) throw new Error('没有可用的请求通道，请先在设置里填写代理地址');

    var lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      try {
        var init = { method: opt.method || 'GET', headers: {} };
        if (opt.headers) Object.assign(init.headers, opt.headers);
        if (opt.ua) init.headers['User-Agent'] = opt.ua;
        if (opt.body != null && opt.method === 'POST') {
          if (opt.form) {
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            init.body = opt.body;
          } else {
            init.headers['Content-Type'] = 'application/json';
            init.body = typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body);
          }
        }
        if (a.ref) init.referrer = a.ref;
        var res = await timedFetch(a.url, init, a.timeout || opt.timeout);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var body = await res.text();
        /* 代理失败时常回显错误页，做一次粗筛 */
        if (body && /^\s*\{?\s*"(?:error|message)"/i.test(body) && body.length < 400) {
          throw new Error('代理返回错误：' + body.slice(0, 120));
        }
        return { body: body, via: a.tag, url: a.url };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('全部通道失败：' + (lastErr ? lastErr.message : '未知错误'));
  }

  async function json(target, opt) {
    var r = await text(target, opt);
    try {
      return { data: JSON.parse(r.body), via: r.via };
    } catch (e) {
      throw new Error('返回内容不是合法 JSON（可能被代理或反爬拦截）');
    }
  }

  /* 生成可直接喂给 <video>/hls.js 的媒体 URL
   *
   * 分两种情况，这是省代理带宽的关键：
   *   - HLS：**必须走代理**。hls.js 用 fetch/XHR 拉 m3u8 和 .ts 分片，受 CORS 限制。
   *   - MP4/FLV：**优先直连**。<video> 元素加载媒体流不受 CORS 约束
   *     （只有 fetch/XHR/Canvas 读像素才受限制），直连可省掉整条视频流量。
   *     若被防盗链拦截，播放器的 onerror 会自动回退到代理 URL。
   */
  function mediaUrl(target, referer, format) {
    var isHls = format === 'hls' || /\.m3u8(\?|#|$)/i.test(target);
    if (isHls) {
      var p = viaProxy(target, referer);
      return p || target;
    }
    return target;
  }

  /* 强制走代理的媒体 URL（作为直连失败后的回退） */
  function mediaProxyUrl(target, referer) {
    return viaProxy(target, referer) || target;
  }

  /* 生成用于 <img> 的封面 URL（公共代理即可） */
  function imageUrl(target) {
    if (!target) return '';
    var p = viaProxy(target, '');
    if (p) return p;
    if (cfg.publicFallback) {
      var pb = viaPublic(target, 0);
      if (pb) return pb.url;
    }
    return target;
  }

  g.NET = {
    load: load,
    save: save,
    cfg: cfg,
    text: text,
    json: json,
    mediaUrl: mediaUrl,
    mediaProxyUrl: mediaProxyUrl,
    imageUrl: imageUrl,
    viaProxy: viaProxy,
    PUBLIC: PUBLIC
  };

  load();
})(window);
