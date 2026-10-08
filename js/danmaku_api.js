/* Dandanplay 弹幕客户端
 * 鉴权：X-AppId / X-Timestamp / X-Signature
 *   signature = base64( sha256( appId + timestamp + path + secret ) )
 * 凭证由用户在「设置」中自行填写（dandanplay 免费注册）。
 */
(function (g) {
  'use strict';

  var API = 'https://api.dandanplay.net';

  /* ---------- 纯 JS SHA-256（crypto.subtle 在非 HTTPS 下不可用） ---------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256bytes(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var bitLen = len * 8;
    var withPad = new Uint8Array((((len + 9) >> 6) + 1) << 6);
    withPad.set(bytes);
    withPad[len] = 0x80;
    /* 大端 64 位长度 */
    var dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

    var w = new Uint32Array(64);
    for (var off = 0; off < withPad.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], gg = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & gg);
        var temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;
        h = gg; gg = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + gg) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 255;
      out[i * 4 + 1] = (H[i] >>> 16) & 255;
      out[i * 4 + 2] = (H[i] >>> 8) & 255;
      out[i * 4 + 3] = H[i] & 255;
    }
    return out;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function utf8(s) {
    if (g.TextEncoder) return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function b64FromBytes(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function sha256b64(str) { return b64FromBytes(sha256bytes(utf8(str))); }

  /* ---------- 签名 ---------- */
  function signature(appId, secret, path, ts) {
    return sha256b64(appId + ts + path + secret);
  }

  function creds() {
    var s = Store.settings();
    return { id: (s.dandanId || '').trim(), secret: (s.dandanSecret || '').trim() };
  }

  function hasCreds() {
    var c = creds();
    return !!(c.id && c.secret);
  }

  /* ---------- 请求 ---------- */
  /* 直连 + 签名头（不走 NET 的代理逻辑，因为代理不便携带自定义鉴权头） */
  async function signedGet(path, query) {
    var c = creds();
    if (!c.id || !c.secret) throw new Error('未配置 dandanplay 凭据');
    var ts = Math.floor(Date.now() / 1000);
    var qs = Object.keys(query || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
    }).join('&');
    var url = API + path + (qs ? '?' + qs : '');

    var res = await fetch(url, {
      headers: {
        'X-AppId': c.id,
        'X-Timestamp': String(ts),
        'X-Signature': signature(c.id, c.secret, path, ts),
        'X-Auth': '1',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error('dandanplay HTTP ' + res.status);
    return res.json();
  }

  /* ---------- 业务 ---------- */
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[\s　]+/g, '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/[·・:：\-—_]/g, '');
  }

  /* 从标题里抽集数 */
  function epNum(s) {
    var m = String(s || '').match(/(?:第|ep|EP|E)\s*(\d{1,4})/);
    if (m) return parseInt(m[1], 10);
    m = String(s || '').match(/\b(\d{1,4})\b/);
    return m ? parseInt(m[1], 10) : 0;
  }

  async function searchEpisodes(title) {
    var r = await signedGet('/api/v2/search/episodes', { anime: title });
    return (r && r.animes) || [];
  }

  async function fetchComments(episodeId) {
    var r = await signedGet('/api/v2/comment/' + episodeId, {
      withRelated: 'true',
      chConvert: '1'
    });
    var list = (r && (r.comments || r.comment)) || [];
    return list.map(function (x) {
      var p = String(x.p || '0').split(',');
      return {
        t: parseFloat(p[0]) || 0,
        mode: parseInt(p[1], 10) || 1,
        size: parseInt(p[2], 10) || 25,
        color: parseInt(p[3], 10) || 0xFFFFFF,
        text: String(x.m || '')
      };
    }).filter(function (x) { return x.text; });
  }

  /* 组合：标题 + 集名 → 弹幕列表 */
  async function fetch(title, epName) {
    if (!hasCreds()) return [];
    if (!title) return [];

    var animes = await searchEpisodes(title);
    if (!animes.length) return [];

    var target = norm(title);
    var best = null, bestScore = -1;
    animes.forEach(function (a) {
      var an = norm(a.animeTitle);
      var score = 0;
      if (an === target) score = 100;
      else if (an.indexOf(target) >= 0 || target.indexOf(an) >= 0) score = 60;
      if (a.typeDescription && title.indexOf(a.typeDescription) >= 0) score += 10;
      if (score > bestScore) { bestScore = score; best = a; }
    });
    if (!best) best = animes[0];

    var eps = best.episodes || [];
    if (!eps.length) return [];

    var want = epNum(epName);
    var pick = null;
    if (want) {
      pick = eps.find(function (e) { return epNum(e.episodeTitle) === want; });
    }
    if (!pick) {
      var en = norm(epName);
      pick = eps.find(function (e) { return en && norm(e.episodeTitle) === en; });
    }
    if (!pick) pick = want ? (eps[want - 1] || eps[0]) : eps[0];

    return fetchComments(pick.episodeId);
  }

  g.DanmakuApi = {
    hasCreds: hasCreds,
    fetch: fetch,
    searchEpisodes: searchEpisodes,
    fetchComments: fetchComments,
    signature: signature,
    sha256b64: sha256b64
  };
})(window);
