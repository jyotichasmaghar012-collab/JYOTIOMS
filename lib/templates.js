'use strict';
/**
 * Nunjucks configured to behave like Jinja2 for the existing templates:
 *  - Python truthiness in if / not / and / or / inline-if ([] and {} are falsy)
 *  - Python string methods (.startswith, .lower, .split, ...) on strings
 *  - Jinja filters nunjucks lacks (format, tojson, map, selectattr w/ test, ...)
 *  - `is none` / `is not none` tests
 */
const path = require('node:path');
const nunjucks = require('nunjucks');
const runtime = require('nunjucks/src/runtime');
const nodes = require('nunjucks/src/nodes');
const { Compiler } = require('nunjucks/src/compiler');
const py = require('./py');

nunjucks.installJinjaCompat();

/* ---------- Python truthiness in compiled templates ---------- */
runtime.pyTruth = py.truthy;

function truthNode(target) {
  const n = Object.create(nodes.Not.prototype);
  n.lineno = target.lineno;
  n.colno = target.colno;
  n.target = target;
  Object.defineProperty(n, 'typename', { value: 'PyTruth' });
  return n;
}

Compiler.prototype.compilePyTruth = function compilePyTruth(node, frame) {
  this._emit('runtime.pyTruth(');
  this.compile(node.target, frame);
  this._emit(')');
};

const origCompileIf = Compiler.prototype.compileIf;
Compiler.prototype.compileIf = function compileIf(node, frame, async) {
  if (node.cond && node.cond.typename !== 'PyTruth') node.cond = truthNode(node.cond);
  return origCompileIf.call(this, node, frame, async);
};
const origCompileIfAsync = Compiler.prototype.compileIfAsync;
if (origCompileIfAsync) {
  Compiler.prototype.compileIfAsync = function compileIfAsync(node, frame) {
    if (node.cond && node.cond.typename !== 'PyTruth') node.cond = truthNode(node.cond);
    return origCompileIfAsync.call(this, node, frame);
  };
}
Compiler.prototype.compileInlineIf = function compileInlineIf(node, frame) {
  this._emit('(runtime.pyTruth(');
  this.compile(node.cond, frame);
  this._emit(')?');
  this.compile(node.body, frame);
  this._emit(':');
  if (node.else_ !== null) this.compile(node.else_, frame);
  else this._emit('""');
  this._emit(')');
};
Compiler.prototype.compileNot = function compileNot(node, frame) {
  this._emit('!runtime.pyTruth(');
  this.compile(node.target, frame);
  this._emit(')');
};
Compiler.prototype.compileOr = function compileOr(node, frame) {
  this._emit('((__l) => runtime.pyTruth(__l) ? __l : (');
  this.compile(node.right, frame);
  this._emit('))(');
  this.compile(node.left, frame);
  this._emit(')');
};
Compiler.prototype.compileAnd = function compileAnd(node, frame) {
  this._emit('((__l) => !runtime.pyTruth(__l) ? __l : (');
  this.compile(node.right, frame);
  this._emit('))(');
  this.compile(node.left, frame);
  this._emit(')');
};

/* ---------- Jinja tuples: ('a', b) is a 2-item sequence, not a comma expr ---------- */
const origCompileGroup = Compiler.prototype.compileGroup;
Compiler.prototype.compileGroup = function compileGroup(node, frame) {
  if (node.children && node.children.length > 1) {
    this._emit('[');
    node.children.forEach((child, i) => {
      if (i > 0) this._emit(',');
      this.compile(child, frame);
    });
    this._emit(']');
    return;
  }
  origCompileGroup.call(this, node, frame);
};

/* ---------- Jinja-style chained inline-if: a if x else b if y else c ---------- */
const { Parser } = require('nunjucks/src/parser');
Parser.prototype.parseInlineIf = function parseInlineIf() {
  let node = this.parseOr();
  if (this.skipSymbol('if')) {
    const condNode = this.parseOr();
    const bodyNode = node;
    node = new nodes.InlineIf(node.lineno, node.colno);
    node.body = bodyNode;
    node.cond = condNode;
    node.else_ = this.skipSymbol('else') ? this.parseInlineIf() : null;
  }
  return node;
};

