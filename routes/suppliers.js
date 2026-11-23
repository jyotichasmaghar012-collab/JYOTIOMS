'use strict';
const { Blueprint, request, session, redirect, url_for, flash, jsonify, pyInt, pyFloat } = require('../lib/core');
const { render_template } = require('../lib/render');
const { zip } = require('../lib/py');
const { get_db, get_setting, next_number, paginate } = require('../db');
const { login_required, admin_required, has_permission } = require('../auth');
const { get_active_branch_id, is_all_branches_view, get_branch_name } = require('../branches');

const LIST_PAGE_SIZE = 20;
const bp = new Blueprint('suppliers');

const STOCK_TABLES = { frame: 'frames', lens: 'lenses', contact_lens: 'contact_lenses' };
const PO_STATUSES = ['Pending', 'Ordered', 'Partially Received', 'Received', 'Cancelled'];
const PO_PAYMENT_STATUSES = ['Due', 'Partial', 'Paid'];
const PURCHASE_TYPES = [['frame', 'Frame'], ['lens', 'Lens'], ['contact_lens', 'Contact Lens']];

bp.before_request(function _require_supplier_permission() {
  if (!('user_id' in session)) return redirect(url_for('login', { next: request.path }));
  // Supplier records are gated by "supplier"; anything purchase-order related
  // by "po_generation".
  const endpoint = (request.endpoint || '').split('.').pop();
  const perm_key = (endpoint.startsWith('po_') || endpoint.startsWith('purchase_requests_')) ? 'po_generation' : 'supplier';
  if (!has_permission(perm_key)) {
    const label = perm_key === 'po_generation' ? 'PO Generation' : 'Supplier';
    flash(`You don't have access to the ${label} module. Please contact the admin.`, 'error');
    return redirect(url_for('dashboard'));
  }
  return undefined;
});

function _po_totals(db, po_id) {
  const row = db.execute('SELECT COALESCE(SUM(total_cost),0) t FROM purchase_order_items WHERE po_id=?', [po_id]).fetchone();
  const total_cost = row.t || 0;
  const po = db.execute('SELECT amount_paid FROM purchase_orders WHERE id=?', [po_id]).fetchone();
  const amount_paid = po ? po.amount_paid : 0;
  return { total_cost, outstanding: Math.max(total_cost - amount_paid, 0) };
}

/** Ordered -> Partially Received -> Received, based on received_qty vs qty. */
function _recalc_po_status(db, po_id) {
  const po = db.execute('SELECT status FROM purchase_orders WHERE id=?', [po_id]).fetchone();
  if (!po || po.status === 'Cancelled') return;
  const items = db.execute('SELECT qty, received_qty FROM purchase_order_items WHERE po_id=?', [po_id]).fetchall();
  if (!items.length) return;
  const total_qty = items.reduce((s, it) => s + it.qty, 0);
  const total_received = items.reduce((s, it) => s + it.received_qty, 0);
  let new_status;
  if (total_received <= 0) new_status = 'Ordered';
  else if (total_received >= total_qty) new_status = 'Received';
  else new_status = 'Partially Received';
  if (new_status === 'Received') {
    db.execute("UPDATE purchase_orders SET status=?, received_date=datetime('now') WHERE id=?", [new_status, po_id]);
  } else {
    db.execute('UPDATE purchase_orders SET status=? WHERE id=?', [new_status, po_id]);
  }
}

/* ---------------- Suppliers ---------------- */
bp.route('/suppliers', login_required(function index() {
  const suppliers = get_db().execute('SELECT * FROM suppliers ORDER BY name').fetchall();
  return render_template('suppliers/index.html', { suppliers });
}));

function supplierFields(f) {
  return [f.require('name').trim(), f.get('phone', '').trim(), f.get('email', '').trim(),
    f.get('address', '').trim(), f.get('notes', '').trim()];
}

bp.route('/suppliers/new', ['GET', 'POST'], login_required(function new_() {
  if (request.method === 'POST') {
    const db = get_db();
    const cur = db.execute('INSERT INTO suppliers (name, phone, email, address, notes) VALUES (?,?,?,?,?)', supplierFields(request.form));
    db.commit();
    flash('Supplier added.', 'success');
    return redirect(url_for('suppliers.detail', { supplier_id: cur.lastrowid }));
  }
  return render_template('suppliers/form.html', { supplier: null });
}), { endpoint: 'new' });

