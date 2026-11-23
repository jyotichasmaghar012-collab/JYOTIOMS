'use strict';
/**
 * Minimal Flask-compatibility layer for Express.
 *
 * The original app is written against Flask's request-global objects
 * (`request`, `session`, `g`, `flash`, `url_for`, blueprints, decorators).
 * Rather than threading `req`/`res` through every helper, this module keeps
 * the current request in an AsyncLocalStorage and exposes proxies with the
 * same shape, so the ported route code reads almost line-for-line like the
 * Python it came from.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const als = new AsyncLocalStorage();

function current() {
  const c = als.getStore();
  if (!c) throw new Error('Working outside of request context.');
  return c;
}
function hasContext() {
  return !!als.getStore();
}

/* ------------------------------------------------------------------ */
/* MultiDict / FileStorage                                             */
/* ------------------------------------------------------------------ */

class MultiDict {
  constructor(src) {
    Object.defineProperty(this, '_lists', { value: {}, enumerable: false, writable: true });
    if (src) {
      for (const [k, v] of Object.entries(src)) {
        const list = Array.isArray(v) ? v.slice() : [v];
        this._lists[k] = list;
        this[k] = list[0];
      }
    }
  }
  get(key, dflt, opts) {
    let type;
    if (typeof dflt === 'object' && dflt !== null && dflt.type) { type = dflt.type; dflt = undefined; }
    if (opts && opts.type) type = opts.type;
    const list = this._lists[key];
    if (!list || list.length === 0) return dflt === undefined ? null : dflt;
    let v = list[0];
    if (type) {
      try {
        v = type(v);
        if (typeof v === 'number' && Number.isNaN(v)) throw new Error('bad');
      } catch (_) {
        return dflt === undefined ? null : dflt;
      }
    }
    return v;
  }
  /** Flask's request.form["key"] - a missing key is a 400 Bad Request. */
  require(key) {
    const list = this._lists[key];
    if (!list || list.length === 0) abort(400, `The browser (or proxy) sent a request that this server could not understand. (missing '${key}')`);
    return list[0];
  }
  getlist(key) {
    return (this._lists[key] || []).slice();
  }
  has(key) {
    return Object.prototype.hasOwnProperty.call(this._lists, key);
  }
  keys() { return Object.keys(this._lists); }
  items() { return Object.keys(this._lists).map((k) => [k, this._lists[k][0]]); }
  to_dict() {
    const o = {};
    for (const k of Object.keys(this._lists)) o[k] = this._lists[k][0];
    return o;
  }
  add(key, value) {
    (this._lists[key] = this._lists[key] || []).push(value);
    if (!(key in this)) this[key] = value;
  }
}

/** Strict int conversion matching Python's int() on request args. */
function pyInt(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('invalid int');
    return Math.trunc(v);
  }
  const s = String(v == null ? '' : v).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Error(`invalid literal for int(): '${v}'`);
  return parseInt(s, 10);
}
function pyFloat(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|infinity|nan)$/i.test(s)) {
    throw new Error(`could not convert string to float: '${v}'`);
  }
  return parseFloat(s);
}

class FileStorage {
  constructor(f) {
    this.filename = f ? (f.originalname || '') : '';
    this.mimetype = f ? (f.mimetype || '') : '';
    this.content_type = this.mimetype;
    this.buffer = f ? f.buffer : Buffer.alloc(0);
    this.content_length = this.buffer.length;
    this.size = this.buffer.length;
  }
  save(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, this.buffer);
  }
  read() { return this.buffer; }
  seek() { /* no-op: whole upload is in memory */ }
  tell() { return this.buffer.length; }
}

/* ------------------------------------------------------------------ */
/* request / session / g proxies                                       */
/* ------------------------------------------------------------------ */

