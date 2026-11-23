'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Blueprint, request, session, redirect, url_for, flash, Response, pyFloat } = require('../lib/core');
const { render_template } = require('../lib/render');
const { Canvas, mm, A4, landscape } = require('../lib/pdfcanvas');
const py = require('../lib/py');
const { get_db, get_setting, next_number, paginate, BASE_DIR } = require('../db');
const { login_required, has_permission } = require('../auth');
const { get_active_branch_id, is_all_branches_view, get_branch_name } = require('../branches');

const bp = new Blueprint('billing');
const PAGE_SIZE = 20;

bp.before_request(function _require_billing_permission() {
  if (!('user_id' in session)) return redirect(url_for('login', { next: request.path }));
  if (!has_permission('billing')) {
    flash("You don't have access to the Billing module. Please contact the admin.", 'error');
    return redirect(url_for('dashboard'));
  }
  return undefined;
});

/** Invoice-list filters from the querystring - shared by the HTML list and
 *  the PDF report so both always see exactly the same rows. */
function _invoice_filters_from_args() {
  return {
    status: request.args.get('status', '').trim(),
    q: request.args.get('q', '').trim(),
    date_from: request.args.get('date_from', '').trim(),
    date_to: request.args.get('date_to', '').trim(),
  };
}

function _invoices_where({ status, q, date_from, date_to }) {
  let where = 'WHERE 1=1';
  const params = [];
  if (!is_all_branches_view()) { where += ' AND o.branch_id = ?'; params.push(get_active_branch_id()); }
  if (status) { where += ' AND i.payment_status = ?'; params.push(status); }
  if (q) {
    where += ' AND (i.invoice_no LIKE ? OR o.order_no LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (date_from) { where += ' AND date(i.created_at) >= date(?)'; params.push(date_from); }
  if (date_to) { where += ' AND date(i.created_at) <= date(?)'; params.push(date_to); }
  return [where, params];
}

const _INVOICES_FROM = `FROM invoices i
              JOIN customers c ON c.id = i.customer_id
              JOIN orders o ON o.id = i.order_id`;

function _query_invoices(filters, limit = null, offset = null) {
  const [where, p] = _invoices_where(filters);
  let params = p;
  let sql = `SELECT i.*, c.name as customer_name, o.order_no, o.branch_id as branch_id, CAST(julianday('now') - julianday(i.created_at) AS INTEGER) as days_since ${_INVOICES_FROM} ${where} ORDER BY i.created_at DESC`;
  if (limit !== null) { sql += ' LIMIT ? OFFSET ?'; params = [...params, limit, offset]; }
  return get_db().execute(sql, params).fetchall();
}

bp.route('/invoices', login_required(function index() {
  const f = _invoice_filters_from_args();
  const [where, count_params] = _invoices_where(f);
  const db = get_db();
  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) ${_INVOICES_FROM} ${where}`, count_params, request.args.get('page', 1), PAGE_SIZE);
  const invoices = _query_invoices(f, PAGE_SIZE, offset);
  const page_url = (p) => url_for('billing.index', { page: p, ...f });
  return render_template('billing/index.html', {
    invoices, ...f, all_branches_view: is_all_branches_view(), get_branch_name,
    page, total_pages, total, page_url,
  });
}));

const fix2 = (n) => Number(n || 0).toFixed(2);

function pdfResponse(buf, download_name) {
  return new Response(buf, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename=${download_name}`,
  });
}

