'use strict';
/**
 * Admin CRUD for Coupons & Discounts (Website Management > Coupons &
 * Discounts), plus the shared validate_coupon() helper used by storefront
 * checkout.
 */
const { Blueprint, request, redirect, url_for, flash, pyInt, pyFloat } = require('../lib/core');
const { render_template } = require('../lib/render');
const py = require('../lib/py');
const { get_db } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('coupons', { url_prefix: '/website/coupons' });

const DISCOUNT_TYPES = ['percentage', 'fixed'];
const ELIGIBILITY_OPTIONS = ['all', 'new_customers'];

/* ---------------- shared helpers ---------------- */

/** '' -> [], '1,2,3' -> [1,2,3] */
function _parse_id_list(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((t) => t.trim()).filter((t) => /^\d+$/.test(t)).map((t) => parseInt(t, 10));
}

/** 'frame:1,contact_lens:5' -> [['frame','1'], ['contact_lens','5']] */
function _parse_product_tokens(raw) {
  if (!raw) return [];
  const out = [];
  for (let tok of String(raw).split(',')) {
    tok = tok.trim();
    const i = tok.indexOf(':');
    if (i >= 0) out.push([tok.slice(0, i).trim(), tok.slice(i + 1).trim()]);
  }
  return out;
}

/** Whether one cart line qualifies under the coupon's restrictions (none set = all). */
function _is_item_eligible(coupon, item, frame_lookup) {
  const categories = _parse_id_list(coupon.applicable_categories);
  const brands = _parse_id_list(coupon.applicable_brands);
  const products = _parse_product_tokens(coupon.applicable_products);
  if (!categories.length && !brands.length && !products.length) return true;
  if (products.some(([t, id]) => t === item.item_type && id === String(item.item_id))) return true;
  if (item.item_type === 'frame') {
    const frame = frame_lookup[item.item_id];
    if (frame) {
      if (frame.category_id !== null && categories.includes(frame.category_id)) return true;
      if (frame.brand_id !== null && brands.includes(frame.brand_id)) return true;
    }
  }
  return false;
}

/**
 * Validate a coupon code against the current cart. Returns
 * [coupon|null, discount_amount, error_message|null].
 */
function validate_coupon(db, code, cart_details, customer_id = null) {
  code = String(code || '').trim();
  if (!code) return [null, 0, 'Please enter a coupon code.'];
  const coupon = db.execute('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE', [code]).fetchone();
  if (!coupon) return [null, 0, 'Invalid coupon code.'];
  if (!coupon.is_active) return [null, 0, 'This coupon is no longer active.'];

  const today = py.todayIso();
  if (coupon.start_date && today < coupon.start_date) return [null, 0, 'This coupon is not active yet.'];
  if (coupon.expiry_date && today > coupon.expiry_date) return [null, 0, 'This coupon has expired.'];

  const cart_total = cart_details.reduce((s, d) => s + d.total, 0);
  if (cart_total < (coupon.min_order_value || 0)) {
    return [null, 0, `This coupon requires a minimum order value of Rs. ${Number(coupon.min_order_value).toFixed(2)}.`];
  }
  if (coupon.usage_limit_total !== null) {
    const used = db.execute('SELECT COUNT(*) c FROM coupon_usages WHERE coupon_id=?', [coupon.id]).fetchone().c;
    if (used >= coupon.usage_limit_total) return [null, 0, 'This coupon has reached its usage limit.'];
  }
  if (customer_id !== null && customer_id !== undefined) {
    if (coupon.usage_limit_per_customer !== null) {
      const used = db.execute('SELECT COUNT(*) c FROM coupon_usages WHERE coupon_id=? AND customer_id=?', [coupon.id, customer_id]).fetchone().c;
      if (used >= coupon.usage_limit_per_customer) return [null, 0, "You've already used this coupon the maximum number of times."];
    }
    if (coupon.customer_eligibility === 'new_customers') {
      const prior = db.execute('SELECT COUNT(*) c FROM orders WHERE customer_id=?', [customer_id]).fetchone().c;
      if (prior > 0) return [null, 0, 'This coupon is only valid for new customers.'];
    }
  }

  const frame_lookup = {};
  if (coupon.applicable_categories || coupon.applicable_brands) {
    const frame_ids = cart_details.filter((d) => d.item_type === 'frame').map((d) => d.item_id);
    if (frame_ids.length) {
      const rows = db.execute(`SELECT id, category_id, brand_id FROM frames WHERE id IN (${frame_ids.map(() => '?').join(',')})`, frame_ids).fetchall();
      for (const r of rows) frame_lookup[r.id] = r;
    }
  }
  const eligible = cart_details.filter((d) => _is_item_eligible(coupon, d, frame_lookup));
  if (!eligible.length) return [null, 0, "This coupon doesn't apply to any items currently in your cart."];

  const base = eligible.reduce((s, d) => s + d.total, 0);
  let discount;
  if (coupon.discount_type === 'percentage') {
    discount = base * (coupon.discount_value / 100.0);
    if (coupon.max_discount_amount !== null) discount = Math.min(discount, coupon.max_discount_amount);
  } else {
    discount = Math.min(coupon.discount_value, base);
  }
  discount = py.round(Math.max(discount, 0), 2);
  return [coupon, discount, null];
}

