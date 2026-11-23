'use strict';
/**
 * Admin CRUD for the frame attribute master lists (Brands, Colours, Sizes,
 * Materials, Frame Shapes, Frame Types, Categories, Genders) that back the
 * dropdowns on the Frame add/edit form. One data-driven blueprint, with the
 * taxonomy as a URL segment, shown as tabs on one "Attributes" page.
 */
const { Blueprint, request, redirect, url_for, flash, jsonify, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { isIntegrityError } = require('../lib/db');
const { get_db, taxonomy_table_for } = require('../db');
const { login_required, admin_required } = require('../auth');

const bp = new Blueprint('taxonomy', { url_prefix: '/inventory/attributes' });

const TAXONOMY_META = [
  ['brands', 'Brand', 'Brands'],
  ['colours', 'Colour', 'Colours'],
  ['sizes', 'Size', 'Sizes'],
  ['materials', 'Material', 'Materials'],
  ['frame_shapes', 'Frame Shape', 'Frame Shapes'],
  ['frame_types', 'Frame Type', 'Frame Types'],
  ['categories', 'Category', 'Categories'],
  ['genders', 'Gender', 'Genders'],
];
const TAXONOMY_LABELS = Object.fromEntries(TAXONOMY_META.map(([k, l, p]) => [k, [l, p]]));
const PAGE_SIZE = 20;

/** Validated table name or null - never interpolate the raw URL segment. */
function _resolve_kind(kind) {
  return Object.prototype.hasOwnProperty.call(TAXONOMY_LABELS, kind) ? taxonomy_table_for(kind) : null;
}

bp.route('/', login_required(function index() {
  const kind = request.args.get('type', 'brands');
  const table = _resolve_kind(kind);
  if (!table) {
    flash('Unknown attribute list.', 'error');
    return redirect(url_for('taxonomy.index'));
  }
  const q = request.args.get('q', '').trim();
  let page;
  try { page = Math.max(1, pyInt(request.args.get('page', 1))); } catch (_) { page = 1; }

  const db = get_db();
  let where = ''; const params = [];
  if (q) { where = 'WHERE name LIKE ?'; params.push(`%${q}%`); }

  const total = db.execute(`SELECT COUNT(*) c FROM ${table} ${where}`, params).fetchone().c;
  const total_pages = Math.max(1, Math.floor((total + PAGE_SIZE - 1) / PAGE_SIZE));
  page = Math.min(page, total_pages);
  const offset = (page - 1) * PAGE_SIZE;

  const rows = db.execute(`SELECT * FROM ${table} ${where} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset]).fetchall();

  const fk_column = {
    brands: 'brand_id', colours: 'colour_id', sizes: 'size_id', materials: 'material_id',
    frame_shapes: 'frame_shape_id', frame_types: 'frame_type_id', categories: 'category_id', genders: 'gender_id',
  }[table];
  const usage_counts = {};
  for (const row of db.execute(`SELECT ${fk_column} AS fk, COUNT(*) c FROM frames WHERE ${fk_column} IS NOT NULL GROUP BY ${fk_column}`).fetchall()) {
    usage_counts[row.fk] = row.c;
  }

  return render_template('inventory/attributes.html', {
    tabs: TAXONOMY_META,
    active_kind: kind,
    active_label: TAXONOMY_LABELS[kind][0],
    active_label_plural: TAXONOMY_LABELS[kind][1],
    rows, q, page, total_pages, total, usage_counts,
  });
}));

/** True for the fetch()-based "quick add" widget on the Frame form. */
function _wants_json() {
  return request.headers.get('X-Requested-With') === 'XMLHttpRequest';
}

bp.route('/<kind>/new', ['POST'], login_required(function new_({ kind }) {
  const table = _resolve_kind(kind);
  if (!table) {
    if (_wants_json()) return [jsonify({ ok: false, error: 'Unknown attribute list.' }), 400];
    flash('Unknown attribute list.', 'error');
    return redirect(url_for('taxonomy.index'));
  }
  const name = request.form.get('name', '').trim();
  const label = TAXONOMY_LABELS[kind][0];
  if (!name) {
    if (_wants_json()) return [jsonify({ ok: false, error: `${label} name is required.` }), 400];
    flash(`${label} name is required.`, 'error');
    return redirect(url_for('taxonomy.index', { type: kind }));
  }
  const db = get_db();
  try {
    const cur = db.execute(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
    db.commit();
    if (_wants_json()) return jsonify({ ok: true, id: cur.lastrowid, name });
    flash(`${label} '${name}' added.`, 'success');
  } catch (e) {
    if (!isIntegrityError(e)) throw e;
    if (_wants_json()) return [jsonify({ ok: false, error: `A ${label.toLowerCase()} named '${name}' already exists.` }), 409];
    flash(`A ${label.toLowerCase()} named '${name}' already exists.`, 'error');
  }
  return redirect(url_for('taxonomy.index', { type: kind }));
}), { endpoint: 'new' });

bp.route('/<kind>/<int:item_id>/edit', ['POST'], login_required(function edit({ kind, item_id }) {
  const table = _resolve_kind(kind);
  if (!table) {
    flash('Unknown attribute list.', 'error');
    return redirect(url_for('taxonomy.index'));
  }
  const name = request.form.get('name', '').trim();
  const label = TAXONOMY_LABELS[kind][0];
  if (!name) {
    flash(`${label} name is required.`, 'error');
    return redirect(url_for('taxonomy.index', { type: kind }));
  }
  const db = get_db();
  const row = db.execute(`SELECT * FROM ${table} WHERE id=?`, [item_id]).fetchone();
  if (!row) {
    flash(`${label} not found.`, 'error');
    return redirect(url_for('taxonomy.index', { type: kind }));
  }
  try {
    db.execute(`UPDATE ${table} SET name=? WHERE id=?`, [name, item_id]);
    db.commit();
    flash(`${label} updated.`, 'success');
  } catch (e) {
    if (!isIntegrityError(e)) throw e;
    flash(`A ${label.toLowerCase()} named '${name}' already exists.`, 'error');
  }
  return redirect(url_for('taxonomy.index', { type: kind }));
}));

bp.route('/<kind>/<int:item_id>/toggle', ['POST'], admin_required(function toggle({ kind, item_id }) {
  const table = _resolve_kind(kind);
  if (!table) {
    flash('Unknown attribute list.', 'error');
    return redirect(url_for('taxonomy.index'));
  }
  const db = get_db();
  const row = db.execute(`SELECT * FROM ${table} WHERE id=?`, [item_id]).fetchone();
  if (!row) {
    flash(`${TAXONOMY_LABELS[kind][0]} not found.`, 'error');
    return redirect(url_for('taxonomy.index', { type: kind }));
  }
  const new_state = row.is_active ? 0 : 1;
  db.execute(`UPDATE ${table} SET is_active=? WHERE id=?`, [new_state, item_id]);
  db.commit();
  flash(new_state ? 'Activated.' : 'Deactivated.', 'success');
  return redirect(url_for('taxonomy.index', { type: kind, page: request.form.get('page', 1) }));
}));

module.exports = { bp, TAXONOMY_META, TAXONOMY_LABELS };
