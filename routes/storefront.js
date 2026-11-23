'use strict';
/**
 * Public online store - browse ready-stock Frames, Sunglasses and Contact
 * Lenses, add to cart, checkout (Cash on Pickup / Delivery, or Pay Online
 * once Razorpay keys are configured). Every online order lands in the SAME
 * orders/order_items/customers tables the staff app uses (source='online').
 *
 * No staff login here - this blueprint is public. A separate lightweight
 * "online_customers" login (session.online_customer_id) lets repeat
 * customers see their orders; checkout never requires an account.
 */
const crypto = require('node:crypto');
const { Blueprint, request, session, redirect, url_for, flash, jsonify, pyInt, pyFloat,
  generate_password_hash, check_password_hash } = require('../lib/core');
const { render_template, context_processor } = require('../lib/render');
const py = require('../lib/py');
const { get_db, get_setting, next_number } = require('../db');
const { validate_coupon, record_coupon_usage } = require('./coupons');
const membership = require('./membership');
const reviews = require('./reviews');
const { create_notification } = require('./alerts');
const mongosync = require('../lib/mongosync');

const bp = new Blueprint('store', { url_prefix: '/store' });

const CART_SESSION_KEY = 'store_cart'; // [{item_type, item_id, qty}]
const COUPON_SESSION_KEY = 'store_coupon_code';
const POINTS_SESSION_KEY = 'store_points_redeem';

/* ---------------- signup validation (server-side, authoritative) ---------------- */
const SIGNUP_NAME_RE = /^[A-Za-z ]+$/;
const SIGNUP_PHONE_RE = /^[0-9]{10}$/;
const SIGNUP_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function _validate_signup_fields(name, phone, email, password) {
  const errors = [];
  if (name.length < 2 || !SIGNUP_NAME_RE.test(name)) errors.push('Full name must be at least 2 characters and contain only letters and spaces.');
  if (!SIGNUP_PHONE_RE.test(phone)) errors.push('Phone number must be exactly 10 digits.');
  if (email && !SIGNUP_EMAIL_RE.test(email)) errors.push('Please enter a valid email address.');
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.');
  }
  return errors;
}

const token_hex = (n) => crypto.randomBytes(n).toString('hex');

