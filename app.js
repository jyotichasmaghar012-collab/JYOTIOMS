'use strict';
/**
 * Optical Shop OMS - Node.js / Express entry point (port of the Flask app.py).
 *
 *   npm install
 *   npm start            -> http://localhost:5000
 *
 * Env vars: PORT (default 5000), OMS_SECRET_KEY (session signing key),
 *           DEBUG=1 (template hot-reload + stack traces), OMS_DB_PATH.
 */
const path = require('node:path');
const fs = require('node:fs');

// Load settings from .env (if present) before anything reads process.env.
// Values already set in the real environment take precedence.
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE) && fs.statSync(ENV_FILE).isFile()) process.loadEnvFile(ENV_FILE);

const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');

const core = require('./lib/core');
const { als, MultiDict, FileStorage, Response, HTTPError, Blueprint, flaskRuleToExpress,
  request, session, redirect, url_for, flash, jsonify, check_password_hash } = core;
const { render_template, context_processor } = require('./lib/render');
const { init_db, get_db, get_setting, close_db, BASE_DIR } = require('./db');
const { login_required, has_permission } = require('./auth');
const { get_active_branch_id, is_all_branches_view, list_branches, get_branch_name } = require('./branches');

const SECRET_KEY = process.env.OMS_SECRET_KEY || 'change-this-secret-key-in-production';
const DEBUG = process.env.DEBUG === '1';
// Hard backstop against oversized uploads (review photos/videos are the
// largest thing accepted) - each file is individually size-checked too.
const MAX_CONTENT_LENGTH = 60 * 1024 * 1024;

const storage = require('./lib/storage');
const mongosync = require('./lib/mongosync');

