/* UI 层 —— 路由 / 搜索 / 详情 / 播放 */
(function (g) {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var view = $('#view');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = 0;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2200);
  }

  function loading(on, txt) {
    var el = $('#loader');
    if (on) {
      $('#loaderText').textContent = txt || '加载中…';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function openDrawer(on) {
    $('#drawer').classList.toggle('open', on);
    $('#scrim').classList.toggle('hidden', !on);
  }

  function openPanel(title, html) {
    $('#spTitle').textContent = title;
    $('#spBody').innerHTML = html;
    $('#sidepanel').classList.add('open');
  }
  function closePanel() { $('#sidepanel').classList.remove('open'); }

  var App = {
    route: { tab: 'home' },
    current: null,      // 正在看的番剧
    chapters: null,     // 线路/分集
    play: { rule: null, item: null, road: 0, ep: 0, url: '' }
  };

  /* ============ 路由 ============ */
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var q = {};
    var parts = h.split('?');
    var path = parts[0];
    if (parts[1]) {
      parts[1].split('&').forEach(function (kv) {
        var p = kv.split('=');
        q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    }
    return { path: path || 'home', q: q };
  }

  function go(path, params) {
    var h = '#/' + path;
    if (params) {
      h += '?' + Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
    }
    location.hash = h;
  }

  async function router() {
    var r = parseHash();
    var p = r.path;
    setTab(p);
    window.scrollTo(0, 0);

    if (p === 'home') return renderHome();
    if (p === 'search') return renderSearch(r.q.kw || '');
    if (p === 'detail') return renderDetail(r.q);
    if (p === 'collect') return renderCollect();
    if (p === 'history') return renderHistory();
    if (p === 'rules') return renderRules();
    if (p === 'settings') return renderSettings();
    if (p === 'about') return renderAbout();
    renderHome();
  }

  function setTab(p) {
    var map = { home: 'home', search: 'home', detail: 'home', collect: 'collect', history: 'history', rules: 'rules', settings: '', about: '' };
    var t = map[p];
    document.querySelectorAll('#tabbar button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === t);
    });
  }

  /* ============ 首页 ============ */
  async function renderHome() {
    var c = Store.collect();
    var h = Store.history();
    view.innerHTML =
      '<div class="sec-title">最近观看 <span class="cnt">' + h.length + '</span></div>' +
      (h.length ? '<div class="grid" id="homeHist"></div>' : '<div class="empty">还没有观看记录</div>') +
      '<div class="sec-title">我的追番 <span class="cnt">' + c.length + '</span></div>' +
      (c.length ? '<div class="grid" id="homeCol"></div>' : '<div class="empty">还没有追番，搜索后点 ★ 收藏</div>');

    if (h.length) fill($('#homeHist'), h.slice(0, 6), 'history');
    if (c.length) fill($('#homeCol'), c.slice(0, 6), 'collect');
  }

  function cardHTML(item, kind) {
    var cover = item.cover ? '<img class="cover" loading="lazy" src="' + esc(NET.imageUrl(item.cover)) + '" alt="">' : '<div class="cover-ph">番</div>';
    return '<div class="card" data-kind="' + kind + '">' + cover +
      '<div class="meta"><div class="nm">' + esc(item.name) + '</div>' +
      '<div class="src">' + esc(item.rule || '') + '</div></div></div>';
  }

  function fill(container, items, kind) {
    container.innerHTML = items.map(function (x) { return cardHTML(x, kind); }).join('');
    container.querySelectorAll('.card').forEach(function (el, i) {
      el.addEventListener('click', function () {
        var it = items[i];
        if (kind === 'history' && it.epUrl) {
          App.current = { name: it.name, rule: it.rule, src: it.src, cover: it.cover };
          App.play.item = it;
          openStage();
          loadEpisodeByUrl(it.rule, it.epUrl, it.epName || '');
          return;
        }
        go('detail', { rule: it.rule, src: it.src, name: it.name, cover: it.cover || '' });
      });
    });
  }

  /* ============ 搜索 ============ */
  async function renderSearch(kw) {
    if (!kw) { renderHome(); return; }
    $('#kw').value = kw;

    var rules = Rules.enabledRules();
    view.innerHTML =
      '<div class="sec-title">搜索「' + esc(kw) + '」 <span class="cnt" id="scCnt">0 / ' + rules.length + ' 源</span></div>' +
      '<div id="scResults"></div>';

    var box = $('#scResults');
    var groups = [];
    var done = 0;

    var render = function () {
      if (!groups.length) {
        box.innerHTML = '<div class="empty">正在搜索…</div>';
        return;
      }
      var html = '';
      groups.forEach(function (gp, gi) {
        html += '<div class="sec-title">' + esc(gp.rule) +
          ' <span class="cnt">' + gp.items.length + '</span></div>';
        html += '<div class="grid">';
        gp.items.forEach(function (it, ii) {
          html += '<div class="card" data-gi="' + gi + '" data-ii="' + ii + '">' +
            '<div class="cover-ph">番</div>' +
            '<div class="meta"><div class="nm">' + esc(it.name) + '</div>' +
            '<div class="src">' + esc(gp.rule) + '</div></div></div>';
        });
        html += '</div>';
      });
      box.innerHTML = html;
      box.querySelectorAll('.card').forEach(function (el) {
        el.addEventListener('click', function () {
          var gp = groups[+el.dataset.gi], it = gp.items[+el.dataset.ii];
          go('detail', { rule: gp.rule, src: it.src, name: it.name, cover: '' });
        });
      });
    };

    render();

    await Source.searchAll(kw, function (r) {
      done++;
      $('#scCnt').textContent = done + ' / ' + rules.length + ' 源';
      if (r.ok && r.value && r.value.length) {
        groups.push({ rule: r.rule.name, ruleObj: r.rule, items: r.value });
        groups.sort(function (a, b) { return a.rule.localeCompare(b.rule); });
      }
      render();
    });

    if (!groups.length) {
      box.innerHTML = '<div class="empty">全部 ' + rules.length + ' 个源都没有结果。<br>' +
        '• 确认规则已启用<br>• 在设置里配置代理<br>• 源站可能已失效</div>';
    }
  }

  /* ============ 详情 ============ */
  async function renderDetail(q) {
    var rule = Rules.byName(q.rule);
    if (!rule) { view.innerHTML = '<div class="empty">规则不存在：' + esc(q.rule) + '</div>'; return; }

    App.current = { name: q.name || '', rule: q.rule, src: q.src || '', cover: q.cover || '' };

    view.innerHTML =
      '<div class="detail-head">' +
      (q.cover ? '<img src="' + esc(NET.imageUrl(q.cover)) + '" alt="">' : '<div class="cover-ph">番</div>') +
      '<div class="info"><h1>' + esc(q.name) + '</h1>' +
      '<div class="tagline"><span class="tag">' + esc(q.rule) + '</span></div>' +
      '<div class="btnrow"><button class="btn primary" id="btnPlay">开始播放</button>' +
      '<button class="btn" id="btnStar">★ 追番</button></div></div></div>' +
      '<div class="sec-title">选集</div><div id="chBox"><div class="empty">加载中…</div></div>';

    $('#btnStar').addEventListener('click', function () {
      var added = Store.toggleCollect({ name: q.name, rule: q.rule, src: q.src, cover: q.cover || '' });
      toast(added ? '已加入追番' : '已取消追番');
      this.classList.toggle('on', added);
    });
    $('#btnStar').classList.toggle('on', Store.isCollected({ rule: q.rule, src: q.src, name: q.name }));

    $('#btnPlay').addEventListener('click', function () {
      if (App.chapters && App.chapters.length) playEpisode(0, 0);
      else toast('还没有分集可播');
    });

    try {
      var roads = await Source.chapters(rule, q.src);
      if (!roads.length) throw new Error('没有解析到分集');
      App.chapters = roads;
      renderChapters();
    } catch (e) {
      $('#chBox').innerHTML = '<div class="empty">分集加载失败：' + esc(e.message) +
        '<br><span class="tiny">可在「规则」里换一个源，或检查代理设置</span></div>';
    }
  }

  function renderChapters() {
    var roads = App.chapters;
    var h = '<div class="chiprow" id="roadChips">' + roads.map(function (r, i) {
      return '<button class="chip' + (i === 0 ? ' on' : '') + '" data-road="' + i + '">' + esc(r.name) +
        ' <span class="tiny">' + r.episodes.length + '</span></button>';
    }).join('') + '</div><div class="epgrid" id="epGrid"></div>';
    $('#chBox').innerHTML = h;

    var curRoad = 0;
    function drawEp(ri) {
      curRoad = ri;
      var grid = $('#epGrid');
      grid.innerHTML = roads[ri].episodes.map(function (e, i) {
        return '<button data-ep="' + i + '">' + esc(e.name) + '</button>';
      }).join('');
      grid.querySelectorAll('button').forEach(function (b, i) {
        b.addEventListener('click', function () { playEpisode(ri, i); });
      });
    }
    drawEp(0);

    $('#roadChips').querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        $('#roadChips').querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on');
        drawEp(parseInt(c.dataset.road, 10));
      });
    });
  }

  /* ============ 播放 ============ */
  function playEpisode(roadIdx, epIdx) {
    var road = App.chapters[roadIdx];
    var ep = road.episodes[epIdx];
    App.play.road = roadIdx;
    App.play.ep = epIdx;
    App.play.rule = App.current.rule;
    App.play.epName = ep.name;
    App.play.epUrl = ep.url;
    openStage();
    loadEpisodeByUrl(App.current.rule, ep.url, ep.name);
  }

  function openStage() {
    $('#stage').classList.remove('hidden');
    $('#stageTitle').textContent = App.current.name || '';
    document.body.style.overflow = 'hidden';
  }

  function closeStage() {
    $('#stage').classList.add('hidden');
    document.body.style.overflow = '';
    Player.destroy();
    if (Player.danmaku) { Player.danmaku.stop(); Player.danmaku.clear(); }
  }

  function stageMsg(html) {
    var el = $('#stageMsg');
    if (!html) { el.classList.remove('show'); return; }
    el.innerHTML = html;
    el.classList.add('show');
  }

  async function loadEpisodeByUrl(ruleName, epUrl, epName) {
    var rule = Rules.byName(ruleName);
    if (!rule) { stageMsg('规则不存在'); return; }

    stageMsg('正在解析播放地址…');
    var video = $('#video');
    $('#videoWrap').querySelector('#danmakuLayer').style.display = '';

    try {
      var info = await Source.playUrl(rule, epUrl);
      if (!info || !info.url) throw new Error('未找到播放地址');

      var ref = rule.referer || rule.baseURL;
      var media = NET.mediaUrl(info.url, ref, info.format);
      var fallback = (info.format === 'hls') ? '' : NET.mediaProxyUrl(info.url, ref);
      var s = Store.settings();

      var dan = Player.attachDanmaku(video, $('#danmakuLayer'), {
        on: s.danmakuOn, opacity: s.danmakuOpacity,
        duration: s.danmakuSpeed, fontSize: s.danmakuFontSize, area: s.danmakuArea
      });
      dan.setData([]);
      dan.start();

      await Player.load(video, media, info.format, {
        onError: function (m) { toast(m, 3000); },
        fallbackUrl: fallback
      });

      stageMsg('');
      video.play().catch(function () { });

      /* 弹幕异步加载，不阻塞播放 */
      loadDanmaku(ruleName, App.current.name, epName, epUrl);

      Store.pushHistory({
        name: App.current.name, rule: ruleName, src: App.current.src,
        cover: App.current.cover, ep: App.play.ep,
        epName: epName, epUrl: epUrl
      });

      renderEpBar();
      toast('已就绪（' + (info.format || 'auto') + '）');
    } catch (e) {
      stageMsg('<div>解析失败</div><div class="tiny">' + esc(e.message) + '</div>' +
        '<div class="btnrow"><button class="btn primary" id="retryBtn">重试</button>' +
        '<button class="btn" id="altBtn">换个源</button></div>');
      var rb = $('#retryBtn');
      if (rb) rb.addEventListener('click', function () { loadEpisodeByUrl(ruleName, epUrl, epName); });
      var ab = $('#altBtn');
      if (ab) ab.addEventListener('click', function () { closeStage(); toast('请在详情页切换线路'); });
    }
  }

  function renderEpBar() {
    var road = App.chapters && App.chapters[App.play.road];
    if (!road) return;
    $('#epBar').innerHTML = road.episodes.map(function (e, i) {
      return '<button class="' + (i === App.play.ep ? 'on' : '') + '" data-ep="' + i + '">' + esc(e.name) + '</button>';
    }).join('');
    $('#epBar').querySelectorAll('button').forEach(function (b, i) {
      b.addEventListener('click', function () { playEpisode(App.play.road, i); });
      if (i === App.play.ep) {
        setTimeout(function () { b.scrollIntoView({ inline: 'center', block: 'nearest' }); }, 60);
      }
    });
  }

  async function loadDanmaku(ruleName, title, epName, epUrl) {
    try {
      /* 优先本地缓存 */
      var key = ruleName + '|' + title + '|' + epName;
      var cached = Store.danmakuCache(key);
      if (cached) { Player.danmaku.setData(cached); return; }

      var list = await DanmakuApi.fetch(title, epName);
      if (list && list.length) {
        Player.danmaku.setData(list);
        Store.setDanmakuCache(key, list);
        toast('弹幕 ' + list.length + ' 条');
      }
    } catch (e) { /* 弹幕失败不影响播放 */ }
  }

  /* 导出给其它模块使用 */
  App.go = go;
  App.toast = toast;
  App.loading = loading;
  App.openDrawer = openDrawer;
  App.openPanel = openPanel;
  App.closePanel = closePanel;
  App.esc = esc;
  App.view = view;
  App.closeStage = closeStage;
  App.loadEpisodeByUrl = loadEpisodeByUrl;
  App.router = router;
  App.$ = $;
  g.App = App;

  /* ============ 启动 ============ */
  async function boot() {
    await Rules.load();
    /* 站点与代理同域时（Cloudflare Pages）自动启用 /proxy，无需用户配置 */
    try { await NET.probeSameOrigin(); } catch (e) { }

    $('#btnSearch').addEventListener('click', function () {
      var kw = $('#kw').value.trim();
      if (kw) go('search', { kw: kw });
    });
    $('#kw').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btnSearch').click(); }
    });
    $('#btnMenu').addEventListener('click', function () { openDrawer(true); });
    $('#btnCloseDrawer').addEventListener('click', function () { openDrawer(false); });
    $('#scrim').addEventListener('click', function () { openDrawer(false); });
    $('#spClose').addEventListener('click', closePanel);
    $('#stageBack').addEventListener('click', closeStage);
    $('#stageInfo').addEventListener('click', function () {
      if (!App.chapters) { toast('暂无分集信息'); return; }
      openPanel('切换线路', App.chapters.map(function (r, i) {
        return '<div class="row" data-road="' + i + '"><div class="bd"><div class="t1">' + esc(r.name) +
          '</div><div class="t2">' + r.episodes.length + ' 集</div></div></div>';
      }).join(''));
      $('#spBody').querySelectorAll('.row').forEach(function (row) {
        row.addEventListener('click', function () {
          var ri = parseInt(row.dataset.road, 10);
          closePanel();
          if (App.play.road === ri) return;
          playEpisode(ri, 0);
        });
      });
    });

    document.querySelectorAll('#tabbar button').forEach(function (b) {
      b.addEventListener('click', function () { go(b.dataset.tab); });
    });
    document.querySelectorAll('#drawerNav a').forEach(function (a) {
      a.addEventListener('click', function () { openDrawer(false); go(a.dataset.tab); });
    });

    window.addEventListener('hashchange', router);
    if (!location.hash) location.hash = '#/home';
    await router();
  }

  document.addEventListener('DOMContentLoaded', boot);

  /* 暴露给 app2（追番/历史/规则/设置）挂载 */
  /* ============ 追番 ============ */
  function renderCollect() {
    var c = Store.collect();
    if (!c.length) {
      view.innerHTML = '<div class="empty">还没有追番<br><span class="tiny">搜索后点 ★ 收藏</span></div>';
      return;
    }
    view.innerHTML = '<div class="sec-title">追番列表 <span class="cnt">' + c.length +
      '</span></div><div class="grid" id="colGrid"></div>';
    fill($('#colGrid'), c, 'collect');
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 2592000000) return Math.floor(d / 86400000) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  /* ============ 历史 ============ */
  function renderHistory() {
    var h = Store.history();
    view.innerHTML = '<div class="sec-title">观看历史 <span class="cnt">' + h.length + '</span></div>' +
      (h.length
        ? '<div class="btnrow" style="margin-bottom:10px">' +
          '<button class="btn sm danger" id="clrHis">清空</button>' +
          '<button class="btn sm" id="expHis">导出 JSON</button></div><div id="hisList"></div>'
        : '<div class="empty">还没有观看记录</div>');
    if (!h.length) return;

    var box = $('#hisList');
    box.innerHTML = h.map(function (x, i) {
      return '<div class="row" data-i="' + i + '"><div class="ic">▶</div>' +
        '<div class="bd"><div class="t1">' + esc(x.name) + '</div>' +
        '<div class="t2">' + esc(x.rule) + (x.epName ? ' · ' + esc(x.epName) : '') + '</div></div>' +
        '<div class="rt">' + fmtTime(x.ts) + '</div></div>';
    }).join('');

    box.querySelectorAll('.row').forEach(function (el) {
      el.addEventListener('click', function () {
        var it = h[+el.dataset.i];
        if (!it.epUrl) { go('detail', { rule: it.rule, src: it.src, name: it.name }); return; }
        App.current = { name: it.name, rule: it.rule, src: it.src, cover: it.cover || '' };
        App.play.epName = it.epName || '';
        App.play.epUrl = it.epUrl;
        App.chapters = null;
        openStage();
        $('#stageTitle').textContent = it.name;
        loadEpisodeByUrl(it.rule, it.epUrl, it.epName || '');
      });
    });

    $('#clrHis').addEventListener('click', function () {
      if (confirm('确定清空全部观看历史？')) { Store.clearHistory(); renderHistory(); }
    });
    $('#expHis').addEventListener('click', function () {
      download('kazumi-history.json', JSON.stringify(h, null, 2));
    });
  }

  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* ============ 规则管理 ============ */
  var rulesFilter = '';

  function renderRules() {
    var all = Rules.all();
    var alive = all.filter(function (r) { return !r.deprecated; });
    var dead = all.filter(function (r) { return r.deprecated; });
    var enCount = Rules.enabledRules().length;

    view.innerHTML =
      '<div class="sec-title">规则管理 <span class="cnt">' + enCount + ' / ' + all.length + ' 启用</span></div>' +
      '<div class="btnrow" style="margin-bottom:10px">' +
      '<button class="btn sm primary" id="rAllOn">全部启用</button>' +
      '<button class="btn sm" id="rAlive">只启用存活(' + alive.length + ')</button>' +
      '<button class="btn sm" id="rAllOff">全部禁用</button>' +
      '</div>' +
      '<div class="btnrow" style="margin-bottom:10px">' +
      '<button class="btn sm" id="rImport">导入规则</button>' +
      '<button class="btn sm" id="rSync">从 GitHub 同步</button>' +
      '<button class="btn sm" id="rAdd">新建规则</button>' +
      '</div>' +
      '<div class="field"><input id="rFilter" placeholder="过滤规则名…" value="' + esc(rulesFilter) + '"></div>' +
      '<div id="rList"></div>';

    function drawList() {
      var f = rulesFilter.toLowerCase();
      var show = all.filter(function (r) { return !f || r.name.toLowerCase().indexOf(f) >= 0; });
      show.sort(function (a, b) {
        if (!!a.deprecated !== !!b.deprecated) return a.deprecated ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      $('#rList').innerHTML = show.map(function (r) {
        var on = Rules.isEnabled(r.name);
        var src = r.searchMode === 'api' ? 'API' : 'XPath';
        return '<div class="row" data-name="' + esc(r.name) + '">' +
          '<div class="ic">' + (r.deprecated ? '✗' : '✓') + '</div>' +
          '<div class="bd"><div class="t1">' + esc(r.name) + ' <span class="tiny">v' + esc(r.version) + '</span></div>' +
          '<div class="t2">api ' + esc(r.api) + ' · ' + src +
          (r.deprecated ? ' · <span style="color:var(--err)">已弃用</span>' : '') +
          (r._builtin ? '' : ' · 自定义') + '</div></div>' +
          '<div class="tg' + (on ? ' on' : '') + '" data-tg="' + esc(r.name) + '"></div></div>';
      }).join('');

      $('#rList').querySelectorAll('.row').forEach(function (row) {
        var nm = row.dataset.name;
        row.querySelector('.t1').addEventListener('click', function () { openRuleEditor(nm); });
        row.querySelector('.t2').addEventListener('click', function () { openRuleEditor(nm); });
        row.querySelector('.tg').addEventListener('click', function (e) {
          e.stopPropagation();
          var on = !Rules.isEnabled(nm);
          Rules.setEnabled(nm, on);
          this.classList.toggle('on', on);
          refreshCount();
        });
      });
    }

    function refreshCount() {
      var c = Rules.enabledRules().length;
      view.querySelector('.sec-title .cnt').textContent = c + ' / ' + all.length + ' 启用';
    }

    drawList();

    $('#rFilter').addEventListener('input', function () { rulesFilter = this.value.trim(); drawList(); });
    $('#rAllOn').addEventListener('click', function () { Rules.setEnabledAll(true); drawList(); refreshCount(); });
    $('#rAllOff').addEventListener('click', function () { Rules.setEnabledAll(false); drawList(); refreshCount(); });
    $('#rAlive').addEventListener('click', function () {
      Rules.setEnabledAll(false);
      alive.forEach(function (r) { Rules.setEnabled(r.name, true); });
      drawList(); refreshCount();
      toast('已启用 ' + alive.length + ' 条存活规则');
    });

    $('#rImport').addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = function () {
        var f = inp.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var data = JSON.parse(fr.result);
            var list = Array.isArray(data) ? data : [data];
            var ok = 0, errs = [];
            list.forEach(function (r) {
              var e = Rules.validate(r);
              if (e.length) { errs.push((r.name || '未命名') + ': ' + e.join('、')); return; }
              Rules.upsert(r);
              ok++;
            });
            toast('导入 ' + ok + ' 条' + (errs.length ? '，' + errs.length + ' 条失败' : ''));
            if (errs.length) console.warn(errs);
            renderRules();
          } catch (e) { toast('JSON 解析失败：' + e.message); }
        };
        fr.readAsText(f);
      };
      inp.click();
    });

    $('#rSync').addEventListener('click', async function () {
      loading(true, '正在从 GitHub 同步规则…');
      try {
        var rules = await Rules.syncFromRemote();
        var ok = 0;
        rules.forEach(function (r) {
          if (r && r.name && !Rules.validate(r).length) { Rules.upsert(r); ok++; }
        });
        loading(false);
        toast('同步完成，共 ' + ok + ' 条');
        renderRules();
      } catch (e) {
        loading(false);
        toast('同步失败：' + e.message, 3000);
      }
    });

    $('#rAdd').addEventListener('click', function () { openRuleEditor(null); });
  }

  function openRuleEditor(name) {
    var r = name ? Rules.byName(name) : Rules.normalize({ name: '', baseURL: '', searchURL: '', searchList: '', searchName: '', searchResult: '', chapterRoads: '', chapterResult: '' }, false);
    var isNew = !name;
    var fields = [
      ['name', '名称'], ['baseURL', 'baseURL'], ['searchURL', 'searchURL（用 @keyword 占位）'],
      ['searchList', 'searchList'], ['searchName', 'searchName'], ['searchResult', 'searchResult'],
      ['chapterRoads', 'chapterRoads'], ['chapterResult', 'chapterResult'], ['referer', 'referer'],
      ['userAgent', 'userAgent']
    ];
    openPanel(isNew ? '新建规则' : '编辑规则 ' + name,
      fields.map(function (f) {
        var v = r[f[0]] || '';
        var big = ['searchList', 'searchName', 'searchResult', 'chapterRoads', 'chapterResult'].indexOf(f[0]) >= 0;
        return '<div class="field"><label>' + f[1] + '</label>' +
          (big ? '<textarea data-k="' + f[0] + '">' + esc(v) + '</textarea>'
            : '<input data-k="' + f[0] + '" value="' + esc(v) + '">') + '</div>';
      }).join('') +
      '<div class="btnrow"><button class="btn primary" id="rSave">保存</button>' +
      (isNew ? '' : '<button class="btn danger" id="rDel">删除</button>') +
      '<button class="btn ghost" id="rTest">测试搜索</button></div>' +
      '<div id="rTestOut" class="tiny" style="margin-top:10px"></div>');

    $('#rSave').addEventListener('click', function () {
      var obj = Rules.exportRule(r);
      panelfields().forEach(function (el) { obj[el.dataset.k] = el.value.trim(); });
      var errs = Rules.validate(obj);
      if (errs.length) { toast('校验失败：' + errs.join('、'), 3000); return; }
      Rules.upsert(obj);
      Rules.setEnabled(obj.name, true);
      closePanel();
      toast('已保存 ' + obj.name);
      renderRules();
    });

    if (!isNew) {
      $('#rDel').addEventListener('click', function () {
        if (!confirm('删除规则 ' + name + '？')) return;
        Rules.remove(name);
        closePanel();
        renderRules();
        toast('已删除');
      });
    }

    $('#rTest').addEventListener('click', async function () {
      var obj = Rules.exportRule(r);
      panelfields().forEach(function (el) { obj[el.dataset.k] = el.value.trim(); });
      obj.searchMode = obj.searchMode || 'xpath';
      var kw = prompt('测试关键词：', '巨人');
      if (!kw) return;
      $('#rTestOut').textContent = '测试中…';
      try {
        var list = await Source.search(Rules.normalize(obj, false), kw);
        $('#rTestOut').innerHTML = '命中 <b>' + list.length + '</b> 条<br>' +
          list.slice(0, 5).map(function (x) { return esc(x.name) + '<br><span style="color:var(--fg3)">' + esc(x.src) + '</span>'; }).join('<br>');
      } catch (e) {
        $('#rTestOut').innerHTML = '<span style="color:var(--err)">失败：' + esc(e.message) + '</span>';
      }
    });

    function panelfields() {
      return Array.prototype.slice.call($('#spBody').querySelectorAll('[data-k]'));
    }
  }

  /* ============ 设置 ============ */
  function renderSettings() {
    var s = Store.settings();
    var net = NET.cfg;

    view.innerHTML =
      '<div class="sec-title">网络</div>' +
      '<div class="field"><label>代理地址（自建 Cloudflare Worker，强烈推荐）</label>' +
      '<input id="stProxy" value="' + esc(net.proxy || '') + '" placeholder="https://xxx.workers.dev"></div>' +
      '<div class="hint" style="margin:-6px 0 12px">留空则只用公共代理抓页面，<b>视频将无法播放</b>。部署方法见「关于」。</div>' +
      '<div class="switch"><div><div class="lbl">公共代理兜底</div>' +
      '<div class="sub">无自建代理时，用公共 CORS 代理抓页面（慢且不稳定）</div></div>' +
      '<div class="tg' + (net.publicFallback ? ' on' : '') + '" data-net="publicFallback"></div></div>' +
      '<div class="switch"><div><div class="lbl">优先直连</div>' +
      '<div class="sub">先尝试不经代理直接请求</div></div>' +
      '<div class="tg' + (net.directFirst ? ' on' : '') + '" data-net="directFirst"></div></div>' +
      '<div class="field" style="margin-top:12px"><label>搜索并发数</label>' +
      '<input id="stConc" type="number" min="1" max="8" value="' + s.concurrency + '"></div>' +

      '<div class="sec-title">弹幕</div>' +
      '<div class="hint" style="margin:-4px 0 10px">弹幕来自 dandanplay，需自行申请 AppId/Secret（免费）。留空则不加载弹幕。</div>' +
      '<div class="field"><label>Dandanplay AppId</label><input id="stDmId" value="' + esc(s.dandanId || '') + '"></div>' +
      '<div class="field"><label>Dandanplay AppSecret</label><input id="stDmSec" type="password" value="' + esc(s.dandanSecret || '') + '"></div>' +
      '<div class="switch"><div><div class="lbl">开启弹幕</div></div>' +
      '<div class="tg' + (s.danmakuOn ? ' on' : '') + '" data-set="danmakuOn"></div></div>' +
      '<div class="field" style="margin-top:10px"><label>透明度 <span id="lbOp">' + s.danmakuOpacity + '</span></label>' +
      '<input id="stOp" type="range" min="0.1" max="1" step="0.05" value="' + s.danmakuOpacity + '"></div>' +
      '<div class="field"><label>滚动时长（秒/屏）<span id="lbSp">' + s.danmakuSpeed + '</span></label>' +
      '<input id="stSp" type="range" min="4" max="16" step="1" value="' + s.danmakuSpeed + '"></div>' +
      '<div class="field"><label>字号 <span id="lbFs">' + s.danmakuFontSize + '</span></label>' +
      '<input id="stFs" type="range" min="10" max="28" step="1" value="' + s.danmakuFontSize + '"></div>' +

      '<div class="sec-title">数据</div>' +
      '<div class="btnrow">' +
      '<button class="btn sm" id="stExport">导出全部数据</button>' +
      '<button class="btn sm" id="stImport">导入数据</button>' +
      '<button class="btn sm danger" id="stReset">恢复默认</button>' +
      '</div>' +
      '<div class="btnrow" style="margin-top:10px">' +
      '<button class="btn sm primary" id="stSave">保存设置</button></div>';

    /* 开关 */
    view.querySelectorAll('[data-set]').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.dataset.set;
        var cur = Store.settings()[k];
        var p = {}; p[k] = !cur;
        Store.patchSettings(p);
        el.classList.toggle('on', !cur);
      });
    });
    view.querySelectorAll('[data-net]').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.dataset.net;
        NET.cfg[k] = !NET.cfg[k];
        NET.save();
        el.classList.toggle('on', NET.cfg[k]);
      });
    });

    $('#stOp').addEventListener('input', function () {
      $('#lbOp').textContent = this.value;
      Store.patchSettings({ danmakuOpacity: parseFloat(this.value) });
      if (Player.danmaku) Player.danmaku.setOption({ opacity: parseFloat(this.value) });
    });
    $('#stSp').addEventListener('input', function () {
      $('#lbSp').textContent = this.value;
      Store.patchSettings({ danmakuSpeed: parseInt(this.value, 10) });
      if (Player.danmaku) Player.danmaku.setOption({ duration: parseInt(this.value, 10) });
    });
    $('#stFs').addEventListener('input', function () {
      $('#lbFs').textContent = this.value;
      Store.patchSettings({ danmakuFontSize: parseInt(this.value, 10) });
      if (Player.danmaku) Player.danmaku.setOption({ fontSize: parseInt(this.value, 10) });
    });

    $('#stSave').addEventListener('click', function () {
      NET.cfg.proxy = $('#stProxy').value.trim();
      NET.save();
      Store.patchSettings({
        concurrency: Math.max(1, Math.min(8, parseInt($('#stConc').value, 10) || 4)),
        dandanId: $('#stDmId').value.trim(),
        dandanSecret: $('#stDmSec').value.trim()
      });
      toast('设置已保存');
    });

    $('#stExport').addEventListener('click', function () {
      download('kazumi-backup.json', JSON.stringify(Store.exportAll(), null, 2));
    });
    $('#stImport').addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = function () {
        var f = inp.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            Store.importAll(JSON.parse(fr.result));
            toast('导入成功，正在重载');
            setTimeout(function () { location.reload(); }, 800);
          } catch (e) { toast('导入失败：' + e.message); }
        };
        fr.readAsText(f);
      };
      inp.click();
    });
    $('#stReset').addEventListener('click', function () {
      if (!confirm('恢复默认设置？规则与追番不受影响。')) return;
      Store.patchSettings(Store.DEFAULT_SETTINGS);
      toast('已恢复默认');
      renderSettings();
    });
  }

  /* ============ 关于 ============ */
  function renderAbout() {
    view.innerHTML =
      '<div class="sec-title">关于</div>' +
      '<div class="row"><div class="bd"><div class="t1">Kazumi Web</div>' +
      '<div class="t2">规则的网页版实现 · 纯静态可部署到 GitHub Pages</div></div></div>' +
      '<div class="sec-title">必须自建代理</div>' +
      '<div class="small" style="line-height:1.9">' +
      '浏览器同源策略会拦掉所有源站请求，公共 CORS 代理实测全部失效（522 超时 / 401 / 已停止服务）。' +
      '视频能被 <code>&lt;video&gt;</code> 直连播放，但<b>搜索和分集列表必须走代理</b>。<br><br>' +
      '<b>Cloudflare Workers（推荐，免费 10 万次/天）</b><br>' +
      '1. 打开 <a href="https://dash.cloudflare.com/sign-up" target="_blank">dash.cloudflare.com/sign-up</a> 注册，去邮箱验证<br>' +
      '2. 左侧栏 → <code>Workers &amp; Pages</code>（新版在 Compute 下）<br>' +
      '3. <code>Create</code> → <code>Create Worker</code> → 命名 <code>kazumi-proxy</code> → <code>Deploy</code><br>' +
      '4. 点 <code>Edit code</code>，清空编辑器，粘贴 ' +
      '<a href="https://ws200822.github.io/kazumi-web/proxy/worker.js" target="_blank">worker.js 全文</a>' +
      ' → <code>Deploy</code><br>' +
      '5. 复制 <code>https://kazumi-proxy.xxx.workers.dev</code> 地址<br>' +
      '6. 回到「设置」填入并保存<br><br>' +
      '<b>验证</b>：浏览器打开 <code>你的地址/</code>（带末尾斜杠）应返回 <code>{"ok":true}</code>；<br>' +
      '再打开 <code>你的地址/?url=https%3A%2F%2Fwww.7sefun.top%2F</code> 应返回一大段 HTML。<br><br>' +
      '<b>⚠ 坑</b>：<code>workers.dev</code> 在国内部分网络被阻断，部署成功 ≠ 能访问。' +
      '用手机流量测一下，不通就改用 <a href="https://dash.deno.com" target="_blank">Deno Deploy</a>' +
      '（用仓库里的 <code>proxy/deno.ts</code>），或绑自己的域名。详见仓库 <code>DEPLOY.md</code>。' +
      '</div>' +
      '<div class="sec-title">数据来源</div>' +
      '<div class="small muted">规则来自 <a href="https://github.com/Predidit/KazumiRules" target="_blank">Predidit/KazumiRules</a>（MIT）<br>' +
      '本项目与其无关联，仅做规则的浏览器端实现</div>' +
      '<div class="sec-title">当前状态</div>' +
      '<div id="abStat" class="small"></div>';

    var s = Store.settings();
    $('#abStat').innerHTML =
      '代理：' + (NET.cfg.proxy ? '<span style="color:var(--ok)">已配置</span>' : '<span style="color:var(--err)">未配置</span>') + '<br>' +
      '规则：' + Rules.enabledRules().length + ' / ' + Rules.all().length + ' 启用<br>' +
      '追番：' + Store.collect().length + ' · 历史：' + Store.history().length + '<br>' +
      '弹幕凭据：' + (s.dandanId && s.dandanSecret ? '<span style="color:var(--ok)">已配置</span>' : '未配置') + '<br>' +
      'hls.js：' + (window.Hls ? '已加载' : '按需加载');
  }

  g.__appCore = {
    App: App, esc: esc, toast: toast, loading: loading, go: go,
    openPanel: openPanel, closePanel: closePanel, cardHTML: cardHTML, fill: fill,
    playEpisode: playEpisode, loadEpisodeByUrl: loadEpisodeByUrl,
    stageMsg: stageMsg, bootDone: function () { }
  };
})(window);