function record_coupon_usage(db, coupon_id, order_id, customer_id, discount_amount) {
  db.execute('INSERT INTO coupon_usages (coupon_id, order_id, customer_id, discount_amount) VALUES (?,?,?,?)',
    [coupon_id, order_id, customer_id, discount_amount]);
}

/* ---------------- admin CRUD ---------------- */

function _taxonomy_options(db) {
  return {
    categories: db.execute('SELECT * FROM categories WHERE is_active=1 ORDER BY name COLLATE NOCASE').fetchall(),
    brands: db.execute('SELECT * FROM brands WHERE is_active=1 ORDER BY name COLLATE NOCASE').fetchall(),
    frames: db.execute('SELECT id, brand, model FROM frames WHERE is_active=1 ORDER BY brand, model').fetchall(),
    contacts: db.execute('SELECT id, brand, lens_type FROM contact_lenses ORDER BY brand').fetchall(),
  };
}

function _coupon_usage_counts(db) {
  const out = {};
  for (const r of db.execute('SELECT coupon_id, COUNT(*) c FROM coupon_usages GROUP BY coupon_id').fetchall()) out[r.coupon_id] = r.c;
  return out;
}

bp.route('/', admin_required(function index() {
  const db = get_db();
  const q = request.args.get('q', '').trim();
  const status = request.args.get('status', '').trim();
  let sql = 'SELECT * FROM coupons WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (code LIKE ? OR name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (status === 'active') sql += ' AND is_active=1';
  else if (status === 'inactive') sql += ' AND is_active=0';
  sql += ' ORDER BY created_at DESC, id DESC';
  return render_template('website/coupons.html', {
    coupons: db.execute(sql, params).fetchall(), q, status, today: py.todayIso(), usage_counts: _coupon_usage_counts(db),
  });
}));

function _resolve_is_active(form) {
  if (!form.get('is_active_present')) return 1;
  return form.get('is_active') ? 1 : 0;
}

function _read_coupon_form(form) {
  return {
    code: form.get('code', '').trim().toUpperCase(),
    name: form.get('name', '').trim(),
    description: form.get('description', '').trim(),
    discount_type: form.get('discount_type', 'percentage').trim(),
    discount_value: form.get('discount_value', '0').trim(),
    min_order_value: form.get('min_order_value', '0').trim(),
    max_discount_amount: form.get('max_discount_amount', '').trim(),
    start_date: form.get('start_date', '').trim() || null,
    expiry_date: form.get('expiry_date', '').trim() || null,
    usage_limit_total: form.get('usage_limit_total', '').trim(),
    usage_limit_per_customer: form.get('usage_limit_per_customer', '').trim(),
    // Lists (not comma-joined) so the template's exact-match `in` checks work.
    applicable_categories: form.getlist('applicable_categories'),
    applicable_brands: form.getlist('applicable_brands'),
    applicable_products: form.getlist('applicable_products'),
    customer_eligibility: form.get('customer_eligibility', 'all').trim(),
    is_active: _resolve_is_active(form),
  };
}