/* ---------- Python string methods on JS strings ---------- */
function defStr(name, fn) {
  if (!Object.prototype.hasOwnProperty.call(String.prototype, name)) {
    Object.defineProperty(String.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
  }
}
defStr('startswith', function (p) { const s = String(this); return Array.isArray(p) ? p.some((x) => s.startsWith(x)) : s.startsWith(p); });
defStr('endswith', function (p) { const s = String(this); return Array.isArray(p) ? p.some((x) => s.endsWith(x)) : s.endsWith(p); });
defStr('lower', function () { return String(this).toLowerCase(); });
defStr('upper', function () { return String(this).toUpperCase(); });
defStr('strip', function (ch) { return ch ? String(this).replace(new RegExp(`^[${escRe(ch)}]+|[${escRe(ch)}]+$`, 'g'), '') : String(this).trim(); });
defStr('lstrip', function (ch) { return ch ? String(this).replace(new RegExp(`^[${escRe(ch)}]+`), '') : String(this).replace(/^\s+/, ''); });
defStr('rstrip', function (ch) { return ch ? String(this).replace(new RegExp(`[${escRe(ch)}]+$`), '') : String(this).replace(/\s+$/, ''); });
defStr('capitalize', function () { const s = String(this); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); });
defStr('title', function () { return py.title(String(this)); });
defStr('isdigit', function () { return /^\d+$/.test(String(this)); });
function escRe(s) { return String(s).replace(/[\]\\^-]/g, '\\$&'); }

