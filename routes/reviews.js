'use strict';
/**
 * Product Review & Rating System.
 *
 * - Admin moderation + Google Review settings live on this file's `bp`.
 * - Shared helpers (eligibility, upload validation, rating math, settings) are
 *   used by routes/storefront.js, which defines the customer-facing routes.
 *
 * Product reviews and Google Business Reviews are separate systems: nothing
 * here ever posts to Google; the storefront only links to the shop's own
 * Google review page.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Blueprint, request, redirect, url_for, flash, pyInt, secure_filename } = require('../lib/core');
const { render_template } = require('../lib/render');
const { extOf } = require('../lib/uploads');
const py = require('../lib/py');
const { get_db, get_setting, set_setting, paginate, BASE_DIR } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('reviews', { url_prefix: '/website/reviews' });

const REVIEW_UPLOAD_DIR = path.join(BASE_DIR, 'static', 'uploads', 'reviews');
const ALLOWED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const ALLOWED_VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
const MAX_REVIEW_IMAGES = 5;
const MAX_REVIEW_VIDEOS = 1;
const STATUS_OPTIONS = ['pending', 'approved', 'rejected', 'hidden'];

const GOOGLE_REVIEW_SETTING_KEYS = [
  'google_review_url', 'google_review_popup_enabled', 'review_auto_approve',
  'review_min_length', 'review_allow_images', 'review_allow_videos',
  'review_request_on_delivery', 'review_edit_window_hours',
  'google_rating_value', 'google_rating_count_label',
];

// eslint-disable-next-line no-control-regex
const _CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

// Best-effort in-process throttle for review/vote endpoints.
const _recent_actions = new Map();

function rate_limited(key, min_gap_seconds = 15) {
  const now = Date.now() / 1000;
  const last = _recent_actions.get(key);
  _recent_actions.set(key, now);
  if (_recent_actions.size > 5000) {
    const cutoff = now - 3600;
    for (const [k, ts] of _recent_actions) if (ts < cutoff) _recent_actions.delete(k);
  }
  return last !== undefined && (now - last) < min_gap_seconds;
}

function clean_text(value, max_len = null) {
  let v = String(value || '').replace(_CONTROL_CHARS_RE, '').trim();
  if (max_len) v = v.slice(0, max_len);
  return v;
}

function table_for(item_type) {
  return { frame: 'frames', contact_lens: 'contact_lenses' }[item_type] || null;
}

function get_review_settings() {
  const out = {};
  for (const k of GOOGLE_REVIEW_SETTING_KEYS) out[k] = get_setting(k, '');
  return out;
}

/** Most recent Delivered order containing this product for this customer -
 *  the only source of truth for "Verified Purchase". */
function eligible_order_for_review(db, customer_id, item_type, item_id) {
  if (!customer_id) return null;
  return db.execute(`SELECT o.id, o.order_no, o.delivered_date FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           WHERE o.customer_id=? AND o.status='Delivered' AND oi.item_type=? AND oi.item_id=?
           ORDER BY o.delivered_date DESC, o.id DESC LIMIT 1`, [customer_id, item_type, item_id]).fetchone();
}

function existing_review(db, customer_id, item_type, item_id) {
  if (!customer_id) return null;
  return db.execute('SELECT * FROM product_reviews WHERE customer_id=? AND item_type=? AND item_id=?', [customer_id, item_type, item_id]).fetchone();
}

function within_edit_window(review) {
  let hours = parseInt(get_setting('review_edit_window_hours', '24') || '24', 10);
  if (Number.isNaN(hours)) hours = 24;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(review.created_at || ''));
  if (!m) return false;
  const created = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return (Date.now() - created.getTime()) <= hours * 3600 * 1000;
}

/** Approved-only average + 5..1 breakdown. */
function rating_summary(db, item_type, item_id) {
  const rows = db.execute("SELECT rating, COUNT(*) c FROM product_reviews WHERE item_type=? AND item_id=? AND status='approved' GROUP BY rating",
    [item_type, item_id]).fetchall();
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0; let total_stars = 0;
  for (const r of rows) {
    breakdown[r.rating] = r.c;
    total += r.c;
    total_stars += r.rating * r.c;
  }
  const average = total ? py.round(total_stars / total, 1) : 0.0;
  return { average, count: total, breakdown, max_bucket: Math.max(...Object.values(breakdown)) || 1 };
}

