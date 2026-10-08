/* 弹幕引擎 —— 解析 + 渲染
 * 支持格式：B站/Dandanplay 的 XML、JSON 数组、以及本地导入
 * 渲染：滚动弹幕（rtl）为主，顶部/底部固定弹幕为次
 */
(function (g) {
  'use strict';

  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 解析 XML 弹幕：<d p="时间,模式,字号,颜色,时间戳,池,用户,行ID">文本</d> */
  function parseXml(text) {
    var out = [];
    var re = /<d\s+p=["']([^"']*)["'][^>]*>([\s\S]*?)<\/d>/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var parts = m[1].split(',');
      var t = parseFloat(parts[0]);
      if (!isFinite(t)) continue;
      out.push({
        t: t,
        mode: parseInt(parts[1], 10) || 1,   // 1/2/3 滚动，4 底部，5 顶部
        size: parseInt(parts[2], 10) || 25,
        color: parseInt(parts[3], 10) || 0xFFFFFF,
        text: decodeEntities(m[2])
      });
    }
    return out;
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* 解析 JSON 弹幕（Dandanplay / 自定义） */
  function parseJson(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return []; }
    var arr = [];
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.comments)) arr = data.comments;
    else if (data && Array.isArray(data.danmakus)) arr = data.danmakus;
    else if (data && Array.isArray(data.data)) arr = data.data;

    return arr.map(function (x) {
      if (typeof x === 'string') {
        var p = x.split(',');
        return { t: parseFloat(p[0]) || 0, mode: 1, size: 25, color: 0xFFFFFF, text: p.slice(4).join(',') };
      }
      /* Dandanplay 格式：p="时间,模式,字号,颜色,..."  m=文本 */
      if (x.p != null && x.m != null) {
        var pp = String(x.p).split(',');
        return {
          t: parseFloat(pp[0]) || 0,
          mode: parseInt(pp[1], 10) || 1,
          size: parseInt(pp[2], 10) || 25,
          color: parseInt(pp[3], 10) || 0xFFFFFF,
          text: String(x.m)
        };
      }
      return {
        t: parseFloat(x.t != null ? x.t : (x.time != null ? x.time : 0)) || 0,
        mode: parseInt(x.mode != null ? x.mode : (x.type || 1), 10) || 1,
        size: parseInt(x.size || x.fontSize || 25, 10) || 25,
        color: parseInt(x.color != null ? x.color : 0xFFFFFF, 10) || 0xFFFFFF,
        text: String(x.text != null ? x.text : (x.content || ''))
      };
    }).filter(function (x) { return x.text; });
  }

  function parse(text) {
    if (!text) return [];
    var s = String(text).trim();
    if (!s) return [];
    if (s.charAt(0) === '<') return parseXml(s);
    if (s.charAt(0) === '[' || s.charAt(0) === '{') return parseJson(s);
    /* 纯文本，每行一条：秒数,文本 */
    return s.split(/\r?\n/).map(function (line) {
      var i = line.indexOf(',');
      if (i < 0) return null;
      return { t: parseFloat(line.slice(0, i)), mode: 1, size: 25, color: 0xFFFFFF, text: line.slice(i + 1) };
    }).filter(function (x) { return x && isFinite(x.t) && x.text; });
  }

  /* ---------------- 渲染引擎 ---------------- */
  function Engine(video, layer, opts) {
    this.video = video;
    this.layer = layer;
    this.opt = Object.assign({
      on: true, opacity: 0.9, duration: 8, fontSize: 16, area: 0.4
    }, opts || {});
    this.items = [];
    this.cursor = 0;
    this.live = [];
    this._raf = 0;
    this._last = -1;
    this._tracks = [];
    this._lastKey = '';
  }

  Engine.prototype.setData = function (items) {
    this.items = (items || []).slice().sort(function (a, b) { return a.t - b.t; });
    this.cursor = 0;
    this.clear();
    this._last = -1;
  };

  Engine.prototype.setOption = function (o) {
    Object.assign(this.opt, o || {});
    this.layer.style.opacity = this.opt.on ? this.opt.opacity : 0;
    this.clear();
  };

  Engine.prototype.clear = function () {
    this.live.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    this.live = [];
    this._tracks = [];
  };

  Engine.prototype.start = function () {
    var self = this;
    this.layer.style.opacity = this.opt.on ? this.opt.opacity : 0;
    cancelAnimationFrame(this._raf);
    (function loop() {
      self._tick();
      self._raf = requestAnimationFrame(loop);
    })();
  };

  Engine.prototype.stop = function () {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  Engine.prototype._tick = function () {
    var v = this.video, t = v.currentTime || 0;

    /* 拖动进度 → 重置 */
    if (t < this._last - 1.5 || t > this._last + 3) {
      this.cursor = 0;
      this.clear();
      /* 重新定位游标 */
      while (this.cursor < this.items.length && this.items[this.cursor].t < t) this.cursor++;
    }
    this._last = t;

    /* 回收过期元素 */
    var now = performance.now();
    this.live = this.live.filter(function (o) {
      if (now - o.born > o.life) {
        if (o.el.parentNode) o.el.parentNode.removeChild(o.el);
        return false;
      }
      return true;
    });

    if (!this.opt.on) { this.cursor = Math.max(this.cursor, 0); return; }

    /* 发射 */
    var guard = 0;
    while (this.cursor < this.items.length && this.items[this.cursor].t <= t && guard++ < 60) {
      var d = this.items[this.cursor++];
      if (d.t >= t - 1.2) this._emit(d);
    }
  };

  Engine.prototype._emit = function (d) {
    var L = this.layer.clientWidth || 320;
    var el = document.createElement('div');
    el.className = 'dm';
    el.textContent = d.text;
    var color = '#' + ('000000' + (d.color >>> 0).toString(16)).slice(-6);
    el.style.color = color;
    el.style.fontSize = Math.round(this.opt.fontSize * (d.size / 25)) + 'px';

    var dur = this.opt.duration;
    var life = dur * 1000;

    if (d.mode === 4 || d.mode === 5) {
      /* 顶部/底部固定 */
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      el.style.top = (d.mode === 5 ? 6 : (this.layer.clientHeight - 40)) + 'px';
      el.style.opacity = '1';
      life = 4000;
      var self0 = this;
      setTimeout(function () {
        if (el.parentNode) { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; }
      }, life - 400);
    } else {
      /* 滚动：按轨道分配 */
      var trackH = Math.round(this.opt.fontSize * 1.5);
      var maxTracks = Math.max(1, Math.floor((this.layer.clientHeight * this.opt.area) / trackH));
      var tr = this._pickTrack(maxTracks, d.text.length, dur);
      el.style.top = (tr * trackH + 4) + 'px';
      el.style.left = L + 'px';

      var self = this;
      requestAnimationFrame(function () {
        var w = el.offsetWidth;
        el.style.transition = 'transform ' + dur + 's linear';
        el.style.transform = 'translateX(-' + (L + w + 20) + 'px)';
      });
    }

    this.layer.appendChild(el);
    this.live.push({ el: el, born: performance.now(), life: life });
  };

  /* 挑一条最空闲的轨道 */
  Engine.prototype._pickTrack = function (n, textLen, dur) {
    var now = performance.now();
    for (var i = 0; i < n; i++) {
      var last = this._tracks[i];
      if (!last || now - last > dur * 260) { this._tracks[i] = now; return i; }
    }
    var min = 0;
    for (var j = 1; j < n; j++) if ((this._tracks[j] || 0) < (this._tracks[min] || 0)) min = j;
    this._tracks[min] = now;
    return min;
  };

  g.Danmaku = {
    parse: parse,
    parseXml: parseXml,
    parseJson: parseJson,
    create: function (video, layer, opts) { return new Engine(video, layer, opts); }
  };
})(window);