/* ---------- Environment ---------- */
function createEnv(templatesDir) {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templatesDir, { noCache: process.env.DEBUG === '1' }), {
    autoescape: true,
    throwOnUndefined: false,
    trimBlocks: false,
    lstripBlocks: false,
  });

  env.addFilter('format', (fmt, ...args) => {
    const kw = args.length && args[args.length - 1] && args[args.length - 1].__keywords ? args.pop() : null;
    if (kw) { const o = Object.assign({}, kw); delete o.__keywords; return py.percentFormat(fmt, [o]); }
    return py.percentFormat(fmt, args);
  });
  env.addFilter('tojson', (v, indent) => {
    const s = JSON.stringify(v === undefined ? null : v, null, indent || undefined) || 'null';
    return new nunjucks.runtime.SafeString(
      s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/'/g, '\\u0027'));
  });
  env.addFilter('map', (arr, ...args) => {
    arr = toList(arr);
    const kw = args.length && args[args.length - 1] && args[args.length - 1].__keywords ? args.pop() : {};
    if (kw.attribute !== undefined) {
      return arr.map((x) => {
        const v = x == null ? undefined : x[kw.attribute];
        return v === undefined && kw.default !== undefined ? kw.default : v;
      });
    }
    const fname = args[0];
    if (fname) { const f = env.getFilter(fname); return arr.map((x) => f(x, ...args.slice(1))); }
    return arr;
  });
  const tests = {
    equalto: (a, b) => a === b, eq: (a, b) => a === b, '==': (a, b) => a === b,
    ne: (a, b) => a !== b, '!=': (a, b) => a !== b,
    gt: (a, b) => a > b, ge: (a, b) => a >= b, lt: (a, b) => a < b, le: (a, b) => a <= b,
    none: (a) => a === null || a === undefined, defined: (a) => a !== undefined,
    in: (a, b) => (Array.isArray(b) || typeof b === 'string' ? b.includes(a) : !!b && a in b),
  };
  function runTest(v, test, arg) {
    if (!test) return py.truthy(v);
    const t = tests[test] || env.tests[test];
    return t ? !!t(v, arg) : false;
  }
  env.addFilter('selectattr', (arr, attr, test, arg) => toList(arr).filter((x) => runTest(x == null ? undefined : x[attr], test, arg)));
  env.addFilter('rejectattr', (arr, attr, test, arg) => toList(arr).filter((x) => !runTest(x == null ? undefined : x[attr], test, arg)));
  env.addFilter('select', (arr, test, arg) => toList(arr).filter((x) => runTest(x, test, arg)));
  env.addFilter('reject', (arr, test, arg) => toList(arr).filter((x) => !runTest(x, test, arg)));
  env.addFilter('list', (v) => toList(v));
  env.addFilter('string', (v) => (v === null || v === undefined ? (v === null ? 'None' : '') : v === true ? 'True' : v === false ? 'False' : String(v)));
  env.addFilter('int', (v, dflt = 0) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).trim());
    return Number.isNaN(n) ? dflt : Math.trunc(n);
  });
  env.addFilter('float', (v, dflt = 0.0) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).trim());
    return Number.isNaN(n) ? dflt : n;
  });
  env.addFilter('round', (v, precision = 0, method = 'common') => {
    const n = Number(v); const m = Math.pow(10, precision);
    if (method === 'ceil') return Math.ceil(n * m) / m;
    if (method === 'floor') return Math.floor(n * m) / m;
    return Math.round(n * m) / m;
  });
  env.addFilter('sum', (arr, ...args) => {
    const kw = args.length && args[args.length - 1] && args[args.length - 1].__keywords ? args.pop() : {};
    const attr = kw.attribute !== undefined ? kw.attribute : args[0];
    const start = kw.start !== undefined ? kw.start : (args[1] || 0);
    return toList(arr).reduce((acc, x) => acc + Number(attr !== undefined && attr !== null ? (x || {})[attr] || 0 : x || 0), start);
  });
  env.addFilter('min', (arr) => { const l = toList(arr); return l.length ? l.reduce((a, b) => (b < a ? b : a)) : undefined; });
  env.addFilter('max', (arr) => { const l = toList(arr); return l.length ? l.reduce((a, b) => (b > a ? b : a)) : undefined; });
  env.addFilter('abs', (v) => Math.abs(Number(v)));
  env.addFilter('title', (v) => py.title(v));
  env.addFilter('capitalize', (v) => { const s = String(v == null ? '' : v); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); });
  env.addFilter('urlencode', (v) => {
    if (v && typeof v === 'object') {
      return Object.entries(v).map(([k, x]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(x))).join('&');
    }
    return encodeURIComponent(String(v == null ? '' : v)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%2F/g, '/');
  });
  env.addFilter('dictsort', (obj) => Object.keys(obj || {}).sort().map((k) => [k, obj[k]]));
  env.addFilter('items', (obj) => Object.entries(obj || {}));

  /** Page numbers to show around `page` (plus first/last), with null marking
   *  an ellipsis gap - used by _pagination.html. */
  env.addGlobal('pagination_window', (page, total_pages, win = 2) => {
    const out = [];
    let last = 0;
    for (let p = 1; p <= total_pages; p++) {
      if (p === 1 || p === total_pages || (p >= page - win && p <= page + win)) {
        if (last && p - last > 1) out.push(null);
        out.push(p);
        last = p;
      }
    }
    return out;
  });

  env.addTest('none', (v) => v === null || v === undefined);
  env.addTest('defined', (v) => v !== undefined);
  env.addTest('undefined', (v) => v === undefined);
  env.addTest('number', (v) => typeof v === 'number');
  env.addTest('string', (v) => typeof v === 'string');
  env.addTest('mapping', (v) => !!v && typeof v === 'object' && !Array.isArray(v));
  env.addTest('sequence', (v) => Array.isArray(v) || typeof v === 'string');
  env.addTest('in', (a, b) => (Array.isArray(b) || typeof b === 'string' ? b.includes(a) : !!b && a in b));

  return env;
}

function toList(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split('');
  if (typeof v[Symbol.iterator] === 'function') return Array.from(v);
  if (typeof v === 'object') return Object.keys(v);
  return [v];
}

module.exports = { createEnv, nunjucks, templatesDir: path.join(__dirname, '..', 'templates') };
