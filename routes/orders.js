'use strict';
const { Blueprint, request, session, redirect, url_for, flash, pyInt, pyFloat } = require('../lib/core');
const { render_template } = require('../lib/render');
const py = require('../lib/py');
const { get_db, get_setting, next_number, paginate } = require('../db');
const { login_required, has_permission } = require('../auth');
const { get_active_branch_id, is_all_branches_view, get_branch_name } = require('../branches');
const membership = require('./membership');
const { create_notification } = require('./alerts');

const bp = new Blueprint('orders', { url_prefix: '/orders' });

bp.before_request(function _require_order_permission() {
  if (!('user_id' in session)) return redirect(url_for('login', { next: request.path }));
  if (!has_permission('order')) {
    flash("You don't have access to the Order module. Please contact the admin.", 'error');
    return redirect(url_for('dashboard'));
  }
  return undefined;
});

const STATUSES = ['Order Placed', 'Lens Fitting', 'Ready for Pickup', 'Delivered', 'Cancelled'];

// Whitelisted ?sort= keys -> SQL expression. Never ORDER BY the raw value.
const SORT_COLUMNS = {
  order_no: 'o.order_no',
  customer: 'c.name',
  phone: 'c.phone',
  branch: 'br.name',
  source: 'o.source',
  status: 'o.status',
  order_date: 'o.order_date',
  expected_delivery: 'o.expected_delivery_date',
};
const DEFAULT_SORT = 'order_date';
const DEFAULT_DIR = 'desc';
const PAGE_SIZE = 20;
const fmtG = (n) => py.percentFormat('%g', [n]);

