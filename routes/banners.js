'use strict';
/**
 * Admin CRUD for the homepage banner slider (Website Management > Homepage
 * Banners). Each row drives one Swiper slide on the storefront home page.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Blueprint, request, redirect, url_for, flash, jsonify, pyInt, secure_filename } = require('../lib/core');
const { render_template } = require('../lib/render');
const { sharp, resizeIfWider } = require('../lib/images');
const { STATIC_DIR, saveImageUpload, deleteStatic, assignUniqueOrder, nextDisplayOrder } = require('../lib/uploads');
const { todayIso } = require('../lib/py');
const { get_db } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('banners', { url_prefix: '/website/banners' });

const BANNER_UPLOAD_DIR = path.join(STATIC_DIR, 'uploads', 'banners');
const BANNER_MAX_DESKTOP_WIDTH = 1920;
const MOBILE_CROP_RATIO = 3 / 2;
const MOBILE_CROP_WIDTH = 900;

const _save_banner_image = (fs_, tag) => saveImageUpload(fs_, { relDir: 'uploads/banners', prefix: `banner_${tag}` });

async function _resize_desktop_if_huge(rel) {
  if (!rel) return;
  await resizeIfWider(path.join(STATIC_DIR, rel), BANNER_MAX_DESKTOP_WIDTH, 88);
}

/** Auto-generate a center-cropped 3:2 mobile variant (max 900px wide, JPEG)
 *  from the desktop upload. Returns its static-relative path or null. */
async function _generate_mobile_variant(desktopRel) {
  if (!sharp || !desktopRel) return null;
  try {
    const input = fs.readFileSync(path.join(STATIC_DIR, desktopRel));
    const meta = await sharp(input).rotate().metadata();
    let w = meta.width; let h = meta.height;
    if (meta.orientation && meta.orientation >= 5) [w, h] = [h, w];
    let region;
    if (w / h > MOBILE_CROP_RATIO) {
      const newW = Math.round(h * MOBILE_CROP_RATIO);
      region = { left: Math.floor((w - newW) / 2), top: 0, width: newW, height: h };
    } else {
      const newH = Math.round(w / MOBILE_CROP_RATIO);
      region = { left: 0, top: Math.floor((h - newH) / 2), width: w, height: newH };
    }
    let p = sharp(input).rotate().extract(region);
    if (region.width > MOBILE_CROP_WIDTH) p = p.resize({ width: MOBILE_CROP_WIDTH, kernel: 'lanczos3' });
    const out = await p.flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    fs.mkdirSync(BANNER_UPLOAD_DIR, { recursive: true });
    const filename = secure_filename(`banner_mobile_auto_${Date.now()}.jpg`);
    fs.writeFileSync(path.join(BANNER_UPLOAD_DIR, filename), out);
    return `uploads/banners/${filename}`;
  } catch (_) {
    return null;
  }
}

function _validate_dates(start, end) {
  if (start && end && start > end) return 'Start Date must be on or before End Date.';
  return null;
}

function fields(f) {
  return {
    title: f.get('title', '').trim(),
    heading: f.get('heading', '').trim(),
    subheading: f.get('subheading', '').trim(),
    button_text: f.get('button_text', '').trim(),
    button_url: f.get('button_url', '').trim(),
    overlay_enabled: f.get('overlay_enabled') ? 1 : 0,
    is_active: f.get('is_active') ? 1 : 0,
    start_date: f.get('start_date', '').trim() || null,
    end_date: f.get('end_date', '').trim() || null,
  };
}

bp.route('/', admin_required(function index() {
  const banners = get_db().execute('SELECT * FROM homepage_banners ORDER BY display_order, id').fetchall();
  return render_template('website/banners.html', { banners, today: todayIso() });
}));

