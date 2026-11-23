'use strict';
/**
 * Admin CRUD for Brands (Website Management > Brands) - logo, description and
 * display order for the storefront "Shop by Brand" section. Operates on the
 * SAME `brands` table as the generic taxonomy admin (Attributes > Brands).
 */
const { Blueprint, request, redirect, url_for, flash, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { isIntegrityError } = require('../lib/db');
const { saveImageUpload, deleteStatic, assignUniqueOrder, nextDisplayOrder } = require('../lib/uploads');
const { get_db } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('brands', { url_prefix: '/website/brands' });
const LOGO_MAX_WIDTH = 600;

const _save_logo = (fs) => saveImageUpload(fs, { relDir: 'uploads/brands', prefix: 'brand', maxWidth: LOGO_MAX_WIDTH });

bp.route('/', admin_required(function index() {
  const db = get_db();
  const q = request.args.get('q', '').trim();
  const brands = q
    ? db.execute('SELECT * FROM brands WHERE name LIKE ? ORDER BY display_order, name COLLATE NOCASE', [`%${q}%`]).fetchall()
    : db.execute('SELECT * FROM brands ORDER BY display_order, name COLLATE NOCASE').fetchall();
  return render_template('website/brands.html', { brands, q });
}));

bp.route('/new', ['GET', 'POST'], admin_required(async function new_() {
  const db = get_db();
  const f = request.form;
  if (request.method === 'POST') {
    const name = f.get('name', '').trim();
    const description = f.get('description', '').trim();
    const is_active = f.get('is_active') ? 1 : 0;
    if (!name) {
      flash('Brand Name is required.', 'error');
      return render_template('website/brand_form.html', { brand: null, form: f });
    }
    const logo_path = await _save_logo(request.files.get('logo'));
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = nextDisplayOrder(db, 'brands'); }
    const order = assignUniqueOrder(db, 'brands', requested);
    try {
      db.execute(`INSERT INTO brands (name, logo_path, description, display_order, is_active)
                   VALUES (?,?,?,?,?)`, [name, logo_path, description, order, is_active]);
      db.commit();
    } catch (e) {
      if (!isIntegrityError(e)) throw e;
      deleteStatic(logo_path);
      flash(`A brand named "${name}" already exists.`, 'error');
      return render_template('website/brand_form.html', { brand: null, form: f });
    }
    flash('Brand added.', 'success');
    return redirect(url_for('brands.index'));
  }
  return render_template('website/brand_form.html', { brand: null, form: null });
}), { endpoint: 'new' });

bp.route('/<int:brand_id>/edit', ['GET', 'POST'], admin_required(async function edit({ brand_id }) {
  const db = get_db();
  const f = request.form;
  const brand = db.execute('SELECT * FROM brands WHERE id=?', [brand_id]).fetchone();
  if (!brand) {
    flash('Brand not found.', 'error');
    return redirect(url_for('brands.index'));
  }
  if (request.method === 'POST') {
    const name = f.get('name', '').trim();
    const description = f.get('description', '').trim();
    const is_active = f.get('is_active') ? 1 : 0;
    if (!name) {
      flash('Brand Name is required.', 'error');
      return render_template('website/brand_form.html', { brand, form: f });
    }
    let logo_path = brand.logo_path;
    const new_logo = await _save_logo(request.files.get('logo'));
    if (new_logo) {
      deleteStatic(logo_path);
      logo_path = new_logo;
    } else if (f.get('remove_logo')) {
      deleteStatic(logo_path);
      logo_path = null;
    }
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = brand.display_order; }
    let order = requested;
    if (requested !== brand.display_order) order = assignUniqueOrder(db, 'brands', requested, brand_id);
    try {
      db.execute(`UPDATE brands SET name=?, logo_path=?, description=?, display_order=?, is_active=?
                   WHERE id=?`, [name, logo_path, description, order, is_active, brand_id]);
      db.commit();
    } catch (e) {
      if (!isIntegrityError(e)) throw e;
      flash(`A brand named "${name}" already exists.`, 'error');
      return render_template('website/brand_form.html', { brand, form: f });
    }
    flash('Brand updated.', 'success');
    return redirect(url_for('brands.index'));
  }
  return render_template('website/brand_form.html', { brand, form: null });
}));

bp.route('/<int:brand_id>/delete', ['POST'], admin_required(function delete_({ brand_id }) {
  const db = get_db();
  const brand = db.execute('SELECT * FROM brands WHERE id=?', [brand_id]).fetchone();
  if (brand) {
    const in_use = db.execute('SELECT COUNT(*) AS c FROM frames WHERE brand_id=?', [brand_id]).fetchone().c;
    if (in_use) {
      flash(`Cannot delete "${brand.name}" - it is used by ${in_use} frame(s). Deactivate it instead.`, 'error');
      return redirect(url_for('brands.index'));
    }
    deleteStatic(brand.logo_path);
    db.execute('DELETE FROM brands WHERE id=?', [brand_id]);
    db.commit();
    flash('Brand deleted.', 'success');
  }
  return redirect(url_for('brands.index'));
}), { endpoint: 'delete' });

bp.route('/<int:brand_id>/toggle', ['POST'], admin_required(function toggle({ brand_id }) {
  const db = get_db();
  const brand = db.execute('SELECT * FROM brands WHERE id=?', [brand_id]).fetchone();
  if (brand) {
    const new_state = brand.is_active ? 0 : 1;
    db.execute('UPDATE brands SET is_active=? WHERE id=?', [new_state, brand_id]);
    db.commit();
    flash(new_state ? 'Brand activated.' : 'Brand deactivated.', 'success');
  }
  return redirect(url_for('brands.index'));
}));

module.exports = { bp };