bp.route('/', login_required(function index() {
  const db = get_db();
  const status = request.args.get('status', '').trim();
  const q = request.args.get('q', '').trim();
  const source = request.args.get('source', '').trim();
  let sort = request.args.get('sort', DEFAULT_SORT).trim();
  if (!(sort in SORT_COLUMNS)) sort = DEFAULT_SORT;
  let sort_dir = request.args.get('dir', DEFAULT_DIR).trim().toLowerCase();
  if (sort_dir !== 'asc' && sort_dir !== 'desc') sort_dir = DEFAULT_DIR;

  const from_clause = `FROM orders o JOIN customers c ON c.id = o.customer_id
              LEFT JOIN branches br ON br.id = o.branch_id`;
  let where = 'WHERE 1=1';
  const params = [];
  if (!is_all_branches_view()) { where += ' AND o.branch_id = ?'; params.push(get_active_branch_id()); }
  if (status) { where += ' AND o.status = ?'; params.push(status); }
  if (source === 'online' || source === 'in_store') { where += ' AND o.source = ?'; params.push(source); }
  if (q) {
    where += ' AND (c.name LIKE ? OR o.order_no LIKE ? OR c.phone LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) ${from_clause} ${where}`, params, request.args.get('page', 1), PAGE_SIZE);
  const orders = db.execute(`SELECT o.*, c.name as customer_name, c.phone as customer_phone
              ${from_clause} ${where}
              ORDER BY ${SORT_COLUMNS[sort]} ${sort_dir.toUpperCase()}, o.id DESC
              LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset]).fetchall();
  const page_url = (p) => url_for('orders.index', { q, status, source, sort, dir: sort_dir, page: p });
  return render_template('orders/index.html', {
    orders, statuses: STATUSES, status, q, source, all_branches_view: is_all_branches_view(), get_branch_name,
    sort, sort_dir, page, total_pages, total, page_url,
  });
}));

const RX_KEYS = ['rx_number', 'od_sph', 'od_cyl', 'od_axis', 'os_sph', 'os_cyl', 'os_axis', 'add_power', 'pd', 'prescribed_by', 'prescribed_date'];

bp.route('/new', ['GET', 'POST'], login_required(function new_() {
  const db = get_db();
  const order_branch_id = get_active_branch_id();
  if (is_all_branches_view()) {
    flash("Please select a specific branch from the sidebar before creating an order (orders can't be created in All Branches view).", 'error');
    return redirect(url_for('dashboard'));
  }

  if (request.method === 'POST') {
    const f = request.form;
    const customer_id = pyInt(f.require('customer_id'));
    const rx_mode = f.get('rx_mode', 'existing');
    let prescription_id = f.get('prescription_id') || null;
    const expected_delivery_date = f.get('expected_delivery_date', '');
    const notes = f.get('notes', '').trim();

    if (rx_mode === 'new') {
      const new_rx = {};
      for (const k of RX_KEYS) new_rx[k] = f.get(`new_${k}`, '').trim();
      if (Object.values(new_rx).some(Boolean)) {
        const cur_rx = db.execute(`INSERT INTO prescriptions
                       (customer_id, rx_number, od_sph, od_cyl, od_axis, os_sph, os_cyl, os_axis, add_power, pd, prescribed_by, prescribed_date)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [customer_id, ...RX_KEYS.map((k) => new_rx[k])]);
        prescription_id = cur_rx.lastrowid;
      }
    }

    const items = [];
    for (const [t, ref, desc, qty, price] of py.zip(f.getlist('item_type[]'), f.getlist('item_ref[]'),
      f.getlist('description[]'), f.getlist('qty[]'), f.getlist('unit_price[]'))) {
      if (!desc.trim()) continue;
      items.push({ type: t, ref: ref ? pyInt(ref) : null, desc: desc.trim(), qty: pyInt(qty || 1), price: pyFloat(price || 0) });
    }
    if (!items.length) {
      flash('Please add at least one item to the order.', 'error');
      return redirect(url_for('orders.new', { customer_id }));
    }

    // Stock check - frames only (lenses/contact lenses are always sourced to order).
    let stock_error = null;
    for (const it of items) {
      if (it.type === 'frame' && it.ref) {
        const row = db.execute('SELECT stock_qty FROM frames WHERE id=?', [it.ref]).fetchone();
        if (row && row.stock_qty < it.qty) {
          stock_error = `Not enough stock for '${it.desc}' (available: ${row.stock_qty}).`;
          break;
        }
      }
    }
    if (stock_error) {
      flash(stock_error, 'error');
      return redirect(url_for('orders.new', { customer_id }));
    }

    // Membership discount - resolved fresh server-side off the submitted items.
    const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);
    const [membership_discount, membership_tier, membership_premium] = membership.resolve_membership_discount(db, customer_id, subtotal);

    // Points redemption - re-verified/capped server-side.
    let requested_points;
    try { requested_points = pyFloat(f.get('points_redeem', '0') || 0); } catch (_) { requested_points = 0.0; }
    const payable_before_points = Math.max(subtotal - membership_discount, 0);
    const [points_used, points_discount] = membership.resolve_points_redemption(db, customer_id, requested_points, payable_before_points);
    const final_payable = payable_before_points - points_discount;

    // Only ACTIVE Premium members earn points, on the final payable amount.
    let points_earned = 0.0;
    if (membership.get_active_premium(db, customer_id)) {
      points_earned = membership.compute_points_earned(db, customer_id, final_payable);
    }

    const order_no = next_number(get_setting('order_prefix', 'ORD'), 'orders');
    const cur = db.execute(`INSERT INTO orders (branch_id, order_no, customer_id, prescription_id, status, expected_delivery_date, notes, created_by,
               membership_tier_id, membership_plan_id, membership_discount_amount,
               points_earned, points_redeemed, points_discount_amount)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      order_branch_id, order_no, customer_id, prescription_id, 'Order Placed', expected_delivery_date, notes,
      session.get('full_name'),
      membership_tier && membership_discount && !membership_premium ? membership_tier.id : null,
      membership_premium ? membership_premium.plan_id : null,
      membership_discount, points_earned, points_used, points_discount,
    ]);
    const order_id = cur.lastrowid;

    let pending_pos_created = 0;
    for (const it of items) {
      const item_cur = db.execute(`INSERT INTO order_items (order_id, item_type, item_id, description, qty, unit_price, total_price)
                   VALUES (?,?,?,?,?,?,?)`, [order_id, it.type, it.ref, it.desc, it.qty, it.price, it.qty * it.price]);
      const order_item_id = item_cur.lastrowid;
      if (it.type === 'frame') {
        if (it.ref) db.execute('UPDATE frames SET stock_qty = stock_qty - ? WHERE id=?', [it.qty, it.ref]);
      } else if (it.type === 'lens' || it.type === 'contact_lens') {
        const table = it.type === 'lens' ? 'lenses' : 'contact_lenses';
        if (it.ref) db.execute(`UPDATE ${table} SET stock_qty = MAX(stock_qty - ?, 0) WHERE id=?`, [it.qty, it.ref]);
        // Every lens/contact-lens line becomes its own Pending PO (no supplier yet).
        const po_number = next_number(get_setting('po_prefix', 'PO'), 'purchase_orders');
        const po_cur = db.execute(`INSERT INTO purchase_orders
                       (branch_id, po_number, supplier_id, purchase_type, status, order_id, order_item_id)
                       VALUES (?,?,NULL,?,'Pending',?,?)`, [order_branch_id, po_number, it.type, order_id, order_item_id]);
        db.execute(`INSERT INTO purchase_order_items
                       (po_id, item_type, item_id, prescription_id, description, qty)
                       VALUES (?,?,?,?,?,?)`, [po_cur.lastrowid, it.type, it.ref, prescription_id, it.desc, it.qty]);
        pending_pos_created += 1;
      }
    }

    let label = '';
    if (membership_discount) {
      label = membership_premium
        ? `Premium Membership Discount (${membership_premium.plan_name})`
        : `${membership_tier.name} Membership Discount`;
      db.execute(`INSERT INTO order_items (order_id, item_type, item_id, description, qty, unit_price, total_price)
                   VALUES (?,?,?,?,?,?,?)`, [order_id, 'other', null, label, 1, -membership_discount, -membership_discount]);
    }
    if (points_discount) {
      db.execute(`INSERT INTO order_items (order_id, item_type, item_id, description, qty, unit_price, total_price)
                   VALUES (?,?,?,?,?,?,?)`, [order_id, 'other', null, `Points Redeemed Discount (${fmtG(points_used)} pts)`, 1, -points_discount, -points_discount]);
    }
    membership.record_points_ledger(db, customer_id, order_id, points_earned, points_used);

    const customer_row = db.execute('SELECT name FROM customers WHERE id=?', [customer_id]).fetchone();
    create_notification(db, 'order_placed', `New in-store order ${order_no}`,
      `${customer_row ? customer_row.name : 'A customer'} - Rs. ${final_payable.toFixed(2)}`,
      { link_url: url_for('orders.detail', { order_id }), branch_id: order_branch_id, related_type: 'order', related_id: order_id });
    db.commit();

    const discount_note = membership_discount ? ` A ${label} of Rs. ${membership_discount.toFixed(2)} was applied.` : '';
    let points_note = '';
    if (points_discount) points_note += ` Rs. ${points_discount.toFixed(2)} off using ${fmtG(points_used)} redeemed points.`;
    if (points_earned) points_note += ` ${fmtG(points_earned)} points earned on this order.`;
    if (pending_pos_created) {
      flash(`Order ${order_no} created.${discount_note}${points_note} ${pending_pos_created} item(s) added to Purchase Orders as ` +
        'Pending - pick a supplier there to move them to Ordered.', 'success');
    } else {
      flash(`Order ${order_no} created.${discount_note}${points_note}`, 'success');
    }
    return redirect(url_for('orders.detail', { order_id }));
  }

  const customers = db.execute('SELECT * FROM customers ORDER BY name').fetchall();
  const frames = db.execute('SELECT * FROM frames WHERE stock_qty > 0 AND is_active = 1 AND branch_id = ? ORDER BY brand', [order_branch_id]).fetchall();
  const lenses = db.execute('SELECT * FROM lenses WHERE branch_id = ? ORDER BY lens_type', [order_branch_id]).fetchall();
  const contacts = db.execute('SELECT * FROM contact_lenses WHERE branch_id = ? ORDER BY brand', [order_branch_id]).fetchall();
  const preselect_customer = request.args.get('customer_id', null, { type: pyInt });
  return render_template('orders/form.html', { customers, frames, lenses, contacts, preselect_customer });
}), { endpoint: 'new' });

bp.route('/customer/<int:customer_id>/prescriptions.json', login_required(function customer_prescriptions_json({ customer_id }) {
  const rows = get_db().execute('SELECT id, prescribed_date, od_sph, od_cyl, od_axis, os_sph, os_cyl, os_axis, add_power, pd ' +
    'FROM prescriptions WHERE customer_id=? ORDER BY created_at DESC', [customer_id]).fetchall();
  return { prescriptions: rows };
}));

/** Live preview of the winning membership discount RATE (preview only). */
bp.route('/customer/<int:customer_id>/membership.json', login_required(function customer_membership_json({ customer_id }) {
  const [pct, tier, premium] = membership.get_winning_membership_rate(get_db(), customer_id);
  let label = null;
  if (premium) label = `${premium.plan_name} Member`;
  else if (tier) label = `${tier.name} Tier`;
  return { percent: pct, label };
}));

/** Live preview of the redeemable points balance (preview only). */
bp.route('/customer/<int:customer_id>/points.json', login_required(function customer_points_json({ customer_id }) {
  const db = get_db();
  const balance = membership.get_points_balance(db, customer_id);
  const [, redeem_rate] = membership.get_points_rates(db);
  return { balance, redeem_rate };
}));

bp.route('/<int:order_id>', login_required(function detail({ order_id }) {
  const db = get_db();
  const order = db.execute(`SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
           FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`, [order_id]).fetchone();
  if (!order) {
    flash('Order not found.', 'error');
    return redirect(url_for('orders.index'));
  }
  const items = db.execute('SELECT * FROM order_items WHERE order_id=?', [order_id]).fetchall();
  const prescription = order.prescription_id
    ? db.execute('SELECT * FROM prescriptions WHERE id=?', [order.prescription_id]).fetchone() : null;
  const invoice = db.execute('SELECT * FROM invoices WHERE order_id=?', [order_id]).fetchone();
  const returns = db.execute('SELECT * FROM returns WHERE order_id=? ORDER BY created_at DESC', [order_id]).fetchall();
  const returned_qty_by_item = {};
  for (const r of returns) returned_qty_by_item[r.order_item_id] = (returned_qty_by_item[r.order_item_id] || 0) + r.qty;
  const po_by_order_item = {};
  for (const po of db.execute('SELECT * FROM purchase_orders WHERE order_id=?', [order_id]).fetchall()) po_by_order_item[po.order_item_id] = po;

  const b = order.branch_id;
  const frames = db.execute('SELECT * FROM frames WHERE stock_qty > 0 AND is_active = 1 AND branch_id = ? ORDER BY brand', [b]).fetchall();
  const lenses = db.execute('SELECT * FROM lenses WHERE branch_id = ? ORDER BY lens_type', [b]).fetchall();
  const contacts = db.execute('SELECT * FROM contact_lenses WHERE branch_id = ? ORDER BY brand', [b]).fetchall();
  return render_template('orders/detail.html', {
    order, items, statuses: STATUSES, prescription, invoice, returns, returned_qty_by_item, po_by_order_item,
    frames, lenses, contacts,
  });
}));

/** +1 releases each line's qty back to stock (cancel), -1 re-reserves it. */
function _adjust_order_stock(db, order_id, direction) {
  const items = db.execute('SELECT item_type, item_id, qty FROM order_items WHERE order_id=?', [order_id]).fetchall();
  for (const it of items) {
    if (!it.item_id) continue;
    const delta = direction * it.qty;
    if (it.item_type === 'frame') {
      db.execute('UPDATE frames SET stock_qty = MAX(stock_qty + ?, 0) WHERE id=?', [delta, it.item_id]);
    } else if (it.item_type === 'lens' || it.item_type === 'contact_lens') {
      const table = it.item_type === 'lens' ? 'lenses' : 'contact_lenses';
      db.execute(`UPDATE ${table} SET stock_qty = MAX(stock_qty + ?, 0) WHERE id=?`, [delta, it.item_id]);
    }
  }
}

function reviewUrlIfEnabled() {
  return get_setting('review_request_on_delivery', '0') === '1' ? url_for('store.account', { _external: true }) : null;
}

bp.route('/<int:order_id>/status', ['POST'], login_required(async function update_status({ order_id }) {
  const { send_notification, order_ready_message, order_delivered_message } = require('../notifications');
  const db = get_db();
  const new_status = request.form.get('status');
  if (!STATUSES.includes(new_status)) {
    flash('Invalid status.', 'error');
    return redirect(url_for('orders.detail', { order_id }));
  }
  const old_row = db.execute('SELECT status FROM orders WHERE id=?', [order_id]).fetchone();
  const old_status = old_row ? old_row.status : null;

  if (new_status === 'Delivered') {
    db.execute('UPDATE orders SET status=?, delivered_date=? WHERE id=?', [new_status, py.nowStr(), order_id]);
  } else {
    db.execute('UPDATE orders SET status=? WHERE id=?', [new_status, order_id]);
  }
  // Only when the transition actually crosses the Cancelled boundary.
  if (old_status !== 'Cancelled' && new_status === 'Cancelled') _adjust_order_stock(db, order_id, +1);
  else if (old_status === 'Cancelled' && new_status !== 'Cancelled') _adjust_order_stock(db, order_id, -1);
  db.commit();
  flash(`Order status set to '${new_status}'.`, 'success');

  const should_notify = (new_status === 'Ready for Pickup' && get_setting('notify_on_ready', '1') === '1') ||
    (new_status === 'Delivered' && get_setting('notify_on_delivered', '0') === '1');
  if (should_notify) {
    const order = db.execute(`SELECT o.order_no, c.id as customer_id, c.name as customer_name, c.phone
               FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id=?`, [order_id]).fetchone();
    if (order) {
      const shop_name = get_setting('shop_name', 'Optical Shop');
      const msg = new_status === 'Ready for Pickup'
        ? order_ready_message(shop_name, order.order_no, order.customer_name)
        : order_delivered_message(shop_name, order.order_no, order.customer_name, reviewUrlIfEnabled());
      await send_notification(order.phone, msg, order.customer_id, order_id);
    }
  }
  return redirect(url_for('orders.detail', { order_id }));
}));

bp.route('/<int:order_id>/notify', ['POST'], login_required(async function notify_customer({ order_id }) {
  const { send_notification, order_ready_message, order_delivered_message } = require('../notifications');
  const db = get_db();
  const order = db.execute(`SELECT o.order_no, o.status, c.id as customer_id, c.name as customer_name, c.phone
           FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id=?`, [order_id]).fetchone();
  if (!order) {
    flash('Order not found.', 'error');
    return redirect(url_for('orders.index'));
  }
  const shop_name = get_setting('shop_name', 'Optical Shop');
  const custom_message = request.form.get('message', '').trim();
  let msg;
  if (custom_message) msg = custom_message;
  else if (order.status === 'Delivered') msg = order_delivered_message(shop_name, order.order_no, order.customer_name, reviewUrlIfEnabled());
  else msg = order_ready_message(shop_name, order.order_no, order.customer_name);
  const result = await send_notification(order.phone, msg, order.customer_id, order_id);
  if (result.ok) flash('SMS sent to customer.', 'success');
  else flash(`Couldn't send SMS: ${result.reason}`, 'error');
  return redirect(url_for('orders.detail', { order_id }));
}));

module.exports = { bp, STATUSES };