bp.route('/suppliers/<int:supplier_id>', login_required(function detail({ supplier_id }) {
  const db = get_db();
  const supplier = db.execute('SELECT * FROM suppliers WHERE id=?', [supplier_id]).fetchone();
  if (!supplier) {
    flash('Supplier not found.', 'error');
    return redirect(url_for('suppliers.index'));
  }
  const purchase_orders = db.execute('SELECT * FROM purchase_orders WHERE supplier_id=? ORDER BY created_at DESC', [supplier_id]).fetchall();
  const outstanding_row = db.execute(`SELECT COALESCE(SUM(total_cost),0) t FROM purchase_order_items
           WHERE po_id IN (SELECT id FROM purchase_orders WHERE supplier_id=? AND status != 'Cancelled')`, [supplier_id]).fetchone();
  const paid_row = db.execute("SELECT COALESCE(SUM(amount_paid),0) t FROM purchase_orders WHERE supplier_id=? AND status != 'Cancelled'", [supplier_id]).fetchone();
  const outstanding = Math.max((outstanding_row.t || 0) - (paid_row.t || 0), 0);
  return render_template('suppliers/detail.html', { supplier, purchase_orders, outstanding, purchase_types: PURCHASE_TYPES });
}));

bp.route('/suppliers/<int:supplier_id>/edit', ['GET', 'POST'], login_required(function edit({ supplier_id }) {
  const db = get_db();
  const supplier = db.execute('SELECT * FROM suppliers WHERE id=?', [supplier_id]).fetchone();
  if (!supplier) {
    flash('Supplier not found.', 'error');
    return redirect(url_for('suppliers.index'));
  }
  if (request.method === 'POST') {
    db.execute('UPDATE suppliers SET name=?, phone=?, email=?, address=?, notes=? WHERE id=?', [...supplierFields(request.form), supplier_id]);
    db.commit();
    flash('Supplier updated.', 'success');
    return redirect(url_for('suppliers.detail', { supplier_id }));
  }
  return render_template('suppliers/form.html', { supplier });
}));

bp.route('/suppliers/<int:supplier_id>/delete', ['POST'], admin_required(function delete_({ supplier_id }) {
  const db = get_db();
  db.execute('DELETE FROM suppliers WHERE id=?', [supplier_id]);
  db.commit();
  flash('Supplier deleted.', 'success');
  return redirect(url_for('suppliers.index'));
}), { endpoint: 'delete' });