function compare_digest(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Per-session CSRF token for the signup/review forms. */
function _get_csrf_token() {
  let token = session.get('_csrf_token');
  if (!token) {
    token = token_hex(24);
    session._csrf_token = token;
  }
  return token;
}

function _valid_csrf(submitted) {
  const expected = session.get('_csrf_token');
  return !!expected && !!submitted && compare_digest(submitted, expected);
}

/** Only local paths are allowed as a post-login redirect target. */
function _safe_next_url(next_url) {
  if (next_url && next_url.startsWith('/') && !next_url.startsWith('//')) return next_url;
  return null;
}

function _store_enabled() {
  return get_setting('store_enabled', '1') === '1';
}

bp.before_request(function _check_store_enabled() {
  if (!_store_enabled() && request.endpoint !== 'store.disabled') return redirect(url_for('store.disabled'));
  return undefined;
});

/** Built-in analytics: one site_visits row per storefront request. Best-effort. */
bp.before_request(async function _log_site_visit() {
  const forwarded = request.headers.get('X-Forwarded-For', '');
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.remote_addr;
  if (mongosync.enabled()) {
    // MongoDB mode: one small document per visit instead of re-saving the DB.
    try {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      await mongosync.logVisit({
        path: request.path, ip_address: ip,
        user_agent: String(request.headers.get('User-Agent', '') || '').slice(0, 255),
        referrer: request.referrer, online_customer_id: session.get('online_customer_id') ?? null,
        visited_at: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
      });
    } catch (_) { /* best-effort */ }
    return undefined;
  }
  try {
    const db = get_db();
    db.execute(`INSERT INTO site_visits (path, ip_address, user_agent, referrer, online_customer_id)
               VALUES (?,?,?,?,?)`, [request.path, ip, String(request.headers.get('User-Agent', '') || '').slice(0, 255),
      request.referrer, session.get('online_customer_id')]);
    db.commit();
  } catch (_) {
    try { get_db().rollback(); } catch (__) { /* ignore */ }
  }
  return undefined;
});

bp.route('/closed', function disabled() {
  return render_template('store/disabled.html');
});

/* ---------------- helpers ---------------- */
function _table_for(item_type) {
  return { frame: 'frames', contact_lens: 'contact_lenses' }[item_type] || null;
}

function _wishlist_count(db, customer_id) {
  if (!customer_id) return 0;
  const row = db.execute('SELECT COUNT(*) AS n FROM wishlist_items WHERE customer_id=?', [customer_id]).fetchone();
  return row ? row.n : 0;
}

/** Saved items as an object keyed "item_type,item_id" - the template's
 *  `('frame', f['id']) in wishlist_ids` stringifies the tuple the same way. */
function _wishlist_ids(db, customer_id) {
  const out = {};
  if (!customer_id) return out;
  for (const r of db.execute('SELECT item_type, item_id FROM wishlist_items WHERE customer_id=?', [customer_id]).fetchall()) {
    out[`${r.item_type},${r.item_id}`] = true;
  }
  return out;
}

// Shop-by-Gender: Men/Women include Unisex, Kids is Kids-only.
const GENDER_FILTER_VALUES = { men: ['Men', 'Unisex'], women: ['Women', 'Unisex'], kids: ['Kids'] };

function _normalize_gender(raw) {
  const g = String(raw || 'all').trim().toLowerCase();
  return g in GENDER_FILTER_VALUES ? g : 'all';
}

// Sort whitelist - ORDER BY is never built from raw input.
const SORT_OPTIONS = {
  brand: 'brand COLLATE NOCASE ASC',
  price_low: 'selling_price ASC',
  price_high: 'selling_price DESC',
  newest: 'id DESC',
};
const SORT_LABELS = {
  brand: 'Brand: A to Z',
  price_low: 'Price: Low to High',
  price_high: 'Price: High to Low',
  newest: 'Newest First',
};

function _normalize_sort(raw) {
  const s = String(raw || 'brand').trim().toLowerCase();
  return s in SORT_OPTIONS ? s : 'brand';
}

function _parse_price(raw) {
  if (raw === null || raw === undefined) return null;
  raw = String(raw).trim();
  if (!raw) return null;
  let v;
  try { v = pyFloat(raw); } catch (_) { return null; }
  return v >= 0 ? v : null;
}

function _default_branch_id(db) {
  const configured = get_setting('store_default_branch_id', '');
  if (configured) return pyInt(configured);
  const row = db.execute('SELECT id FROM branches ORDER BY id LIMIT 1').fetchone();
  return row ? row.id : null;
}

function _get_cart() {
  const c = session.get(CART_SESSION_KEY, []);
  return Array.isArray(c) ? c : [];
}

function _save_cart(cart) {
  session[CART_SESSION_KEY] = cart;
}

function _cart_count() {
  return _get_cart().reduce((s, l) => s + l.qty, 0);
}

/** Resolve the session cart against live rows (price/stock); drops lines no
 *  longer available. */
function _cart_details(db) {
  const details = [];
  let changed = false;
  for (const line of _get_cart()) {
    const table = _table_for(line.item_type);
    if (!table) { changed = true; continue; }
    const row = db.execute(`SELECT * FROM ${table} WHERE id=? AND online_visible=1 AND is_active=1`, [line.item_id]).fetchone();
    if (!row) { changed = true; continue; }
    const qty = row.stock_qty > 0 ? Math.min(line.qty, row.stock_qty) : 0;
    if (qty <= 0) { changed = true; continue; }
    if (qty !== line.qty) changed = true;
    const label = line.item_type === 'frame'
      ? `${row.brand} ${row.model || ''} ${row.color || ''}`.trim()
      : `${row.brand} ${row.lens_type || ''} ${row.power || ''}`.trim();
    details.push({
      item_type: line.item_type, item_id: row.id, label, price: row.selling_price, qty,
      stock_qty: row.stock_qty, image_path: row.image_path, total: row.selling_price * qty,
    });
  }
  if (changed) _save_cart(details.map((d) => ({ item_type: d.item_type, item_id: d.item_id, qty: d.qty })));
  return details;
}

function _cart_grand_total(details) {
  return details.reduce((s, d) => s + d.total, 0);
}

/** customers.id for coupon/membership previews - only for logged-in shoppers. */
function _applied_coupon_customer_id(db) {
  const oc = _current_online_customer(db);
  return oc ? oc.customer_id : null;
}

/** Re-validates the session coupon against the CURRENT cart on every read. */
function _applied_coupon(db, details) {
  const code = session.get(COUPON_SESSION_KEY);
  if (!code) return [null, 0, null];
  const [coupon, discount, error] = validate_coupon(db, code, details, _applied_coupon_customer_id(db));
  if (error) {
    session.pop(COUPON_SESSION_KEY);
    return [null, 0, error];
  }
  return [coupon, discount, null];
}

/** Re-validates the session points request on every read. [used, discount] */
function _applied_points(db, customer_id, payable_before_points) {
  let requested = session.get(POINTS_SESSION_KEY);
  if (!requested || !customer_id) return [0.0, 0.0];
  try { requested = pyFloat(requested); } catch (_) {
    session.pop(POINTS_SESSION_KEY);
    return [0.0, 0.0];
  }
  return membership.resolve_points_redemption(db, customer_id, requested, payable_before_points);
}

function _shop_ctx() {
  const db = get_db();
  const online_customer = _current_online_customer(db);
  return {
    shop_name: get_setting('shop_name', 'My Optical Shop'),
    shop_phone: get_setting('shop_phone', ''),
    shop_address: get_setting('shop_address', ''),
    store_tagline: get_setting('store_tagline', ''),
    cart_count: _cart_count(),
    currency: get_setting('currency_symbol', 'Rs.'),
    online_customer,
    banner_image: get_setting('store_banner_image', ''),
    banner_link: get_setting('store_banner_link', ''),
    wishlist_count: online_customer ? _wishlist_count(db, online_customer.customer_id) : 0,
  };
}

// "Visit Us" branch list on every storefront page.
context_processor(function _inject_store_branches() {
  return { store_branches: get_db().execute('SELECT id, name, address, phone FROM branches ORDER BY name').fetchall() };
}, 'store');

// Brands mega-menu, grouped by first letter.
context_processor(function _inject_store_brands() {
  const rows = get_db().execute(`SELECT DISTINCT brand FROM (
             SELECT brand FROM frames WHERE online_visible=1 AND is_active=1 AND stock_qty > 0
             UNION
             SELECT brand FROM contact_lenses WHERE online_visible=1 AND is_active=1 AND stock_qty > 0
           ) WHERE brand IS NOT NULL AND TRIM(brand) != '' ORDER BY brand COLLATE NOCASE`).fetchall();
  const grouped = [];
  let current = null;
  for (const r of rows) {
    const letter = String(r.brand)[0].toUpperCase();
    if (letter !== current) { grouped.push({ letter, brands: [] }); current = letter; }
    grouped[grouped.length - 1].brands.push(r.brand);
  }
  return { store_brands_grouped: grouped };
}, 'store');

/* ---------------- homepage sections ---------------- */
function _active_banners(db) {
  const today = py.todayIso();
  return db.execute(`SELECT * FROM homepage_banners
           WHERE is_active = 1
             AND (start_date IS NULL OR start_date <= ?)
             AND (end_date IS NULL OR end_date >= ?)
           ORDER BY display_order, id`, [today, today]).fetchall();
}

function _active_side_posters(db) {
  const out = {};
  for (const r of db.execute('SELECT * FROM side_posters WHERE is_active = 1 AND image_path IS NOT NULL').fetchall()) out[r.side] = r;
  return out;
}

const _FLAG_COLUMNS = new Set(['is_best_seller', 'is_new_arrival', 'is_featured']);

function _flagged_products(db, flag_column, limit = 12) {
  if (!_FLAG_COLUMNS.has(flag_column)) throw new Error('bad flag column');
  const frames = db.execute(`SELECT id, brand, model, selling_price, image_path FROM frames
            WHERE online_visible=1 AND is_active=1 AND stock_qty > 0 AND ${flag_column}=1
            ORDER BY id DESC LIMIT ?`, [limit]).fetchall();
  const contacts = db.execute(`SELECT id, brand, lens_type, selling_price, image_path FROM contact_lenses
            WHERE online_visible=1 AND is_active=1 AND stock_qty > 0 AND ${flag_column}=1
            ORDER BY id DESC LIMIT ?`, [limit]).fetchall();
  return [
    ...frames.map((f) => ({ item_type: 'frame', id: f.id, title: `${f.brand} ${f.model || ''}`.trim(), price: f.selling_price, image_path: f.image_path })),
    ...contacts.map((c) => ({ item_type: 'contact_lens', id: c.id, title: `${c.brand} ${c.lens_type || ''}`.trim(), price: c.selling_price, image_path: c.image_path })),
  ].slice(0, limit);
}

const _active_trust_items = (db) => db.execute('SELECT * FROM trust_items WHERE is_active=1 ORDER BY display_order, id').fetchall();
const _active_store_services = (db) => db.execute('SELECT * FROM store_services WHERE is_active=1 ORDER BY display_order, id').fetchall();
const _active_promotions = (db) => db.execute('SELECT * FROM promotions WHERE is_active=1 ORDER BY display_order, id').fetchall();
const _active_categories_with_image = (db, limit = 12) => db.execute(`SELECT * FROM categories WHERE is_active=1 AND image_path IS NOT NULL
           ORDER BY display_order, name COLLATE NOCASE LIMIT ?`, [limit]).fetchall();
const _active_brands_with_logo = (db, limit = 16) => db.execute(`SELECT * FROM brands WHERE is_active=1 AND logo_path IS NOT NULL
           ORDER BY display_order, name COLLATE NOCASE LIMIT ?`, [limit]).fetchall();

function genderFragments(gender) {
  if (gender === 'all') return { gf: '', gfp: [], gc: '', gcp: [] };
  const allowed = GENDER_FILTER_VALUES[gender];
  const ph = allowed.map(() => '?').join(',');
  return {
    gf: ` AND COALESCE(g.name, 'Unisex') IN (${ph})`, gfp: [...allowed],
    gc: ` AND COALESCE(gender, 'Unisex') IN (${ph})`, gcp: [...allowed],
  };
}

/** Brand facet values - every active filter EXCEPT brand itself. */
function _available_brands(db, category, gender, q) {
  const { gf, gfp, gc, gcp } = genderFragments(gender);
  const names = new Set();
  if (category !== 'contact_lens') {
    let where = 'frames.online_visible=1 AND frames.is_active=1 AND frames.stock_qty > 0';
    const params = [];
    if (category === 'Eyeglasses' || category === 'Sunglasses') { where += ' AND category = ?'; params.push(category); }
    if (q) {
      const like = `%${q}%`;
      where += ' AND (brand LIKE ? OR model LIKE ? OR color LIKE ? OR category LIKE ?)';
      params.push(like, like, like, like);
    }
    where += gf;
    params.push(...gfp);
    for (const r of db.execute(`SELECT DISTINCT brand FROM frames LEFT JOIN genders g ON g.id = frames.gender_id WHERE ${where}`, params).fetchall()) {
      if (r.brand) names.add(r.brand);
    }
  }
  if (category === 'all' || category === 'contact_lens') {
    let where = 'online_visible=1 AND is_active=1 AND stock_qty > 0';
    const params = [];
    if (q) {
      const like = `%${q}%`;
      where += ' AND (brand LIKE ? OR lens_type LIKE ? OR power LIKE ?)';
      params.push(like, like, like);
    }
    where += gc;
    params.push(...gcp);
    for (const r of db.execute(`SELECT DISTINCT brand FROM contact_lenses WHERE ${where}`, params).fetchall()) {
      if (r.brand) names.add(r.brand);
    }
  }
  return [...names].sort((a, b) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
}

/* ---------------- product image galleries ---------------- */
/** {item_id: image_path} of the SECOND gallery image (desktop hover swap). */
function _second_images_for(db, item_type, ids) {
  if (!ids.length) return {};
  const rows = db.execute(`SELECT item_id, image_path, sort_order,
               ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY sort_order, id) AS rn
            FROM product_images WHERE item_type=? AND item_id IN (${ids.map(() => '?').join(',')})`, [item_type, ...ids]).fetchall();
  const out = {};
  for (const r of rows) if (r.rn === 2) out[r.item_id] = r.image_path;
  return out;
}

/** {item_id: [image_path, ...]} - full ordered gallery per item. */
function _gallery_images_for(db, item_type, ids) {
  if (!ids.length) return {};
  const rows = db.execute(`SELECT item_id, image_path FROM product_images
            WHERE item_type=? AND item_id IN (${ids.map(() => '?').join(',')}) ORDER BY item_id, sort_order, id`, [item_type, ...ids]).fetchall();
  const out = {};
  for (const r of rows) (out[r.item_id] = out[r.item_id] || []).push(r.image_path);
  return out;
}

/* ---------------- Product Variants ---------------- */
/**
 * Collapse frames sharing an ACTIVE product_group_id into one representative
 * card. Returns [deduped, swatches_by_frame_id, price_from_by_frame_id].
 */
function _dedupe_grouped_frames(db, frames) {
  const groups = new Map();
  for (const f of frames) {
    const gid = f.product_group_id ?? null;
    if (gid !== null) {
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid).push(f);
    }
  }
  if (!groups.size) return [frames, {}, {}];
  const gids = [...groups.keys()];
  const active = {};
  for (const r of db.execute(`SELECT id, is_active FROM product_groups WHERE id IN (${gids.map(() => '?').join(',')})`, gids).fetchall()) active[r.id] = r.is_active;

  const repFor = new Map();
  const swatches = {};
  const price_from = {};
  for (const [gid, variants] of groups) {
    if (!active[gid]) continue;
    const sorted = [...variants].sort((a, b) => {
      const ga = a.grouped_at || ''; const gb = b.grouped_at || '';
      if (ga !== gb) return ga < gb ? -1 : 1;
      return a.id - b.id;
    });
    const rep = sorted[0];
    repFor.set(gid, rep);
    const prices = variants.map((v) => v.selling_price);
    if (Math.min(...prices) !== Math.max(...prices)) price_from[rep.id] = Math.min(...prices);
    swatches[rep.id] = sorted.map((v) => ({ id: v.id, color: v.color, image_path: v.image_path }));
  }
  const result = [];
  const emitted = new Set();
  for (const f of frames) {
    const gid = f.product_group_id ?? null;
    if (gid === null || !repFor.has(gid)) { result.push(f); continue; }
    if (emitted.has(gid)) continue;
    emitted.add(gid);
    result.push(repFor.get(gid));
  }
  return [result, swatches, price_from];
}

/* ---------------- "You May Also Like" (Cart / Checkout) ---------------- */
const RECO_LIMIT = 12;
const RECO_POOL_TTL_SECONDS = 300;
const _RECO_POOL_CACHE = new Map(); // token -> [timestamp, pool]

function _reco_session_token() {
  let token = session.get('_reco_token');
  if (!token) {
    token = token_hex(10);
    session._reco_token = token;
  }
  return token;
}

function _recommendation_pool(db) {
  const token = _reco_session_token();
  const now = Date.now() / 1000;
  const cached = _RECO_POOL_CACHE.get(token);
  if (cached && (now - cached[0]) < RECO_POOL_TTL_SECONDS) return cached[1];

  const frames = db.execute(`SELECT id, brand, model, color, category, selling_price, stock_qty,
                  low_stock_threshold, image_path FROM frames
           WHERE online_visible=1 AND is_active=1 AND stock_qty > 0`).fetchall();
  const contacts = db.execute(`SELECT id, brand, lens_type, power, selling_price, stock_qty,
                  low_stock_threshold, image_path FROM contact_lenses
           WHERE online_visible=1 AND is_active=1 AND stock_qty > 0`).fetchall();
  const pool = [
    ...frames.map((r) => ({
      item_type: 'frame', id: r.id, brand: r.brand, model: r.model, color: r.color, category: r.category,
      price: r.selling_price, stock_qty: r.stock_qty, low_stock_threshold: r.low_stock_threshold, image_path: r.image_path,
    })),
    ...contacts.map((r) => ({
      item_type: 'contact_lens', id: r.id, brand: r.brand, model: r.lens_type, color: r.power, category: null,
      price: r.selling_price, stock_qty: r.stock_qty, low_stock_threshold: r.low_stock_threshold, image_path: r.image_path,
    })),
  ];
  if (_RECO_POOL_CACHE.size > 3000) {
    const oldest = [..._RECO_POOL_CACHE.entries()].sort((a, b) => a[1][0] - b[1][0]).slice(0, 1500);
    for (const [k] of oldest) _RECO_POOL_CACHE.delete(k);
  }
  _RECO_POOL_CACHE.set(token, [now, pool]);
  return pool;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _recommended_products(db, cart_details, limit = RECO_LIMIT) {
  const pool = _recommendation_pool(db);
  const inCart = new Set(cart_details.map((d) => `${d.item_type},${d.item_id}`));
  const chosen = shuffle(pool.filter((p) => !inCart.has(`${p.item_type},${p.id}`))).slice(0, limit);
  const hover = {};
  for (const t of ['frame', 'contact_lens']) {
    const ids = chosen.filter((p) => p.item_type === t).map((p) => p.id);
    if (ids.length) hover[t] = _second_images_for(db, t, ids);
  }
  return chosen.map((p) => ({
    ...p,
    hover_image: (hover[p.item_type] || {})[p.id] ?? null,
    stock_label: p.stock_qty <= (p.low_stock_threshold || 0) ? 'Low Stock' : 'In Stock',
    detail_url: url_for('store.product_detail', { item_type: p.item_type, item_id: p.id }),
  }));
}

/* ---------------- product reviews ---------------- */
const REVIEWS_PER_PAGE = 10;

/** Identity used to prevent double "Helpful" votes. */
function _voter_key(db) {
  const oc = _current_online_customer(db);
  if (oc) return `oc:${oc.id}`;
  let key = session.get('_review_voter_key');
  if (!key) {
    key = token_hex(16);
    session._review_voter_key = key;
  }
  return key;
}

function _reviews_for_product(db, item_type, item_id) {
  const summary = reviews.rating_summary(db, item_type, item_id);
  const a = request.args;
  const sort = a.get('sort', 'recent');
  const star_filter = a.get('rating', '');
  const photos_only = a.get('photos') === '1';
  let page = Math.max(1, a.get('page', 1, { type: pyInt }) || 1);

  let sql = "SELECT * FROM product_reviews WHERE item_type=? AND item_id=? AND status='approved'";
  const params = [item_type, item_id];
  if (['1', '2', '3', '4', '5'].includes(star_filter)) { sql += ' AND rating=?'; params.push(parseInt(star_filter, 10)); }
  if (photos_only) sql += " AND id IN (SELECT review_id FROM review_media WHERE media_type='image')";
  const order_map = {
    recent: ' ORDER BY created_at DESC, id DESC',
    highest: ' ORDER BY rating DESC, created_at DESC',
    lowest: ' ORDER BY rating ASC, created_at DESC',
    helpful: ' ORDER BY helpful_count DESC, created_at DESC',
  };
  sql += order_map[sort] || order_map.recent;
  const matching = db.execute(sql, params).fetchall();

  const total_filtered = matching.length;
  const total_pages = Math.max(1, Math.ceil(total_filtered / REVIEWS_PER_PAGE));
  page = Math.min(page, total_pages);
  const start = (page - 1) * REVIEWS_PER_PAGE;
  const page_rows = matching.slice(start, start + REVIEWS_PER_PAGE);

  const media_by_review = {};
  const ids = page_rows.map((r) => r.id);
  let voted = new Set();
  const voter_key = _voter_key(db);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const m of db.execute(`SELECT * FROM review_media WHERE review_id IN (${ph}) ORDER BY sort_order, id`, ids).fetchall()) {
      (media_by_review[m.review_id] = media_by_review[m.review_id] || []).push(m);
    }
    voted = new Set(db.execute(`SELECT review_id FROM review_helpful_votes WHERE voter_key=? AND review_id IN (${ph})`, [voter_key, ...ids])
      .fetchall().map((r) => r.review_id));
  }
  const list = page_rows.map((r) => ({
    review: r,
    images: (media_by_review[r.id] || []).filter((m) => m.media_type === 'image'),
    videos: (media_by_review[r.id] || []).filter((m) => m.media_type === 'video'),
    voted_helpful: voted.has(r.id),
  }));

  const oc = _current_online_customer(db);
  let my_review = null;
  let can_review = false;
  if (oc) {
    my_review = reviews.existing_review(db, oc.customer_id, item_type, item_id);
    if (!my_review) can_review = !!reviews.eligible_order_for_review(db, oc.customer_id, item_type, item_id);
  }
  return {
    review_summary: summary,
    reviews: list,
    review_sort: sort,
    review_rating_filter: star_filter,
    review_photos_only: photos_only,
    review_page: page,
    review_total_pages: total_pages,
    review_total_filtered: total_filtered,
    my_review,
    can_review,
    review_settings: reviews.get_review_settings(),
    review_csrf_token: _get_csrf_token(),
    review_edit_open: my_review ? reviews.within_edit_window(my_review) : false,
  };
}

