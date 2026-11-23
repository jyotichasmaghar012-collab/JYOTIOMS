'use strict';
const { Blueprint, request, session, redirect, url_for, flash, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { get_db, get_setting, paginate } = require('../db');
const { login_required, has_permission } = require('../auth');

const bp = new Blueprint('customers', { url_prefix: '/customers' });
const PAGE_SIZE = 20;

bp.before_request(function _require_customer_permission() {
  if (!('user_id' in session)) return redirect(url_for('login', { next: request.path }));
  if (!has_permission('customer')) {
    flash("You don't have access to the Customer module. Please contact the admin.", 'error');
    return redirect(url_for('dashboard'));
  }
  return undefined;
});

function _checkup_due_query(db, limit = null) {
  let months;
  try { months = pyInt(get_setting('checkup_reminder_months', '12') || 12); } catch (_) { months = 12; }
  let sql = `
        SELECT c.id, c.name, c.phone, MAX(COALESCE(p.prescribed_date, p.created_at)) as last_checkup
        FROM customers c JOIN prescriptions p ON p.customer_id = c.id
        GROUP BY c.id
        HAVING date(last_checkup) <= date('now', ?)
        ORDER BY last_checkup ASC
    `;
  if (limit) sql += ` LIMIT ${pyInt(limit)}`;
  return db.execute(sql, [`-${months} months`]).fetchall();
}

bp.route('/', login_required(function index() {
  const q = request.args.get('q', '').trim();
  const db = get_db();
  let where = ''; let params = [];
  if (q) {
    const like = `%${q}%`;
    where = 'WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?';
    params = [like, like, like];
  }
  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) FROM customers ${where}`, params, request.args.get('page', 1), PAGE_SIZE);
  const rows = db.execute(`SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset]).fetchall();
  const page_url = (p) => url_for('customers.index', { q, page: p });
  return render_template('customers/index.html', { customers: rows, q, page, total_pages, total, page_url });
}));

bp.route('/new', ['GET', 'POST'], login_required(function new_() {
  if (request.method === 'POST') {
    const db = get_db();
    const f = request.form;
    const cur = db.execute('INSERT INTO customers (name, phone, email, address, notes) VALUES (?,?,?,?,?)', [
      f.require('name').trim(), f.get('phone', '').trim(), f.get('email', '').trim(),
      f.get('address', '').trim(), f.get('notes', '').trim(),
    ]);
    db.commit();
    flash('Customer added.', 'success');
    return redirect(url_for('customers.detail', { customer_id: cur.lastrowid }));
  }
  return render_template('customers/form.html', { customer: null });
}), { endpoint: 'new' });

bp.route('/<int:customer_id>', login_required(function detail({ customer_id }) {
  const db = get_db();
  const customer = db.execute('SELECT * FROM customers WHERE id = ?', [customer_id]).fetchone();
  if (!customer) {
    flash('Customer not found.', 'error');
    return redirect(url_for('customers.index'));
  }
  const prescriptions = db.execute('SELECT * FROM prescriptions WHERE customer_id = ? ORDER BY created_at DESC', [customer_id]).fetchall();
  const orders = db.execute('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [customer_id]).fetchall();
  return render_template('customers/detail.html', { customer, prescriptions, orders });
}));

bp.route('/<int:customer_id>/edit', ['GET', 'POST'], login_required(function edit({ customer_id }) {
  const db = get_db();
  const customer = db.execute('SELECT * FROM customers WHERE id = ?', [customer_id]).fetchone();
  if (!customer) {
    flash('Customer not found.', 'error');
    return redirect(url_for('customers.index'));
  }
  if (request.method === 'POST') {
    const f = request.form;
    db.execute('UPDATE customers SET name=?, phone=?, email=?, address=?, notes=? WHERE id=?', [
      f.require('name').trim(), f.get('phone', '').trim(), f.get('email', '').trim(),
      f.get('address', '').trim(), f.get('notes', '').trim(), customer_id,
    ]);
    db.commit();
    flash('Customer updated.', 'success');
    return redirect(url_for('customers.detail', { customer_id }));
  }
  return render_template('customers/form.html', { customer });
}));

bp.route('/<int:customer_id>/delete', ['POST'], login_required(function delete_({ customer_id }) {
  const db = get_db();
  db.execute('DELETE FROM customers WHERE id = ?', [customer_id]);
  db.commit();
  flash('Customer deleted.', 'success');
  return redirect(url_for('customers.index'));
}), { endpoint: 'delete' });

bp.route('/<int:customer_id>/prescriptions/new', ['GET', 'POST'], login_required(function new_prescription({ customer_id }) {
  const db = get_db();
  const customer = db.execute('SELECT * FROM customers WHERE id = ?', [customer_id]).fetchone();
  if (!customer) {
    flash('Customer not found.', 'error');
    return redirect(url_for('customers.index'));
  }
  if (request.method === 'POST') {
    const f = request.form;
    db.execute(`INSERT INTO prescriptions
               (customer_id, rx_number, od_sph, od_cyl, od_axis, os_sph, os_cyl, os_axis, add_power, pd, prescribed_by, prescribed_date, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      customer_id, f.get('rx_number', '').trim(),
      f.get('od_sph', ''), f.get('od_cyl', ''), f.get('od_axis', ''),
      f.get('os_sph', ''), f.get('os_cyl', ''), f.get('os_axis', ''),
      f.get('add_power', ''), f.get('pd', ''), f.get('prescribed_by', ''),
      f.get('prescribed_date', ''), f.get('notes', ''),
    ]);
    db.commit();
    flash('Prescription added.', 'success');
    return redirect(url_for('customers.detail', { customer_id }));
  }
  return render_template('customers/prescription_form.html', { customer });
}));

bp.route('/checkup-due', login_required(function checkup_due() {
  const rows = _checkup_due_query(get_db());
  return render_template('customers/checkup_due.html', { customers: rows });
}));

bp.route('/<int:customer_id>/send-reminder', ['POST'], login_required(async function send_reminder({ customer_id }) {
  const { send_notification, checkup_reminder_message } = require('../notifications');
  const db = get_db();
  const customer = db.execute('SELECT * FROM customers WHERE id=?', [customer_id]).fetchone();
  if (!customer) {
    flash('Customer not found.', 'error');
    return redirect(url_for('customers.index'));
  }
  const shop_name = get_setting('shop_name', 'Optical Shop');
  const msg = checkup_reminder_message(shop_name, customer.name);
  const result = await send_notification(customer.phone, msg, customer_id);
  if (result.ok) flash('Reminder sent.', 'success');
  else flash(`Couldn't send the reminder: ${result.reason}`, 'error');
  return redirect(request.referrer || url_for('customers.checkup_due'));
}));

bp.route('/checkup-due/send-all', ['POST'], login_required(async function send_all_reminders() {
  const { send_notification, checkup_reminder_message } = require('../notifications');
  const db = get_db();
  const rows = _checkup_due_query(db);
  const shop_name = get_setting('shop_name', 'Optical Shop');
  let sent = 0; let failed = 0;
  for (const c of rows) {
    const msg = checkup_reminder_message(shop_name, c.name);
    const result = await send_notification(c.phone, msg, c.id);
    if (result.ok) sent++; else failed++;
  }
  flash(`${sent} reminders sent, ${failed} failed (check Settings > Notifications for details).`, sent ? 'success' : 'error');
  return redirect(url_for('customers.checkup_due'));
}));

module.exports = { bp, _checkup_due_query };