function _validate_coupon_form(db, data, exclude_id = null) {
  if (!data.code) return 'Coupon Code is required.';
  if (!data.name) return 'Coupon Name is required.';
  if (!DISCOUNT_TYPES.includes(data.discount_type)) return 'Invalid discount type.';
  let dv;
  try { dv = pyFloat(data.discount_value); } catch (_) { return 'Discount Value must be a number.'; }
  if (dv <= 0) return 'Discount Value must be greater than zero.';
  if (data.discount_type === 'percentage' && dv > 100) return "A percentage discount can't exceed 100%.";
  try { pyFloat(data.min_order_value || 0); } catch (_) { return 'Minimum Order Value must be a number.'; }
  if (data.max_discount_amount) {
    try { pyFloat(data.max_discount_amount); } catch (_) { return 'Maximum Discount Amount must be a number.'; }
  }
  if (data.start_date && data.expiry_date && data.start_date > data.expiry_date) return 'Start Date must be on or before Expiry Date.';
  for (const [key, label] of [['usage_limit_total', 'Usage Limit (Total)'], ['usage_limit_per_customer', 'Usage Limit Per Customer']]) {
    if (data[key]) {
      let n;
      try { n = pyInt(data[key]); } catch (_) { return `${label} must be a whole number.`; }
      if (n < 1) return `${label} must be at least 1.`;
    }
  }
  if (!ELIGIBILITY_OPTIONS.includes(data.customer_eligibility)) return 'Invalid customer eligibility option.';
  let sql = 'SELECT id FROM coupons WHERE code = ? COLLATE NOCASE';
  const params = [data.code];
  if (exclude_id) { sql += ' AND id != ?'; params.push(exclude_id); }
  if (db.execute(sql, params).fetchone()) return 'A coupon with this code already exists.';
  return null;
}

function _coupon_params(d) {
  return [
    d.code, d.name, d.description, d.discount_type,
    pyFloat(d.discount_value), pyFloat(d.min_order_value || 0),
    d.max_discount_amount ? pyFloat(d.max_discount_amount) : null,
    d.start_date, d.expiry_date,
    d.usage_limit_total ? pyInt(d.usage_limit_total) : null,
    d.usage_limit_per_customer ? pyInt(d.usage_limit_per_customer) : null,
    d.applicable_categories.join(',') || null, d.applicable_brands.join(',') || null,
    d.applicable_products.join(',') || null, d.customer_eligibility, d.is_active,
  ];
}