bp.route('/review/submit', ['POST'], function review_submit() {
  const db = get_db();
  const f = request.form;
  const item_type = f.get('item_type', '');
  const item_id = f.get('item_id', null, { type: pyInt });
  const table = _table_for(item_type);
  const redirect_url = table && item_id ? url_for('store.product_detail', { item_type, item_id }) : url_for('store.home');

  if (!_valid_csrf(f.get('csrf_token', ''))) {
    flash('Your session expired - please try submitting the review again.', 'error');
    return redirect(redirect_url + '#write-review');
  }
  const oc = _current_online_customer(db);
  if (!oc) {
    flash('Please log in to write a review.', 'error');
    return redirect(url_for('store.login', { next: redirect_url }));
  }
  if (!table || !item_id || !db.execute(`SELECT id FROM ${table} WHERE id=?`, [item_id]).fetchone()) {
    flash('Product not found.', 'error');
    return redirect(url_for('store.home'));
  }
  if (reviews.existing_review(db, oc.customer_id, item_type, item_id)) {
    flash("You've already reviewed this product. You can edit your existing review instead.", 'error');
    return redirect(redirect_url + '#reviews');
  }
  const eligible = reviews.eligible_order_for_review(db, oc.customer_id, item_type, item_id);
  if (!eligible) {
    flash('Only customers who have purchased and received this product can write a review.', 'error');
    return redirect(redirect_url + '#reviews');
  }
  const settings = reviews.get_review_settings();
  let rating;
  try { rating = pyInt(f.get('rating', '0')); } catch (_) { rating = 0; }
  if (rating < 1 || rating > 5) {
    flash('Please select a star rating from 1 to 5.', 'error');
    return redirect(redirect_url + '#write-review');
  }
  const title = reviews.clean_text(f.get('title', ''), 150);
  const body = reviews.clean_text(f.get('body', ''), 4000);
  const min_len = parseInt(settings.review_min_length || '0', 10) || 0;
  if (!title) {
    flash('Please add a review title.', 'error');
    return redirect(redirect_url + '#write-review');
  }
  if (body.length < min_len) {
    flash(`Your review must be at least ${min_len} characters long.`, 'error');
    return redirect(redirect_url + '#write-review');
  }
  // Rate-limit only valid, about-to-be-inserted submissions.
  if (reviews.rate_limited(`review_submit:${oc.id}`, 20)) {
    flash("You're submitting too quickly - please wait a moment and try again.", 'error');
    return redirect(redirect_url + '#write-review');
  }

  const is_anonymous = f.get('is_anonymous') ? 1 : 0;
  const display_name = is_anonymous ? null : oc.name;
  const status = settings.review_auto_approve === '1' ? 'approved' : 'pending';
  const cur = db.execute(`INSERT INTO product_reviews
           (item_type, item_id, customer_id, online_customer_id, order_id, rating, title, body,
            display_name, is_anonymous, is_verified_purchase, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`, [item_type, item_id, oc.customer_id, oc.id, eligible.id, rating, title, body,
    display_name, is_anonymous, status]);
  const review_id = cur.lastrowid;

  const upload_errors = [];
  if (settings.review_allow_images === '1') {
    const images = request.files.getlist('images').filter((x) => x && x.filename).slice(0, reviews.MAX_REVIEW_IMAGES);
    images.forEach((file, order) => {
      const [p, error] = reviews.save_review_file(file, 'image');
      if (error) upload_errors.push(error);
      else if (p) db.execute('INSERT INTO review_media (review_id, media_type, file_path, sort_order) VALUES (?,?,?,?)', [review_id, 'image', p, order]);
    });
  }
  if (settings.review_allow_videos === '1') {
    const video = request.files.get('video');
    if (video && video.filename) {
      const [p, error] = reviews.save_review_file(video, 'video');
      if (error) upload_errors.push(error);
      else if (p) db.execute('INSERT INTO review_media (review_id, media_type, file_path, sort_order) VALUES (?,?,?,0)', [review_id, 'video', p]);
    }
  }

  const product = db.execute(`SELECT brand FROM ${table} WHERE id=?`, [item_id]).fetchone();
  const reviewer = is_anonymous ? 'Someone' : oc.name;
  create_notification(db, 'review_submitted', `New ${rating}★ review submitted`,
    `${reviewer} reviewed ${product ? product.brand : 'a product'} - ${title}` + (status === 'approved' ? '' : ' (pending approval)'),
    { link_url: url_for('reviews.index'), related_type: 'review', related_id: review_id });
  db.commit();
  // CSRF token deliberately NOT rotated here (one-review-per-product is already enforced).
  for (const e of upload_errors) flash(e, 'error');
  if (status === 'approved') flash('Thank you for your review!', 'success');
  else flash('Thank you! Your review has been submitted and will appear after a quick check by our team.', 'success');
  const popup = settings.google_review_popup_enabled === '1' && settings.google_review_url ? '1' : '0';
  return redirect(`${redirect_url}?reviewed=1&popup=${popup}#reviews`);
});

