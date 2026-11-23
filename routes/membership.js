'use strict';
/**
 * Membership Program (Website Management > Memberships).
 *
 * - Tiers (membership_tiers): free, automatic, keyed off lifetime spend.
 * - Plans (membership_plans): paid, opt-in, fixed duration (customer_memberships).
 *
 * At checkout the bigger of the two discounts applies - never both. Both
 * stack independently with a coupon code.
 *
 * Exposes the shared resolution helpers (used by storefront/orders) plus the
 * admin CRUD blueprint.
 */
const { Blueprint, request, redirect, url_for, flash, pyInt, pyFloat } = require('../lib/core');
const { render_template } = require('../lib/render');
const py = require('../lib/py');
const { get_db, get_setting, set_setting } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('membership', { url_prefix: '/website/membership' });

/* ---------------- shared helpers ---------------- */

/** Net amount spent across every non-cancelled order. */
function get_lifetime_spend(db, customer_id) {
  if (!customer_id) return 0.0;
  const row = db.execute(`SELECT COALESCE(SUM(oi.total_price), 0) AS total
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE o.customer_id=? AND o.status != 'Cancelled'`, [customer_id]).fetchone();
  return row.total || 0.0;
}

function get_all_tiers(db) {
  return db.execute('SELECT * FROM membership_tiers WHERE is_active=1 ORDER BY min_spend ASC, sort_order ASC').fetchall();
}

/** [current_tier|null, lifetime_spend, next_tier|null] */
function get_customer_tier(db, customer_id) {
  const spend = get_lifetime_spend(db, customer_id);
  let current = null; let nxt = null;
  for (const t of get_all_tiers(db)) {
    if (spend >= (t.min_spend || 0)) current = t;
    else { nxt = t; break; }
  }
  return [current, spend, nxt];
}

/** Currently-active paid membership row (with plan), or null. */
function get_active_premium(db, customer_id) {
  if (!customer_id) return null;
  return db.execute(`SELECT cm.*, mp.name AS plan_name, mp.discount_percent AS plan_discount_percent,
                  mp.benefits AS plan_benefits
           FROM customer_memberships cm JOIN membership_plans mp ON mp.id = cm.plan_id
           WHERE cm.customer_id=? AND cm.status='active' AND cm.expires_at >= ?
           ORDER BY cm.expires_at DESC LIMIT 1`, [customer_id, py.todayIso()]).fetchone();
}

/** [winning_percent, tier|null, premium|null] - premium only when it won. */
function get_winning_membership_rate(db, customer_id) {
  if (!customer_id) return [0.0, null, null];
  const [tier] = get_customer_tier(db, customer_id);
  const premium = get_active_premium(db, customer_id);
  const tier_pct = tier ? (tier.discount_percent || 0) : 0;
  const premium_pct = premium ? (premium.plan_discount_percent || 0) : 0;
  if (premium && premium_pct >= tier_pct && premium_pct > 0) return [premium_pct, tier, premium];
  if (tier && tier_pct > 0) return [tier_pct, tier, null];
  return [0.0, tier, null];
}

/** [discount_amount, tier|null, premium|null] */
function resolve_membership_discount(db, customer_id, cart_total) {
  if (!customer_id || cart_total <= 0) return [0.0, null, null];
  const [pct, tier, premium] = get_winning_membership_rate(db, customer_id);
  if (pct <= 0) return [0.0, tier, null];
  return [py.round(cart_total * pct / 100.0, 2), tier, premium];
}

/* ---------------- points / loyalty ---------------- */

/** [earn_rate, redeem_rate] */
function get_points_rates() {
  const earn = pyFloat(get_setting('points_earn_rate', '1') || 0);
  const redeem = pyFloat(get_setting('points_redeem_rate', '10') || 0);
  return [earn, redeem];
}

function get_points_balance(db, customer_id) {
  if (!customer_id) return 0.0;
  const row = db.execute('SELECT COALESCE(SUM(points), 0) AS bal FROM points_ledger WHERE customer_id=?', [customer_id]).fetchone();
  return row.bal || 0.0;
}