/* ---------------- Purchase Orders ---------------- */
bp.route('/purchase-orders', login_required(function po_index() {
  const db = get_db();
  const status = request.args.get('status', '').trim();
  const purchase_type = request.args.get('purchase_type', '').trim();
  // LEFT JOIN suppliers - a "Pending" PO auto-created from an order has no supplier yet.
  const from_clause = `FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
             LEFT JOIN orders o ON o.id = po.order_id
             LEFT JOIN customers c ON c.id = o.customer_id`;
  let where = 'WHERE 1=1';
  const params = [];
  if (!is_all_branches_view()) { where += ' AND po.branch_id = ?'; params.push(get_active_branch_id()); }
  if (status) { where += ' AND po.status = ?'; params.push(status); }
  if (purchase_type) { where += ' AND po.purchase_type = ?'; params.push(purchase_type); }

  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) ${from_clause} ${where}`, params, request.args.get('page', 1), LIST_PAGE_SIZE);
  const pos = db.execute(`SELECT po.*, s.name as supplier_name, o.order_no, c.name as customer_name, c.phone as customer_phone
            ${from_clause} ${where} ORDER BY po.created_at DESC LIMIT ? OFFSET ?`, [...params, LIST_PAGE_SIZE, offset]).fetchall();
  const all_suppliers = db.execute('SELECT * FROM suppliers ORDER BY name').fetchall();

  // Every order-linked PO always has exactly one item.
  const linked = pos.filter((r) => r.order_id).map((r) => r.id);
  const item_by_po = {};
  if (linked.length) {
    const ph = linked.map(() => '?').join(',');
    for (const it of db.execute(`SELECT * FROM purchase_order_items WHERE po_id IN (${ph})`, linked).fetchall()) {
      if (!(it.po_id in item_by_po)) item_by_po[it.po_id] = it;
    }
  }
  const page_url = (p) => url_for('suppliers.po_index', { status, purchase_type, page: p });
  return render_template('suppliers/po_index.html', {
    pos, statuses: PO_STATUSES, status, purchase_types: PURCHASE_TYPES, purchase_type,
    all_suppliers, item_by_po, all_branches_view: is_all_branches_view(), get_branch_name,
    page, total_pages, total, page_url,
  });
}));

/** Pending PO (auto-created from an order line) gets a supplier + unit cost
 *  right on the PO list and moves to Ordered. */
bp.route('/purchase-orders/<int:po_id>/assign-supplier', ['POST'], login_required(function po_assign_supplier({ po_id }) {
  const db = get_db();
  const po = db.execute('SELECT * FROM purchase_orders WHERE id=?', [po_id]).fetchone();
  const return_status = request.form.get('return_status', 'Pending').trim() || 'Pending';
  if (!po) {
    flash('Purchase order not found.', 'error');
    return redirect(url_for('suppliers.po_index', { status: return_status }));
  }
  if (po.status !== 'Pending') {
    flash('This purchase order already has a supplier assigned.', 'error');
    return redirect(url_for('suppliers.po_index', { status: return_status }));
  }
  const supplier_id = request.form.get('supplier_id') || null;
  if (!supplier_id) {
    flash('Please select a supplier.', 'error');
    return redirect(url_for('suppliers.po_index', { status: return_status }));
  }
  const unit_cost = pyFloat(request.form.get('unit_cost') || 0);
  db.execute("UPDATE purchase_orders SET supplier_id=?, status='Ordered' WHERE id=?", [supplier_id, po_id]);
  db.execute('UPDATE purchase_order_items SET unit_cost=?, total_cost = qty * ? WHERE po_id=?', [unit_cost, unit_cost, po_id]);
  db.commit();
  flash(`Supplier assigned - ${po.po_number} is now Ordered.`, 'success');
  return redirect(url_for('suppliers.po_index', { status: return_status }));
}));

bp.route('/purchase-orders/<int:po_id>/prescription.json', login_required(function po_prescription_json({ po_id }) {
  const db = get_db();
  const po = db.execute(`SELECT po.order_id, c.name as customer_name, o.order_no,
                  (SELECT prescription_id FROM purchase_order_items WHERE po_id = po.id LIMIT 1) as prescription_id
           FROM purchase_orders po
           LEFT JOIN orders o ON o.id = po.order_id
           LEFT JOIN customers c ON c.id = o.customer_id
           WHERE po.id=?`, [po_id]).fetchone();
  if (!po) return [jsonify({ ok: false, error: 'Purchase order not found.' }), 404];
  if (!po.prescription_id) return [jsonify({ ok: false, error: 'This item has no prescription attached.' }), 404];
  const rx = db.execute('SELECT * FROM prescriptions WHERE id=?', [po.prescription_id]).fetchone();
  if (!rx) return [jsonify({ ok: false, error: 'Prescription not found.' }), 404];
  return jsonify({ ok: true, customer_name: po.customer_name, order_no: po.order_no, prescription: rx });
}));

function _po_new_frame(db, supplier, po_branch_id) {
  const supplier_id = supplier.id;
  if (request.method === 'POST') {
    const f = request.form;
    const notes = f.get('notes', '').trim();
    const expected_delivery_date = f.get('expected_delivery_date', '').trim();
    const items = [];
    for (const [t, desc, ref, qty, cost] of zip(f.getlist('item_type[]'), f.getlist('description[]'),
      f.getlist('item_ref[]'), f.getlist('qty[]'), f.getlist('unit_cost[]'))) {
      if (!desc.trim()) continue;
      items.push({
        type: t || 'frame', desc: desc.trim(), ref: ref ? pyInt(ref) : null,
        qty: pyInt(qty || 1), cost: pyFloat(cost || 0),
      });
    }
    if (!items.length) {
      flash('Please add at least one item to the purchase order.', 'error');
      return redirect(url_for('suppliers.po_new', { supplier_id, purchase_type: 'frame' }));
    }
    const po_number = next_number(get_setting('po_prefix', 'PO'), 'purchase_orders');
    const cur = db.execute(`INSERT INTO purchase_orders (branch_id, po_number, supplier_id, purchase_type, status, notes, expected_delivery_date)
               VALUES (?,?,?,?,?,?,?)`, [po_branch_id, po_number, supplier_id, 'frame', 'Ordered', notes, expected_delivery_date]);
    const po_id = cur.lastrowid;
    for (const it of items) {
      db.execute(`INSERT INTO purchase_order_items (po_id, item_type, item_id, description, qty, unit_cost, total_cost)
                   VALUES (?,?,?,?,?,?,?)`, [po_id, it.type, it.ref, it.desc, it.qty, it.cost, it.qty * it.cost]);
    }
    db.commit();
    flash(`Purchase order ${po_number} created.`, 'success');
    return redirect(url_for('suppliers.po_detail', { po_id }));
  }
  const frames = db.execute('SELECT * FROM frames WHERE branch_id = ? ORDER BY brand', [po_branch_id]).fetchall();
  return render_template('suppliers/po_form_frame.html', { supplier, frames });
}

function _po_new_lens_contact(db, supplier, po_branch_id, purchase_type) {
  const supplier_id = supplier.id;
  const type_label = purchase_type === 'lens' ? 'Lens' : 'Contact Lens';
  if (request.method === 'POST') {
    const f = request.form;
    const notes = f.get('notes', '').trim();
    const expected_delivery_date = f.get('expected_delivery_date', '').trim();
    const customer_id = f.get('customer_id') || null;
    const rx_mode = f.get('rx_mode', 'existing');
    let prescription_id = f.get('prescription_id') || null;

    if (rx_mode === 'new' && customer_id) {
      const keys = ['rx_number', 'od_sph', 'od_cyl', 'od_axis', 'os_sph', 'os_cyl', 'os_axis', 'add_power', 'pd', 'prescribed_by', 'prescribed_date'];
      const new_rx = {};
      for (const k of keys) new_rx[k] = f.get(`new_${k}`, '').trim();
      if (Object.values(new_rx).some(Boolean)) {
        const cur_rx = db.execute(`INSERT INTO prescriptions
                       (customer_id, rx_number, od_sph, od_cyl, od_axis, os_sph, os_cyl, os_axis, add_power, pd, prescribed_by, prescribed_date)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [customer_id, ...keys.map((k) => new_rx[k])]);
        prescription_id = cur_rx.lastrowid;
      }
    }

    const items = [];
    for (const [lt, brand, qty, cost] of zip(f.getlist('lens_type[]'), f.getlist('brand[]'), f.getlist('qty[]'), f.getlist('unit_cost[]'))) {
      if (!lt.trim() && !brand.trim()) continue;
      const desc = [lt.trim(), brand.trim()].filter(Boolean).join(' - ') || type_label;
      items.push({ desc, qty: pyInt(qty || 1), cost: pyFloat(cost || 0) });
    }
    if (!items.length) {
      flash('Please add at least one item to the purchase order.', 'error');
      return redirect(url_for('suppliers.po_new', { supplier_id, purchase_type }));
    }
    const po_number = next_number(get_setting('po_prefix', 'PO'), 'purchase_orders');
    const cur = db.execute(`INSERT INTO purchase_orders (branch_id, po_number, supplier_id, purchase_type, status, notes, expected_delivery_date)
               VALUES (?,?,?,?,?,?,?)`, [po_branch_id, po_number, supplier_id, purchase_type, 'Ordered', notes, expected_delivery_date]);
    const po_id = cur.lastrowid;
    for (const it of items) {
      db.execute(`INSERT INTO purchase_order_items (po_id, item_type, item_id, prescription_id, description, qty, unit_cost, total_cost)
                   VALUES (?,?,?,?,?,?,?,?)`, [po_id, purchase_type, null, prescription_id, it.desc, it.qty, it.cost, it.qty * it.cost]);
    }
    db.commit();
    flash(`Purchase order ${po_number} created.`, 'success');
    return redirect(url_for('suppliers.po_detail', { po_id }));
  }
  const customers = db.execute('SELECT * FROM customers ORDER BY name').fetchall();
  return render_template('suppliers/po_form_lens.html', { supplier, customers, purchase_type, type_label });
}