bp.route('/new', ['GET', 'POST'], admin_required(async function new_() {
  const db = get_db();
  const f = request.form;
  if (request.method === 'POST') {
    const v = fields(f);
    if (!v.title) {
      flash('Banner Title is required.', 'error');
      return render_template('website/banner_form.html', { banner: null, form: f });
    }
    const desktop_path = await _save_banner_image(request.files.get('desktop_image'), 'desktop');
    if (!desktop_path) {
      flash('Desktop Banner Image is required (JPG, PNG or WEBP).', 'error');
      return render_template('website/banner_form.html', { banner: null, form: f });
    }
    await _resize_desktop_if_huge(desktop_path);
    let mobile_path = await _save_banner_image(request.files.get('mobile_image'), 'mobile');
    if (!mobile_path) mobile_path = await _generate_mobile_variant(desktop_path);

    const date_error = _validate_dates(v.start_date, v.end_date);
    if (date_error) {
      deleteStatic(desktop_path);
      deleteStatic(mobile_path);
      flash(date_error, 'error');
      return render_template('website/banner_form.html', { banner: null, form: f });
    }
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = nextDisplayOrder(db, 'homepage_banners'); }
    const order = assignUniqueOrder(db, 'homepage_banners', requested);
    db.execute(`INSERT INTO homepage_banners
               (title, desktop_image_path, mobile_image_path, heading, subheading, button_text, button_url,
                overlay_enabled, display_order, is_active, start_date, end_date)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      v.title, desktop_path, mobile_path, v.heading, v.subheading, v.button_text, v.button_url,
      v.overlay_enabled, order, v.is_active, v.start_date, v.end_date,
    ]);
    db.commit();
    flash('Banner added.', 'success');
    return redirect(url_for('banners.index'));
  }
  return render_template('website/banner_form.html', { banner: null, form: null });
}), { endpoint: 'new' });

bp.route('/<int:banner_id>/edit', ['GET', 'POST'], admin_required(async function edit({ banner_id }) {
  const db = get_db();
  const f = request.form;
  const banner = db.execute('SELECT * FROM homepage_banners WHERE id=?', [banner_id]).fetchone();
  if (!banner) {
    flash('Banner not found.', 'error');
    return redirect(url_for('banners.index'));
  }
  if (request.method === 'POST') {
    const v = fields(f);
    if (!v.title) {
      flash('Banner Title is required.', 'error');
      return render_template('website/banner_form.html', { banner, form: f });
    }
    const date_error = _validate_dates(v.start_date, v.end_date);
    if (date_error) {
      flash(date_error, 'error');
      return render_template('website/banner_form.html', { banner, form: f });
    }
    let desktop_path = banner.desktop_image_path;
    const new_desktop = await _save_banner_image(request.files.get('desktop_image'), 'desktop');
    if (new_desktop) {
      deleteStatic(desktop_path);
      desktop_path = new_desktop;
      await _resize_desktop_if_huge(desktop_path);
    }
    let mobile_path = banner.mobile_image_path;
    const new_mobile = await _save_banner_image(request.files.get('mobile_image'), 'mobile');
    if (new_mobile) {
      deleteStatic(mobile_path);
      mobile_path = new_mobile;
    } else if (f.get('remove_mobile_image')) {
      deleteStatic(mobile_path);
      mobile_path = null;
    } else if (new_desktop && !mobile_path) {
      mobile_path = await _generate_mobile_variant(desktop_path);
    }
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = banner.display_order; }
    let order = requested;
    if (requested !== banner.display_order) order = assignUniqueOrder(db, 'homepage_banners', requested, banner_id);
    db.execute(`UPDATE homepage_banners SET title=?, desktop_image_path=?, mobile_image_path=?, heading=?,
               subheading=?, button_text=?, button_url=?, overlay_enabled=?, display_order=?, is_active=?,
               start_date=?, end_date=? WHERE id=?`, [
      v.title, desktop_path, mobile_path, v.heading, v.subheading, v.button_text, v.button_url,
      v.overlay_enabled, order, v.is_active, v.start_date, v.end_date, banner_id,
    ]);
    db.commit();
    flash('Banner updated.', 'success');
    return redirect(url_for('banners.index'));
  }
  return render_template('website/banner_form.html', { banner, form: null });
}));

bp.route('/<int:banner_id>/delete', ['POST'], admin_required(function delete_({ banner_id }) {
  const db = get_db();
  const banner = db.execute('SELECT * FROM homepage_banners WHERE id=?', [banner_id]).fetchone();
  if (banner) {
    deleteStatic(banner.desktop_image_path);
    deleteStatic(banner.mobile_image_path);
    db.execute('DELETE FROM homepage_banners WHERE id=?', [banner_id]);
    db.commit();
    flash('Banner deleted.', 'success');
  }
  return redirect(url_for('banners.index'));
}), { endpoint: 'delete' });

bp.route('/<int:banner_id>/toggle', ['POST'], admin_required(function toggle({ banner_id }) {
  const db = get_db();
  const banner = db.execute('SELECT * FROM homepage_banners WHERE id=?', [banner_id]).fetchone();
  if (banner) {
    const new_state = banner.is_active ? 0 : 1;
    db.execute('UPDATE homepage_banners SET is_active=? WHERE id=?', [new_state, banner_id]);
    db.commit();
    flash(new_state ? 'Banner activated.' : 'Banner deactivated.', 'success');
  }
  return redirect(url_for('banners.index'));
}));

/** AJAX drag-and-drop reorder. Body: {"order": [id, id, ...]}. */
bp.route('/reorder', ['POST'], admin_required(function reorder() {
  const db = get_db();
  const payload = request.get_json({ silent: true }) || {};
  const ids = Array.isArray(payload.order) ? payload.order : [];
  ids.forEach((banner_id, idx) => {
    db.execute('UPDATE homepage_banners SET display_order=? WHERE id=?', [idx, banner_id]);
  });
  db.commit();
  return jsonify({ ok: true });
}));

module.exports = { bp };