bp.route('/review/<int:review_id>/edit', ['GET', 'POST'], function review_edit({ review_id }) {
  const db = get_db();
  const oc = _current_online_customer(db);
  const review = db.execute('SELECT * FROM product_reviews WHERE id=?', [review_id]).fetchone();
  if (!review || !oc || review.customer_id !== oc.customer_id) {
    flash('Review not found.', 'error');
    return redirect(url_for('store.home'));
  }
  const product_url = url_for('store.product_detail', { item_type: review.item_type, item_id: review.item_id });
  if (!reviews.within_edit_window(review)) {
    flash('The edit window for this review has closed.', 'error');
    return redirect(product_url + '#reviews');
  }
  if (request.method === 'POST') {
    const f = request.form;
    if (!_valid_csrf(f.get('csrf_token', ''))) {
      flash('Your session expired - please try again.', 'error');
      return redirect(url_for('store.review_edit', { review_id }));
    }
    const settings = reviews.get_review_settings();
    let rating;
    try { rating = pyInt(f.get('rating', '0')); } catch (_) { rating = 0; }
    const title = reviews.clean_text(f.get('title', ''), 150);
    const body = reviews.clean_text(f.get('body', ''), 4000);
    const min_len = parseInt(settings.review_min_length || '0', 10) || 0;
    if (rating < 1 || rating > 5 || !title || body.length < min_len) {
      flash(`Please select a rating, add a title, and write at least ${min_len} characters.`, 'error');
      return redirect(url_for('store.review_edit', { review_id }));
    }
    const is_anonymous = f.get('is_anonymous') ? 1 : 0;
    const display_name = is_anonymous ? null : oc.name;
    // Re-moderate on every edit unless auto-approve is on.
    const new_status = settings.review_auto_approve === '1' ? 'approved' : 'pending';
    db.execute(`UPDATE product_reviews SET rating=?, title=?, body=?, display_name=?, is_anonymous=?,
               status=?, edited_at=? WHERE id=?`, [rating, title, body, display_name, is_anonymous, new_status, py.nowStr(), review_id]);
    if (settings.review_allow_images === '1') {
      const existing_count = db.execute("SELECT COUNT(*) c FROM review_media WHERE review_id=? AND media_type='image'", [review_id]).fetchone().c;
      const slots = Math.max(0, reviews.MAX_REVIEW_IMAGES - existing_count);
      const images = request.files.getlist('images').filter((x) => x && x.filename).slice(0, slots);
      let next_order = existing_count;
      for (const file of images) {
        const [p, error] = reviews.save_review_file(file, 'image');
        if (error) { flash(error, 'error'); continue; }
        if (p) {
          db.execute('INSERT INTO review_media (review_id, media_type, file_path, sort_order) VALUES (?,?,?,?)', [review_id, 'image', p, next_order]);
          next_order += 1;
        }
      }
    }
    db.commit();
    flash(new_status === 'approved' ? 'Review updated.' : 'Review updated - it will reappear after a quick check by our team.', 'success');
    return redirect(product_url + '#reviews');
  }
  const images = db.execute("SELECT * FROM review_media WHERE review_id=? AND media_type='image' ORDER BY sort_order, id", [review_id]).fetchall();
  return render_template('store/review_edit.html', { review, images, csrf_token: _get_csrf_token(), ..._shop_ctx() });
});

bp.route('/review/<int:review_id>/helpful', ['POST'], function review_helpful({ review_id }) {
  const db = get_db();
  const review = db.execute("SELECT * FROM product_reviews WHERE id=? AND status='approved'", [review_id]).fetchone();
  if (!review) {
    flash('Review not found.', 'error');
    return redirect(url_for('store.home'));
  }
  const redirect_url = url_for('store.product_detail', { item_type: review.item_type, item_id: review.item_id });
  const anchor = `#review-${review_id}`;
  if (!_valid_csrf(request.form.get('csrf_token', ''))) {
    flash('Your session expired - please try again.', 'error');
    return redirect(redirect_url + anchor);
  }
  const key = _voter_key(db);
  if (db.execute('SELECT 1 FROM review_helpful_votes WHERE review_id=? AND voter_key=?', [review_id, key]).fetchone()) {
    flash("You've already marked this review as helpful.", 'error');
    return redirect(redirect_url + anchor);
  }
  if (reviews.rate_limited(`helpful_vote:${key}`, 2)) {
    flash('Please slow down a little.', 'error');
    return redirect(redirect_url + anchor);
  }
  db.execute('INSERT INTO review_helpful_votes (review_id, voter_key) VALUES (?,?)', [review_id, key]);
  db.execute('UPDATE product_reviews SET helpful_count = helpful_count + 1 WHERE id=?', [review_id]);
  db.commit();
  flash('Thanks for your feedback!', 'success');
  return redirect(redirect_url + anchor);
});

/* ---------------- homepage "Customer Reviews" + Google Rating ---------------- */
function _homepage_reviews_ctx(db) {
  const overall = db.execute("SELECT COUNT(*) c, COALESCE(AVG(rating),0) avg_rating FROM product_reviews WHERE status='approved'").fetchone();
  let featured_rows = db.execute(`SELECT * FROM product_reviews WHERE status='approved' AND is_featured=1
           ORDER BY created_at DESC LIMIT 6`).fetchall();
  if (!featured_rows.length) {
    featured_rows = db.execute(`SELECT * FROM product_reviews WHERE status='approved'
               ORDER BY rating DESC, created_at DESC LIMIT 6`).fetchall();
  }
  const featured = featured_rows.map((r) => {
    const image = db.execute("SELECT file_path FROM review_media WHERE review_id=? AND media_type='image' ORDER BY sort_order, id LIMIT 1", [r.id]).fetchone();
    const table = _table_for(r.item_type);
    const product = table ? db.execute(`SELECT * FROM ${table} WHERE id=?`, [r.item_id]).fetchone() : null;
    return {
      review: r,
      customer_image: image ? image.file_path : null,
      product_label: product ? (r.item_type === 'frame' ? `${product.brand} ${product.model || ''}` : `${product.brand}`).trim() : '',
      product_url: product ? url_for('store.product_detail', { item_type: r.item_type, item_id: r.item_id }) : null,
    };
  });
  return {
    site_review_count: overall.c,
    site_avg_rating: overall.c ? py.round(overall.avg_rating, 1) : 0,
    featured_reviews: featured,
    google_rating_value: get_setting('google_rating_value', ''),
    google_rating_count_label: get_setting('google_rating_count_label', ''),
    google_review_url: get_setting('google_review_url', ''),
  };
}