bp.route('/suppliers/<int:supplier_id>/purchase-orders/new/<purchase_type>', ['GET', 'POST'], login_required(function po_new({ supplier_id, purchase_type }) {
  if (!(purchase_type in STOCK_TABLES)) {
    flash('Invalid purchase order type.', 'error');
    return redirect(url_for('suppliers.detail', { supplier_id }));
  }
  const db = get_db();
  const supplier = db.execute('SELECT * FROM suppliers WHERE id=?', [supplier_id]).fetchone();
  if (!supplier) {
    flash('Supplier not found.', 'error');
    return redirect(url_for('suppliers.index'));
  }
  if (is_all_branches_view()) {
    flash('Please select a specific branch from the sidebar before creating a purchase order.', 'error');
    return redirect(url_for('suppliers.detail', { supplier_id }));
  }
  const po_branch_id = get_active_branch_id();
  if (purchase_type === 'frame') return _po_new_frame(db, supplier, po_branch_id);
  return _po_new_lens_contact(db, supplier, po_branch_id, purchase_type);
}));

/** Add a brand-new frame to inventory from the Frame PO page popup. */
bp.route('/suppliers/<int:supplier_id>/frames/quick-add', ['POST'], login_required(function po_frame_quick_add() {
  const db = get_db();
  if (is_all_branches_view()) return [jsonify({ ok: false, error: 'Please select a specific branch first.' }), 400];
  const branch_id = get_active_branch_id();
  const f = request.form;
  const brand = f.get('brand', '').trim();
  if (!brand) return [jsonify({ ok: false, error: 'Brand is required.' }), 400];
  const model = f.get('model', '').trim();
  const color = f.get('color', '').trim();
  const size = f.get('size', '').trim();
  const cost_price = pyFloat(f.get('cost_price') || 0);
  const selling_price = pyFloat(f.get('selling_price') || 0);
  const cur = db.execute(`INSERT INTO frames (branch_id, brand, model, color, size, cost_price, selling_price, stock_qty, low_stock_threshold)
           VALUES (?,?,?,?,?,?,?,0,2)`, [branch_id, brand, model, color, size, cost_price, selling_price]);
  db.commit();
  const label = [brand, model, color].filter(Boolean).join(' ');
  return jsonify({ ok: true, id: cur.lastrowid, label, cost: cost_price });
}));