/** [points_used, discount_amount] - capped by balance (prior orders only)
 *  and by payable_total. */
function resolve_points_redemption(db, customer_id, requested_points, payable_total) {
  if (!customer_id || !requested_points || requested_points <= 0 || !payable_total || payable_total <= 0) return [0.0, 0.0];
  const [, redeem_rate] = get_points_rates(db);
  if (redeem_rate <= 0) return [0.0, 0.0];
  const balance = get_points_balance(db, customer_id);
  let points_used = Math.min(requested_points, balance);
  if (points_used <= 0) return [0.0, 0.0];
  let discount = points_used / redeem_rate;
  if (discount > payable_total) {
    discount = payable_total;
    points_used = discount * redeem_rate;
  }
  return [py.round(points_used, 2), py.round(discount, 2)];
}

/** Only call for an ACTIVE Premium member. */
function compute_points_earned(db, customer_id, final_payable_amount) {
  if (!customer_id || !final_payable_amount || final_payable_amount <= 0) return 0.0;
  const [earn_rate] = get_points_rates(db);
  if (earn_rate <= 0) return 0.0;
  return py.round(final_payable_amount * earn_rate, 2);
}

/** Ledger rows for one order. Does not commit. */
function record_points_ledger(db, customer_id, order_id, points_earned, points_used) {
  if (points_used && points_used > 0) {
    db.execute('INSERT INTO points_ledger (customer_id, order_id, points, reason) VALUES (?,?,?,?)',
      [customer_id, order_id, -Math.abs(points_used), 'redeemed']);
  }
  if (points_earned && points_earned > 0) {
    db.execute('INSERT INTO points_ledger (customer_id, order_id, points, reason) VALUES (?,?,?,?)',
      [customer_id, order_id, points_earned, 'earned']);
  }
}