/* ---------------- catalog ---------------- */
function _catalog_totals(db) {
  const fc = db.execute('SELECT COUNT(*) c FROM frames WHERE online_visible=1 AND is_active=1 AND stock_qty > 0').fetchone().c;
  const cc = db.execute('SELECT COUNT(*) c FROM contact_lenses WHERE online_visible=1 AND is_active=1 AND stock_qty > 0').fetchone().c;
  return fc + cc;
}

bp.route('/', function home() {
  const db = get_db();
  const a = request.args;
  const category = a.get('cat', 'all');
  const q = a.get('q', '').trim();
  const gender = _normalize_gender(a.get('gender'));
  // Multi-select brand filter (?brand=X&brand=Y).
  const brand = a.getlist('brand').map((b) => b.trim()).filter(Boolean);
  const sort = _normalize_sort(a.get('sort'));
  const price_min = _parse_price(a.get('price_min'));
  const price_max = _parse_price(a.get('price_max'));
  const total_products = _catalog_totals(db);
  const available_brands = _available_brands(db, category, gender, q);
  const oc = _current_online_customer(db);
  const wishlist_ids = _wishlist_ids(db, oc ? oc.customer_id : null);

  let bf = ''; let bfp = []; let bc = ''; let bcp = [];
  if (brand.length) {
    const ph = brand.map(() => '?').join(',');
    bf = ` AND frames.brand COLLATE NOCASE IN (${ph})`; bfp = [...brand];
    bc = ` AND brand COLLATE NOCASE IN (${ph})`; bcp = [...brand];
  }
  const { gf, gfp, gc, gcp } = genderFragments(gender);
  let price_sql = ''; const price_params = [];
  if (price_min !== null) { price_sql += ' AND selling_price >= ?'; price_params.push(price_min); }
  if (price_max !== null) { price_sql += ' AND selling_price <= ?'; price_params.push(price_max); }
  const sort_sql = SORT_OPTIONS[sort];

  const common = (frames, contacts) => {
    const [fr, frame_group_swatches, frame_group_price_from] = _dedupe_grouped_frames(db, frames);
    const fids = fr.map((f) => f.id); const cids = contacts.map((c) => c.id);
    return {
      frames: fr, contacts, category, gender, brand, sort, sort_options: SORT_LABELS, price_min, price_max,
      available_brands, wishlist_ids, total_products,
      frame_hover_images: _second_images_for(db, 'frame', fids),
      contact_hover_images: _second_images_for(db, 'contact_lens', cids),
      frame_galleries: _gallery_images_for(db, 'frame', fids),
      contact_galleries: _gallery_images_for(db, 'contact_lens', cids),
      frame_group_swatches, frame_group_price_from,
    };
  };

  if (q) {
    const like = `%${q}%`;
    const frames = db.execute(`SELECT frames.* FROM frames LEFT JOIN genders g ON g.id = frames.gender_id
               WHERE frames.online_visible=1 AND frames.is_active=1 AND frames.stock_qty > 0
               AND (brand LIKE ? OR model LIKE ? OR color LIKE ? OR category LIKE ?)${gf}${bf}${price_sql}
               ORDER BY ${sort_sql}`, [like, like, like, like, ...gfp, ...bfp, ...price_params]).fetchall();
    const contacts = db.execute(`SELECT * FROM contact_lenses WHERE online_visible=1 AND is_active=1 AND stock_qty > 0
               AND (brand LIKE ? OR lens_type LIKE ? OR power LIKE ?)${gc}${bc}${price_sql}
               ORDER BY ${sort_sql}`, [like, like, like, ...gcp, ...bcp, ...price_params]).fetchall();
    return render_template('store/home.html', {
      ...common(frames, contacts), search_query: q, banners: [], side_posters: {},
      best_sellers: [], new_arrivals: [], featured_products: [], showcase_brands: [], showcase_categories: [],
      active_promotions: [], active_trust_items: [], active_store_services: [], category_seo: null,
      ..._shop_ctx(),
    });
  }

  let category_seo = null;
  let frames_q = 'SELECT frames.* FROM frames LEFT JOIN genders g ON g.id = frames.gender_id WHERE frames.online_visible=1 AND frames.is_active=1 AND frames.stock_qty > 0';
  const params = [];
  if (category === 'Eyeglasses' || category === 'Sunglasses') {
    frames_q += ' AND category = ?';
    params.push(category);
    category_seo = db.execute('SELECT meta_title, meta_description FROM categories WHERE name=? COLLATE NOCASE', [category]).fetchone();
  }
  frames_q += gf + bf + price_sql;
  params.push(...gfp, ...bfp, ...price_params);
  const frames = category !== 'contact_lens' ? db.execute(frames_q + ` ORDER BY ${sort_sql}`, params).fetchall() : [];
  let contacts = [];
  if (category === 'all' || category === 'contact_lens') {
    contacts = db.execute(`SELECT * FROM contact_lenses WHERE online_visible=1 AND is_active=1 AND stock_qty > 0${gc}${bc}${price_sql} ORDER BY ${sort_sql}`,
      [...gcp, ...bcp, ...price_params]).fetchall();
  }
  return render_template('store/home.html', {
    ...common(frames, contacts), search_query: '',
    banners: _active_banners(db), side_posters: _active_side_posters(db),
    best_sellers: _flagged_products(db, 'is_best_seller'),
    new_arrivals: _flagged_products(db, 'is_new_arrival'),
    featured_products: _flagged_products(db, 'is_featured'),
    showcase_brands: _active_brands_with_logo(db),
    showcase_categories: _active_categories_with_image(db),
    active_promotions: _active_promotions(db),
    active_trust_items: _active_trust_items(db),
    active_store_services: _active_store_services(db),
    category_seo,
    ..._homepage_reviews_ctx(db),
    ..._shop_ctx(),
  });
});

bp.route('/product/<item_type>/<int:item_id>', function product_detail({ item_type, item_id }) {
  const db = get_db();
  const table = _table_for(item_type);
  if (!table) {
    flash('Product not found.', 'error');
    return redirect(url_for('store.home'));
  }
  const product = db.execute(`SELECT * FROM ${table} WHERE id=? AND online_visible=1 AND is_active=1`, [item_id]).fetchone();
  if (!product) {
    flash('This product is no longer available.', 'error');
    return redirect(url_for('store.home'));
  }
  const gallery = db.execute('SELECT * FROM product_images WHERE item_type=? AND item_id=? ORDER BY sort_order, id', [item_type, item_id]).fetchall();
  let gender_label;
  if (item_type === 'frame') {
    const g = db.execute('SELECT name FROM genders WHERE id=?', [product.gender_id]).fetchone();
    gender_label = g ? g.name : 'Unisex';
  } else {
    gender_label = product.gender || 'Unisex';
  }
  // Color variant swatches - only for an ACTIVE product group.
  let variant_siblings = [];
  if (item_type === 'frame' && product.product_group_id !== null && product.product_group_id !== undefined) {
    const grp = db.execute('SELECT is_active FROM product_groups WHERE id=?', [product.product_group_id]).fetchone();
    if (grp && grp.is_active) {
      variant_siblings = db.execute(`SELECT id, color, image_path FROM frames
                   WHERE product_group_id=? AND online_visible=1 AND is_active=1 AND stock_qty > 0
                   ORDER BY grouped_at ASC, id ASC`, [product.product_group_id]).fetchall();
    }
  }
  const review_ctx = _reviews_for_product(db, item_type, item_id);
  const oc = _current_online_customer(db);
  const is_wishlisted = `${item_type},${item_id}` in _wishlist_ids(db, oc ? oc.customer_id : null);
  return render_template('store/product_detail.html', {
    product, item_type, gallery, gender_label, variant_siblings, is_wishlisted,
    just_submitted: request.args.get('reviewed') === '1', show_google_popup: request.args.get('popup') === '1',
    ...review_ctx, ..._shop_ctx(),
  });
});

/** JSON for the "You May Also Like" Quick View modal. */
bp.route('/product/<item_type>/<int:item_id>/quick-view', function product_quick_view({ item_type, item_id }) {
  const table = _table_for(item_type);
  if (!table) return [jsonify({ ok: false, error: 'Invalid product.' }), 404];
  const db = get_db();
  const product = db.execute(`SELECT * FROM ${table} WHERE id=? AND online_visible=1 AND is_active=1`, [item_id]).fetchone();
  if (!product) return [jsonify({ ok: false, error: 'This product is no longer available.' }), 404];
  const gallery = db.execute('SELECT image_path FROM product_images WHERE item_type=? AND item_id=? ORDER BY sort_order, id', [item_type, item_id]).fetchall();
  let images = gallery.map((g) => url_for('static', { filename: g.image_path }));
  if (!images.length && product.image_path) images = [url_for('static', { filename: product.image_path })];
  const stock_qty = product.stock_qty;
  const low = product.low_stock_threshold || 0;
  const stock_label = stock_qty <= 0 ? 'Out of Stock' : (stock_qty <= low ? 'Low Stock' : 'In Stock');
  return jsonify({
    ok: true, item_type, item_id,
    brand: product.brand,
    frame_id: item_type === 'frame' ? product.model : null,
    color: item_type === 'frame' ? product.color : product.power,
    size: item_type === 'frame' ? product.size : null,
    price: product.selling_price,
    currency: get_setting('currency_symbol', 'Rs.'),
    description: product.online_description || '',
    stock_qty, stock_label, images,
    detail_url: url_for('store.product_detail', { item_type, item_id }),
  });
});