bp.route('/purchase-orders/customer/<int:customer_id>/prescriptions.json', login_required(function po_customer_prescriptions_json({ customer_id }) {
  const rows = get_db().execute('SELECT id, prescribed_date, od_sph, od_cyl, od_axis, os_sph, os_cyl, os_axis, add_power, pd, rx_number ' +
    'FROM prescriptions WHERE customer_id=? ORDER BY created_at DESC', [customer_id]).fetchall();
  return jsonify({ prescriptions: rows });
}));

bp.route('/purchase-orders/<int:po_id>', login_required(function po_detail({ po_id }) {
  const db = get_db();
  const po = db.execute(`SELECT po.*, s.name as supplier_name, s.phone as supplier_phone FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=?`, [po_id]).fetchone();
  if (!po) {
    flash('Purchase order not found.', 'error');
    return redirect(url_for('suppliers.po_index'));
  }
  const items = db.execute('SELECT * FROM purchase_order_items WHERE po_id=?', [po_id]).fetchall();
  const prescriptions = {};
  for (const it of items) {
    if (it.prescription_id && !(it.prescription_id in prescriptions)) {
      prescriptions[it.prescription_id] = db.execute('SELECT * FROM prescriptions WHERE id=?', [it.prescription_id]).fetchone();
    }
  }
  const totals = _po_totals(db, po_id);
  const all_suppliers = db.execute('SELECT * FROM suppliers ORDER BY name').fetchall();
  return render_template('suppliers/po_detail.html', { po, items, statuses: PO_STATUSES, prescriptions, totals, all_suppliers });
}));