/** Python str(float) - "1.0" rather than "1". */
function floatStr(n) {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/* ---------------- admin: tiers ---------------- */

bp.route('/', admin_required(function index() {
  const db = get_db();
  const tiers = db.execute('SELECT * FROM membership_tiers ORDER BY min_spend ASC, sort_order ASC').fetchall();
  const plans = db.execute('SELECT * FROM membership_plans ORDER BY price ASC, id ASC').fetchall();
  const plan_member_counts = {};
  for (const r of db.execute("SELECT plan_id, COUNT(*) c FROM customer_memberships WHERE status='active' GROUP BY plan_id").fetchall()) {
    plan_member_counts[r.plan_id] = r.c;
  }
  const [points_earn_rate, points_redeem_rate] = get_points_rates(db);
  return render_template('website/membership.html', { tiers, plans, plan_member_counts, points_earn_rate, points_redeem_rate });
}));

bp.route('/points/save', ['POST'], admin_required(function save_points_settings() {
  let earn_rate; let redeem_rate;
  try {
    earn_rate = pyFloat(request.form.get('points_earn_rate', '1'));
    redeem_rate = pyFloat(request.form.get('points_redeem_rate', '10'));
  } catch (_) {
    flash('Earn rate and redeem rate must be numbers.', 'error');
    return redirect(url_for('membership.index'));
  }
  if (earn_rate < 0) {
    flash("Points earn rate can't be negative.", 'error');
    return redirect(url_for('membership.index'));
  }
  if (redeem_rate <= 0) {
    flash('Points redeem rate must be greater than 0 (this is how many points equal Rs.1 of discount).', 'error');
    return redirect(url_for('membership.index'));
  }
  set_setting('points_earn_rate', floatStr(earn_rate));
  set_setting('points_redeem_rate', floatStr(redeem_rate));
  flash('Points Program settings updated.', 'success');
  return redirect(url_for('membership.index'));
}));

function tierNumbers() {
  return [pyFloat(request.form.get('min_spend', '0')), pyFloat(request.form.get('discount_percent', '0'))];
}

bp.route('/tiers/<int:tier_id>/edit', ['POST'], admin_required(function edit_tier({ tier_id }) {
  const db = get_db();
  const tier = db.execute('SELECT * FROM membership_tiers WHERE id=?', [tier_id]).fetchone();
  if (!tier) {
    flash('Tier not found.', 'error');
    return redirect(url_for('membership.index'));
  }
  const name = request.form.get('name', '').trim();
  if (!name) {
    flash('Tier name is required.', 'error');
    return redirect(url_for('membership.index'));
  }
  let min_spend; let discount_percent;
  try { [min_spend, discount_percent] = tierNumbers(); } catch (_) {
    flash('Minimum spend and discount % must be numbers.', 'error');
    return redirect(url_for('membership.index'));
  }
  if (min_spend < 0) {
    flash("Minimum spend can't be negative.", 'error');
    return redirect(url_for('membership.index'));
  }
  if (discount_percent < 0 || discount_percent > 100) {
    flash('Discount % must be between 0 and 100.', 'error');
    return redirect(url_for('membership.index'));
  }
  db.execute('UPDATE membership_tiers SET name=?, min_spend=?, discount_percent=? WHERE id=?', [name, min_spend, discount_percent, tier_id]);
  db.commit();
  flash(`${name} tier updated.`, 'success');
  return redirect(url_for('membership.index'));
}));

bp.route('/tiers/new', ['POST'], admin_required(function new_tier() {
  const db = get_db();
  const name = request.form.get('name', '').trim();
  if (!name) {
    flash('Tier name is required.', 'error');
    return redirect(url_for('membership.index'));
  }
  let min_spend; let discount_percent;
  try { [min_spend, discount_percent] = tierNumbers(); } catch (_) {
    flash('Minimum spend and discount % must be numbers.', 'error');
    return redirect(url_for('membership.index'));
  }
  if (min_spend < 0 || discount_percent < 0 || discount_percent > 100) {
    flash("Minimum spend can't be negative and discount % must be between 0 and 100.", 'error');
    return redirect(url_for('membership.index'));
  }
  const next_sort = (db.execute('SELECT COALESCE(MAX(sort_order), 0) m FROM membership_tiers').fetchone().m || 0) + 1;
  db.execute('INSERT INTO membership_tiers (name, min_spend, discount_percent, sort_order) VALUES (?,?,?,?)', [name, min_spend, discount_percent, next_sort]);
  db.commit();
  flash(`${name} tier added.`, 'success');
  return redirect(url_for('membership.index'));
}));

bp.route('/tiers/<int:tier_id>/toggle', ['POST'], admin_required(function toggle_tier({ tier_id }) {
  const db = get_db();
  const tier = db.execute('SELECT * FROM membership_tiers WHERE id=?', [tier_id]).fetchone();
  if (!tier) {
    flash('Tier not found.', 'error');
    return redirect(url_for('membership.index'));
  }
  const new_state = tier.is_active ? 0 : 1;
  db.execute('UPDATE membership_tiers SET is_active=? WHERE id=?', [new_state, tier_id]);
  db.commit();
  flash(new_state ? 'Tier activated.' : 'Tier deactivated.', 'success');
  return redirect(url_for('membership.index'));
}));

/* ---------------- admin: plans ---------------- */

function planFields() {
  const f = request.form;
  return {
    price: pyFloat(f.get('price', '0')),
    duration_days: pyInt(f.get('duration_days', '365')),
    discount_percent: pyFloat(f.get('discount_percent', '0')),
  };
}

bp.route('/plans/new', ['POST'], admin_required(function new_plan() {
  const db = get_db();
  const name = request.form.get('name', '').trim();
  if (!name) {
    flash('Plan name is required.', 'error');
    return redirect(url_for('membership.index'));
  }
  let p;
  try { p = planFields(); } catch (_) {
    flash('Price, duration, and discount % must be numbers.', 'error');
    return redirect(url_for('membership.index'));
  }
  if (p.price < 0 || p.duration_days < 1 || p.discount_percent < 0 || p.discount_percent > 100) {
    flash('Price/duration must be positive and discount % must be between 0 and 100.', 'error');
    return redirect(url_for('membership.index'));
  }
  const benefits = request.form.get('benefits', '').trim();
  db.execute('INSERT INTO membership_plans (name, price, duration_days, discount_percent, benefits) VALUES (?,?,?,?,?)',
    [name, p.price, p.duration_days, p.discount_percent, benefits]);
  db.commit();
  flash(`${name} plan added.`, 'success');
  return redirect(url_for('membership.index'));
}));

bp.route('/plans/<int:plan_id>/edit', ['POST'], admin_required(function edit_plan({ plan_id }) {
  const db = get_db();
  const plan = db.execute('SELECT * FROM membership_plans WHERE id=?', [plan_id]).fetchone();
  if (!plan) {
    flash('Plan not found.', 'error');
    return redirect(url_for('membership.index'));
  }
  const name = request.form.get('name', '').trim();
  if (!name) {
    flash('Plan name is required.', 'error');
    return redirect(url_for('membership.index'));
  }
  let p;
  try { p = planFields(); } catch (_) {
    flash('Price, duration, and discount % must be numbers.', 'error');
    return redirect(url_for('membership.index'));
  }
  if (p.price < 0 || p.duration_days < 1 || p.discount_percent < 0 || p.discount_percent > 100) {
    flash('Price/duration must be positive and discount % must be between 0 and 100.', 'error');
    return redirect(url_for('membership.index'));
  }
  const benefits = request.form.get('benefits', '').trim();
  db.execute('UPDATE membership_plans SET name=?, price=?, duration_days=?, discount_percent=?, benefits=? WHERE id=?',
    [name, p.price, p.duration_days, p.discount_percent, benefits, plan_id]);
  db.commit();
  flash(`${name} plan updated.`, 'success');
  return redirect(url_for('membership.index'));
}));

bp.route('/plans/<int:plan_id>/toggle', ['POST'], admin_required(function toggle_plan({ plan_id }) {
  const db = get_db();
  const plan = db.execute('SELECT * FROM membership_plans WHERE id=?', [plan_id]).fetchone();
  if (!plan) {
    flash('Plan not found.', 'error');
    return redirect(url_for('membership.index'));
  }
  const new_state = plan.is_active ? 0 : 1;
  db.execute('UPDATE membership_plans SET is_active=? WHERE id=?', [new_state, plan_id]);
  db.commit();
  flash(new_state ? 'Plan activated - customers can be enrolled again.'
    : 'Plan deactivated - existing members keep their benefits until expiry, but no new enrollments.', 'success');
  return redirect(url_for('membership.index'));
}));

/* ---------------- admin: members ---------------- */

bp.route('/members', admin_required(function members() {
  const db = get_db();
  const q = request.args.get('q', '').trim();
  const rows = [];
  if (q) {
    const customers = db.execute('SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name COLLATE NOCASE LIMIT 50', [`%${q}%`, `%${q}%`]).fetchall();
    for (const c of customers) {
      const [tier, spend, next_tier] = get_customer_tier(db, c.id);
      rows.push({ customer: c, tier, spend, next_tier, premium: get_active_premium(db, c.id) });
    }
  }
  const pending_requests = db.execute(`SELECT cm.*, c.name AS customer_name, c.phone AS customer_phone, mp.name AS plan_name, mp.price AS plan_price
           FROM customer_memberships cm
           JOIN customers c ON c.id = cm.customer_id
           JOIN membership_plans mp ON mp.id = cm.plan_id
           WHERE cm.status='requested' ORDER BY cm.created_at DESC`).fetchall();
  const plans = db.execute('SELECT * FROM membership_plans WHERE is_active=1 ORDER BY price ASC').fetchall();
  return render_template('website/membership_members.html', { q, rows, pending_requests, plans });
}));

/** Manually grant/renew Premium (payment collected offline). */
bp.route('/members/<int:customer_id>/assign-premium', ['POST'], admin_required(function assign_premium({ customer_id }) {
  const db = get_db();
  const q = request.form.get('q', '');
  const customer = db.execute('SELECT * FROM customers WHERE id=?', [customer_id]).fetchone();
  if (!customer) {
    flash('Customer not found.', 'error');
    return redirect(url_for('membership.members'));
  }
  let plan_id;
  try { plan_id = pyInt(request.form.get('plan_id', '')); } catch (_) {
    flash('Please choose a plan.', 'error');
    return redirect(url_for('membership.members', { q }));
  }
  const plan = db.execute('SELECT * FROM membership_plans WHERE id=? AND is_active=1', [plan_id]).fetchone();
  if (!plan) {
    flash('That plan is not available.', 'error');
    return redirect(url_for('membership.members', { q }));
  }
  db.execute("UPDATE customer_memberships SET status='cancelled' WHERE customer_id=? AND status='active'", [customer_id]);
  const today = py.today();
  const expires = py.isoDate(py.addDays(today, plan.duration_days));
  db.execute(`INSERT INTO customer_memberships (customer_id, plan_id, status, started_at, expires_at, amount_paid, notes)
           VALUES (?,?, 'active', ?, ?, ?, ?)`, [customer_id, plan_id, py.isoDate(today), expires, plan.price, 'Assigned by admin']);
  db.commit();
  flash(`${customer.name} is now a ${plan.name} member until ${expires}.`, 'success');
  return redirect(url_for('membership.members', { q }));
}));

bp.route('/members/<int:customer_id>/cancel-premium', ['POST'], admin_required(function cancel_premium({ customer_id }) {
  const db = get_db();
  db.execute("UPDATE customer_memberships SET status='cancelled' WHERE customer_id=? AND status='active'", [customer_id]);
  db.commit();
  flash('Premium membership cancelled.', 'success');
  return redirect(url_for('membership.members', { q: request.form.get('q', '') }));
}));

/** Storefront "Request Premium" -> active, once payment is collected offline. */
bp.route('/requests/<int:membership_id>/approve', ['POST'], admin_required(function approve_request({ membership_id }) {
  const db = get_db();
  const req = db.execute("SELECT * FROM customer_memberships WHERE id=? AND status='requested'", [membership_id]).fetchone();
  if (!req) {
    flash('Request not found (it may have already been handled).', 'error');
    return redirect(url_for('membership.members'));
  }
  const plan = db.execute('SELECT * FROM membership_plans WHERE id=?', [req.plan_id]).fetchone();
  db.execute("UPDATE customer_memberships SET status='cancelled' WHERE customer_id=? AND status='active'", [req.customer_id]);
  const today = py.today();
  const expires = py.isoDate(py.addDays(today, plan.duration_days));
  db.execute("UPDATE customer_memberships SET status='active', started_at=?, expires_at=?, amount_paid=? WHERE id=?",
    [py.isoDate(today), expires, plan.price, membership_id]);
  db.commit();
  flash('Membership request approved and activated.', 'success');
  return redirect(url_for('membership.members'));
}));

bp.route('/requests/<int:membership_id>/dismiss', ['POST'], admin_required(function dismiss_request({ membership_id }) {
  const db = get_db();
  db.execute("UPDATE customer_memberships SET status='cancelled' WHERE id=? AND status='requested'", [membership_id]);
  db.commit();
  flash('Request dismissed.', 'success');
  return redirect(url_for('membership.members'));
}));

module.exports = {
  bp, get_lifetime_spend, get_all_tiers, get_customer_tier, get_active_premium, get_winning_membership_rate,
  resolve_membership_discount, get_points_rates, get_points_balance, resolve_points_redemption,
  compute_points_earned, record_points_ledger,
};