const requestImpl = {
  get method() { return current().req.method; },
  get path() { return current().req.path; },
  get full_path() {
    const r = current().req;
    const q = r.originalUrl.includes('?') ? r.originalUrl.slice(r.originalUrl.indexOf('?')) : '?';
    return r.path + q;
  },
  get url() {
    const r = current().req;
    return `${r.protocol}://${r.get('host')}${r.originalUrl}`;
  },
  get host_url() { return this.url_root; },
  get url_root() {
    const r = current().req;
    return `${r.protocol}://${r.get('host')}/`;
  },
  get host() { return current().req.get('host'); },
  get scheme() { return current().req.protocol; },
  get args() { return current().args; },
  get form() { return current().form; },
  get files() { return current().files; },
  get values() {
    const c = current();
    const m = new MultiDict();
    for (const k of c.args.keys()) for (const v of c.args.getlist(k)) m.add(k, v);
    for (const k of c.form.keys()) for (const v of c.form.getlist(k)) m.add(k, v);
    return m;
  },
  get cookies() { return current().req.cookies || parseCookies(current().req.headers.cookie); },
  get headers() {
    const r = current().req;
    return { get: (k, d = null) => r.get(k) ?? d };
  },
  get remote_addr() { return current().req.ip; },
  get endpoint() { return current().endpoint || null; },
  get view_args() { return current().viewArgs || {}; },
  get is_json() { return !!current().req.is('application/json'); },
  get referrer() { return current().req.get('referer') || null; },
  get user_agent() { return { string: current().req.get('user-agent') || '' }; },
  get_json(opts) {
    const r = current().req;
    if (r.is('application/json') || (opts && (opts.force || opts.silent))) {
      return r.body && typeof r.body === 'object' && !(r.body instanceof MultiDict) ? r.body : (r.jsonBody ?? null);
    }
    return null;
  },
  get json() { return this.get_json(); },
  get raw() { return current().req; },
};

function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const request = requestImpl;

const session = new Proxy({}, {
  get(_t, prop) {
    const s = current().req.session;
    if (prop === 'get') return (k, d = null) => (s[k] === undefined ? d : s[k]);
    if (prop === 'pop') return (k, d = null) => { const v = s[k]; delete s[k]; return v === undefined ? d : v; };
    if (prop === 'clear') return () => { for (const k of Object.keys(s)) delete s[k]; };
    if (prop === 'setdefault') return (k, d) => { if (s[k] === undefined) s[k] = d; return s[k]; };
    if (prop === 'modified') return true;
    return s[prop];
  },
  set(_t, prop, value) {
    if (prop === 'modified' || prop === 'permanent') return true;
    current().req.session[prop] = value;
    return true;
  },
  has(_t, prop) {
    const v = current().req.session[prop];
    return v !== undefined;
  },
  deleteProperty(_t, prop) {
    delete current().req.session[prop];
    return true;
  },
  ownKeys() { return Reflect.ownKeys(current().req.session); },
  getOwnPropertyDescriptor(_t, prop) {
    return { enumerable: true, configurable: true, value: current().req.session[prop] };
  },
});

const g = new Proxy({}, {
  get(_t, prop) { return current().g[prop]; },
  set(_t, prop, v) { current().g[prop] = v; return true; },
  has(_t, prop) { return prop in current().g; },
  deleteProperty(_t, prop) { delete current().g[prop]; return true; },
});

/* ------------------------------------------------------------------ */
/* flash                                                               */
/* ------------------------------------------------------------------ */

function flash(message, category = 'message') {
  const s = current().req.session;
  const list = s._flashes || [];
  list.push([category, String(message)]);
  s._flashes = list;
}