/** kind: 'image' | 'video'. Returns [rel_path|null, error|null]. */
function save_review_file(fileStorage, kind) {
  if (!fileStorage || !fileStorage.filename) return [null, null];
  const ext = extOf(fileStorage.filename);
  const allowed = kind === 'image' ? ALLOWED_IMAGE_EXT : ALLOWED_VIDEO_EXT;
  const max_bytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (!allowed.has(ext)) return [null, `'${fileStorage.filename}' isn't a supported ${kind} format.`];
  const size = fileStorage.size;
  if (size === 0) return [null, null];
  if (size > max_bytes) return [null, `'${fileStorage.filename}' is too large (max ${Math.floor(max_bytes / (1024 * 1024))}MB).`];
  fs.mkdirSync(REVIEW_UPLOAD_DIR, { recursive: true });
  const filename = secure_filename(`review_${kind}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}.${ext}`);
  fileStorage.save(path.join(REVIEW_UPLOAD_DIR, filename));
  return [`uploads/reviews/${filename}`, null];
}

function _delete_media_file(rel) {
  if (!rel) return;
  const abs = path.resolve(BASE_DIR, 'static', rel);
  try {
    if (abs.startsWith(path.resolve(REVIEW_UPLOAD_DIR) + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) { /* ignore */ }
}

/* ==================== Admin: Review Moderation ==================== */

function _product_label(db, item_type, item_id) {
  const table = table_for(item_type);
  if (!table) return 'Unknown product';
  const row = db.execute(`SELECT * FROM ${table} WHERE id=?`, [item_id]).fetchone();
  if (!row) return 'Deleted product';
  if (item_type === 'frame') return `${row.brand} ${row.model || ''}`.trim();
  return `${row.brand} ${row.lens_type || ''}`.trim();
}

const PAGE_SIZE = 20;

bp.route('/', admin_required(function index() {
  const db = get_db();
  const status = request.args.get('status', '').trim();
  const rating = request.args.get('rating', '').trim();
  const q = request.args.get('q', '').trim();
  let where = 'WHERE 1=1';
  const params = [];
  if (STATUS_OPTIONS.includes(status)) { where += ' AND status=?'; params.push(status); }
  if (['1', '2', '3', '4', '5'].includes(rating)) { where += ' AND rating=?'; params.push(parseInt(rating, 10)); }
  if (q) { where += ' AND (title LIKE ? OR body LIKE ? OR display_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const [filtered_total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) FROM product_reviews ${where}`, params, request.args.get('page', 1), PAGE_SIZE);
  const rows = db.execute(`SELECT * FROM product_reviews ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset]).fetchall();
  const items = rows.map((r) => ({
    review: r,
    product_label: _product_label(db, r.item_type, r.item_id),
    customer: db.execute('SELECT name, phone FROM customers WHERE id=?', [r.customer_id]).fetchone(),
    images: db.execute("SELECT * FROM review_media WHERE review_id=? AND media_type='image' ORDER BY sort_order, id", [r.id]).fetchall(),
    videos: db.execute("SELECT * FROM review_media WHERE review_id=? AND media_type='video' ORDER BY sort_order, id", [r.id]).fetchall(),
  }));
  const page_url = (p) => url_for('reviews.index', { status, rating, q, page: p });
  const counts = {};
  for (const s of STATUS_OPTIONS) counts[s] = db.execute('SELECT COUNT(*) c FROM product_reviews WHERE status=?', [s]).fetchone().c;
  return render_template('website/reviews.html', {
    items, status, rating, q, counts,
    total: db.execute('SELECT COUNT(*) c FROM product_reviews').fetchone().c,
    page, total_pages, filtered_total, page_url,
  });
}));

function _set_status(review_id, status) {
  const db = get_db();
  db.execute('UPDATE product_reviews SET status=? WHERE id=?', [status, review_id]);
  db.commit();
}

bp.route('/<int:review_id>/approve', ['POST'], admin_required(function approve({ review_id }) {
  _set_status(review_id, 'approved');
  flash('Review approved and published on the storefront.', 'success');
  return redirect(url_for('reviews.index'));
}));

bp.route('/<int:review_id>/reject', ['POST'], admin_required(function reject({ review_id }) {
  _set_status(review_id, 'rejected');
  flash('Review rejected - it will not be shown on the storefront.', 'success');
  return redirect(url_for('reviews.index'));
}));

bp.route('/<int:review_id>/hide', ['POST'], admin_required(function hide({ review_id }) {
  const db = get_db();
  const row = db.execute('SELECT status FROM product_reviews WHERE id=?', [review_id]).fetchone();
  if (!row) {
    flash('Review not found.', 'error');
    return redirect(url_for('reviews.index'));
  }
  const new_status = row.status === 'hidden' ? 'approved' : 'hidden';
  db.execute('UPDATE product_reviews SET status=? WHERE id=?', [new_status, review_id]);
  db.commit();
  flash(new_status === 'approved' ? 'Review unhidden and republished.' : 'Review hidden from the storefront.', 'success');
  return redirect(url_for('reviews.index'));
}));

bp.route('/<int:review_id>/delete', ['POST'], admin_required(function delete_({ review_id }) {
  const db = get_db();
  const review = db.execute('SELECT * FROM product_reviews WHERE id=?', [review_id]).fetchone();
  if (!review) {
    flash('Review not found.', 'error');
    return redirect(url_for('reviews.index'));
  }
  const media = db.execute('SELECT * FROM review_media WHERE review_id=?', [review_id]).fetchall();
  db.execute('DELETE FROM product_reviews WHERE id=?', [review_id]); // cascades media + votes
  db.commit();
  for (const m of media) _delete_media_file(m.file_path);
  flash('Review permanently deleted.', 'success');
  return redirect(url_for('reviews.index'));
}), { endpoint: 'delete' });

bp.route('/<int:review_id>/feature', ['POST'], admin_required(function feature({ review_id }) {
  const db = get_db();
  const row = db.execute('SELECT is_featured, status FROM product_reviews WHERE id=?', [review_id]).fetchone();
  if (!row) {
    flash('Review not found.', 'error');
    return redirect(url_for('reviews.index'));
  }
  if (row.status !== 'approved' && !row.is_featured) {
    flash('Only approved reviews can be featured.', 'error');
    return redirect(url_for('reviews.index'));
  }
  const new_val = row.is_featured ? 0 : 1;
  db.execute('UPDATE product_reviews SET is_featured=? WHERE id=?', [new_val, review_id]);
  db.commit();
  flash(new_val ? 'Marked as a featured review.' : 'Removed from featured reviews.', 'success');
  return redirect(url_for('reviews.index'));
}));

bp.route('/<int:review_id>/reply', ['POST'], admin_required(function reply({ review_id }) {
  const db = get_db();
  if (!db.execute('SELECT id FROM product_reviews WHERE id=?', [review_id]).fetchone()) {
    flash('Review not found.', 'error');
    return redirect(url_for('reviews.index'));
  }
  const text = clean_text(request.form.get('admin_reply', ''), 2000);
  db.execute('UPDATE product_reviews SET admin_reply=?, admin_reply_at=? WHERE id=?', [text || null, text ? py.nowStr() : null, review_id]);
  db.commit();
  flash(text ? 'Reply saved.' : 'Reply removed.', 'success');
  return redirect(url_for('reviews.index'));
}));

/* ==================== Admin: Google Review Settings ==================== */

bp.route('/settings', ['GET', 'POST'], admin_required(function google_settings() {
  if (request.method === 'POST') {
    const f = request.form;
    const url = f.get('google_review_url', '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      flash('Google Review URL must start with http:// or https://', 'error');
      return redirect(url_for('reviews.google_settings'));
    }
    set_setting('google_review_url', url);
    for (const k of ['google_review_popup_enabled', 'review_auto_approve', 'review_allow_images', 'review_allow_videos', 'review_request_on_delivery']) {
      set_setting(k, f.get(k) ? '1' : '0');
    }
    const min_len = f.get('review_min_length', '10').trim();
    set_setting('review_min_length', /^\d+$/.test(min_len) ? min_len : '10');
    const edit_hrs = f.get('review_edit_window_hours', '24').trim();
    set_setting('review_edit_window_hours', /^\d+$/.test(edit_hrs) ? edit_hrs : '24');
    set_setting('google_rating_value', clean_text(f.get('google_rating_value', ''), 10));
    set_setting('google_rating_count_label', clean_text(f.get('google_rating_count_label', ''), 60));
    flash('Google Review settings saved.', 'success');
    return redirect(url_for('reviews.google_settings'));
  }
  return render_template('website/google_review_settings.html', { values: get_review_settings() });
}));

module.exports = {
  bp, REVIEW_UPLOAD_DIR, ALLOWED_IMAGE_EXT, ALLOWED_VIDEO_EXT, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES,
  MAX_REVIEW_IMAGES, MAX_REVIEW_VIDEOS, STATUS_OPTIONS, GOOGLE_REVIEW_SETTING_KEYS,
  rate_limited, clean_text, table_for, get_review_settings, eligible_order_for_review, existing_review,
  within_edit_window, rating_summary, save_review_file, _delete_media_file, _product_label,
};