/** Export the currently-filtered invoice list as a PDF report. */
bp.route('/invoices/report/pdf', login_required(async function invoices_report_pdf() {
  const f = _invoice_filters_from_args();
  const rows = _query_invoices(f);
  const show_branch = is_all_branches_view();
  const currency = get_setting('currency_symbol', 'Rs.');
  const shop_name = get_setting('shop_name') || 'My Optical Shop';
  const branchNames = rows.map((i) => (show_branch ? (get_branch_name(i.branch_id) || '-').slice(0, 16) : null));

  const c = new Canvas({ pagesize: landscape(A4) });
  const { width, height } = c;
  const cols = [['Invoice#', 20, 'left'], ['Order#', 45, 'left'], ['Customer', 70, 'left']];
  if (show_branch) cols.push(['Branch', 120, 'left']);
  const amt_x = show_branch ? 165 : 140;
  cols.push(['Total', amt_x, 'right'], ['Paid', amt_x + 25, 'right'], ['Status', amt_x + 50, 'left'],
    ['Due Since', amt_x + 75, 'left'], ['Date', amt_x + 105, 'left']);

  function draw_header(y) {
    c.setFont('Helvetica-Bold', 14);
    c.drawString(15 * mm, y, shop_name);
    c.setFont('Helvetica', 9);
    c.drawRightString(width - 15 * mm, y, 'Invoices Report');
    y -= 6 * mm;
    const bits = [];
    if (f.q) bits.push(`Search: "${f.q}"`);
    if (f.status) bits.push(`Status: ${f.status}`);
    if (f.date_from) bits.push(`From: ${f.date_from}`);
    if (f.date_to) bits.push(`To: ${f.date_to}`);
    c.setFont('Helvetica', 8);
    c.drawString(15 * mm, y, 'Filters: ' + (bits.length ? bits.join(', ') : 'None (all invoices)'));
    c.drawRightString(width - 15 * mm, y, `${rows.length} invoice(s)`);
    y -= 8 * mm;
    c.setFont('Helvetica-Bold', 8);
    for (const [label, x, align] of cols) {
      if (align === 'right') c.drawRightString(x * mm, y, label); else c.drawString(x * mm, y, label);
    }
    y -= 2 * mm;
    c.line(15 * mm, y, width - 15 * mm, y);
    y -= 5 * mm;
    return y;
  }

  let y = draw_header(height - 15 * mm);
  c.setFont('Helvetica', 8);
  let total_amt = 0; let total_paid = 0; let total_due = 0;
  rows.forEach((i, idx) => {
    if (y < 20 * mm) {
      c.showPage();
      y = draw_header(height - 15 * mm);
      c.setFont('Helvetica', 8);
    }
    let due_label = '-';
    if (i.payment_status !== 'Paid') due_label = i.days_since <= 0 ? 'Today' : `${i.days_since}d overdue`;
    const values = [i.invoice_no, i.order_no, String(i.customer_name || '').slice(0, 22)];
    if (show_branch) values.push(branchNames[idx]);
    values.push(`${currency} ${fix2(i.total)}`, `${currency} ${fix2(i.amount_paid)}`,
      i.payment_status, due_label, String(i.created_at || '').slice(0, 10));
    cols.forEach(([, x, align], k) => {
      const val = py.str(values[k]);
      if (align === 'right') c.drawRightString(x * mm, y, val); else c.drawString(x * mm, y, val);
    });
    y -= 6 * mm;
    total_amt += i.total || 0;
    total_paid += i.amount_paid || 0;
    total_due += Math.max((i.total || 0) - (i.amount_paid || 0), 0);
  });
  if (rows.length) {
    y -= 2 * mm;
    c.line(15 * mm, y, width - 15 * mm, y);
    y -= 6 * mm;
    c.setFont('Helvetica-Bold', 9);
    c.drawString(15 * mm, y, `Totals: Billed ${currency} ${fix2(total_amt)}   |   Paid ${currency} ${fix2(total_paid)}   |   Due ${currency} ${fix2(total_due)}`);
  } else {
    c.setFont('Helvetica', 10);
    c.drawString(15 * mm, y, 'No invoices match the selected filters.');
  }
  c.showPage();
  const buf = await c.save();
  return pdfResponse(buf, 'invoices_report.pdf');
}));