bp.route('/new', ['GET', 'POST'], admin_required(function new_() {
  const db = get_db();
  if (request.method === 'POST') {
    const data = _read_coupon_form(request.form);
    const error = _validate_coupon_form(db, data);
    if (error) {
      flash(error, 'error');
      return render_template('website/coupon_form.html', { coupon: null, form: data, ..._taxonomy_options(db) });
    }
    db.execute(`INSERT INTO coupons (code, name, description, discount_type, discount_value, min_order_value,
               max_discount_amount, start_date, expiry_date, usage_limit_total, usage_limit_per_customer,
               applicable_categories, applicable_brands, applicable_products, customer_eligibility, is_active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, _coupon_params(data));
    db.commit();
    flash('Coupon created.', 'success');
    return redirect(url_for('coupons.index'));
  }
  return render_template('website/coupon_form.html', { coupon: null, form: null, ..._taxonomy_options(db) });
}), { endpoint: 'new' });

/** DB row in the same shape _read_coupon_form() produces. */
function _coupon_to_form_dict(coupon) {
  return {
    ...coupon,
    applicable_categories: _parse_id_list(coupon.applicable_categories).map(String),
    applicable_brands: _parse_id_list(coupon.applicable_brands).map(String),
    applicable_products: _parse_product_tokens(coupon.applicable_products).map(([t, i]) => `${t}:${i}`),
  };
}

bp.route('/<int:coupon_id>/edit', ['GET', 'POST'], admin_required(function edit({ coupon_id }) {
  const db = get_db();
  const coupon = db.execute('SELECT * FROM coupons WHERE id=?', [coupon_id]).fetchone();
  if (!coupon) {
    flash('Coupon not found.', 'error');
    return redirect(url_for('coupons.index'));
  }
  if (request.method === 'POST') {
    const data = _read_coupon_form(request.form);
    const error = _validate_coupon_form(db, data, coupon_id);
    if (error) {
      flash(error, 'error');
      return render_template('website/coupon_form.html', { coupon, form: data, ..._taxonomy_options(db) });
    }
    db.execute(`UPDATE coupons SET code=?, name=?, description=?, discount_type=?, discount_value=?,
               min_order_value=?, max_discount_amount=?, start_date=?, expiry_date=?, usage_limit_total=?,
               usage_limit_per_customer=?, applicable_categories=?, applicable_brands=?, applicable_products=?,
               customer_eligibility=?, is_active=? WHERE id=?`, [..._coupon_params(data), coupon_id]);
    db.commit();
    flash('Coupon updated.', 'success');
    return redirect(url_for('coupons.index'));
  }
  return render_template('website/coupon_form.html', { coupon, form: _coupon_to_form_dict(coupon), ..._taxonomy_options(db) });
}));

bp.route('/<int:coupon_id>/delete', ['POST'], admin_required(function delete_({ coupon_id }) {
  const db = get_db();
  // A used coupon is order history - block delete, suggest Deactivate.
  const used = db.execute('SELECT COUNT(*) c FROM coupon_usages WHERE coupon_id=?', [coupon_id]).fetchone().c;
  if (used) {
    flash("This coupon has already been used on one or more orders and can't be deleted (order history depends on it). Deactivate it instead to stop further use.", 'error');
    return redirect(url_for('coupons.index'));
  }
  db.execute('DELETE FROM coupons WHERE id=?', [coupon_id]);
  db.commit();
  flash('Coupon deleted.', 'success');
  return redirect(url_for('coupons.index'));
}), { endpoint: 'delete' });

bp.route('/<int:coupon_id>/toggle', ['POST'], admin_required(function toggle({ coupon_id }) {
  const db = get_db();
  const coupon = db.execute('SELECT is_active FROM coupons WHERE id=?', [coupon_id]).fetchone();
  if (!coupon) {
    flash('Coupon not found.', 'error');
    return redirect(url_for('coupons.index'));
  }
  const new_state = coupon.is_active ? 0 : 1;
  db.execute('UPDATE coupons SET is_active=? WHERE id=?', [new_state, coupon_id]);
  db.commit();
  flash(new_state ? 'Coupon activated.' : 'Coupon deactivated.', 'success');
  return redirect(url_for('coupons.index'));
}));

bp.route('/<int:coupon_id>/duplicate', ['POST'], admin_required(function duplicate({ coupon_id }) {
  const db = get_db();
  const c = db.execute('SELECT * FROM coupons WHERE id=?', [coupon_id]).fetchone();
  if (!c) {
    flash('Coupon not found.', 'error');
    return redirect(url_for('coupons.index'));
  }
  const base_code = `${c.code}-COPY`;
  let new_code = base_code;
  let n = 2;
  while (db.execute('SELECT id FROM coupons WHERE code = ? COLLATE NOCASE', [new_code]).fetchone()) {
    new_code = `${base_code}${n}`;
    n += 1;
  }
  db.execute(`INSERT INTO coupons (code, name, description, discount_type, discount_value, min_order_value,
           max_discount_amount, start_date, expiry_date, usage_limit_total, usage_limit_per_customer,
           applicable_categories, applicable_brands, applicable_products, customer_eligibility, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, [
    new_code, `${c.name} (Copy)`, c.description, c.discount_type, c.discount_value, c.min_order_value,
    c.max_discount_amount, c.start_date, c.expiry_date, c.usage_limit_total, c.usage_limit_per_customer,
    c.applicable_categories, c.applicable_brands, c.applicable_products, c.customer_eligibility,
  ]);
  db.commit();
  flash(`Coupon duplicated as ${new_code} (created Inactive - review then activate).`, 'success');
  return redirect(url_for('coupons.index'));
}));

module.exports = { bp, validate_coupon, record_coupon_usage, _parse_id_list, _parse_product_tokens };