bp.route('/purchase-orders/<int:po_id>/receive', ['POST'], login_required(function po_receive({ po_id }) {
  const db = get_db();
  const po = db.execute('SELECT * FROM purchase_orders WHERE id=?', [po_id]).fetchone();
  if (!po) {
    flash('Purchase order not found.', 'error');
    return redirect(url_for('suppliers.po_index'));
  }
  if (po.status === 'Received' || po.status === 'Cancelled') {
    flash('This purchase order can no longer be received.', 'error');
    return redirect(url_for('suppliers.po_detail', { po_id }));
  }
  const f = request.form;
  let any_received = false;
  for (const [poi_id, recv_raw, dmg_raw] of zip(f.getlist('poi_id[]'), f.getlist('receive_qty[]'), f.getlist('damaged_qty[]'))) {
    let recv_qty = pyInt(recv_raw || 0);
    let damaged_qty = pyInt(dmg_raw || 0);
    if (recv_qty <= 0) continue;
    const item = db.execute('SELECT * FROM purchase_order_items WHERE id=? AND po_id=?', [poi_id, po_id]).fetchone();
    if (!item) continue;
    const remaining = item.qty - item.received_qty;
    if (remaining <= 0) continue;
    recv_qty = Math.min(recv_qty, remaining);
    damaged_qty = Math.min(damaged_qty, recv_qty);
    const sellable_qty = recv_qty - damaged_qty;
    db.execute('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id=?', [recv_qty, item.id]);
    const table = STOCK_TABLES[item.item_type];
    if (table && item.item_id && sellable_qty > 0) {
      db.execute(`UPDATE ${table} SET stock_qty = stock_qty + ? WHERE id=?`, [sellable_qty, item.item_id]);
    }
    any_received = true;
  }
  if (!any_received) {
    flash('No valid receive quantity was entered.', 'error');
    return redirect(url_for('suppliers.po_detail', { po_id }));
  }
  _recalc_po_status(db, po_id);
  db.commit();
  flash('Goods received - inventory stock updated.', 'success');
  return redirect(url_for('suppliers.po_detail', { po_id }));
}));

bp.route('/purchase-orders/<int:po_id>/payment', ['POST'], login_required(function po_payment({ po_id }) {
  const db = get_db();
  const po = db.execute('SELECT * FROM purchase_orders WHERE id=?', [po_id]).fetchone();
  if (!po) {
    flash('Purchase order not found.', 'error');
    return redirect(url_for('suppliers.po_index'));
  }
  const totals = _po_totals(db, po_id);
  let amount_paid = pyFloat(request.form.get('amount_paid') || 0);
  const payment_mode = request.form.get('payment_mode', '').trim();
  const supplier_invoice_no = request.form.get('supplier_invoice_no', '').trim();
  let payment_status;
  if (amount_paid <= 0) payment_status = 'Due';
  else if (amount_paid >= totals.total_cost) { payment_status = 'Paid'; amount_paid = totals.total_cost; } else payment_status = 'Partial';
  db.execute('UPDATE purchase_orders SET amount_paid=?, payment_mode=?, supplier_invoice_no=?, payment_status=? WHERE id=?',
    [amount_paid, payment_mode, supplier_invoice_no, payment_status, po_id]);
  db.commit();
  flash('Payment updated.', 'success');
  return redirect(url_for('suppliers.po_detail', { po_id }));
}));

bp.route('/purchase-orders/<int:po_id>/cancel', ['POST'], login_required(function po_cancel({ po_id }) {
  const db = get_db();
  const po = db.execute('SELECT * FROM purchase_orders WHERE id=?', [po_id]).fetchone();
  if (!po) {
    flash('Purchase order not found.', 'error');
    return redirect(url_for('suppliers.po_index'));
  }
  if (po.status === 'Received' || po.status === 'Partially Received') {
    flash("A purchase order that has already received goods (in full or in part) can't be cancelled.", 'error');
    return redirect(url_for('suppliers.po_detail', { po_id }));
  }
  db.execute("UPDATE purchase_orders SET status='Cancelled' WHERE id=?", [po_id]);
  db.commit();
  flash('Purchase order cancelled.', 'success');
  return redirect(url_for('suppliers.po_detail', { po_id }));
}));

/** Old "Purchase Requests" page - merged into Purchase Orders (Pending tab). */
bp.route('/purchase-requests', login_required(function purchase_requests_index() {
  return redirect(url_for('suppliers.po_index', { status: 'Pending' }));
}));

module.exports = { bp, PO_STATUSES, PO_PAYMENT_STATUSES, PURCHASE_TYPES, STOCK_TABLES };
