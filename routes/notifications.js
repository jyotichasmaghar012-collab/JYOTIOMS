'use strict';
const { Blueprint, request, redirect, url_for, flash } = require('../lib/core');
const { render_template } = require('../lib/render');
const { get_db, get_setting, set_setting, paginate } = require('../db');
const { admin_required } = require('../auth');
const { send_notification } = require('../notifications');

const bp = new Blueprint('notifications', { url_prefix: '/settings/notifications' });

bp.route('/', ['GET', 'POST'], admin_required(function index() {
  const f = request.form;
  if (request.method === 'POST') {
    set_setting('notify_provider', f.get('notify_provider', 'none'));
    set_setting('notify_api_key', f.get('notify_api_key', '').trim());
    set_setting('notify_sender_id', f.get('notify_sender_id', '').trim());
    set_setting('notify_webhook_url', f.get('notify_webhook_url', '').trim());
    set_setting('notify_on_ready', f.get('notify_on_ready') ? '1' : '0');
    set_setting('notify_on_delivered', f.get('notify_on_delivered') ? '1' : '0');
    set_setting('checkup_reminder_months', f.get('checkup_reminder_months', '12').trim());
    flash('Notification settings saved.', 'success');
    return redirect(url_for('notifications.index'));
  }

  const keys = ['notify_provider', 'notify_api_key', 'notify_sender_id', 'notify_webhook_url',
    'notify_on_ready', 'notify_on_delivered', 'checkup_reminder_months'];
  const values = {};
  for (const k of keys) values[k] = get_setting(k, '');

  const db = get_db();
  const history_page_size = 20;
  const [history_total, history_total_pages, history_page, history_offset] = paginate(
    db, 'SELECT COUNT(*) FROM notifications_log', [], request.args.get('page', 1), history_page_size);
  const history = db.execute(`SELECT n.*, c.name as customer_name FROM notifications_log n
           LEFT JOIN customers c ON c.id = n.customer_id
           ORDER BY n.created_at DESC LIMIT ? OFFSET ?`, [history_page_size, history_offset]).fetchall();
  const history_page_url = (p) => url_for('notifications.index', { page: p });

  return render_template('settings/notifications.html', {
    values, history, history_page, history_total_pages, history_total, history_page_url,
  });
}));

bp.route('/test', ['POST'], admin_required(async function test_send() {
  const phone = request.form.get('test_phone', '').trim();
  const message = request.form.get('test_message', '').trim() || 'Test message from your Optical Shop OMS.';
  const result = await send_notification(phone, message, null, null, 'sms');
  if (result.ok) flash('Test message sent! Check your phone.', 'success');
  else flash(`Couldn't send the test message: ${result.reason}`, 'error');
  return redirect(url_for('notifications.index'));
}));

module.exports = { bp };