/* ---------------- cart ---------------- */
const wantsJson = () => request.headers.get('X-Requested-With') === 'XMLHttpRequest';

bp.route('/cart/add', ['POST'], function cart_add() {
  const f = request.form;
  const item_type = f.get('item_type');
  const item_id = f.get('item_id', null, { type: pyInt });
  const qty = Math.max(1, f.get('qty', 1, { type: pyInt }));
  const table = _table_for(item_type);
  const json = wantsJson();
  const fail = (message, status = 400) => {
    if (json) return [jsonify({ ok: false, error: message }), status];
    flash(message, 'error');
    return redirect(url_for('store.home'));
  };
  if (!table || !item_id) return fail('Invalid product.');
  const db = get_db();
  const row = db.execute(`SELECT * FROM ${table} WHERE id=? AND online_visible=1 AND is_active=1`, [item_id]).fetchone();
  if (!row) return fail('This product is no longer available.', 404);
  if (row.stock_qty <= 0) return fail('This product is currently out of stock.');

  const cart = _get_cart();
  const line = cart.find((l) => l.item_type === item_type && l.item_id === item_id);
  if (line) line.qty = Math.min(line.qty + qty, row.stock_qty);
  else cart.push({ item_type, item_id, qty: Math.min(qty, row.stock_qty) });
  _save_cart(cart);

  if (json) return jsonify({ ok: true, message: 'Product added to cart.', cart_count: _cart_count() });
  flash('Added to cart.', 'success');
  return redirect(f.get('next') || url_for('store.product_detail', { item_type, item_id }));
});

/** Wishlist add/remove (logged-in customers only). */
bp.route('/wishlist/toggle', ['POST'], function wishlist_toggle() {
  const f = request.form;
  const item_type = f.get('item_type');
  const item_id = f.get('item_id', null, { type: pyInt });
  const table = _table_for(item_type);
  const json = wantsJson();
  const next_url = f.get('next') || request.referrer || url_for('store.home');
  const fail = (message, status = 400) => {
    if (json) return [jsonify({ ok: false, error: message }), status];
    flash(message, 'error');
    return redirect(next_url);
  };
  if (!table || !item_id) return fail('Invalid product.');
  const db = get_db();
  const oc = _current_online_customer(db);
  if (!oc) {
    if (json) return [jsonify({ ok: false, error: 'Please login to save items to your wishlist.', login_required: true }), 401];
    return redirect(url_for('store.login', { next: next_url }));
  }
  if (!db.execute(`SELECT id FROM ${table} WHERE id=? AND online_visible=1 AND is_active=1`, [item_id]).fetchone()) {
    return fail('This product is no longer available.', 404);
  }
  const existing = db.execute('SELECT id FROM wishlist_items WHERE customer_id=? AND item_type=? AND item_id=?', [oc.customer_id, item_type, item_id]).fetchone();
  let saved; let message;
  if (existing) {
    db.execute('DELETE FROM wishlist_items WHERE id=?', [existing.id]);
    db.commit();
    saved = false; message = 'Removed from wishlist.';
  } else {
    db.execute('INSERT INTO wishlist_items (customer_id, item_type, item_id) VALUES (?, ?, ?)', [oc.customer_id, item_type, item_id]);
    db.commit();
    saved = true; message = 'Added to wishlist.';
  }
  if (json) return jsonify({ ok: true, saved, message, wishlist_count: _wishlist_count(db, oc.customer_id) });
  flash(message, 'success');
  return redirect(next_url);
});

bp.route('/cart/update', ['POST'], function cart_update() {
  const f = request.form;
  const item_type = f.get('item_type');
  const item_id = f.get('item_id', null, { type: pyInt });
  // Quantity is always >= 1; removal only happens via /cart/remove.
  let qty = f.get('qty', null, { type: pyInt });
  if (qty === null || qty < 1) qty = 1;
  const cart = _get_cart();
  for (const line of cart) if (line.item_type === item_type && line.item_id === item_id) line.qty = qty;
  _save_cart(cart);
  return redirect(url_for('store.cart_view'));
});

bp.route('/cart/remove', ['POST'], function cart_remove() {
  const item_type = request.form.get('item_type');
  const item_id = request.form.get('item_id', null, { type: pyInt });
  _save_cart(_get_cart().filter((l) => !(l.item_type === item_type && l.item_id === item_id)));
  flash('Removed from cart.', 'success');
  return redirect(url_for('store.cart_view'));
});

bp.route('/cart/apply-coupon', ['POST'], function cart_apply_coupon() {
  const db = get_db();
  const details = _cart_details(db);
  const code = request.form.get('coupon_code', '');
  if (!details.length) {
    flash('Your cart is empty.', 'error');
    return redirect(url_for('store.cart_view'));
  }
  const [coupon, discount, error] = validate_coupon(db, code, details, _applied_coupon_customer_id(db));
  if (error) {
    flash(error, 'error');
    return redirect(url_for('store.cart_view'));
  }
  session[COUPON_SESSION_KEY] = coupon.code;
  flash(`Coupon '${coupon.code}' applied - you saved Rs. ${discount.toFixed(2)}.`, 'success');
  return redirect(url_for('store.cart_view'));
});

bp.route('/cart/remove-coupon', ['POST'], function cart_remove_coupon() {
  session.pop(COUPON_SESSION_KEY);
  flash('Coupon removed.', 'success');
  return redirect(url_for('store.cart_view'));
});

bp.route('/cart/apply-points', ['POST'], function cart_apply_points() {
  const db = get_db();
  const oc = _current_online_customer(db);
  if (!oc) {
    flash('Please log in to your account to redeem points.', 'error');
    return redirect(url_for('store.cart_view'));
  }
  let requested;
  try { requested = pyFloat(request.form.get('points_redeem', '0') || 0); } catch (_) { requested = 0; }
  if (requested <= 0) {
    flash("Enter how many points you'd like to redeem.", 'error');
    return redirect(url_for('store.cart_view'));
  }
  if (membership.get_points_balance(db, oc.customer_id) <= 0) {
    flash("You don't have any redeemable points yet.", 'error');
    return redirect(url_for('store.cart_view'));
  }
  session[POINTS_SESSION_KEY] = requested;
  flash('Points applied - the discount is shown below.', 'success');
  return redirect(url_for('store.cart_view'));
});

bp.route('/cart/remove-points', ['POST'], function cart_remove_points() {
  session.pop(POINTS_SESSION_KEY);
  flash('Points redemption removed.', 'success');
  return redirect(url_for('store.cart_view'));
});

/** Shared cart/checkout pricing preview (logged-in shoppers only for
 *  membership/points; always re-resolved at order time). */
function pricingPreview(db, details) {
  const grand_total = _cart_grand_total(details);
  const [coupon, discount, coupon_error] = _applied_coupon(db, details);
  if (coupon_error) flash(coupon_error, 'error');
  const cid = _applied_coupon_customer_id(db);
  const [membership_discount, membership_tier, membership_premium] = membership.resolve_membership_discount(db, cid, grand_total);
  const payable_before_points = Math.max(grand_total - discount - membership_discount, 0);
  const [points_used, points_discount] = _applied_points(db, cid, payable_before_points);
  const points_balance = cid ? membership.get_points_balance(db, cid) : 0;
  return {
    grand_total, coupon, discount, membership_discount, membership_tier, membership_premium,
    payable_before_points, points_used, points_discount, points_balance,
  };
}

bp.route('/cart', function cart_view() {
  const db = get_db();
  const details = _cart_details(db);
  const p = pricingPreview(db, details);
  return render_template('store/cart.html', {
    items: details, grand_total: p.grand_total, coupon: p.coupon, discount_amount: p.discount,
    membership_discount: p.membership_discount, membership_tier: p.membership_tier, membership_premium: p.membership_premium,
    points_balance: p.points_balance, points_used: p.points_used, points_discount: p.points_discount,
    payable_total: Math.max(p.payable_before_points - p.points_discount, 0),
    recommended_products: _recommended_products(db, details),
    ..._shop_ctx(),
  });
});