function get_flashed_messages(opts) {
  const withCategories = !!(opts && (opts.with_categories || opts.__keywords && opts.with_categories));
  const c = current();
  if (c.flashed === undefined) {
    c.flashed = c.req.session._flashes || [];
    delete c.req.session._flashes;
  }
  return withCategories ? c.flashed.map((x) => [x[0], x[1]]) : c.flashed.map((x) => x[1]);
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

class Response {
  constructor(body = '', status = 200, headers = {}) {
    this.body = body;
    this.status = status;
    this.headers = Object.assign({}, headers);
    this.cookies = [];
    this.file = null;
    this.after = [];
  }
  set_cookie(name, value, opts = {}) { this.cookies.push([name, value, opts]); return this; }
  delete_cookie(name) { this.cookies.push([name, '', { max_age: 0 }]); return this; }
}

function redirect(url, code = 302) {
  return new Response('', code, { Location: url });
}

function jsonify(obj) {
  return new Response(JSON.stringify(obj === undefined ? null : obj), 200, { 'Content-Type': 'application/json' });
}

function make_response(body, status = 200, headers = {}) {
  if (body instanceof Response) { body.status = status || body.status; Object.assign(body.headers, headers); return body; }
  return new Response(body, status, headers);
}

function send_file(filePath, opts = {}) {
  const r = new Response('', 200, {});
  r.file = { path: filePath, as_attachment: !!opts.as_attachment, download_name: opts.download_name, mimetype: opts.mimetype };
  return r;
}

class HTTPError extends Error {
  constructor(code, description) {
    super(description || `HTTP ${code}`);
    this.code = code;
    this.description = description;
  }
}
function abort(code, description) {
  throw new HTTPError(code, description);
}

/* ------------------------------------------------------------------ */
/* Routing (blueprints + url_for)                                      */
/* ------------------------------------------------------------------ */

const endpoints = new Map(); // endpoint -> flask-style rule

function flaskRuleToExpress(rule) {
  const converters = {};
  const expr = rule.replace(/<(?:(\w+):)?(\w+)>/g, (_m, conv, name) => {
    converters[name] = conv || 'string';
    if (conv === 'int') return `:${name}(\\d+)`;
    if (conv === 'float') return `:${name}([0-9.]+)`;
    if (conv === 'path') return `:${name}(*)`;
    return `:${name}`;
  });
  return { expr, converters };
}

function url_for(endpoint, values) {
  values = Object.assign({}, values || {});
  delete values.__keywords;
  let external = false;
  if (values._external) { external = true; }
  delete values._external;
  let anchor = values._anchor; delete values._anchor;

  if (endpoint === 'static') {
    const fn = String(values.filename || '').replace(/^\/+/, '');
    delete values.filename;
    let u = '/static/' + fn.split('/').map(encodeURIComponent).join('/');
    const qs = buildQuery(values);
    if (qs) u += '?' + qs;
    return external ? request.url_root.replace(/\/$/, '') + u : u;
  }
  // Relative endpoint (".index") resolves against the current blueprint.
  if (endpoint.startsWith('.') && hasContext()) {
    const ep = current().endpoint || '';
    endpoint = ep.split('.')[0] + endpoint;
  }
  const rule = endpoints.get(endpoint);
  if (!rule) throw new Error(`Could not build url for endpoint '${endpoint}'.`);
  let u = rule.replace(/<(?:(\w+):)?(\w+)>/g, (_m, conv, name) => {
    if (!(name in values) || values[name] === undefined || values[name] === null) {
      throw new Error(`Could not build url for endpoint '${endpoint}'. Missing '${name}'.`);
    }
    const v = values[name];
    delete values[name];
    if (conv === 'path') return String(v).split('/').map(encodeURIComponent).join('/');
    return encodeURIComponent(String(v));
  });
  const qs = buildQuery(values);
  if (qs) u += '?' + qs;
  if (anchor) u += '#' + encodeURIComponent(anchor);
  if (external) u = request.url_root.replace(/\/$/, '') + u;
  return u;
}

function buildQuery(values) {
  const parts = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) {
      const s = x === true ? 'True' : x === false ? 'False' : String(x);
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(s).replace(/%20/g, '+'));
    }
  }
  return parts.join('&');
}

