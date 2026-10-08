/* 播放器 —— HLS / MP4 + 弹幕挂载
 * iOS Safari 原生支持 HLS，直接给 video.src 即可；
 * 其余浏览器走 hls.js。媒体一律经自建代理转发，以带上 Referer/UA 并透传 Range。
 */
(function (g) {
  'use strict';

  var HLS_CDNS = [
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
    'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js'
  ];

  var P = {
    video: null,
    hls: null,
    dan: null,
    _loadingHls: null
  };

  function loadHlsLib() {
    if (g.Hls) return Promise.resolve(g.Hls);
    if (P._loadingHls) return P._loadingHls;
    P._loadingHls = new Promise(function (resolve, reject) {
      var i = 0;
      (function tryNext() {
        if (i >= HLS_CDNS.length) return reject(new Error('hls.js 加载失败'));
        var s = document.createElement('script');
        s.src = HLS_CDNS[i++];
        s.onload = function () { g.Hls ? resolve(g.Hls) : tryNext(); };
        s.onerror = tryNext;
        document.head.appendChild(s);
      })();
    });
    return P._loadingHls;
  }

  function nativeHls(video) {
    return !!video.canPlayType('application/vnd.apple.mpegurl');
  }

  function destroy() {
    if (P.hls) {
      try { P.hls.destroy(); } catch (e) { /* ignore */ }
      P.hls = null;
    }
    if (P.video) {
      P.video.removeAttribute('src');
      try { P.video.load(); } catch (e) { /* ignore */ }
    }
  }

  /* 绑定弹幕引擎 */
  function attachDanmaku(video, layer, opts) {
    if (!P.dan) P.dan = Danmaku.create(video, layer, opts || {});
    else P.dan.setOption(opts || {});
    return P.dan;
  }

  /* 加载并播放 */
  async function load(video, url, format, opt) {
    opt = opt || {};
    P.video = video;

    var isHls = format === 'hls' || /\.m3u8(\?|#|$)/i.test(url);
    var native = nativeHls(video);

    if (P.hls) { try { P.hls.destroy(); } catch (e) { } P.hls = null; }
    video.removeAttribute('src');

    var errEl = opt.onError || function () { };

    if (isHls && !native) {
      var Hls;
      try { Hls = await loadHlsLib(); }
      catch (e) { errEl('hls.js 加载失败，请检查网络'); throw e; }

      if (Hls.isSupported()) {
        var h = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 90,
          enableWorker: true,
          lowLatencyMode: false,
          xhrSetup: function (xhr) { xhr.withCredentials = false; }
        });
        P.hls = h;
        h.on(Hls.Events.ERROR, function (evt, data) {
          if (!data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            errEl('网络错误，正在重试…');
            setTimeout(function () { try { h.startLoad(); } catch (e) { } }, 1200);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            errEl('媒体错误，正在恢复…');
            try { h.recoverMediaError(); } catch (e) { }
          } else {
            errEl('播放失败：' + (data.details || '未知错误'));
            try { h.destroy(); } catch (e) { }
            P.hls = null;
          }
        });
        h.loadSource(url);
        h.attachMedia(video);
        return 'hlsjs';
      }
    }

    /* 原生播放（iOS HLS / mp4 / flv 交给浏览器）
     * MP4 直连若被防盗链拦截，自动回退到代理 URL 重试一次。 */
    video.src = url;

    if (opt.fallbackUrl && opt.fallbackUrl !== url) {
      video.onerror = function () {
        if (this.src === opt.fallbackUrl) return;
        this.onerror = null;
        this.src = opt.fallbackUrl;
        try { this.load(); } catch (e) { }
        this.play().catch(function () { });
      };
    }

    if (opt.startTime) {
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        try { video.currentTime = opt.startTime; } catch (e) { }
      });
    }
    return native && isHls ? 'native-hls' : 'native';
  }

  async function play(video) {
    try { await video.play(); }
    catch (e) {
      /* iOS 需要用户手势，静默忽略，由用户点播放按钮触发 */
    }
  }

  g.Player = {
    load: load,
    play: play,
    destroy: destroy,
    attachDanmaku: attachDanmaku,
    get danmaku() { return P.dan; },
    get hls() { return P.hls; },
    loadHlsLib: loadHlsLib
  };
})(window);
