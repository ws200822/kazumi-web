/* 规则管理 —— 内置 bundle + 用户自定义覆盖 + 导入导出 */
(function (g) {
  'use strict';

  var R = {
    all: [],
    enabled: [],
    _ready: null
  };

  /* 相对地址补全（对齐 Kazumi 的 normalizeEpisodeUrl） */
  function abs(base, raw) {
    raw = (raw == null ? '' : String(raw)).trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.indexOf('//') === 0) return (/^http:/.test(base) ? 'http:' : 'https:') + raw;
    try { return new URL(raw, base).href; } catch (e) { return raw; }
  }

  async function load() {
    if (R._ready) return R._ready;
    R._ready = (async function () {
      var bundle = { rules: [] };
      try {
        var res = await fetch('rules/bundle.json', { cache: 'force-cache' });
        bundle = await res.json();
      } catch (e) {
        console.warn('内置规则加载失败', e);
      }
      R.bundle = bundle;

      var map = new Map();
      (bundle.rules || []).forEach(function (r) { map.set(r.name, normalize(r, true)); });
      (Store.customRules() || []).forEach(function (r) { map.set(r.name, normalize(r, false)); });
      R.all = Array.from(map.values());
      R.all.sort(function (a, b) {
        if (!!a.deprecated !== !!b.deprecated) return a.deprecated ? 1 : -1;
        return String(a.name).localeCompare(String(b.name));
      });

      var en = Store.enabledNames();
      if (!en) {
        en = R.all.filter(function (r) { return !r.deprecated; }).map(function (r) { return r.name; });
        Store.setEnabledNames(en);
      }
      R.enabled = en.filter(function (n) { return map.has(n); });
      return R.all;
    })();
    return R._ready;
  }

  /* 归一化：补默认值，兼容老规则 */
  function normalize(r, builtin) {
    r = Object.assign({}, r);
    r.api = String(r.api == null ? '1' : r.api);
    r.name = String(r.name || '').trim();
    r.version = String(r.version == null ? '' : r.version);
    r.baseURL = r.baseURL || r.baseUrl || '';
    r.userAgent = r.userAgent || '';
    r.referer = r.referer || r.baseURL || '';
    r.searchURL = r.searchURL || '';
    r.searchList = r.searchList || '';
    r.searchName = r.searchName || '';
    r.searchResult = r.searchResult || '';
    r.chapterRoads = r.chapterRoads || '';
    r.chapterResult = r.chapterResult || '';
    r.searchMode = (r.searchMode === 'api') ? 'api' : 'xpath';
    r.chapterMode = (r.chapterMode === 'api') ? 'api' : 'xpath';
    r.usePost = !!r.usePost;
    r._builtin = !!builtin;
    r._id = r.name;
    return r;
  }

  /* 启用的规则，按用户设定的优先顺序返回 */
  function orderNames() {
    var saved = Store.sourceOrder() || [];
    var list = R.enabled.slice();
    list.sort(function (a, b) {
      var ia = saved.indexOf(a), ib = saved.indexOf(b);
      if (ia < 0 && ib < 0) return 0;
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    return list;
  }

  function enabledRules() {
    var byName = {};
    R.all.forEach(function (r) { byName[r.name] = r; });
    return orderNames().map(function (n) { return byName[n]; }).filter(Boolean);
  }

  /* 上移/下移一个源（dir = -1 / +1） */
  function moveSource(name, dir) {
    var list = orderNames();
    var i = list.indexOf(name);
    if (i < 0) return list;
    var j = i + dir;
    if (j < 0 || j >= list.length) return list;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    Store.setSourceOrder(list);
    return list;
  }

  function byName(name) {
    return R.all.find(function (r) { return r.name === name; }) || null;
  }

  function isEnabled(name) {
    return R.enabled.indexOf(name) >= 0;
  }

  function setEnabled(name, on) {
    var i = R.enabled.indexOf(name);
    if (on && i < 0) R.enabled.push(name);
    if (!on && i >= 0) R.enabled.splice(i, 1);
    Store.setEnabledNames(R.enabled);
    return R.enabled;
  }

  function setEnabledAll(on) {
    R.enabled = on ? R.all.map(function (r) { return r.name; }) : [];
    Store.setEnabledNames(R.enabled);
    return R.enabled;
  }

  /* 校验导入的规则对象 */
  function validate(r) {
    var errs = [];
    if (!r || typeof r !== 'object') return ['不是合法的 JSON 对象'];
    if (!r.name) errs.push('缺少 name');
    if (!r.baseURL && !r.baseUrl) errs.push('缺少 baseURL');
    var xpathMode = (r.searchMode !== 'api');
    if (xpathMode) {
      if (!r.searchURL) errs.push('缺少 searchURL');
      if (!r.searchList) errs.push('缺少 searchList');
      if (!r.searchName) errs.push('缺少 searchName');
      if (!r.searchResult) errs.push('缺少 searchResult');
      if (!r.chapterRoads) errs.push('缺少 chapterRoads');
      if (!r.chapterResult) errs.push('缺少 chapterResult');
    }
    return errs;
  }

  /* 保存用户规则（覆盖内置同名规则） */
  function upsert(ruleObj) {
    var list = Store.customRules();
    var i = list.findIndex(function (x) { return x.name === ruleObj.name; });
    if (i >= 0) list[i] = ruleObj; else list.push(ruleObj);
    Store.setCustomRules(list);

    var idx = R.all.findIndex(function (x) { return x.name === ruleObj.name; });
    var nr = normalize(ruleObj, false);
    if (idx >= 0) R.all[idx] = nr; else R.all.push(nr);
    return nr;
  }

  function remove(name) {
    var list = Store.customRules().filter(function (x) { return x.name !== name; });
    Store.setCustomRules(list);
    R.all = R.all.filter(function (x) { return x.name !== name; });
    setEnabled(name, false);
  }

  /* 导出单条规则（去掉内部字段） */
  function exportRule(r) {
    var o = {};
    ['api', 'type', 'name', 'version', 'muliSources', 'useWebview', 'useNativePlayer',
      'usePost', 'useLegacyParser', 'adBlocker', 'userAgent', 'baseURL', 'searchURL',
      'searchList', 'searchName', 'searchResult', 'chapterRoads', 'chapterResult',
      'referer', 'searchMode', 'chapterMode', 'searchApiConfig', 'chapterApiConfig',
      'anticrawlerConfig', 'antiCrawlerConfig'].forEach(function (k) {
        if (r[k] !== undefined) o[k] = r[k];
      });
    return o;
  }

  /* 从 GitHub 规则仓库同步最新规则 */
  async function syncFromRemote() {
    var api = 'https://api.github.com/repos/Predidit/KazumiRules/git/trees/main?recursive=1';
    var r = await NET.json(api, {});
    var tree = (r.data.tree || []).filter(function (t) {
      return /^[^\/]+\.json$/.test(t.path) && t.path !== 'index.json';
    });
    var out = [];
    for (var i = 0; i < tree.length; i++) {
      var raw = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/' + tree[i].path;
      try {
        var res = await NET.text(raw, {});
        out.push(JSON.parse(res.body));
      } catch (e) { /* 单条失败不影响整体 */ }
    }
    return out;
  }

  g.Rules = {
    load: load,
    all: function () { return R.all; },
    bundle: function () { return R.bundle; },
    enabledRules: enabledRules,
    orderNames: orderNames,
    moveSource: moveSource,
    byName: byName,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    setEnabledAll: setEnabledAll,
    validate: validate,
    upsert: upsert,
    remove: remove,
    exportRule: exportRule,
    syncFromRemote: syncFromRemote,
    abs: abs,
    normalize: normalize
  };
})(window);
