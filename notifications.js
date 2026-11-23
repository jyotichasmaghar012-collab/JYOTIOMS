'use strict';
/**
 * Pluggable SMS/WhatsApp notification sender.
 *
 * Supported providers (configured in Settings > Notifications):
 *   - "none"            : notifications disabled, everything is just logged
 *   - "fast2sms"        : Fast2SMS quick SMS API (India SMS gateway)
 *   - "generic_webhook" : any provider accepting a simple HTTP GET with a URL
 *                         template using {phone} and {message} placeholders.
 *
 * Every attempt (successful or not) is written to notifications_log.
 *
 * send_notification() is async (network I/O). It commits any pending DB
 * transaction before going to the network, so no write lock is held while
 * waiting on the SMS provider.
 */
const { get_db, get_setting } = require('./db');

function _log(customer_id, order_id, channel, phone, message, status, response_info = '') {
  const db = get_db();
  db.execute(`INSERT INTO notifications_log
           (customer_id, order_id, channel, phone, message, status, response_info)
           VALUES (?,?,?,?,?,?,?)`,
  [customer_id, order_id, channel, phone, message, status, String(response_info || '').slice(0, 500)]);
  db.commit();
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Never throws - always returns {ok, reason} and always logs the attempt. */
async function send_notification(phone, message, customer_id = null, order_id = null, channel = 'sms') {
  const provider = get_setting('notify_provider', 'none');
  phone = String(phone || '').trim();

  if (!phone) {
    _log(customer_id, order_id, channel, phone, message, 'failed', 'No phone number on file');
    return { ok: false, reason: 'No phone number on file' };
  }
  if (provider === 'none' || !provider) {
    _log(customer_id, order_id, channel, phone, message, 'skipped_not_configured');
    return { ok: false, reason: 'Notifications not configured yet (Settings > Notifications)' };
  }

  get_db().commit();
  let ok; let info;
  try {
    if (provider === 'fast2sms') [ok, info] = await _send_fast2sms(phone, message);
    else if (provider === 'generic_webhook') [ok, info] = await _send_generic_webhook(phone, message);
    else [ok, info] = [false, `Unknown provider '${provider}'`];
  } catch (e) {
    ok = false; info = `Error: ${e && e.message ? e.message : e}`;
  }
  _log(customer_id, order_id, channel, phone, message, ok ? 'sent' : 'failed', info);
  return { ok, reason: info };
}

async function _send_fast2sms(phone, message) {
  const api_key = get_setting('notify_api_key', '');
  if (!api_key) return [false, 'Fast2SMS API key not set in Settings'];
  let digits = phone.replace(/\D/g, '');
  if (digits.length > 10) digits = digits.slice(-10);
  const body = new URLSearchParams({
    authorization: api_key, message, language: 'english', route: 'q', numbers: digits,
  });
  const resp = await fetchWithTimeout('https://www.fast2sms.com/dev/bulkV2', { method: 'POST', body });
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text);
    return [!!parsed.return, text];
  } catch (_) {
    return [false, text];
  }
}

async function _send_generic_webhook(phone, message) {
  const template = get_setting('notify_webhook_url', '');
  if (!template) return [false, 'Webhook URL not set in Settings'];
  const url = template.split('{phone}').join(encodeURIComponent(phone)).split('{message}').join(encodeURIComponent(message));
  const resp = await fetchWithTimeout(url, { method: 'GET' });
  const text = await resp.text();
  return [resp.status >= 200 && resp.status < 300, text];
}

function order_ready_message(shop_name, order_no, customer_name) {
  return `Hi ${customer_name}, your order ${order_no} is ready for pickup. - ${shop_name}`;
}

function order_delivered_message(shop_name, order_no, customer_name, review_url = null) {
  let msg = `Thank you ${customer_name}! Your order ${order_no} has been delivered. - ${shop_name}`;
  if (review_url) msg += ` We'd love your feedback - please review your purchase: ${review_url}`;
  return msg;
}

function checkup_reminder_message(shop_name, customer_name) {
  return `Hi ${customer_name}, your eye checkup is due. Please contact us to schedule an eye test. - ${shop_name}`;
}

module.exports = { send_notification, order_ready_message, order_delivered_message, checkup_reminder_message };