/* ---------------- checkout ---------------- */
bp.route('/checkout', ['GET', 'POST'], function checkout() {
  const db = get_db();
  const details = _cart_details(db);
  if (!details.length) {
    flash('Your cart is empty.', 'error');
    return redirect(url_for('store.home'));
  }
  const delivery_charge = pyFloat(get_setting('store_delivery_charge', '0') || 0);
  const razorpay_configured = !!String(get_setting('razorpay_key_id', '') || '').trim();

  if (request.method === 'POST') {
    const f = request.form;
    const name = f.get('name', '').trim();
    const phone = f.get('phone', '').trim();
    const email = f.get('email', '').trim();
    const delivery_type = f.get('delivery_type', 'pickup');
    const address = f.get('address', '').trim();
    let payment_method = f.get('payment_method', 'cod');

    if (!name || !phone) {
      flash('Name and phone number are required.', 'error');
      return redirect(url_for('store.checkout'));
    }
    if (delivery_type === 'delivery' && !address) {
      flash('Address is required for delivery.', 'error');
      return redirect(url_for('store.checkout'));
    }
    if (payment_method === 'online' && !razorpay_configured) payment_method = 'cod';

    // Re-check stock right before committing.
    for (const d of details) {
      const row = db.execute(`SELECT stock_qty FROM ${_table_for(d.item_type)} WHERE id=?`, [d.item_id]).fetchone();
      if (!row || row.stock_qty < d.qty) {
        flash(`Stock for '${d.label}' has reduced, please update your cart.`, 'error');
        return redirect(url_for('store.cart_view'));
      }
    }

    // Find or create customer by phone.
    const customer = db.execute('SELECT * FROM customers WHERE phone = ?', [phone]).fetchone();
    const customer_id = customer ? customer.id
      : db.execute('INSERT INTO customers (name, phone, email, address) VALUES (?,?,?,?)', [name, phone, email, address]).lastrowid;

    const branch_id = _default_branch_id(db);
    const order_no = next_number(get_setting('online_order_prefix', 'WEB'), 'orders');
    const delivery_charge_line = delivery_type === 'delivery' ? delivery_charge : 0;

    // Re-validate the coupon against the now-known customer.
    let coupon = null; let discount_amount = 0;
    const coupon_code = session.get(COUPON_SESSION_KEY);
    if (coupon_code) {
      let coupon_error;
      [coupon, discount_amount, coupon_error] = validate_coupon(db, coupon_code, details, customer_id);
      if (coupon_error) {
        session.pop(COUPON_SESSION_KEY);
        flash(`Coupon could not be applied: ${coupon_error}`, 'error');
        return redirect(url_for('store.cart_view'));
      }
    }

    const grand_total = _cart_grand_total(details);
    const [membership_discount, membership_tier, membership_premium] = membership.resolve_membership_discount(db, customer_id, grand_total);
    const payable_before_points = Math.max(grand_total - discount_amount - membership_discount, 0);
    let points_requested;
    try { points_requested = pyFloat(session.get(POINTS_SESSION_KEY) || 0); } catch (_) { points_requested = 0.0; }
    const [points_used, points_discount] = membership.resolve_points_redemption(db, customer_id, points_requested, payable_before_points);
    const final_payable = payable_before_points - points_discount;
    let points_earned = 0.0;
    if (membership.get_active_premium(db, customer_id)) points_earned = membership.compute_points_earned(db, customer_id, final_payable);

    const cur = db.execute(`INSERT INTO orders (branch_id, order_no, customer_id, status, notes, created_by,
               source, delivery_type, delivery_address, payment_method, online_payment_status,
               coupon_id, coupon_code, discount_amount,
               membership_tier_id, membership_plan_id, membership_discount_amount,
               points_earned, points_redeemed, points_discount_amount)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      branch_id, order_no, customer_id, 'Order Placed', f.get('notes', '').trim(), 'Online Store',
      'online', delivery_type, delivery_type === 'delivery' ? address : null,
      payment_method, payment_method === 'online' ? 'pending' : null,
      coupon ? coupon.id : null, coupon ? coupon.code : null, discount_amount,
      membership_tier && membership_discount && !membership_premium ? membership_tier.id : null,
      membership_premium ? membership_premium.plan_id : null,
      membership_discount, points_earned, points_used, points_discount,
    ]);
    const order_id = cur.lastrowid;
    const addLine = (desc, amount) => db.execute(`INSERT INTO order_items (order_id, item_type, item_id, description, qty, unit_price, total_price)
                   VALUES (?,?,?,?,?,?,?)`, [order_id, 'other', null, desc, 1, amount, amount]);

    for (const d of details) {
      db.execute(`INSERT INTO order_items (order_id, item_type, item_id, description, qty, unit_price, total_price)
                   VALUES (?,?,?,?,?,?,?)`, [order_id, d.item_type, d.item_id, d.label, d.qty, d.price, d.total]);
      db.execute(`UPDATE ${_table_for(d.item_type)} SET stock_qty = stock_qty - ? WHERE id=?`, [d.qty, d.item_id]);
    }
    if (delivery_charge_line) addLine('Delivery Charge', delivery_charge_line);
    if (coupon) {
      addLine(`Coupon Discount (${coupon.code})`, -discount_amount);
      record_coupon_usage(db, coupon.id, order_id, customer_id, discount_amount);
    }
    if (membership_discount) {
      addLine(membership_premium ? `Premium Membership Discount (${membership_premium.plan_name})` : `${membership_tier.name} Membership Discount`, -membership_discount);
    }
    if (points_discount) addLine(`Points Redeemed Discount (${py.percentFormat('%g', [points_used])} pts)`, -points_discount);
    membership.record_points_ledger(db, customer_id, order_id, points_earned, points_used);

    create_notification(db, 'order_placed', `New online order ${order_no}`,
      `${name} - Rs. ${(final_payable + delivery_charge_line).toFixed(2)}`,
      { link_url: url_for('orders.detail', { order_id }), branch_id, related_type: 'order', related_id: order_id });
    db.commit();
    _save_cart([]);
    session.pop(COUPON_SESSION_KEY);
    session.pop(POINTS_SESSION_KEY);
    session.last_online_order_no = order_no;

    if (payment_method === 'online' && razorpay_configured) return redirect(url_for('store.pay_online', { order_id }));
    flash(`Order ${order_no} placed!`, 'success');
    return redirect(url_for('store.order_confirmation', { order_no }));
  }

  const p = pricingPreview(db, details);
  return render_template('store/checkout.html', {
    items: details, grand_total: p.grand_total, delivery_charge, razorpay_configured,
    coupon: p.coupon, discount_amount: p.discount,
    membership_discount: p.membership_discount, membership_tier: p.membership_tier, membership_premium: p.membership_premium,
    points_balance: p.points_balance, points_used: p.points_used, points_discount: p.points_discount,
    payable_total: Math.max(p.payable_before_points - p.points_discount, 0) + delivery_charge,
    recommended_products: _recommended_products(db, details),
    ..._shop_ctx(),
  });
});

/** Razorpay Checkout page (only once Razorpay keys are configured). */
bp.route('/pay/<int:order_id>', async function pay_online({ order_id }) {
  const db = get_db();
  const order = db.execute("SELECT * FROM orders WHERE id=? AND source='online'", [order_id]).fetchone();
  if (!order) {
    flash('Order not found.', 'error');
    return redirect(url_for('store.home'));
  }
  const key_id = String(get_setting('razorpay_key_id', '') || '').trim();
  const key_secret = String(get_setting('razorpay_key_secret', '') || '').trim();
  if (!key_id || !key_secret) {
    flash("Online payment isn't set up yet. Please use Cash on Pickup/Delivery.", 'error');
    return redirect(url_for('store.order_confirmation', { order_no: order.order_no }));
  }
  const items = db.execute('SELECT * FROM order_items WHERE order_id=?', [order_id]).fetchall();
  const amount_rupees = items.reduce((s, i) => s + i.total_price, 0);
  // Capture everything the template needs before the network call.
  const shop = _shop_ctx();
  db.commit();
  let rzp_order;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10000);
    let resp;
    try {
      resp = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${key_id}:${key_secret}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: Math.trunc(py.round(amount_rupees * 100)), currency: 'INR', receipt: order.order_no }),
        signal: ac.signal,
      });
    } finally { clearTimeout(t); }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    rzp_order = await resp.json();
  } catch (_) {
    flash("The online payment gateway isn't reachable right now. Your order has been confirmed as Cash on Pickup/Delivery.", 'error');
    return redirect(url_for('store.order_confirmation', { order_no: order.order_no }));
  }
  return render_template('store/pay.html', {
    order, razorpay_order_id: rzp_order.id, amount_paise: rzp_order.amount, key_id, ...shop,
  });
});

bp.route('/pay/<int:order_id>/verify', ['POST'], function pay_verify({ order_id }) {
  const db = get_db();
  const order = db.execute("SELECT * FROM orders WHERE id=? AND source='online'", [order_id]).fetchone();
  if (!order) {
    flash('Order not found.', 'error');
    return redirect(url_for('store.home'));
  }
  const key_secret = String(get_setting('razorpay_key_secret', '') || '').trim();
  const f = request.form;
  const rzp_order_id = f.get('razorpay_order_id', '');
  const rzp_payment_id = f.get('razorpay_payment_id', '');
  const rzp_signature = f.get('razorpay_signature', '');
  const expected = crypto.createHmac('sha256', key_secret).update(`${rzp_order_id}|${rzp_payment_id}`).digest('hex');
  if (compare_digest(expected, rzp_signature)) {
    db.execute("UPDATE orders SET online_payment_status='paid', online_payment_ref=? WHERE id=?", [rzp_payment_id, order_id]);
    db.commit();
    flash('Payment successful! Order confirmed.', 'success');
  } else {
    db.execute("UPDATE orders SET online_payment_status='failed' WHERE id=?", [order_id]);
    db.commit();
    flash("Couldn't verify the payment. Please contact the shop.", 'error');
  }
  return redirect(url_for('store.order_confirmation', { order_no: order.order_no }));
});

bp.route('/order/<order_no>/confirmation', function order_confirmation({ order_no }) {
  const db = get_db();
  const order = db.execute(`SELECT o.*, c.name as customer_name, c.phone as customer_phone
           FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.order_no=? AND o.source='online'`, [order_no]).fetchone();
  if (!order) {
    flash('Order not found.', 'error');
    return redirect(url_for('store.home'));
  }
  const items = db.execute('SELECT * FROM order_items WHERE order_id=?', [order.id]).fetchall();
  return render_template('store/order_confirmation.html', { order, items, ..._shop_ctx() });
});

/* ---------------- order tracking (no account needed) ---------------- */
bp.route('/track', ['GET', 'POST'], function track() {
  let order = null; let items = []; let searched = false;
  if (request.method === 'POST') {
    searched = true;
    const order_no = request.form.get('order_no', '').trim();
    const phone = request.form.get('phone', '').trim();
    const db = get_db();
    order = db.execute(`SELECT o.*, c.name as customer_name, c.phone as customer_phone
               FROM orders o JOIN customers c ON c.id=o.customer_id
               WHERE o.order_no=? AND c.phone=? AND o.source='online'`, [order_no, phone]).fetchone();
    if (order) items = db.execute('SELECT * FROM order_items WHERE order_id=?', [order.id]).fetchall();
    else flash('Order not found. Please check the order number and phone number.', 'error');
  }
  return render_template('store/track.html', { order, items, searched, ..._shop_ctx() });
});

bp.route('/find-a-store', function find_a_store() {
  const branches = get_db().execute('SELECT id, name, address, phone FROM branches ORDER BY name').fetchall();
  return render_template('store/find_a_store.html', { branches, ..._shop_ctx() });
});

/* ---------------- customer account ---------------- */
function _current_online_customer(db) {
  const oc_id = session.get('online_customer_id');
  if (!oc_id) return null;
  return db.execute(`SELECT oc.*, c.name, c.phone, c.email, c.address FROM online_customers oc
           JOIN customers c ON c.id = oc.customer_id WHERE oc.id=?`, [oc_id]).fetchone();
}

bp.route('/signup', ['GET', 'POST'], function signup() {
  const db = get_db();
  if (request.method === 'POST') {
    const f = request.form;
    if (!_valid_csrf(f.get('csrf_token', ''))) {
      flash('Your session expired - please try submitting the form again.', 'error');
      return redirect(url_for('store.signup'));
    }
    const name = f.get('name', '').trim();
    const phone = f.get('phone', '').trim();
    const email = f.get('email', '').trim();
    const password = f.get('password', '');
    const errors = _validate_signup_fields(name, phone, email, password);
    if (errors.length) {
      for (const m of errors) flash(m, 'error');
      return redirect(url_for('store.signup'));
    }
    if (db.execute('SELECT id FROM online_customers WHERE phone=?', [phone]).fetchone()) {
      flash('An account with this phone number already exists. Please log in.', 'error');
      return redirect(url_for('store.login'));
    }
    const customer = db.execute('SELECT * FROM customers WHERE phone=?', [phone]).fetchone();
    const customer_id = customer ? customer.id
      : db.execute('INSERT INTO customers (name, phone, email) VALUES (?,?,?)', [name, phone, email]).lastrowid;
    const cur = db.execute('INSERT INTO online_customers (customer_id, email, phone, password_hash) VALUES (?,?,?,?)',
      [customer_id, email || null, phone, generate_password_hash(password)]);
    db.commit();
    session.pop('_csrf_token'); // one-time use
    session.online_customer_id = cur.lastrowid;
    flash('Account created! Welcome.', 'success');
    return redirect(url_for('store.account'));
  }
  return render_template('store/signup.html', { csrf_token: _get_csrf_token(), ..._shop_ctx() });
});

bp.route('/login', ['GET', 'POST'], function login() {
  const next_url = request.values.get('next', '');
  if (request.method === 'POST') {
    const phone = request.form.get('phone', '').trim();
    const password = request.form.get('password', '');
    const oc = get_db().execute('SELECT * FROM online_customers WHERE phone=?', [phone]).fetchone();
    if (oc && check_password_hash(oc.password_hash, password)) {
      session.online_customer_id = oc.id;
      flash('Logged in.', 'success');
      return redirect(_safe_next_url(next_url) || url_for('store.home'));
    }
    flash('Incorrect phone or password.', 'error');
  }
  return render_template('store/login.html', { next: next_url, ..._shop_ctx() });
});

bp.route('/logout', function logout() {
  session.pop('online_customer_id');
  flash("You've been logged out.", 'success');
  return redirect(url_for('store.home'));
});

bp.route('/account', function account() {
  const db = get_db();
  const oc = _current_online_customer(db);
  if (!oc) return redirect(url_for('store.login', { next: request.path }));
  const cid = oc.customer_id;
  const orders = db.execute("SELECT * FROM orders WHERE customer_id=? AND source='online' ORDER BY created_at DESC", [cid]).fetchall();
  const [membership_tier, membership_spend, membership_next_tier] = membership.get_customer_tier(db, cid);
  const membership_premium = membership.get_active_premium(db, cid);
  const membership_pending = db.execute(`SELECT cm.*, mp.name AS plan_name, mp.price AS plan_price FROM customer_memberships cm
           JOIN membership_plans mp ON mp.id = cm.plan_id
           WHERE cm.customer_id=? AND cm.status='requested' ORDER BY cm.created_at DESC LIMIT 1`, [cid]).fetchone();
  const membership_plans = db.execute('SELECT * FROM membership_plans WHERE is_active=1 ORDER BY price ASC').fetchall();

  // Delivered items (any source) still lacking a review.
  const reviewable = [];
  const delivered = db.execute(`SELECT DISTINCT oi.item_type, oi.item_id, oi.description FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           WHERE o.customer_id=? AND o.status='Delivered' AND oi.item_type IN ('frame','contact_lens')`, [cid]).fetchall();
  for (const item of delivered) {
    if (!reviews.existing_review(db, cid, item.item_type, item.item_id)) {
      const product = db.execute(`SELECT * FROM ${_table_for(item.item_type)} WHERE id=?`, [item.item_id]).fetchone();
      if (product) reviewable.push({ item_type: item.item_type, item_id: item.item_id, description: item.description, product });
    }
  }
  const points_balance = membership.get_points_balance(db, cid);
  const wishlist_products = [];
  for (const wl of db.execute('SELECT * FROM wishlist_items WHERE customer_id=? ORDER BY created_at DESC', [cid]).fetchall()) {
    const table = _table_for(wl.item_type);
    const product = table ? db.execute(`SELECT * FROM ${table} WHERE id=?`, [wl.item_id]).fetchone() : null;
    if (product) wishlist_products.push({ item_type: wl.item_type, item_id: wl.item_id, product });
  }
  return render_template('store/account.html', {
    orders, reviewable, membership_tier, membership_spend, membership_next_tier, membership_premium,
    membership_pending, membership_plans, points_balance, wishlist_products, ..._shop_ctx(),
  });
});

/** Storefront "Request Premium" - an admin approves once payment is collected offline. */
bp.route('/account/request-premium', ['POST'], function request_premium() {
  const db = get_db();
  const oc = _current_online_customer(db);
  if (!oc) return redirect(url_for('store.login', { next: url_for('store.account') }));
  let plan_id;
  try { plan_id = pyInt(request.form.get('plan_id', '')); } catch (_) {
    flash('Please choose a membership plan.', 'error');
    return redirect(url_for('store.account'));
  }
  const plan = db.execute('SELECT * FROM membership_plans WHERE id=? AND is_active=1', [plan_id]).fetchone();
  if (!plan) {
    flash('That membership plan is not available.', 'error');
    return redirect(url_for('store.account'));
  }
  if (membership.get_active_premium(db, oc.customer_id)) {
    flash('You already have an active Premium membership.', 'error');
    return redirect(url_for('store.account'));
  }
  if (db.execute("SELECT id FROM customer_memberships WHERE customer_id=? AND status='requested'", [oc.customer_id]).fetchone()) {
    flash('You already have a pending Premium request - our team will confirm it shortly.', 'error');
    return redirect(url_for('store.account'));
  }
  const cur = db.execute("INSERT INTO customer_memberships (customer_id, plan_id, status, amount_paid, notes) VALUES (?,?, 'requested', 0, ?)",
    [oc.customer_id, plan_id, 'Requested by customer on storefront']);
  create_notification(db, 'membership_requested', 'Premium membership requested',
    `${oc.name} requested ${plan.name} membership (${get_setting('currency_symbol', 'Rs.')} ${Number(plan.price).toFixed(0)}).`,
    { link_url: url_for('membership.members'), related_type: 'membership', related_id: cur.lastrowid });
  db.commit();
  flash(`Your request for ${plan.name} membership has been sent. We'll activate it once payment is confirmed.`, 'success');
  return redirect(url_for('store.account'));
});

module.exports = { bp };