// Local: migrate data/oms.db right away. MongoDB mode: first pull the saved
// database from Atlas, migrate, and save it back; requests wait for this.
let ready;
if (mongosync.enabled()) {
  ready = mongosync.startup(init_db);
  ready.catch((e) => console.error('MongoDB startup failed:', e && e.message ? e.message : e));
} else {
  init_db();
  ready = Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* Template globals (Flask: @app.context_processor inject_globals)     */
/* ------------------------------------------------------------------ */
context_processor(function inject_globals() {
  const loggedIn = 'user_id' in session;
  const ctx = {
    current_user: loggedIn ? {
      id: session.user_id, username: session.username, full_name: session.full_name, role: session.role,
    } : null,
    shop_name: loggedIn ? get_setting('shop_name', 'My Optical Shop') : 'My Optical Shop',
    shop_logo: get_setting('shop_logo_path', ''),
  };
  if (loggedIn) {
    const active_branch_id = get_active_branch_id();
    ctx.all_branches_view = is_all_branches_view();
    ctx.active_branch_id = active_branch_id;
    ctx.active_branch_name = active_branch_id ? get_branch_name(active_branch_id) : 'All Branches';
    if (session.role === 'admin') ctx.branch_switcher_list = list_branches();
    const db = get_db();
    if (has_permission('po_generation') && !request.path.startsWith('/store')) {
      const row = is_all_branches_view()
        ? db.execute("SELECT COUNT(*) c FROM purchase_orders WHERE status='Pending'").fetchone()
        : db.execute("SELECT COUNT(*) c FROM purchase_orders WHERE status='Pending' AND branch_id=?", [active_branch_id]).fetchone();
      ctx.pending_po_count = row ? row.c : 0;
    }
    if (!request.path.startsWith('/store')) {
      const { _branch_filter_sql } = require('./routes/alerts');
      const [where, params] = _branch_filter_sql();
      const row = db.execute(`SELECT COUNT(*) c FROM activity_notifications WHERE is_read=0 AND ${where}`, params).fetchone();
      ctx.unread_notifications_count = row ? row.c : 0;
    }
  }
  ctx.has_permission = has_permission;
  return ctx;
});

/* ------------------------------------------------------------------ */
/* App-level routes                                                    */
/* ------------------------------------------------------------------ */
const appBp = new Blueprint('');

// Staff OMS PWA: service worker served from the root path so its default
// scope is the whole app (see static/sw.js).
appBp.route('/sw.js', function service_worker() {
  const r = core.send_file(path.join(BASE_DIR, 'static', 'sw.js'), { mimetype: 'application/javascript' });
  r.headers['Cache-Control'] = 'no-cache';
  return r;
});

appBp.route('/login', ['GET', 'POST'], function login() {
  if (request.method === 'POST') {
    const username = request.form.get('username', '').trim();
    const password = request.form.get('password', '');
    const db = get_db();
    const user = db.execute('SELECT * FROM users WHERE username = ? AND active = 1', [username]).fetchone();
    if (user && check_password_hash(user.password_hash, password)) {
      session.user_id = user.id;
      session.username = user.username;
      session.full_name = user.full_name;
      session.role = user.role;
      session.branch_id = user.branch_id; // NULL for admin
      session.active_branch_id = null; // admin defaults to "All Branches" each login
      session.permissions = String(user.permissions || '').split(',').filter(Boolean);
      flash(`Welcome back, ${user.full_name}!`, 'success');
      return redirect(request.args.get('next') || url_for('dashboard'));
    }
    flash('Incorrect username or password.', 'error');
  }
  return render_template('login.html');
});

appBp.route('/logout', function logout() {
  session.clear();
  flash('You have been logged out.', 'success');
  return redirect(url_for('login'));
});

// Shared "Prescribed By" reference list used by every prescriber dropdown.
appBp.route('/prescribers.json', login_required(function prescribers_json() {
  const rows = get_db().execute('SELECT id, name FROM prescribers ORDER BY name').fetchall();
  return jsonify({ prescribers: rows });
}));

appBp.route('/prescribers/quick-add', ['POST'], login_required(function prescribers_quick_add() {
  const db = get_db();
  const name = request.form.get('name', '').trim();
  if (!name) return [jsonify({ ok: false, error: 'Name cannot be empty.' }), 400];
  const existing = db.execute('SELECT id FROM prescribers WHERE name = ?', [name]).fetchone();
  if (existing) return jsonify({ ok: true, id: existing.id, name });
  const cur = db.execute('INSERT INTO prescribers (name) VALUES (?)', [name]);
  db.commit();
  return jsonify({ ok: true, id: cur.lastrowid, name });
}));

/** Dashboard stats scoped to one branch_id, or all branches when null. */
function _compute_branch_stats(db, branch_id) {
  const bfilter = branch_id ? ' AND branch_id = ?' : '';
  const ofilter = branch_id ? ' AND o.branch_id = ?' : '';
  const p = branch_id ? [branch_id] : [];
  const recent_where = branch_id ? ' WHERE o.branch_id = ?' : '';
  return {
    today_orders: db.execute(`SELECT COUNT(*) c FROM orders WHERE date(order_date) = date('now')${bfilter}`, p).fetchone().c,
    pending_orders: db.execute(`SELECT COUNT(*) c FROM orders WHERE status NOT IN ('Delivered','Cancelled')${bfilter}`, p).fetchone().c,
    total_due: db.execute(`SELECT COALESCE(SUM(i.total - i.amount_paid),0) t FROM invoices i
            JOIN orders o ON o.id = i.order_id
            WHERE i.payment_status != 'Paid'${ofilter}`, p).fetchone().t,
    month_revenue: db.execute(`SELECT COALESCE(SUM(i.total),0) t FROM invoices i
            JOIN orders o ON o.id = i.order_id
            WHERE strftime('%Y-%m', i.created_at) = strftime('%Y-%m','now')${ofilter}`, p).fetchone().t,
    low_stock_frames: db.execute(`SELECT * FROM frames WHERE stock_qty <= low_stock_threshold${bfilter} ORDER BY stock_qty ASC LIMIT 10`, p).fetchall(),
    low_stock_lenses: db.execute(`SELECT * FROM lenses WHERE stock_qty <= low_stock_threshold${bfilter} ORDER BY stock_qty ASC LIMIT 10`, p).fetchall(),
    low_stock_contacts: db.execute(`SELECT * FROM contact_lenses WHERE stock_qty <= low_stock_threshold${bfilter} ORDER BY stock_qty ASC LIMIT 10`, p).fetchall(),
    recent_orders: db.execute(`SELECT o.*, c.name as customer_name FROM orders o
            JOIN customers c ON c.id = o.customer_id
            ${recent_where}
            ORDER BY o.created_at DESC LIMIT 8`, p).fetchall(),
    pending_pos: db.execute(`SELECT COUNT(*) c FROM purchase_orders WHERE status = 'Ordered'${bfilter}`, p).fetchone().c,
  };
}

appBp.route('/', login_required(function dashboard() {
  const db = get_db();
  const active_branch_id = get_active_branch_id();
  const stats = _compute_branch_stats(db, active_branch_id);
  let branch_breakdown = null;
  if (is_all_branches_view()) {
    branch_breakdown = list_branches(db).map((b) => ({ branch: b, stats: _compute_branch_stats(db, b.id) }));
  }
  // Customers & prescriptions are shared across all branches, so checkup
  // reminders are intentionally NOT branch-filtered.
  const { _checkup_due_query } = require('./routes/customers');
  const checkup_due = _checkup_due_query(db, 6);
  let months = parseInt(get_setting('checkup_reminder_months', '12') || '12', 10);
  if (!months) months = 12;
  const checkup_due_total = db.execute(`SELECT COUNT(*) c FROM (
             SELECT c.id FROM customers c JOIN prescriptions p ON p.customer_id = c.id
             GROUP BY c.id
             HAVING date(MAX(COALESCE(p.prescribed_date, p.created_at))) <= date('now', ?)
           )`, [`-${months} months`]).fetchone().c;
  return render_template('dashboard.html', { branch_breakdown, checkup_due, checkup_due_total, ...stats });
}));

/* ------------------------------------------------------------------ */
/* Blueprints                                                          */
/* ------------------------------------------------------------------ */
const BLUEPRINT_MODULES = [
  'customers', 'inventory', 'orders', 'billing', 'settings', 'notifications', 'returns',
  'suppliers', 'branches', 'storefront', 'taxonomy', 'banners', 'brands', 'category_showcase',
  'promotions', 'content_sections', 'side_posters', 'coupons', 'reviews', 'product_groups',
  'membership', 'alerts',
];
const blueprints = [appBp, ...BLUEPRINT_MODULES.map((m) => require(`./routes/${m}`).bp)];

/* ------------------------------------------------------------------ */
/* Express wiring                                                      */
/* ------------------------------------------------------------------ */
const app = express();
app.set('query parser', 'simple');
app.set('trust proxy', true);
app.disable('x-powered-by');

if (storage.UPLOAD_STATIC !== storage.REPO_STATIC) {
  // Newly uploaded files (temp folder on Vercel) take priority over the repo copy.
  app.use('/static', express.static(storage.UPLOAD_STATIC, { fallthrough: true }));
}
app.use('/static', express.static(storage.REPO_STATIC, { fallthrough: true }));
if (mongosync.enabled()) {
  // An upload this instance hasn't seen yet: fetch it from MongoDB once.
  app.get('/static/uploads/*', (req, res, next) => {
    mongosync.fetchUpload(req.path.replace(/^\/static\//, ''))
      .then((p) => (p ? res.sendFile(p) : next()))
      .catch(next);
  });
}

app.use(cookieSession({
  name: 'session',
  keys: [SECRET_KEY],
  httpOnly: true,
  sameSite: 'lax',
}));

app.use(express.urlencoded({ extended: false, limit: MAX_CONTENT_LENGTH, parameterLimit: 100000 }));
app.use(express.json({ limit: MAX_CONTENT_LENGTH }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CONTENT_LENGTH, fieldSize: MAX_CONTENT_LENGTH } });
app.use((req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  upload.any()(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send(errorPage(413, 'Request Entity Too Large'));
      return next(err);
    }
    return next();
  });
});

