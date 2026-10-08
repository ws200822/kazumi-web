/* 本地持久化 —— 规则 / 追番 / 历史 / 设置 */
(function (g) {
  'use strict';

  var K = {
    rules: 'kz.rules',        // 用户自定义/覆盖的规则
    enabled: 'kz.enabled',    // 启用的规则名列表
    collect: 'kz.collect',    // 追番
    history: 'kz.history',    // 历史
    settings: 'kz.settings',  // 设置
    danmaku: 'kz.danmaku'     // 弹幕缓存
  };

  var LIMIT = { collect: 500, history: 300 };

  function read(key, def) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return def;
      var v = JSON.parse(raw);
      return v == null ? def : v;
    } catch (e) { return def; }
  }

  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* ---------- 设置 ---------- */
  var DEFAULT_SETTINGS = {
    proxy: '',
    publicFallback: true,
    directFirst: true,
    danmakuOn: true,
    danmakuOpacity: 0.9,
    danmakuSpeed: 8,          // 秒/屏
    danmakuFontSize: 16,
    danmakuArea: 0.4,
    autoNext: true,
    concurrency: 4,           // 多源搜索并发
    timeout: 20000
  };

  function settings() {
    return Object.assign({}, DEFAULT_SETTINGS, read(K.settings, {}));
  }
  function patchSettings(p) {
    var s = Object.assign(settings(), p);
    write(K.settings, s);
    return s;
  }

  /* ---------- 规则 ---------- */
  function customRules() { return read(K.rules, []); }
  function setCustomRules(list) { return write(K.rules, list); }
  function enabledNames() { return read(K.enabled, null); }
  function setEnabledNames(n) { return write(K.enabled, n); }

  /* ---------- 追番 ---------- */
  function collect() { return read(K.collect, []); }

  function collectId(item) {
    return (item.rule || '') + '|' + (item.src || item.name || '');
  }

  function isCollected(item) {
    var id = collectId(item);
    return collect().some(function (x) { return x.id === id; });
  }

  function toggleCollect(item) {
    var list = collect();
    var id = collectId(item);
    var i = list.findIndex(function (x) { return x.id === id; });
    var added;
    if (i >= 0) { list.splice(i, 1); added = false; }
    else {
      list.unshift(Object.assign({}, item, { id: id, ts: Date.now() }));
      added = true;
    }
    if (list.length > LIMIT.collect) list.length = LIMIT.collect;
    write(K.collect, list);
    return added;
  }

  function removeCollect(id) {
    var list = collect().filter(function (x) { return x.id !== id; });
    write(K.collect, list);
    return list;
  }

  /* ---------- 历史 ---------- */
  function history() { return read(K.history, []); }

  function pushHistory(entry) {
    var list = history().filter(function (x) {
      return !(x.rule === entry.rule && x.src === entry.src && x.ep === entry.ep);
    });
    list.unshift(Object.assign({}, entry, { ts: Date.now() }));
    if (list.length > LIMIT.history) list.length = LIMIT.history;
    write(K.history, list);
    return list;
  }

  /* 记录播放进度，用于续播 */
  function saveProgress(key, sec, dur) {
    var prog = read('kz.progress', {});
    prog[key] = { sec: sec, dur: dur, ts: Date.now() };
    write('kz.progress', prog);
  }
  function getProgress(key) {
    var p = read('kz.progress', {})[key];
    if (!p) return 0;
    /* 距结尾 30 秒内视为看完 */
    if (p.dur && p.sec > p.dur - 30) return 0;
    return p.sec || 0;
  }

  function clearHistory() { write(K.history, []); }

  /* ---------- 弹幕缓存 ---------- */
  function danmakuCache(key) { return read(K.danmaku, {})[key] || null; }
  function setDanmakuCache(key, list) {
    var c = read(K.danmaku, {});
    c[key] = list;
    var keys = Object.keys(c);
    if (keys.length > 60) { delete c[keys[0]]; }
    write(K.danmaku, c);
  }

  /* ---------- 源的优先顺序 ---------- */
  function sourceOrder() { return read('kz.sourceOrder', []); }
  function setSourceOrder(list) { return write('kz.sourceOrder', list); }

  /* ---------- 全局导出/导入 ---------- */
  function exportAll() {
    return {
      v: 2, ts: Date.now(),
      rules: customRules(),
      enabled: enabledNames(),
      collect: collect(),
      history: history(),
      settings: settings()
    };
  }

  function importAll(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('数据格式无效');
    if (obj.rules) setCustomRules(obj.rules);
    if (obj.enabled) setEnabledNames(obj.enabled);
    if (obj.collect) write(K.collect, obj.collect);
    if (obj.history) write(K.history, obj.history);
    if (obj.settings) patchSettings(obj.settings);
    return true;
  }

  g.Store = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    settings: settings, patchSettings: patchSettings,
    customRules: customRules, setCustomRules: setCustomRules,
    enabledNames: enabledNames, setEnabledNames: setEnabledNames,
    collect: collect, isCollected: isCollected, toggleCollect: toggleCollect,
    removeCollect: removeCollect, collectId: collectId,
    history: history, pushHistory: pushHistory, clearHistory: clearHistory,
    saveProgress: saveProgress, getProgress: getProgress,
    danmakuCache: danmakuCache, setDanmakuCache: setDanmakuCache,
    sourceOrder: sourceOrder, setSourceOrder: setSourceOrder,
    exportAll: exportAll, importAll: importAll,
    read: read, write: write
  };
})(window);
