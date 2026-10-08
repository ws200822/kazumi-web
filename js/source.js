/* 采集引擎 —— 搜索 / 章节 / 播放地址
 *
 * 链路（实测自 7sefun，MacCMS 系站点）：
 *   搜索   : GET searchURL(@keyword)        → XPath searchList/searchName/searchResult
 *   章节   : GET 详情页                       → XPath chapterRoads/chapterResult
 *   播放   : GET 分集页 → player_aaaa 变量    → base64 → decodeURIComponent → 真实地址
 *
 * 关键结论：MacCMS 系站点的播放地址**不在 HTML 里**，而是以 base64 藏在
 * `var player_xxxx={...}` 这个 JSON 中。纯 HTTP + 解码即可拿到，无需 WebView。
 * Kazumi 之所以走 WebView，是为了兼容那些用 JS 动态解析/加密的少数站点。
 */
(function (g) {
  'use strict';

  /* ================= 极简 JSONPath =================
   * 支持：$.a.b[*].c   $.a[0]   $.a.b   $[*]
   */
  function jsonPath(obj, path) {
    if (path == null) return obj === undefined ? [] : [obj];
    var p = String(path).trim();
    if (!p || p === '$') return obj === undefined ? [] : [obj];
    p = p.replace(/^\$\.?/, '');
    if (!p) return obj === undefined ? [] : [obj];
    var segs = p.split('.').filter(function (s) { return s !== ''; });
    var out = [];

    function applyIndex(v, parts, k, next) {
      if (k >= parts.length) { next(v); return; }
      var pt = parts[k];
      if (pt === '[*]') {
        if (Array.isArray(v)) v.forEach(function (x) { applyIndex(x, parts, k + 1, next); });
        else if (v && typeof v === 'object') Object.keys(v).forEach(function (kk) { applyIndex(v[kk], parts, k + 1, next); });
      } else {
        var n = parseInt(pt.slice(1, -1), 10);
        if (Array.isArray(v) && n >= 0 && n < v.length) applyIndex(v[n], parts, k + 1, next);
      }
    }

    (function walk(node, i) {
      if (i >= segs.length) { if (node !== undefined) out.push(node); return; }
      if (node == null) return;
      var seg = segs[i];
      var m = seg.match(/^([^\[\]]*)((?:\[\d+\]|\[\*\])+)$/);
      if (m) {
        var base = m[1] ? node[m[1]] : node;
        var parts = m[2].match(/\[\*\]|\[\d+\]/g) || [];
        applyIndex(base, parts, 0, function (v) { walk(v, i + 1); });
        return;
      }
      walk(node[seg], i + 1);
    })(obj, 0);

    return out;
  }

  function jp1(obj, path) {
    var r = jsonPath(obj, path);
    return r.length ? r[0] : undefined;
  }

  /* ================= base64 / 地址解码 ================= */
  function b64raw(s) {
    try {
      s = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return atob(s);
    } catch (e) { return null; }
  }

  /* atob 得到 latin1，中文 URL 需要还原成 UTF-8 */
  function b64utf(s) {
    var bin = b64raw(s);
    if (bin == null) return null;
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }

  /* 依次尝试：base64 → base64 两次 → 原样；每层再试一次 URL 解码 */
  function decodeAddress(raw, encrypt) {
    if (!raw) return '';
    var cands = [];
    var b1 = b64utf(raw);
    if (b1) { cands.push(b1); }
    if (b1) { var b2 = b64utf(b1); if (b2) cands.push(b2); }
    cands.push(String(raw));

    for (var i = 0; i < cands.length; i++) {
      var s = cands[i];
      var tries = [s];
      try { tries.push(decodeURIComponent(s)); } catch (e) { /* ignore */ }
      for (var j = 0; j < tries.length; j++) {
        var u = tries[j].trim();
        if (/^https?:\/\//i.test(u)) return u;
        if (u.indexOf('//') === 0) return 'https:' + u;
      }
    }
    return '';
  }

  function fmtOf(u) {
    if (!u) return 'auto';
    if (/\.m3u8(\?|#|$)/i.test(u)) return 'hls';
    if (/\.mp4(\?|#|$)/i.test(u)) return 'mp4';
    if (/\.flv(\?|#|$)/i.test(u)) return 'flv';
    return 'auto';
  }

  /* 花括号配对提取一段 JSON 对象文本 */
  function braceExtract(s, start) {
    var d = 0, inStr = false, esc = false;
    for (var i = start; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) return s.slice(start, i + 1); }
    }
    return null;
  }

  /* 从分集页 HTML 中提取播放地址 */
  function decodePlayer(html) {
    var re = /(?:var\s+|window\.)?player_\w+\s*=\s*/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var start = html.indexOf('{', m.index + m[0].length);
      if (start < 0) continue;
      var js = braceExtract(html, start);
      if (!js) continue;

      var obj = null;
      try { obj = JSON.parse(js); }
      catch (e) {
        try { obj = (new Function('return (' + js + ');'))(); }
        catch (e2) { continue; }
      }
      if (!obj || typeof obj !== 'object') continue;

      var raw = obj.url || obj.url_next || '';
      if (!raw || typeof raw !== 'string') continue;

      var real = decodeAddress(raw, obj.encrypt);
      if (real) {
        return {
          url: real,
          format: fmtOf(real),
          from: obj.from || '',
          encrypt: obj.encrypt,
          server: obj.server || ''
        };
      }
    }
    return null;
  }

  /* 兜底：正文里直接躺着 m3u8/mp4 */
  function findMedia(body) {
    var m = body.match(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|flv)(?:\?[^\s"'<>\\]*)?/i);
    if (m) {
      var u = m[0].replace(/\\\//g, '/');
      return { url: u, format: fmtOf(u), from: 'regex' };
    }
    return null;
  }

  /* ================= 搜索 ================= */
  async function searchXpath(rule, kw) {
    var url = String(rule.searchURL || '').replace(/@keyword/g, encodeURIComponent(kw));
    if (!/^https?:\/\//i.test(url)) throw new Error('searchURL 无效');

    var opt = { referer: rule.referer || rule.baseURL, ua: rule.userAgent };
    var res;
    if (rule.usePost) {
      var u = new URL(url);
      var form = u.searchParams.toString();
      u.search = '';
      res = await NET.text(u.href, Object.assign({
        method: 'POST', body: form, form: true
      }, opt));
    } else {
      res = await NET.text(url, opt);
    }

    var doc = KXP.doc(res.body);
    var nodes = KXP.all(doc, rule.searchList);
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      var nm = KXP.text(KXP.one(nodes[i], rule.searchName));
      var hr = KXP.attr(KXP.one(nodes[i], rule.searchResult), 'href');
      if (!nm || !hr) continue;
      items.push({ name: nm, src: Rules.abs(rule.baseURL, hr) });
    }
    return dedupe(items);
  }

  async function searchApi(rule, kw) {
    var cfg = rule.searchApiConfig || {};
    var req = cfg.request || {};
    if (!req.url) throw new Error('searchApiConfig.request.url 缺失');

    var url = String(req.url).replace(/@keyword/g, encodeURIComponent(kw));
    var q = req.query || {};
    var qs = Object.keys(q).map(function (k) {
      return encodeURIComponent(k) + '=' +
        encodeURIComponent(String(q[k]).replace(/@keyword/g, kw));
    });
    if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');

    var opt = {
      referer: rule.referer || rule.baseURL,
      ua: rule.userAgent,
      method: (req.method || 'GET').toUpperCase()
    };
    if (opt.method === 'POST' && req.body != null) {
      opt.body = JSON.stringify(req.body);
    }
    var res = await NET.text(url, opt);
    var data;
    try { data = JSON.parse(res.body); }
    catch (e) { throw new Error('API 响应不是 JSON'); }

    var list = jsonPath(data, cfg.listPath || '$');
    var items = [];
    list.forEach(function (it) {
      var nm = jp1(it, cfg.namePath);
      var src = jp1(it, cfg.sourcePath);
      if (nm == null || src == null) return;
      items.push({
        name: String(nm).trim(),
        src: String(src),
        raw: it
      });
    });
    return dedupe(items);
  }

  function dedupe(items) {
    var seen = Object.create(null), out = [];
    items.forEach(function (x) {
      var k = x.name + '\u0000' + x.src;
      if (seen[k]) return;
      seen[k] = 1;
      out.push(x);
    });
    return out;
  }

  async function search(rule, kw) {
    if (!kw) return [];
    if (rule.searchMode === 'api' && rule.searchApiConfig && rule.searchApiConfig.request) {
      return searchApi(rule, kw);
    }
    return searchXpath(rule, kw);
  }

  /* ================= 章节 ================= */
  async function chaptersXpath(rule, src) {
    var url = Rules.abs(rule.baseURL, src);
    var res = await NET.text(url, { referer: rule.referer || rule.baseURL, ua: rule.userAgent });
    var doc = KXP.doc(res.body);
    var roads = KXP.all(doc, rule.chapterRoads);
    var out = [];

    for (var i = 0; i < roads.length; i++) {
      var as = KXP.all(roads[i], rule.chapterResult);
      var eps = [];
      for (var j = 0; j < as.length; j++) {
        var h = KXP.attr(as[j], 'href');
        if (!h) continue;
        var nm = KXP.text(as[j]).replace(/\s+/g, '');
        eps.push({
          name: nm || ('第' + (j + 1) + '集'),
          url: Rules.abs(rule.baseURL, h)
        });
      }
      if (eps.length) {
        out.push({
          name: rule.muliSources ? ('线路 ' + (i + 1)) : '正片',
          episodes: dedupeEp(eps)
        });
      }
    }
    return out;
  }

  function dedupeEp(eps) {
    var seen = Object.create(null), out = [];
    eps.forEach(function (e) {
      if (seen[e.url]) return;
      seen[e.url] = 1;
      out.push(e);
    });
    return out;
  }

  async function chaptersApi(rule, src) {
    var cfg = rule.chapterApiConfig || {};
    var req = cfg.request || {};
    if (!req.url) throw new Error('chapterApiConfig.request.url 缺失');

    var url = String(req.url).replace(/@source/g, encodeURIComponent(src));
    var q = req.query || {};
    var qs = Object.keys(q).map(function (k) {
      return encodeURIComponent(k) + '=' +
        encodeURIComponent(String(q[k]).replace(/@source/g, src));
    });
    if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');

    var res = await NET.text(url, {
      referer: rule.referer || rule.baseURL,
      ua: rule.userAgent,
      method: (req.method || 'GET').toUpperCase()
    });
    var data;
    try { data = JSON.parse(res.body); }
    catch (e) { throw new Error('API 响应不是 JSON'); }

    var roads = jsonPath(data, cfg.roadsPath || '$');
    var out = [];

    roads.forEach(function (road, ri) {
      var eps = [];
      var list = jsonPath(road, cfg.episodesPath || '$');
      if (!list.length) list = Array.isArray(road) ? road : [road];

      list.forEach(function (ep, ei) {
        var nm = jp1(ep, cfg.episodeNamePath);
        var ord = jp1(ep, cfg.episodeUrlPath);
        var page = cfg.episodePage || {};
        var epUrl = '';
        if (page.url) {
          epUrl = String(page.url)
            .replace(/@source/g, encodeURIComponent(src))
            .replace(/@episodeUrl/g, encodeURIComponent(ord == null ? '' : ord));
        }
        if (!epUrl) return;
        eps.push({
          name: nm == null ? ('第' + (ei + 1) + '集') : String(nm),
          url: epUrl
        });
      });

      var rn = jp1(road, cfg.roadNamePath);
      if (eps.length) {
        out.push({ name: (rn ? String(rn) : '线路 ' + (ri + 1)), episodes: eps });
      }
    });

    return out;
  }

  async function chapters(rule, src) {
    if (rule.chapterMode === 'api' && rule.chapterApiConfig && rule.chapterApiConfig.request) {
      return chaptersApi(rule, src);
    }
    return chaptersXpath(rule, src);
  }

  /* ================= 播放地址 ================= */
  async function playUrl(rule, epUrl) {
    var res = await NET.text(epUrl, {
      referer: rule.referer || rule.baseURL,
      ua: rule.userAgent
    });
    var body = res.body;

    var d = decodePlayer(body);
    if (d) return d;

    var f = findMedia(body);
    if (f) return f;

    /* 有些站点把地址放在 iframe 的 data-* 或 JSON 接口里，留一层提示 */
    var ifr = body.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (ifr) {
      throw new Error('该集需要解析外链播放器（' + ifr[1].slice(0, 60) + '…），当前版本暂不支持');
    }
    throw new Error('未在页面中找到播放地址');
  }

  /* ================= 多源并发 ================= */
  async function pool(tasks, limit, onEach) {
    var results = [];
    var idx = 0;
    var running = 0;
    return new Promise(function (resolve) {
      function next() {
        if (idx >= tasks.length && running === 0) return resolve(results);
        while (running < limit && idx < tasks.length) {
          (function (i) {
            running++;
            var t = tasks[i];
            Promise.resolve()
              .then(t.fn)
              .then(function (v) { var r = { ok: true, rule: t.rule, value: v }; results.push(r); if (onEach) onEach(r); })
              .catch(function (e) { var r = { ok: false, rule: t.rule, error: e }; results.push(r); if (onEach) onEach(r); })
              .finally(function () { running--; next(); });
          })(idx++);
        }
        if (idx >= tasks.length && running === 0) resolve(results);
      }
      next();
    });
  }

  /* 在全部启用规则上并发搜索 */
  async function searchAll(kw, onEach) {
    var rules = Rules.enabledRules();
    var tasks = rules.map(function (r) {
      return {
        rule: r,
        fn: async function () {
          var list = await search(r, kw);
          if (!list.length) throw new Error('无结果');
          return list;
        }
      };
    });
    var limit = Math.max(1, Math.min(8, Store.settings().concurrency || 4));
    return pool(tasks, limit, onEach);
  }

  g.Source = {
    search: search,
    searchAll: searchAll,
    chapters: chapters,
    playUrl: playUrl,
    decodePlayer: decodePlayer,
    decodeAddress: decodeAddress,
    jsonPath: jsonPath,
    jsonPath1: jp1,
    fmtOf: fmtOf,
    pool: pool
  };
})(window);