// Request context (Flask's request/session/g globals)
app.use((req, res, next) => {
  const files = new MultiDict();
  for (const f of req.files || []) files.add(f.fieldname, new FileStorage(f));
  const isJson = req.is('application/json');
  const ctx = {
    req, res, g: {},
    args: new MultiDict(req.query || {}),
    form: new MultiDict(isJson || !req.body ? {} : req.body),
    files,
  };
  res.on('close', () => close_db(ctx));
  als.run(ctx, () => next());
});

const STATUS_TEXT = {
  400: ['Bad Request', 'The browser (or proxy) sent a request that this server could not understand.'],
  403: ['Forbidden', "You don't have the permission to access the requested resource."],
  404: ['Not Found', 'The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.'],
  405: ['Method Not Allowed', 'The method is not allowed for the requested URL.'],
  413: ['Request Entity Too Large', 'The data value transmitted exceeds the capacity limit.'],
  500: ['Internal Server Error', 'The server encountered an internal error and was unable to complete your request.'],
  503: ['Service Unavailable', 'The service is temporarily busy. Please try again in a moment.'],
};
function errorPage(code, description) {
  const [title, dflt] = STATUS_TEXT[code] || ['Error', ''];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>\n<html lang=en>\n<title>${code} ${title}</title>\n<h1>${title}</h1>\n<p>${esc(description || dflt)}</p>\n`;
}

function sendResult(res, result) {
  let status = null; let headers = {};
  if (Array.isArray(result) && result.length >= 2 && result.length <= 3 && typeof result[1] === 'number') {
    headers = result[2] || {};
    status = result[1];
    result = result[0];
  }
  if (result instanceof Response) {
    const r = result;
    for (const [name, value, opts] of r.cookies) {
      const o = { httpOnly: !!opts.httponly, path: opts.path || '/', sameSite: opts.samesite ? String(opts.samesite).toLowerCase() : undefined };
      if (opts.max_age !== undefined) o.maxAge = opts.max_age * 1000;
      if (opts.secure) o.secure = true;
      if (opts.max_age === 0) res.clearCookie(name, { path: o.path }); else res.cookie(name, value, o);
    }
    res.status(status || r.status);
    res.set(Object.assign({}, r.headers, headers));
    if (r.file) {
      const opts = {};
      if (r.file.mimetype) res.type(r.file.mimetype);
      const done = (err) => {
        for (const fn of r.after) { try { fn(); } catch (_) { /* ignore */ } }
        if (err && !res.headersSent) res.status(404).send(errorPage(404));
      };
      if (r.file.as_attachment) return res.download(r.file.path, r.file.download_name || path.basename(r.file.path), opts, done);
      return res.sendFile(path.resolve(r.file.path), opts, done);
    }
    if (!res.get('Content-Type')) res.type('html');
    return res.send(r.body === undefined || r.body === null ? '' : r.body);
  }
  if (typeof result === 'string') {
    res.status(status || 200).set(headers);
    if (!res.get('Content-Type')) res.type('html');
    return res.send(result);
  }
  if (result && typeof result === 'object') {
    return res.status(status || 200).set(headers).json(result);
  }
  throw new Error('View function did not return a valid response.');
}

function handleError(err, res) {
  if (err instanceof HTTPError) {
    if (!res.headersSent) res.status(err.code).type('html').send(errorPage(err.code, err.description));
    return;
  }
  console.error(err);
  if (!res.headersSent) {
    res.status(500).type('html').send(DEBUG
      ? `<pre>${String(err && err.stack ? err.stack : err).replace(/</g, '&lt;')}</pre>`
      : errorPage(500));
  }
}

// Register all blueprint routes, grouping methods per rule so an unmatched
// method answers 405 (like Flask) instead of 404.
const rules = new Map();
for (const bp of blueprints) {
  for (const r of bp.routes) {
    const key = r.rule;
    if (!rules.has(key)) rules.set(key, []);
    rules.get(key).push({ ...r, bp });
  }
}
// Static rules before dynamic ones, so "/orders/new" wins over "/orders/<id>".
const ruleKeys = [...rules.keys()].sort((a, b) => {
  const da = (a.match(/</g) || []).length; const dbb = (b.match(/</g) || []).length;
  return da - dbb;
});
for (const rule of ruleKeys) {
  const handlers = rules.get(rule);
  const { expr, converters } = flaskRuleToExpress(rule);
  const variants = [expr];
  // Flask: a rule ending in "/" also answers without the trailing slash (via redirect).
  if (expr.length > 1 && expr.endsWith('/')) variants.push(expr.slice(0, -1));
  app.all(variants, (req, res, next) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const h = handlers.find((x) => x.methods.includes(method)) ||
      (method === 'OPTIONS' ? null : undefined);
    if (rule.endsWith('/') && rule.length > 1 && !req.path.endsWith('/')) {
      const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(308, req.path + '/' + q);
    }
    if (!h) {
      res.set('Allow', [...new Set(handlers.flatMap((x) => x.methods)), 'HEAD', 'OPTIONS'].join(', '));
      if (method === 'OPTIONS') return res.status(200).end();
      return res.status(405).type('html').send(errorPage(405));
    }
    const ctx = core.current();
    ctx.endpoint = h.endpoint;
    const params = {};
    for (const [name, conv] of Object.entries(converters)) {
      const v = req.params[name];
      params[name] = conv === 'int' ? parseInt(v, 10) : conv === 'float' ? parseFloat(v) : v;
    }
    ctx.viewArgs = params;
    (async () => {
      await ready;
      if (mongosync.enabled()) {
        ctx.syncTok = await mongosync.beginRequest(!['GET', 'HEAD', 'OPTIONS'].includes(method));
      }
      let result;
      try {
        for (const before of h.bp.befores) {
          const r = await before();
          if (r !== undefined && r !== null) { result = r; break; }
        }
        if (result === undefined) result = await h.handler(params);
      } catch (err) {
        close_db(ctx);
        if (ctx.syncTok) await mongosync.endRequest(ctx.syncTok, { failed: true });
        throw err;
      }
      if (ctx.syncTok) {
        // Save to MongoDB BEFORE responding (serverless may freeze afterwards).
        close_db(ctx);
        const saved = await mongosync.endRequest(ctx.syncTok);
        if (!saved) {
          return res.status(503).type('html').send(errorPage(503,
            'Your change could not be saved because someone else saved at the same moment. Please go back and try again.'));
        }
      }
      return sendResult(res, result);
    })().catch((err) => {
      if (err && err.code === 'OMS_BUSY') return res.status(503).type('html').send(errorPage(503, err.message));
      return handleError(err, res);
    });
    return undefined;
  });
}

app.use((req, res) => res.status(404).type('html').send(errorPage(404)));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => handleError(err, res));

if (require.main === module) {
  const port = parseInt(process.env.PORT || '5000', 10);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Optical Shop OMS running on http://localhost:${port}`);
  });
}

module.exports = app;
