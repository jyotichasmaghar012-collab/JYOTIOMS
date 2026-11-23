'use strict';
/**
 * In-app Activity Notifications ("Notifications" sidebar tab) - a live feed
 * of things staff should know about at a glance: a new order, an order's
 * delivery date arriving while not yet Delivered, a product review, or a
 * Premium membership request.
 *
 * Separate from Settings > SMS Notifications (routes/notifications.js,
 * `notifications_log`), which is OUTBOUND SMS to customers.
 *
 * Branch scoping: a notification with branch_id set only shows to staff
 * viewing that branch (admin "All Branches" sees everything); branch_id=NULL
 * notifications always show to everyone.
 */
const { Blueprint, request, redirect, url_for, flash, jsonify } = require('../lib/core');
const { render_template } = require('../lib/render');
const { get_db } = require('../db');
const { login_required } = require('../auth');
const { get_active_branch_id, is_all_branches_view, get_branch_name } = require('../branches');

const bp = new Blueprint('alerts', { url_prefix: '/notifications' });

/** Insert one activity-notification row. Deliberately does NOT commit - the
 *  caller commits it together with its own INSERT. */
function create_notification(db, type, title, message = '', opts = {}) {
  const { link_url = null, branch_id = null, related_type = null, related_id = null } = opts;
  db.execute(`INSERT INTO activity_notifications (type, title, message, link_url, branch_id, related_type, related_id)
           VALUES (?,?,?,?,?,?,?)`, [type, title, message, link_url, branch_id, related_type, related_id]);
}

/** Lazily generates one 'delivery_due' notification per order whose
 *  expected_delivery_date has arrived while not Delivered/Cancelled. */
function _sync_delivery_reminders(db) {
  const due = db.execute(`SELECT o.id, o.order_no, o.branch_id, o.expected_delivery_date, c.name AS customer_name
           FROM orders o JOIN customers c ON c.id = o.customer_id
           WHERE o.expected_delivery_date IS NOT NULL AND o.expected_delivery_date != ''
             AND o.expected_delivery_date <= date('now')
             AND o.status NOT IN ('Delivered', 'Cancelled')
             AND NOT EXISTS (
               SELECT 1 FROM activity_notifications an
               WHERE an.type='delivery_due' AND an.related_type='order' AND an.related_id=o.id
             )`).fetchall();
  for (const o of due) {
    create_notification(db, 'delivery_due', `Delivery due: ${o.order_no}`,
      `${o.customer_name}'s order was expected on ${o.expected_delivery_date} - still not marked Delivered.`,
      { link_url: url_for('orders.detail', { order_id: o.id }), branch_id: o.branch_id, related_type: 'order', related_id: o.id });
  }
  if (due.length) db.commit();
}

/** [sql_fragment, params] - admin in 'All Branches' sees everything; everyone
 *  else sees their active branch's notifications plus every global one. */
function _branch_filter_sql() {
  if (is_all_branches_view()) return ['1=1', []];
  return ['(branch_id = ? OR branch_id IS NULL)', [get_active_branch_id()]];
}

bp.route('/', login_required(function index() {
  const db = get_db();
  _sync_delivery_reminders(db);
  const [where, params] = _branch_filter_sql();
  const notifications = db.execute(
    `SELECT * FROM activity_notifications WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params).fetchall();
  return render_template('alerts/index.html', { notifications, get_branch_name });
}));

bp.route('/unread-count.json', login_required(function unread_count_json() {
  const db = get_db();
  _sync_delivery_reminders(db);
  const [where, params] = _branch_filter_sql();
  const row = db.execute(`SELECT COUNT(*) c FROM activity_notifications WHERE is_read=0 AND ${where}`, params).fetchone();
  return jsonify({ count: row ? row.c : 0 });
}));

bp.route('/<int:notification_id>/read', ['POST'], login_required(function mark_read({ notification_id }) {
  const db = get_db();
  db.execute('UPDATE activity_notifications SET is_read=1 WHERE id=?', [notification_id]);
  db.commit();
  return redirect(request.referrer || url_for('alerts.index'));
}));

bp.route('/mark-all-read', ['POST'], login_required(function mark_all_read() {
  const db = get_db();
  const [where, params] = _branch_filter_sql();
  db.execute(`UPDATE activity_notifications SET is_read=1 WHERE ${where}`, params);
  db.commit();
  flash('All notifications marked as read.', 'success');
  return redirect(url_for('alerts.index'));
}));

module.exports = { bp, create_notification, _sync_delivery_reminders, _branch_filter_sql };
