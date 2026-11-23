'use strict';
/**
 * Admin CRUD for the homepage Category Showcase (Website Management >
 * Categories) - image, description, display order and SEO fields. Operates
 * on the SAME `categories` table as Attributes > Categories.
 */
const { Blueprint, request, redirect, url_for, flash, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { isIntegrityError } = require('../lib/db');
const { saveImageUpload, deleteStatic, assignUniqueOrder, nextDisplayOrder } = require('../lib/uploads');
const { get_db } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('category_showcase', { url_prefix: '/website/categories' });
const IMAGE_MAX_WIDTH = 900;

const _save_image = (fs) => saveImageUpload(fs, { relDir: 'uploads/categories', prefix: 'category', maxWidth: IMAGE_MAX_WIDTH });

bp.route('/', admin_required(function index() {
  const db = get_db();
  const q = request.args.get('q', '').trim();
  const categories = q
    ? db.execute('SELECT * FROM categories WHERE name LIKE ? ORDER BY display_order, name COLLATE NOCASE', [`%${q}%`]).fetchall()
    : db.execute('SELECT * FROM categories ORDER BY display_order, name COLLATE NOCASE').fetchall();
  return render_template('website/categories.html', { categories, q });
}));

function seoFields(f) {
  return {
    meta_title: f.get('meta_title', '').trim() || null,
    meta_description: f.get('meta_description', '').trim() || null,
    slug: f.get('slug', '').trim() || null,
  };
}

bp.route('/new', ['GET', 'POST'], admin_required(async function new_() {
  const db = get_db();
  const f = request.form;
  if (request.method === 'POST') {
    const name = f.get('name', '').trim();
    const description = f.get('description', '').trim();
    const is_active = f.get('is_active') ? 1 : 0;
    const { meta_title, meta_description, slug } = seoFields(f);
    if (!name) {
      flash('Category Name is required.', 'error');
      return render_template('website/category_form.html', { category: null, form: f });
    }
    const image_path = await _save_image(request.files.get('image'));
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = nextDisplayOrder(db, 'categories'); }
    const order = assignUniqueOrder(db, 'categories', requested);
    try {
      db.execute(`INSERT INTO categories (name, image_path, description, display_order, is_active,
                   meta_title, meta_description, slug)
                   VALUES (?,?,?,?,?,?,?,?)`, [name, image_path, description, order, is_active, meta_title, meta_description, slug]);
      db.commit();
    } catch (e) {
      if (!isIntegrityError(e)) throw e;
      deleteStatic(image_path);
      flash(`A category named "${name}" already exists.`, 'error');
      return render_template('website/category_form.html', { category: null, form: f });
    }
    flash('Category added.', 'success');
    return redirect(url_for('category_showcase.index'));
  }
  return render_template('website/category_form.html', { category: null, form: null });
}), { endpoint: 'new' });

bp.route('/<int:category_id>/edit', ['GET', 'POST'], admin_required(async function edit({ category_id }) {
  const db = get_db();
  const f = request.form;
  const category = db.execute('SELECT * FROM categories WHERE id=?', [category_id]).fetchone();
  if (!category) {
    flash('Category not found.', 'error');
    return redirect(url_for('category_showcase.index'));
  }
  if (request.method === 'POST') {
    const name = f.get('name', '').trim();
    const description = f.get('description', '').trim();
    const is_active = f.get('is_active') ? 1 : 0;
    const { meta_title, meta_description, slug } = seoFields(f);
    if (!name) {
      flash('Category Name is required.', 'error');
      return render_template('website/category_form.html', { category, form: f });
    }
    let image_path = category.image_path;
    const new_image = await _save_image(request.files.get('image'));
    if (new_image) {
      deleteStatic(image_path);
      image_path = new_image;
    } else if (f.get('remove_image')) {
      deleteStatic(image_path);
      image_path = null;
    }
    let requested;
    try { requested = pyInt(f.get('display_order', '').trim()); } catch (_) { requested = category.display_order; }
    let order = requested;
    if (requested !== category.display_order) order = assignUniqueOrder(db, 'categories', requested, category_id);
    try {
      db.execute(`UPDATE categories SET name=?, image_path=?, description=?, display_order=?, is_active=?,
                   meta_title=?, meta_description=?, slug=?
                   WHERE id=?`, [name, image_path, description, order, is_active, meta_title, meta_description, slug, category_id]);
      db.commit();
    } catch (e) {
      if (!isIntegrityError(e)) throw e;
      flash(`A category named "${name}" already exists.`, 'error');
      return render_template('website/category_form.html', { category, form: f });
    }
    flash('Category updated.', 'success');
    return redirect(url_for('category_showcase.index'));
  }
  return render_template('website/category_form.html', { category, form: null });
}));

bp.route('/<int:category_id>/delete', ['POST'], admin_required(function delete_({ category_id }) {
  const db = get_db();
  const category = db.execute('SELECT * FROM categories WHERE id=?', [category_id]).fetchone();
  if (category) {
    const in_use = db.execute('SELECT COUNT(*) AS c FROM frames WHERE category_id=?', [category_id]).fetchone().c;
    if (in_use) {
      flash(`Cannot delete "${category.name}" - it is used by ${in_use} frame(s). Deactivate it instead.`, 'error');
      return redirect(url_for('category_showcase.index'));
    }
    deleteStatic(category.image_path);
    db.execute('DELETE FROM categories WHERE id=?', [category_id]);
    db.commit();
    flash('Category deleted.', 'success');
  }
  return redirect(url_for('category_showcase.index'));
}), { endpoint: 'delete' });

bp.route('/<int:category_id>/toggle', ['POST'], admin_required(function toggle({ category_id }) {
  const db = get_db();
  const category = db.execute('SELECT * FROM categories WHERE id=?', [category_id]).fetchone();
  if (category) {
    const new_state = category.is_active ? 0 : 1;
    db.execute('UPDATE categories SET is_active=? WHERE id=?', [new_state, category_id]);
    db.commit();
    flash(new_state ? 'Category activated.' : 'Category deactivated.', 'success');
  }
  return redirect(url_for('category_showcase.index'));
}));

module.exports = { bp };