class Blueprint {
  constructor(name, opts = {}) {
    this.name = name;
    this.url_prefix = opts.url_prefix || '';
    this.routes = [];
    this.befores = [];
  }
  /**
   * bp.route('/x/<int:id>', handler)                       // GET
   * bp.route('/x', ['GET', 'POST'], handler)
   * The endpoint name is the handler's function name (like Flask), or pass
   * { endpoint: 'name' } as the last argument.
   */
  route(rule, methodsOrHandler, maybeHandler, opts) {
    let methods = ['GET'];
    let handler;
    if (typeof methodsOrHandler === 'function') { handler = methodsOrHandler; opts = maybeHandler; }
    else { methods = methodsOrHandler; handler = maybeHandler; }
    opts = opts || {};
    const fname = opts.endpoint || handler.endpointName || handler.name;
    if (!fname) throw new Error(`Route ${rule} needs a named handler or endpoint option`);
    const endpoint = this.name ? `${this.name}.${fname}` : fname;
    const full = (this.url_prefix + rule) || '/';
    this.routes.push({ rule: full, methods: methods.map((m) => m.toUpperCase()), handler, endpoint });
    if (!endpoints.has(endpoint)) endpoints.set(endpoint, full);
    return handler;
  }
  before_request(fn) {
    this.befores.push(fn);
    return fn;
  }
}

/** Give a wrapped handler the same endpoint name as the inner function. */
function wraps(inner, outer) {
  outer.endpointName = inner.endpointName || inner.name;
  return outer;
}

/* ------------------------------------------------------------------ */
/* werkzeug helpers                                                    */
/* ------------------------------------------------------------------ */

const WINDOWS_DEVICE_FILES = new Set(['CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

function secure_filename(filename) {
  let f = String(filename || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  f = f.replace(/[\/\\]/g, ' ');
  f = f.split(/\s+/).filter(Boolean).join('_');
  f = f.replace(/[^A-Za-z0-9_.-]/g, '').replace(/^[._]+|[._]+$/g, '');
  if (process.platform === 'win32' && f && WINDOWS_DEVICE_FILES.has(f.split('.')[0].toUpperCase())) {
    f = '_' + f;
  }
  return f;
}

const SALT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function genSalt(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += SALT_CHARS[bytes[i] % SALT_CHARS.length];
  return s;
}

function hashInternal(method, salt, password) {
  const parts = method.split(':');
  const algo = parts[0];
  if (algo === 'scrypt') {
    const n = parseInt(parts[1] || '32768', 10);
    const r = parseInt(parts[2] || '8', 10);
    const p = parseInt(parts[3] || '1', 10);
    return crypto.scryptSync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), 64,
      { N: n, r, p, maxmem: 132 * n * r * p }).toString('hex');
  }
  if (algo === 'pbkdf2') {
    const hash = parts[1] || 'sha256';
    const iters = parseInt(parts[2] || '600000', 10);
    const len = crypto.createHash(hash).digest().length;
    return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), iters, len, hash).toString('hex');
  }
  throw new Error(`Invalid hash method '${method}'.`);
}

/** Produces werkzeug-compatible hashes, so the same users table works with
 *  both the old Python app and this Node port. */
function generate_password_hash(password, method = 'scrypt:32768:8:1', saltLength = 16) {
  const salt = genSalt(saltLength);
  return `${method}$${salt}$${hashInternal(method, salt, password)}`;
}

function check_password_hash(pwhash, password) {
  try {
    const [method, salt, hashval] = String(pwhash).split('$');
    if (!method || salt === undefined || !hashval) return false;
    const got = hashInternal(method, salt, String(password));
    const a = Buffer.from(got);
    const b = Buffer.from(hashval);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

module.exports = {
  als, current, hasContext,
  MultiDict, FileStorage, pyInt, pyFloat,
  request, session, g,
  flash, get_flashed_messages,
  Response, redirect, jsonify, make_response, send_file, abort, HTTPError,
  Blueprint, url_for, endpoints, flaskRuleToExpress, wraps, buildQuery,
  secure_filename, generate_password_hash, check_password_hash,
};
