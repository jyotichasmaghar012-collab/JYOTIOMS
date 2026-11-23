'use strict';
/**
 * Admin CRUD for the homepage Promotions section (Website Management >
 * Promotions) - any number of promotional tiles (image + title + description
 * + button), each independently orderable and togglable.
 */
const { Blueprint, request, redirect, url_for, flash, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { saveImageUpload, deleteStatic, assignUniqueOrder, nextDisplayOrder } = require('../lib/uploads');
const { get_db } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('promotions', { url_prefix: '/website/promotions' });
const IMAGE_MAX_WIDTH = 1200;

const _save_image = (fs) => saveImageUpload(fs, { relDir: 'uploads/promotions', prefix: 'promo', maxWidth: IMAGE_MAX_WIDTH });

bp.route('/', admin_required(function index() {
  const promos = get_db().execute('SELECT * FROM promotions ORDER BY display_order, id').fetchall();
  return render_template('website/promotions.html', { promos });
}));

function fields(f) {
  return {
    title: f.get('title', '').trim(),
    description: f.get('description', '').trim(),
    button_text: f.get('button_text', '').trim(),
    button_url: f.get('button_url', '').trim(),
    is_active: f.get('is_active') ? 1 : 0,
  };
}

bp.route('/new', ['GET', 'POST'], admin_required(async function new_() {
  const db = get_db();
  const f = request.form;
  if (request.method === 'POST') {
    const { title, description, button_text, button_url, is_active } = fields(f);
    if (!title) {
      flash('Title is required.', 'error');
      return render_template('website/promotion_form.html', { promo: null, form: f });
    }
    const image_path = await _save_image(request.files.get('image'));
    if (!image_path) {
      flash('An image is required (JPG, PNG or WEBP).', 'error');
      return render_template('website/promotion_form.html', { promo: null, form: f });
    }
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = nextDisplayOrder(db, 'promotions'); }
    const order = assignUniqueOrder(db, 'promotions', requested);
    db.execute(`INSERT INTO promotions (title, description, image_path, button_text, button_url, display_order, is_active)
               VALUES (?,?,?,?,?,?,?)`, [title, description, image_path, button_text, button_url, order, is_active]);
    db.commit();
    flash('Promotion added.', 'success');
    return redirect(url_for('promotions.index'));
  }
  return render_template('website/promotion_form.html', { promo: null, form: null });
}), { endpoint: 'new' });

bp.route('/<int:promo_id>/edit', ['GET', 'POST'], admin_required(async function edit({ promo_id }) {
  const db = get_db();
  const f = request.form;
  const promo = db.execute('SELECT * FROM promotions WHERE id=?', [promo_id]).fetchone();
  if (!promo) {
    flash('Promotion not found.', 'error');
    return redirect(url_for('promotions.index'));
  }
  if (request.method === 'POST') {
    const { title, description, button_text, button_url, is_active } = fields(f);
    if (!title) {
      flash('Title is required.', 'error');
      return render_template('website/promotion_form.html', { promo, form: f });
    }
    let image_path = promo.image_path;
    const new_image = await _save_image(request.files.get('image'));
    if (new_image) {
      deleteStatic(image_path);
      image_path = new_image;
    }
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = promo.display_order; }
    let order = requested;
    if (requested !== promo.display_order) order = assignUniqueOrder(db, 'promotions', requested, promo_id);
    db.execute(`UPDATE promotions SET title=?, description=?, image_path=?, button_text=?, button_url=?,
               display_order=?, is_active=? WHERE id=?`,
    [title, description, image_path, button_text, button_url, order, is_active, promo_id]);
    db.commit();
    flash('Promotion updated.', 'success');
    return redirect(url_for('promotions.index'));
  }
  return render_template('website/promotion_form.html', { promo, form: null });
}));

bp.route('/<int:promo_id>/delete', ['POST'], admin_required(function delete_({ promo_id }) {
  const db = get_db();
  const promo = db.execute('SELECT * FROM promotions WHERE id=?', [promo_id]).fetchone();
  if (promo) {
    deleteStatic(promo.image_path);
    db.execute('DELETE FROM promotions WHERE id=?', [promo_id]);
    db.commit();
    flash('Promotion deleted.', 'success');
  }
  return redirect(url_for('promotions.index'));
}), { endpoint: 'delete' });

bp.route('/<int:promo_id>/toggle', ['POST'], admin_required(function toggle({ promo_id }) {
  const db = get_db();
  const promo = db.execute('SELECT * FROM promotions WHERE id=?', [promo_id]).fetchone();
  if (promo) {
    const new_state = promo.is_active ? 0 : 1;
    db.execute('UPDATE promotions SET is_active=? WHERE id=?', [new_state, promo_id]);
    db.commit();
    flash(new_state ? 'Promotion activated.' : 'Promotion deactivated.', 'success');
  }
  return redirect(url_for('promotions.index'));
}));

module.exports = { bp };