bp.route('/orders/<int:order_id>/invoice/create', ['GET', 'POST'], login_required(function create_invoice({ order_id }) {
  const db = get_db();
  const order = db.execute('SELECT * FROM orders WHERE id=?', [order_id]).fetchone();
  if (!order) {
    flash('Order not found.', 'error');
    return redirect(url_for('orders.index'));
  }
  const existing = db.execute('SELECT * FROM invoices WHERE order_id=?', [order_id]).fetchone();
  if (existing) return redirect(url_for('billing.view_invoice', { invoice_id: existing.id }));

  const items = db.execute('SELECT * FROM order_items WHERE order_id=?', [order_id]).fetchall();
  const subtotal = items.reduce((s, it) => s + it.total_price, 0);
  const default_gst = pyFloat(get_setting('gst_percent', '12'));
  let prescription = null;
  if (order.prescription_id) {
    prescription = db.execute('SELECT * FROM prescriptions WHERE id=?', [order.prescription_id]).fetchone();
  }

  if (request.method === 'POST') {
    const f = request.form;
    const discount = pyFloat(f.get('discount') || 0);
    const gst_percent = pyFloat(f.get('gst_percent') || 0);
    const amount_paid = pyFloat(f.get('amount_paid') || 0);
    const payment_mode = f.get('payment_mode', '').trim();
    const taxable = Math.max(subtotal - discount, 0);
    const gst_amount = py.round(taxable * gst_percent / 100, 2);
    const total = py.round(taxable + gst_amount, 2);
    let payment_status;
    if (amount_paid <= 0) payment_status = 'Due';
    else if (amount_paid >= total) payment_status = 'Paid';
    else payment_status = 'Partial';

    const invoice_no = next_number(get_setting('invoice_prefix', 'INV'), 'invoices');
    const cur = db.execute(`INSERT INTO invoices (invoice_no, order_id, customer_id, subtotal, discount, gst_percent,
               gst_amount, total, payment_status, amount_paid, payment_mode)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [invoice_no, order_id, order.customer_id, subtotal, discount, gst_percent,
      gst_amount, total, payment_status, amount_paid, payment_mode]);
    db.commit();
    flash(`Invoice ${invoice_no} generated.`, 'success');
    return redirect(url_for('billing.view_invoice', { invoice_id: cur.lastrowid }));
  }
  return render_template('billing/create_invoice.html', { order, items, subtotal, default_gst, prescription });
}));

function loadInvoice(db, invoice_id) {
  return db.execute(`SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
                  o.order_no, o.prescription_id as prescription_id FROM invoices i
           JOIN customers c ON c.id=i.customer_id
           JOIN orders o ON o.id = i.order_id WHERE i.id=?`, [invoice_id]).fetchone();
}

bp.route('/invoices/<int:invoice_id>', login_required(function view_invoice({ invoice_id }) {
  const db = get_db();
  const invoice = loadInvoice(db, invoice_id);
  if (!invoice) {
    flash('Invoice not found.', 'error');
    return redirect(url_for('billing.index'));
  }
  const items = db.execute('SELECT * FROM order_items WHERE order_id=?', [invoice.order_id]).fetchall();
  const prescription = invoice.prescription_id
    ? db.execute('SELECT * FROM prescriptions WHERE id=?', [invoice.prescription_id]).fetchone() : null;
  const shop = {
    name: get_setting('shop_name'),
    address: get_setting('shop_address'),
    phone: get_setting('shop_phone'),
    currency: get_setting('currency_symbol', 'Rs.'),
  };
  return render_template('billing/invoice.html', { invoice, items, shop, prescription });
}));

bp.route('/invoices/<int:invoice_id>/payment', ['POST'], login_required(function update_payment({ invoice_id }) {
  const db = get_db();
  const invoice = db.execute('SELECT * FROM invoices WHERE id=?', [invoice_id]).fetchone();
  if (!invoice) {
    flash('Invoice not found.', 'error');
    return redirect(url_for('billing.index'));
  }
  let amount_paid = pyFloat(request.form.get('amount_paid') || 0);
  const payment_mode = request.form.get('payment_mode', '').trim();
  let payment_status;
  if (amount_paid <= 0) payment_status = 'Due';
  else if (amount_paid >= invoice.total) { payment_status = 'Paid'; amount_paid = invoice.total; } else payment_status = 'Partial';
  db.execute('UPDATE invoices SET amount_paid=?, payment_mode=?, payment_status=? WHERE id=?', [amount_paid, payment_mode, payment_status, invoice_id]);
  db.commit();
  flash('Payment updated.', 'success');
  return redirect(url_for('billing.view_invoice', { invoice_id }));
}));

bp.route('/invoices/<int:invoice_id>/pdf', login_required(async function invoice_pdf({ invoice_id }) {
  const db = get_db();
  const invoice = loadInvoice(db, invoice_id);
  if (!invoice) {
    flash('Invoice not found.', 'error');
    return redirect(url_for('billing.index'));
  }
  const items = db.execute('SELECT * FROM order_items WHERE order_id=?', [invoice.order_id]).fetchall();
  const rx = invoice.prescription_id
    ? db.execute('SELECT * FROM prescriptions WHERE id=?', [invoice.prescription_id]).fetchone() : null;
  const shop_name = get_setting('shop_name');
  const shop_address = get_setting('shop_address');
  const shop_phone = get_setting('shop_phone');
  const currency = get_setting('currency_symbol', 'Rs.');

  const c = new Canvas({ pagesize: A4 });
  const { width, height } = c;
  let y = height - 25 * mm;
  c.setFont('Helvetica-Bold', 16);
  c.drawString(20 * mm, y, shop_name || 'My Optical Shop');
  c.setFont('Helvetica', 9);
  y -= 6 * mm;
  c.drawString(20 * mm, y, shop_address || '');
  y -= 5 * mm;
  c.drawString(20 * mm, y, `Phone: ${shop_phone || ''}`);

  c.setFont('Helvetica-Bold', 13);
  c.drawRightString(width - 20 * mm, height - 25 * mm, `Invoice #${invoice.invoice_no}`);
  c.setFont('Helvetica', 9);
  c.drawRightString(width - 20 * mm, height - 31 * mm, `Order: ${invoice.order_no}`);
  c.drawRightString(width - 20 * mm, height - 36 * mm, `Date: ${invoice.created_at}`);

  y -= 12 * mm;
  c.setFont('Helvetica-Bold', 10);
  c.drawString(20 * mm, y, 'Bill To:');
  c.setFont('Helvetica', 9);
  y -= 5 * mm;
  c.drawString(20 * mm, y, invoice.customer_name || '');
  y -= 5 * mm;
  c.drawString(20 * mm, y, invoice.customer_phone || '');

  if (rx) {
    const d = (v) => v || '-';
    y -= 9 * mm;
    c.setFont('Helvetica-Bold', 10);
    let rx_label = 'Prescription';
    if (rx.rx_number) rx_label += ` (Rx No. ${rx.rx_number})`;
    c.drawString(20 * mm, y, rx_label);
    c.setFont('Helvetica', 9);
    y -= 5 * mm;
    c.drawString(20 * mm, y, `OD (Right): SPH ${d(rx.od_sph)}  CYL ${d(rx.od_cyl)}  AXIS ${d(rx.od_axis)}`);
    y -= 5 * mm;
    c.drawString(20 * mm, y, `OS (Left): SPH ${d(rx.os_sph)}  CYL ${d(rx.os_cyl)}  AXIS ${d(rx.os_axis)}`);
    y -= 5 * mm;
    c.drawString(20 * mm, y, `ADD: ${d(rx.add_power)}   PD: ${d(rx.pd)}`);
    if (rx.prescribed_by || rx.prescribed_date) {
      y -= 5 * mm;
      c.drawString(20 * mm, y, `Prescribed by: ${d(rx.prescribed_by)}   Date: ${d(rx.prescribed_date)}`);
    }
  }

  y -= 10 * mm;
  c.setFont('Helvetica-Bold', 9);
  c.drawString(20 * mm, y, 'Item');
  c.drawString(110 * mm, y, 'Qty');
  c.drawString(130 * mm, y, 'Unit Price');
  c.drawString(160 * mm, y, 'Total');
  y -= 3 * mm;
  c.line(20 * mm, y, width - 20 * mm, y);
  y -= 6 * mm;

  c.setFont('Helvetica', 9);
  for (const it of items) {
    c.drawString(20 * mm, y, py.str(it.description).slice(0, 55));
    c.drawString(110 * mm, y, py.str(it.qty));
    c.drawString(130 * mm, y, `${currency} ${fix2(it.unit_price)}`);
    c.drawString(160 * mm, y, `${currency} ${fix2(it.total_price)}`);
    y -= 6 * mm;
    if (y < 40 * mm) {
      c.showPage();
      c.setFont('Helvetica', 9);
      y = height - 25 * mm;
    }
  }

  y -= 4 * mm;
  c.line(20 * mm, y, width - 20 * mm, y);
  y -= 8 * mm;
  c.setFont('Helvetica', 10);
  const row = (label, value) => {
    c.drawRightString(width - 45 * mm, y, label);
    c.drawRightString(width - 20 * mm, y, value);
  };
  row('Subtotal:', `${currency} ${fix2(invoice.subtotal)}`);
  y -= 6 * mm;
  row('Discount:', `${currency} ${fix2(invoice.discount)}`);
  y -= 6 * mm;
  row(`GST (${invoice.gst_percent}%):`, `${currency} ${fix2(invoice.gst_amount)}`);
  y -= 6 * mm;
  c.setFont('Helvetica-Bold', 11);
  row('Total:', `${currency} ${fix2(invoice.total)}`);
  y -= 8 * mm;
  c.setFont('Helvetica', 9);
  row('Paid:', `${currency} ${fix2(invoice.amount_paid)}`);
  y -= 6 * mm;
  c.setFont('Helvetica-Bold', 10);
  row('Payment Status:', invoice.payment_status);
  c.showPage();

  const buf = await c.save();
  // The per-invoice PDF is kept in data/ (as in the original app).
  try { fs.writeFileSync(path.join(require('../lib/storage').DATA_DIR, `invoice_${invoice.invoice_no}.pdf`), buf); } catch (_) { /* ignore */ }
  return pdfResponse(buf, `invoice_${invoice.invoice_no}.pdf`);
}));

module.exports = { bp };
