/* XPath 引擎 —— 复刻 Kazumi 的 xpath_selector 语义
 *
 * 语义要点（与 Dart 版 xpath_selector 对齐）：
 *   1. 规则里的表达式一律以 `//` 开头，但在 Kazumi 中它是**相对上下文节点**求值的。
 *      浏览器的 document.evaluate 把 `//x` 当作绝对路径，因此必须改写。
 *   2. 改写规则：`//x` → `.//x`（相对后代）；`/x` 保持绝对；`x` 保持相对。
 *   3. 在 document 上，`.//div[2]` 与 `//div[2]` 结果一致（document 自身不是元素），
 *      所以这一条改写对根节点查询同样安全。
 */
(function (g) {
  'use strict';

  var SNAP = XPathResult.ORDERED_NODE_SNAPSHOT_TYPE;
  var FIRST = XPathResult.FIRST_ORDERED_NODE_TYPE;

  function rewrite(expr) {
    expr = (expr == null ? '' : String(expr)).trim();
    if (!expr) return '.';
    var c = expr[0];
    if (c === '.') return expr;              // 已是相对
    if (c === '(') return expr;              // 函数/括号开头，原样交给引擎
    if (expr.indexOf('//') === 0) return '.' + expr;  // //x → .//x
    if (c === '/') return expr;              // 绝对路径，保持
    return expr;                             // 普通相对表达式，保持
  }

  function evaluate(ctx, expr, resultType) {
    if (!ctx) return null;
    var doc = ctx.ownerDocument || ctx;
    try {
      return doc.evaluate(rewrite(expr), ctx, null, resultType, null);
    } catch (e) {
      return null;
    }
  }

  /* 返回全部匹配节点（数组） */
  function all(ctx, expr) {
    var r = evaluate(ctx, expr, SNAP);
    if (!r) return [];
    var out = [], i, n = r.snapshotLength;
    for (i = 0; i < n; i++) out.push(r.snapshotItem(i));
    return out;
  }

  /* 返回单个节点（首个） */
  function one(ctx, expr) {
    var r = evaluate(ctx, expr, FIRST);
    return r ? r.singleNodeValue : null;
  }

  /* 取节点文本，规范化空白 */
  function text(node) {
    if (!node) return '';
    var t = node.nodeType === 3 || node.nodeType === 2 ? node.nodeValue : node.textContent;
    return (t == null ? '' : String(t)).replace(/\s+/g, ' ').trim();
  }

  /* 取属性 */
  function attr(node, name) {
    if (!node) return '';
    if (node.nodeType === 1 && node.getAttribute) {
      var v = node.getAttribute(name);
      return v == null ? '' : String(v).trim();
    }
    return '';
  }

  /* 解析 HTML 文本为 Document */
  function doc(html) {
    return new DOMParser().parseFromString(String(html || ''), 'text/html');
  }

  /* 解析片段（用于取 innerHTML 片段） */
  function frag(node) {
    return node && node.outerHTML ? node.outerHTML : '';
  }

  g.KXP = {
    rewrite: rewrite,
    all: all,
    one: one,
    text: text,
    attr: attr,
    doc: doc,
    frag: frag,
    /* 便捷：在 document 上按规则查询 */
    query: function (document, expr) { return all(document, expr); },
    /* 便捷：在节点上按规则查询 */
    pluck: function (node, expr) { return one(node, expr); },
    pluckAll: function (node, expr) { return all(node, expr); }
  };
})(window);
