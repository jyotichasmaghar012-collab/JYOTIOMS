'use strict';
/**
 * Product Variants: Parent Product + Color Variant system.
 *
 * A `product_groups` row is the "parent" - shared display fields only. Price/
 * stock/color stay on each `frames` row. Linking a frame into a group is a
 * deliberate one-at-a-time admin action; an ungrouped frame behaves as a
 * standalone product exactly as before.
 */
const { Blueprint, request, redirect, url_for, flash, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { get_db } = require('../db');
const { login_required, admin_required } = require('../auth');

const bp = new Blueprint('product_groups', { url_prefix: '/inventory/product-groups' });
const PAGE_SIZE = 20;

/** Whether this request is rendered inside the "Product Groups" popup iframe
 *  (?embed=1 or a hidden embed form field) - threaded through every redirect
 *  so the flow stays inside the popup. */
function _embed() {
  return request.values.get('embed') || null;
}

function _taxonomy_options(db) {
  return {
    brands: db.execute('SELECT * FROM brands WHERE is_active=1 ORDER BY name COLLATE NOCASE').fetchall(),
    categories: db.execute('SELECT * FROM categories WHERE is_active=1 ORDER BY name COLLATE NOCASE').fetchall(),
    genders: db.execute('SELECT * FROM genders WHERE is_active=1 ORDER BY name COLLATE NOCASE').fetchall(),
    sizes: db.execute('SELECT * FROM sizes WHERE is_active=1 ORDER BY name COLLATE NOCASE').fetchall(),
  };
}

function _group_or_404(db, group_id) {
  return db.execute(`SELECT pg.*, b.name AS brand_name, c.name AS category_name,
                  g.name AS gender_name, s.name AS size_name
           FROM product_groups pg
           LEFT JOIN brands b ON b.id = pg.brand_id
           LEFT JOIN categories c ON c.id = pg.category_id
           LEFT JOIN genders g ON g.id = pg.gender_id
           LEFT JOIN sizes s ON s.id = pg.size_id
           WHERE pg.id = ?`, [group_id]).fetchone();
}

bp.route('/', login_required(function index() {
  const db = get_db();
  const embed = _embed();
  const q = request.args.get('q', '').trim();
  let page;
  try { page = Math.max(1, pyInt(request.args.get('page', 1))); } catch (_) { page = 1; }
  let where = ''; const params = [];
  if (q) { where = 'WHERE pg.name LIKE ?'; params.push(`%${q}%`); }
  const total = db.execute(`SELECT COUNT(*) c FROM product_groups pg ${where}`, params).fetchone().c;
  const total_pages = Math.max(1, Math.floor((total + PAGE_SIZE - 1) / PAGE_SIZE));
  page = Math.min(page, total_pages);
  const offset = (page - 1) * PAGE_SIZE;
  const groups = db.execute(`SELECT pg.*, b.name AS brand_name,
               (SELECT COUNT(*) FROM frames f WHERE f.product_group_id = pg.id) AS variant_count
           FROM product_groups pg
           LEFT JOIN brands b ON b.id = pg.brand_id
           ${where}
           ORDER BY pg.name COLLATE NOCASE
           LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset]).fetchall();
  return render_template('inventory/product_groups.html', { groups, q, page, total_pages, total, embed });
}));

bp.route('/new', ['GET', 'POST'], login_required(function new_() {
  const db = get_db();
  const embed = _embed();
  const f = request.form;
  if (request.method === 'POST') {
    const name = f.get('name', '').trim();
    if (!name) {
      flash('Product name is required.', 'error');
      return render_template('inventory/product_group_form.html', { group: null, form: f, taxonomy_options: _taxonomy_options(db), embed });
    }
    const cur = db.execute(`INSERT INTO product_groups (name, brand_id, category_id, gender_id, size_id, description)
               VALUES (?,?,?,?,?,?)`, [
      name, f.get('brand_id') || null, f.get('category_id') || null, f.get('gender_id') || null,
      f.get('size_id') || null, f.get('description', '').trim() || null,
    ]);
    db.commit();
    flash(`'${name}' created. Now attach its color variants below.`, 'success');
    return redirect(url_for('product_groups.manage', { group_id: cur.lastrowid, embed }));
  }
  return render_template('inventory/product_group_form.html', { group: null, form: null, taxonomy_options: _taxonomy_options(db), embed });
}), { endpoint: 'new' });

bp.route('/<int:group_id>/edit', ['GET', 'POST'], login_required(function edit({ group_id }) {
  const db = get_db();
  const embed = _embed();
  const f = request.form;
  const group = _group_or_404(db, group_id);
  if (!group) {
    flash('Product group not found.', 'error');
    return redirect(url_for('product_groups.index', { embed }));
  }
  if (request.method === 'POST') {
    const name = f.get('name', '').trim();
    if (!name) {
      flash('Product name is required.', 'error');
      return render_template('inventory/product_group_form.html', { group, form: f, taxonomy_options: _taxonomy_options(db), embed });
    }
    db.execute(`UPDATE product_groups SET name=?, brand_id=?, category_id=?, gender_id=?, size_id=?, description=?
               WHERE id=?`, [
      name, f.get('brand_id') || null, f.get('category_id') || null, f.get('gender_id') || null,
      f.get('size_id') || null, f.get('description', '').trim() || null, group_id,
    ]);
    db.commit();
    flash('Product group updated.', 'success');
    return redirect(url_for('product_groups.manage', { group_id, embed }));
  }
  return render_template('inventory/product_group_form.html', { group, form: null, taxonomy_options: _taxonomy_options(db), embed });
}));

bp.route('/<int:group_id>', login_required(function manage({ group_id }) {
  const db = get_db();
  const embed = _embed();
  const group = _group_or_404(db, group_id);
  if (!group) {
    flash('Product group not found.', 'error');
    return redirect(url_for('product_groups.index', { embed }));
  }
  const variants = db.execute(`SELECT * FROM frames WHERE product_group_id = ?
           ORDER BY grouped_at ASC, id ASC`, [group_id]).fetchall();
  const q = request.args.get('q', '').trim();
  let candidates = [];
  if (q) {
    const like = `%${q}%`;
    candidates = db.execute(`SELECT * FROM frames
               WHERE product_group_id IS NULL
                 AND (brand LIKE ? OR model LIKE ? OR color LIKE ? OR model_name LIKE ?)
               ORDER BY brand, model LIMIT 25`, [like, like, like, like]).fetchall();
  }
  return render_template('inventory/product_group_manage.html', { group, variants, q, candidates, embed });
}));

bp.route('/<int:group_id>/attach', ['POST'], login_required(function attach({ group_id }) {
  const db = get_db();
  const embed = _embed();
  const group = _group_or_404(db, group_id);
  if (!group) {
    flash('Product group not found.', 'error');
    return redirect(url_for('product_groups.index', { embed }));
  }
  let frame_id;
  try { frame_id = pyInt(request.form.get('frame_id', '')); } catch (_) {
    flash('Choose a frame to attach.', 'error');
    return redirect(url_for('product_groups.manage', { group_id, q: request.form.get('q', ''), embed }));
  }
  const frame = db.execute('SELECT * FROM frames WHERE id=?', [frame_id]).fetchone();
  if (!frame) {
    flash('That frame no longer exists.', 'error');
    return redirect(url_for('product_groups.manage', { group_id, embed }));
  }
  if (frame.product_group_id !== null && frame.product_group_id !== undefined) {
    flash('That frame already belongs to a product group - detach it from there first.', 'error');
    return redirect(url_for('product_groups.manage', { group_id, embed }));
  }
  db.execute("UPDATE frames SET product_group_id=?, grouped_at=datetime('now') WHERE id=?", [group_id, frame_id]);
  db.commit();
  flash(`${frame.brand} ${frame.model || ''} (${frame.color || 'no color set'}) added as a variant.`, 'success');
  return redirect(url_for('product_groups.manage', { group_id, embed }));
}));

bp.route('/<int:group_id>/detach/<int:frame_id>', ['POST'], login_required(function detach({ group_id, frame_id }) {
  const db = get_db();
  const embed = _embed();
  const frame = db.execute('SELECT * FROM frames WHERE id=? AND product_group_id=?', [frame_id, group_id]).fetchone();
  if (!frame) {
    flash("That variant isn't part of this group.", 'error');
    return redirect(url_for('product_groups.manage', { group_id, embed }));
  }
  db.execute('UPDATE frames SET product_group_id=NULL, grouped_at=NULL WHERE id=?', [frame_id]);
  db.commit();
  flash(`${frame.brand} ${frame.model || ''} is now a standalone product again.`, 'success');
  return redirect(url_for('product_groups.manage', { group_id, embed }));
}));

bp.route('/<int:group_id>/toggle', ['POST'], login_required(function toggle({ group_id }) {
  const db = get_db();
  const embed = _embed();
  const group = db.execute('SELECT is_active FROM product_groups WHERE id=?', [group_id]).fetchone();
  if (!group) {
    flash('Product group not found.', 'error');
    return redirect(url_for('product_groups.index', { embed }));
  }
  const new_state = group.is_active ? 0 : 1;
  db.execute('UPDATE product_groups SET is_active=? WHERE id=?', [new_state, group_id]);
  db.commit();
  flash(new_state
    ? 'Grouping re-enabled - variants will show as one product again.'
    : 'Grouping paused - each variant now shows separately on the storefront until re-enabled.', 'success');
  return redirect(url_for('product_groups.manage', { group_id, embed }));
}));

bp.route('/<int:group_id>/delete', ['POST'], admin_required(function delete_({ group_id }) {
  const db = get_db();
  const embed = _embed();
  const group = db.execute('SELECT * FROM product_groups WHERE id=?', [group_id]).fetchone();
  if (!group) {
    flash('Product group not found.', 'error');
    return redirect(url_for('product_groups.index', { embed }));
  }
  const variant_count = db.execute('SELECT COUNT(*) c FROM frames WHERE product_group_id=?', [group_id]).fetchone().c;
  if (variant_count) {
    flash(`Can't delete '${group.name}' - it still has ${variant_count} variant(s) attached. Detach them first, then delete.`, 'error');
    return redirect(url_for('product_groups.manage', { group_id, embed }));
  }
  db.execute('DELETE FROM product_groups WHERE id=?', [group_id]);
  db.commit();
  flash(`'${group.name}' deleted.`, 'success');
  return redirect(url_for('product_groups.index', { embed }));
}), { endpoint: 'delete' });

module.exports = { bp };
