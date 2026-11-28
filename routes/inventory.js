'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Blueprint, request, session, redirect, url_for, flash, jsonify, pyInt, pyFloat, secure_filename } = require('../lib/core');
const { render_template } = require('../lib/render');
const { extOf, deleteStatic } = require('../lib/uploads');
const { get_db, GENDER_VALUES, paginate, BASE_DIR } = require('../db');
const { login_required, admin_required } = require('../auth');
const { get_active_branch_id, is_all_branches_view, list_branches, get_branch_name } = require('../branches');

const CATALOG_PAGE_SIZE = 20;
const bp = new Blueprint('inventory', { url_prefix: '/inventory' });

const { UPLOAD_STATIC } = require('../lib/storage');
const PRODUCT_UPLOAD_DIR = path.join(UPLOAD_STATIC, 'uploads', 'products');
const ALLOWED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

// Product image gallery (shared by Frames and Contact Lenses).
const GALLERY_ITEM_TABLE = { frame: 'frames', contact_lens: 'contact_lenses' };
const GALLERY_ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MAX_GALLERY_IMAGES = 20;

// Frame form field -> [taxonomy table, frames FK column, required?]
const FRAME_TAXONOMY_FIELDS = [
  ['brand_id', 'brands', 'brand_id', true],
  ['category_id', 'categories', 'category_id', true],
  ['colour_id', 'colours', 'colour_id', false],
  ['size_id', 'sizes', 'size_id', false],
  ['material_id', 'materials', 'material_id', false],
  ['frame_shape_id', 'frame_shapes', 'frame_shape_id', false],
  ['frame_type_id', 'frame_types', 'frame_type_id', false],
  ['gender_id', 'genders', 'gender_id', true],
];
// FK column -> legacy free-text column on frames it mirrors.
const LEGACY_TEXT_COLUMN = { brand_id: 'brand', colour_id: 'color', size_id: 'size', category_id: 'category' };

const isAdmin = () => session.role === 'admin';
const ciSort = (arr) => arr.sort((a, b) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });

/** Active rows for every Frame-form dropdown, keyed by table; a deactivated
 *  row the frame still references is appended so it isn't silently lost. */
function _frame_taxonomy_options(db, frame = null) {
  const options = {};
  for (const [, table, fk_col] of FRAME_TAXONOMY_FIELDS) {
    let rows = db.execute(`SELECT * FROM ${table} WHERE is_active=1 ORDER BY name COLLATE NOCASE`).fetchall();
    if (frame && frame[fk_col] !== null && frame[fk_col] !== undefined && !rows.some((r) => r.id === frame[fk_col])) {
      const extra = db.execute(`SELECT * FROM ${table} WHERE id=?`, [frame[fk_col]]).fetchone();
      if (extra) rows = [...rows, extra];
    }
    options[table] = rows;
  }
  return options;
}

/** [fk_values, legacy_values, error|null] from the submitted Frame form. */
function _resolve_frame_taxonomy_form(db, form) {
  const fk_values = {}; const legacy_values = {};
  for (const [field, table, fk_col, required] of FRAME_TAXONOMY_FIELDS) {
    const raw = String(form.get(field, '') || '').trim();
    if (!raw) {
      if (required) {
        const label = table !== 'categories' ? table.charAt(0).toUpperCase() + table.slice(1, -1).toLowerCase() : 'Category';
        return [{}, {}, `${label} is required.`];
      }
      fk_values[fk_col] = null;
      if (fk_col in LEGACY_TEXT_COLUMN) legacy_values[LEGACY_TEXT_COLUMN[fk_col]] = '';
      continue;
    }
    let row_id;
    try { row_id = pyInt(raw); } catch (_) { return [{}, {}, 'Invalid selection submitted.']; }
    const row = db.execute(`SELECT * FROM ${table} WHERE id=?`, [row_id]).fetchone();
    if (!row) return [{}, {}, 'Invalid selection submitted.'];
    fk_values[fk_col] = row_id;
    if (fk_col in LEGACY_TEXT_COLUMN) legacy_values[LEGACY_TEXT_COLUMN[fk_col]] = row.name;
  }
  return [fk_values, legacy_values, null];
}

function _save_product_image(fileStorage, item_type, item_id) {
  if (!fileStorage || !fileStorage.filename) return null;
  const ext = extOf(fileStorage.filename);
  if (!ALLOWED_IMAGE_EXT.has(ext)) return null;
  fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
  const filename = secure_filename(`${item_type}_${item_id}.${ext}`);
  fileStorage.save(path.join(PRODUCT_UPLOAD_DIR, filename));
  return `uploads/products/${filename}`;
}

function _gallery_images(db, item_type, item_id) {
  return db.execute('SELECT * FROM product_images WHERE item_type=? AND item_id=? ORDER BY sort_order, id', [item_type, item_id]).fetchall();
}

/** Keep frames/contact_lenses.image_path mirroring the primary gallery image. */
function _sync_primary_image_path(db, item_type, item_id) {
  const table = GALLERY_ITEM_TABLE[item_type];
  const primary = db.execute('SELECT image_path FROM product_images WHERE item_type=? AND item_id=? AND is_primary=1', [item_type, item_id]).fetchone();
  db.execute(`UPDATE ${table} SET image_path=? WHERE id=?`, [primary ? primary.image_path : null, item_id]);
  db.commit();
}

function _gallery_redirect(item_type, item_id) {
  if (item_type === 'frame') return redirect(url_for('inventory.frames_edit', { item_id }));
  return redirect(url_for('inventory.contacts_edit', { item_id }));
}

bp.route('/product-images/<item_type>/<int:item_id>/upload', ['POST'], login_required(function product_images_upload({ item_type, item_id }) {
  if (!(item_type in GALLERY_ITEM_TABLE)) {
    flash('Unknown product type.', 'error');
    return redirect(url_for('inventory.frames_index'));
  }
  const db = get_db();
  const table = GALLERY_ITEM_TABLE[item_type];
  if (!db.execute(`SELECT id FROM ${table} WHERE id=?`, [item_id]).fetchone()) {
    flash('Product not found.', 'error');
    return redirect(url_for('inventory.frames_index'));
  }
  const existing = _gallery_images(db, item_type, item_id);
  const slots_left = MAX_GALLERY_IMAGES - existing.length;
  if (slots_left <= 0) {
    flash(`Maximum ${MAX_GALLERY_IMAGES} images allowed per product.`, 'error');
    return _gallery_redirect(item_type, item_id);
  }
  const files = request.files.getlist('gallery_images').filter((f) => f && f.filename);
  let next_order = existing.length ? existing[existing.length - 1].sort_order + 1 : 0;
  let added = 0; let skipped = 0;
  fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
  for (const f of files) {
    if (added >= slots_left) { skipped += files.length - added; break; }
    const ext = extOf(f.filename);
    if (!GALLERY_ALLOWED_EXT.has(ext)) { skipped += 1; continue; }
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const filename = secure_filename(`${item_type}_${item_id}_${rand}.${ext}`);
    f.save(path.join(PRODUCT_UPLOAD_DIR, filename));
    const is_primary = !existing.length && added === 0 ? 1 : 0;
    db.execute('INSERT INTO product_images (item_type, item_id, image_path, sort_order, is_primary) VALUES (?,?,?,?,?)',
      [item_type, item_id, `uploads/products/${filename}`, next_order, is_primary]);
    next_order += 1;
    added += 1;
  }
  db.commit();
  if (added && !existing.length) _sync_primary_image_path(db, item_type, item_id);
  if (added && skipped) flash(`${added} image(s) uploaded, ${skipped} skipped (unsupported format or gallery is full).`, 'success');
  else if (added) flash(`${added} image(s) uploaded.`, 'success');
  else flash('No valid images uploaded. Use JPG, PNG or WEBP.', 'error');
  return _gallery_redirect(item_type, item_id);
}));

bp.route('/product-images/<item_type>/<int:item_id>/<int:image_id>/delete', ['POST'], login_required(function product_images_delete({ item_type, item_id, image_id }) {
  if (!(item_type in GALLERY_ITEM_TABLE)) {
    flash('Unknown product type.', 'error');
    return redirect(url_for('inventory.frames_index'));
  }
  const db = get_db();
  const row = db.execute('SELECT * FROM product_images WHERE id=? AND item_type=? AND item_id=?', [image_id, item_type, item_id]).fetchone();
  if (row) {
    const total = db.execute('SELECT COUNT(*) c FROM product_images WHERE item_type=? AND item_id=?', [item_type, item_id]).fetchone().c;
    if (total <= 1) {
      flash('At least one product image is required - upload a replacement before deleting the last one.', 'error');
      return _gallery_redirect(item_type, item_id);
    }
    deleteStatic(row.image_path);
    db.execute('DELETE FROM product_images WHERE id=?', [image_id]);
    db.commit();
    if (row.is_primary) {
      const nxt = db.execute('SELECT id FROM product_images WHERE item_type=? AND item_id=? ORDER BY sort_order, id LIMIT 1', [item_type, item_id]).fetchone();
      if (nxt) {
        db.execute('UPDATE product_images SET is_primary=1 WHERE id=?', [nxt.id]);
        db.commit();
      }
    }
    _sync_primary_image_path(db, item_type, item_id);
    flash('Image deleted.', 'success');
  }
  return _gallery_redirect(item_type, item_id);
}));

bp.route('/product-images/<item_type>/<int:item_id>/<int:image_id>/primary', ['POST'], login_required(function product_images_set_primary({ item_type, item_id, image_id }) {
  if (!(item_type in GALLERY_ITEM_TABLE)) {
    flash('Unknown product type.', 'error');
    return redirect(url_for('inventory.frames_index'));
  }
  const db = get_db();
  if (db.execute('SELECT id FROM product_images WHERE id=? AND item_type=? AND item_id=?', [image_id, item_type, item_id]).fetchone()) {
    db.execute('UPDATE product_images SET is_primary=0 WHERE item_type=? AND item_id=?', [item_type, item_id]);
    db.execute('UPDATE product_images SET is_primary=1 WHERE id=?', [image_id]);
    db.commit();
    _sync_primary_image_path(db, item_type, item_id);
    flash('Featured image updated.', 'success');
  }
  return _gallery_redirect(item_type, item_id);
}));

/** AJAX drag-and-drop gallery reorder. Body: {"order": [image_id, ...]}. */
bp.route('/product-images/<item_type>/<int:item_id>/reorder', ['POST'], login_required(function product_images_reorder({ item_type, item_id }) {
  if (!(item_type in GALLERY_ITEM_TABLE)) return [jsonify({ ok: false, error: 'Unknown product type.' }), 400];
  const db = get_db();
  const payload = request.get_json({ silent: true }) || {};
  const ids = Array.isArray(payload.order) ? payload.order : [];
  ids.forEach((image_id, idx) => {
    db.execute('UPDATE product_images SET sort_order=? WHERE id=? AND item_type=? AND item_id=?', [idx, image_id, item_type, item_id]);
  });
  db.commit();
  return jsonify({ ok: true });
}));

/* ---------------- "Fill from product link" ---------------- */
const productimport = require('../lib/productimport');
const { sharp } = require('../lib/images');
const MAX_IMPORTED_IMAGES = 8;
const IMPORT_IMAGE_TIMEOUT_MS = 7000;
const IMPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMPORT_IMAGE_MAX_SIDE = 1600;

/** GET (not POST) on purpose: it only reads another website and never writes
 *  to the database, so in MongoDB mode it skips the write lock/save cycle. */
bp.route('/frames/import-link', login_required(async function frames_import_link() {
  const url = request.args.get('url', '').trim();
  if (!url) return [jsonify({ ok: false, error: 'Paste a product link first.' }), 400];
  try {
    return jsonify({ ok: true, product: await productimport.importProduct(url) });
  } catch (e) {
    if (e instanceof productimport.ImportError) return jsonify({ ok: false, error: e.message });
    console.error('Product link import failed:', e);
    return jsonify({ ok: false, error: 'Could not read that link.' });
  }
}));

/** "Paste page source" fallback for sites that block automated requests: the
 *  staff member copies the page source from their own browser and the same
 *  readers parse it. POST because the source is large; JSON-only so a plain
 *  cross-site form cannot submit it. Nothing is written to the database. */
const IMPORT_HTML_MAX_CHARS = 4 * 1024 * 1024;
bp.route('/frames/import-html', ['POST'], login_required(async function frames_import_html() {
  if (!request.is_json) return [jsonify({ ok: false, error: 'Bad request.' }), 400];
  const body = request.get_json() || {};
  const html = typeof body.html === 'string' ? body.html : '';
  if (!html.trim()) return [jsonify({ ok: false, error: 'Paste the page source first.' }), 400];
  if (html.length > IMPORT_HTML_MAX_CHARS) return jsonify({ ok: false, error: 'The pasted page source is too large.' });
  try {
    return jsonify({ ok: true, product: productimport.importFromHtml(html, typeof body.url === 'string' ? body.url : '') });
  } catch (e) {
    if (e instanceof productimport.ImportError) return jsonify({ ok: false, error: e.message });
    console.error('Page source import failed:', e);
    return jsonify({ ok: false, error: 'Could not read that page source.' });
  }
}));

/** Download one picked photo, re-encode it (JPEG/PNG/WEBP, max 1600px) and
 *  store it under uploads/products/. Returns the static path or null. */
async function _download_product_image(url, item_type, item_id) {
  try {
    const { buf } = await productimport.safeFetch(url, {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      maxBytes: IMPORT_IMAGE_MAX_BYTES, timeoutMs: IMPORT_IMAGE_TIMEOUT_MS,
    });
    if (!sharp) return null;
    const meta = await sharp(buf).metadata();
    if (!meta || !meta.width || !meta.height) return null;
    const keep = { png: 'png', webp: 'webp', jpeg: 'jpg' }[meta.format] || 'jpg';
    let p = sharp(buf).rotate().resize({ width: IMPORT_IMAGE_MAX_SIDE, height: IMPORT_IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    if (keep === 'jpg') p = p.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true });
    else if (keep === 'png') p = p.png();
    else p = p.webp({ quality: 88 });
    const out = await p.toBuffer();
    fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const filename = secure_filename(`${item_type}_${item_id}_${rand}.${keep}`);
    fs.writeFileSync(path.join(PRODUCT_UPLOAD_DIR, filename), out);
    return `uploads/products/${filename}`;
  } catch (_) {
    return null;
  }
}

/** Add the photos picked in the "Fill from product link" box to the
 *  product's gallery (in the picked order). Returns [added, failed]. */
async function _import_gallery_images(db, item_type, item_id, urls) {
  const picked = [...new Set(urls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))];
  if (!picked.length) return [0, 0];
  const existing = _gallery_images(db, item_type, item_id);
  const room = Math.min(MAX_IMPORTED_IMAGES, MAX_GALLERY_IMAGES - existing.length);
  const todo = picked.slice(0, Math.max(0, room));
  const paths = await Promise.all(todo.map((u) => _download_product_image(u, item_type, item_id)));
  let next_order = existing.length ? existing[existing.length - 1].sort_order + 1 : 0;
  let has_primary = existing.some((r) => r.is_primary);
  let added = 0;
  for (const p of paths) {
    if (!p) continue;
    db.execute('INSERT INTO product_images (item_type, item_id, image_path, sort_order, is_primary) VALUES (?,?,?,?,?)',
      [item_type, item_id, p, next_order, has_primary ? 0 : 1]);
    next_order += 1; added += 1; has_primary = true;
  }
  db.commit();
  if (added) _sync_primary_image_path(db, item_type, item_id);
  return [added, picked.length - added];
}

function _import_flash_suffix(added, failed) {
  if (!added && !failed) return '';
  if (!failed) return ` ${added} photo(s) added from the product link.`;
  return ` ${added} photo(s) added from the product link, ${failed} could not be downloaded (add them by hand if needed).`;
}

/** Active checkbox; a hidden is_active_present sentinel distinguishes
 *  "unchecked" from "field never sent" (defaults to Active). */
function _resolve_is_active(form) {
  if (!form.get('is_active_present')) return 1;
  return form.get('is_active') ? 1 : 0;
}

/** Branch to stamp on a NEW item: staff -> own branch; admin -> form pick. */
function _creator_branch_id() {
  if (isAdmin()) {
    const bid = request.form.get('branch_id', '').trim();
    return bid ? pyInt(bid) : null;
  }
  return session.branch_id ?? null;
}

/** [sql_filter, params] scoping a SELECT to the current branch context. */
function _list_filter() {
  if (is_all_branches_view()) return ['', []];
  return [' WHERE branch_id = ?', [get_active_branch_id()]];
}

/* ---------------- Frames ---------------- */
bp.route('/frames', login_required(function frames_index() {
  const db = get_db();
  const [branch_where, branch_params] = _list_filter();
  const from_clause = `FROM frames
            LEFT JOIN genders ON genders.id = frames.gender_id
            LEFT JOIN product_groups pg ON pg.id = frames.product_group_id
            LEFT JOIN materials ON materials.id = frames.material_id`;
  const a = request.args;
  const q = a.get('q', '').trim();
  const brand = a.get('brand', '').trim();
  const category = a.get('category', '').trim();
  const colour = a.get('colour', '').trim();
  const gender = a.get('gender', '').trim();

  let where = branch_where;
  const params = [...branch_params];
  const add = (cond, ...p) => { where += (where ? ' AND ' : ' WHERE ') + cond; params.push(...p); };
  if (q) {
    const like = `%${q}%`;
    add('(frames.brand LIKE ? OR frames.model LIKE ? OR frames.model_name LIKE ? OR frames.barcode LIKE ? OR frames.sku LIKE ?)', like, like, like, like, like);
  }
  if (brand) add('frames.brand = ?', brand);
  if (category) add('frames.category = ?', category);
  if (colour) add('frames.color = ?', colour);
  if (gender) add("COALESCE(genders.name, 'Unisex') = ?", gender);

  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) ${from_clause} ${where}`, params, a.get('page', 1), CATALOG_PAGE_SIZE);
  const frames = db.execute(`SELECT frames.*, genders.name AS gender_name, pg.id AS group_id, pg.name AS group_name,
                   materials.name AS material_name
            ${from_clause} ${where} ORDER BY brand, model LIMIT ? OFFSET ?`, [...params, CATALOG_PAGE_SIZE, offset]).fetchall();

  // Filter dropdown options come from the full branch-scoped catalog.
  const option_rows = db.execute(`SELECT DISTINCT frames.brand AS brand, frames.category AS category, frames.color AS color,
                   genders.name AS gender_name
            FROM frames LEFT JOIN genders ON genders.id = frames.gender_id ${branch_where}`, branch_params).fetchall();
  const uniq = (vals) => ciSort([...new Set(vals)]);
  const page_url = (p) => url_for('inventory.frames_index', { q, brand, category, colour, gender, page: p });
  return render_template('inventory/frames.html', {
    frames, all_branches_view: is_all_branches_view(), get_branch_name,
    filter_brands: uniq(option_rows.map((r) => r.brand).filter(Boolean)),
    filter_categories: uniq(option_rows.map((r) => r.category).filter(Boolean)),
    filter_colours: uniq(option_rows.map((r) => r.color).filter(Boolean)),
    filter_genders: uniq(option_rows.map((r) => r.gender_name || 'Unisex')),
    q, brand, category, colour, gender, page, total_pages, total, page_url,
  });
}));

function frameValues(f, legacy, fk) {
  return [
    legacy.brand ?? '',
    f.get('model', '').trim(),
    legacy.color ?? '',
    legacy.size ?? '',
    pyFloat(f.get('cost_price') || 0),
    pyFloat(f.get('selling_price') || 0),
    pyInt(f.get('stock_qty') || 0),
    pyInt(f.get('low_stock_threshold') || 2),
    legacy.category || 'Eyeglasses',
    f.get('online_visible') ? 1 : 0,
    f.get('online_description', '').trim(),
    fk.brand_id, fk.colour_id, fk.size_id, fk.category_id, fk.material_id, fk.frame_shape_id, fk.frame_type_id, fk.gender_id,
    f.get('model_name', '').trim() || null,
    f.get('sku', '').trim() || null,
    f.get('barcode', '').trim() || null,
    _resolve_is_active(f),
    f.get('is_best_seller') ? 1 : 0,
    f.get('is_new_arrival') ? 1 : 0,
    f.get('is_featured') ? 1 : 0,
    f.get('meta_title', '').trim() || null,
    f.get('meta_description', '').trim() || null,
    f.get('slug', '').trim() || null,
  ];
}

bp.route('/frames/new', ['GET', 'POST'], login_required(async function frames_new() {
  const db = get_db();
  if (request.method === 'POST') {
    const f = request.form;
    const branch_id = _creator_branch_id();
    if (isAdmin() && !branch_id) {
      flash('Please select a branch to add this frame to.', 'error');
      return redirect(url_for('inventory.frames_new'));
    }
    const [fk, legacy, error] = _resolve_frame_taxonomy_form(db, f);
    if (error) {
      flash(error, 'error');
      return render_template('inventory/frame_form.html', {
        frame: null, branches: isAdmin() ? list_branches(db) : null, default_branch_id: get_active_branch_id(),
        taxonomy_options: _frame_taxonomy_options(db), form: f, gallery: [],
      });
    }
    const cur = db.execute(`INSERT INTO frames (branch_id, brand, model, color, size, cost_price, selling_price, stock_qty,
               low_stock_threshold, category, online_visible, online_description,
               brand_id, colour_id, size_id, category_id, material_id, frame_shape_id, frame_type_id, gender_id,
               model_name, sku, barcode, is_active, is_best_seller, is_new_arrival, is_featured,
               meta_title, meta_description, slug)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [branch_id, ...frameValues(f, legacy, fk)]);
    const frame_id = cur.lastrowid;
    const image_path = _save_product_image(request.files.get('image'), 'frame', frame_id);
    if (image_path) {
      db.execute('UPDATE frames SET image_path=? WHERE id=?', [image_path, frame_id]);
      db.execute("INSERT INTO product_images (item_type, item_id, image_path, sort_order, is_primary) VALUES ('frame',?,?,0,1)", [frame_id, image_path]);
    }
    db.commit();
    const [imp_added, imp_failed] = await _import_gallery_images(db, 'frame', frame_id, f.getlist('import_image_url'));
    flash('Frame added. You can add more photos to its gallery from here.' + _import_flash_suffix(imp_added, imp_failed), 'success');
    return redirect(url_for('inventory.frames_edit', { item_id: frame_id }));
  }
  return render_template('inventory/frame_form.html', {
    frame: null, branches: isAdmin() ? list_branches(db) : null, default_branch_id: get_active_branch_id(),
    taxonomy_options: _frame_taxonomy_options(db), form: null, gallery: [],
  });
}));

bp.route('/frames/<int:item_id>/edit', ['GET', 'POST'], login_required(async function frames_edit({ item_id }) {
  const db = get_db();
  const frame = db.execute('SELECT * FROM frames WHERE id=?', [item_id]).fetchone();
  if (!frame) {
    flash('Frame not found.', 'error');
    return redirect(url_for('inventory.frames_index'));
  }
  if (request.method === 'POST') {
    const f = request.form;
    const branch_id = isAdmin() ? _creator_branch_id() : frame.branch_id;
    const [fk, legacy, error] = _resolve_frame_taxonomy_form(db, f);
    if (error) {
      flash(error, 'error');
      return render_template('inventory/frame_form.html', {
        frame, branches: isAdmin() ? list_branches(db) : null, default_branch_id: frame.branch_id,
        taxonomy_options: _frame_taxonomy_options(db, frame), form: f, gallery: _gallery_images(db, 'frame', item_id),
      });
    }
    db.execute(`UPDATE frames SET branch_id=?, brand=?, model=?, color=?, size=?, cost_price=?, selling_price=?,
               stock_qty=?, low_stock_threshold=?, category=?, online_visible=?, online_description=?,
               brand_id=?, colour_id=?, size_id=?, category_id=?, material_id=?, frame_shape_id=?, frame_type_id=?, gender_id=?,
               model_name=?, sku=?, barcode=?, is_active=?, is_best_seller=?, is_new_arrival=?, is_featured=?,
               meta_title=?, meta_description=?, slug=?
               WHERE id=?`, [branch_id, ...frameValues(f, legacy, fk), item_id]);
    const image_path = _save_product_image(request.files.get('image'), 'frame', item_id);
    if (image_path) db.execute('UPDATE frames SET image_path=? WHERE id=?', [image_path, item_id]);
    db.commit();
    const [imp_added, imp_failed] = await _import_gallery_images(db, 'frame', item_id, f.getlist('import_image_url'));
    flash('Frame updated.' + _import_flash_suffix(imp_added, imp_failed), 'success');
    return redirect(url_for('inventory.frames_index'));
  }
  return render_template('inventory/frame_form.html', {
    frame, branches: isAdmin() ? list_branches(db) : null, default_branch_id: frame.branch_id,
    taxonomy_options: _frame_taxonomy_options(db, frame), form: null, gallery: _gallery_images(db, 'frame', item_id),
  });
}));

/** Remove every gallery row (and file) for a product being deleted. */
function _delete_gallery_for(db, item_type, item_id) {
  for (const row of db.execute('SELECT image_path FROM product_images WHERE item_type=? AND item_id=?', [item_type, item_id]).fetchall()) {
    deleteStatic(row.image_path);
  }
  db.execute('DELETE FROM product_images WHERE item_type=? AND item_id=?', [item_type, item_id]);
}

bp.route('/frames/<int:item_id>/toggle-active', ['POST'], login_required(function frames_toggle_active({ item_id }) {
  const db = get_db();
  const frame = db.execute('SELECT is_active FROM frames WHERE id=?', [item_id]).fetchone();
  if (!frame) {
    flash('Frame not found.', 'error');
    return redirect(url_for('inventory.frames_index'));
  }
  const new_state = frame.is_active ? 0 : 1;
  db.execute('UPDATE frames SET is_active=? WHERE id=?', [new_state, item_id]);
  db.commit();
  flash(new_state ? 'Frame activated.' : 'Frame marked inactive.', 'success');
  return redirect(url_for('inventory.frames_index'));
}));

bp.route('/frames/<int:item_id>/delete', ['POST'], admin_required(function frames_delete({ item_id }) {
  const db = get_db();
  _delete_gallery_for(db, 'frame', item_id);
  db.execute('DELETE FROM frames WHERE id=?', [item_id]);
  db.commit();
  flash('Frame deleted.', 'success');
  return redirect(url_for('inventory.frames_index'));
}));

/* ---------------- Frame barcodes ---------------- */
function _frame_barcode_code(frame_id, custom_barcode = null) {
  if (custom_barcode) return custom_barcode;
  return `FRM${String(frame_id).padStart(6, '0')}`;
}

/** ?ids=1,2,3 -> those frames; otherwise every frame in this branch context. */
bp.route('/frames/barcodes/print', login_required(function frames_barcodes_print() {
  const db = get_db();
  const ids_param = request.args.get('ids', '').trim();
  let rows;
  if (ids_param) {
    const ids = ids_param.split(',').filter((i) => /^\d+$/.test(i.trim())).map((i) => parseInt(i, 10));
    if (!ids.length) {
      flash('No frame was selected.', 'error');
      return redirect(url_for('inventory.frames_index'));
    }
    rows = db.execute(`SELECT * FROM frames WHERE id IN (${ids.map(() => '?').join(',')})`, ids).fetchall();
  } else {
    const [where, params] = _list_filter();
    rows = db.execute(`SELECT * FROM frames${where} ORDER BY brand, model`, params).fetchall();
  }
  const labels = rows.map((fr) => ({
    code: _frame_barcode_code(fr.id, fr.barcode ?? null),
    brand: fr.brand,
    model: fr.model || '',
    color: fr.color || '',
    size: fr.size || '',
    price: fr.selling_price,
  }));
  return render_template('inventory/frame_barcodes.html', { labels, currency: 'Rs.' });
}));

bp.route('/frames/<int:item_id>/barcode', login_required(function frame_barcode_single({ item_id }) {
  return redirect(url_for('inventory.frames_barcodes_print', { ids: String(item_id) }));
}));

/* ---------------- Lenses ---------------- */
bp.route('/lenses', login_required(function lenses_index() {
  const db = get_db();
  const [where, params] = _list_filter();
  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) FROM lenses${where}`, params, request.args.get('page', 1), CATALOG_PAGE_SIZE);
  const lenses = db.execute(`SELECT * FROM lenses${where} ORDER BY lens_type LIMIT ? OFFSET ?`, [...params, CATALOG_PAGE_SIZE, offset]).fetchall();
  const page_url = (p) => url_for('inventory.lenses_index', { page: p });
  return render_template('inventory/lenses.html', {
    lenses, all_branches_view: is_all_branches_view(), get_branch_name, page, total_pages, total, page_url,
  });
}));

function lensValues(f) {
  return [
    f.require('lens_type').trim(), f.get('material', '').trim(), f.get('brand', '').trim(),
    pyFloat(f.get('selling_price') || 0), pyInt(f.get('stock_qty') || 0), pyInt(f.get('low_stock_threshold') || 2),
  ];
}

bp.route('/lenses/new', ['GET', 'POST'], login_required(function lenses_new() {
  const db = get_db();
  if (request.method === 'POST') {
    const branch_id = _creator_branch_id();
    if (isAdmin() && !branch_id) {
      flash('Please select a branch to add this lens to.', 'error');
      return redirect(url_for('inventory.lenses_new'));
    }
    db.execute(`INSERT INTO lenses (branch_id, lens_type, material, brand, selling_price, stock_qty, low_stock_threshold)
               VALUES (?,?,?,?,?,?,?)`, [branch_id, ...lensValues(request.form)]);
    db.commit();
    flash('Lens added.', 'success');
    return redirect(url_for('inventory.lenses_index'));
  }
  return render_template('inventory/lens_form.html', {
    lens: null, branches: isAdmin() ? list_branches(db) : null, default_branch_id: get_active_branch_id(),
  });
}));

bp.route('/lenses/<int:item_id>/edit', ['GET', 'POST'], login_required(function lenses_edit({ item_id }) {
  const db = get_db();
  const lens = db.execute('SELECT * FROM lenses WHERE id=?', [item_id]).fetchone();
  if (!lens) {
    flash('Lens not found.', 'error');
    return redirect(url_for('inventory.lenses_index'));
  }
  if (request.method === 'POST') {
    const branch_id = isAdmin() ? _creator_branch_id() : lens.branch_id;
    db.execute(`UPDATE lenses SET branch_id=?, lens_type=?, material=?, brand=?, selling_price=?, stock_qty=?, low_stock_threshold=?
               WHERE id=?`, [branch_id, ...lensValues(request.form), item_id]);
    db.commit();
    flash('Lens updated.', 'success');
    return redirect(url_for('inventory.lenses_index'));
  }
  return render_template('inventory/lens_form.html', {
    lens, branches: isAdmin() ? list_branches(db) : null, default_branch_id: lens.branch_id,
  });
}));

bp.route('/lenses/<int:item_id>/delete', ['POST'], admin_required(function lenses_delete({ item_id }) {
  const db = get_db();
  db.execute('DELETE FROM lenses WHERE id=?', [item_id]);
  db.commit();
  flash('Lens deleted.', 'success');
  return redirect(url_for('inventory.lenses_index'));
}));

/* ---------------- Contact Lenses ---------------- */
bp.route('/contacts', login_required(function contacts_index() {
  const db = get_db();
  const [where, bparams] = _list_filter();
  const params = [...bparams];
  const gender_filter = request.args.get('gender', '').trim();
  let extra = '';
  if (GENDER_VALUES.includes(gender_filter)) {
    extra = (where ? ' AND ' : ' WHERE ') + 'gender = ?';
    params.push(gender_filter);
  }
  const [total, total_pages, page, offset] = paginate(db, `SELECT COUNT(*) FROM contact_lenses${where}${extra}`, params, request.args.get('page', 1), CATALOG_PAGE_SIZE);
  const contacts = db.execute(`SELECT * FROM contact_lenses${where}${extra} ORDER BY brand LIMIT ? OFFSET ?`, [...params, CATALOG_PAGE_SIZE, offset]).fetchall();
  const page_url = (p) => url_for('inventory.contacts_index', { gender: gender_filter, page: p });
  return render_template('inventory/contacts.html', {
    contacts, all_branches_view: is_all_branches_view(), get_branch_name, gender_values: GENDER_VALUES, gender_filter,
    page, total_pages, total, page_url,
  });
}));

function contactValues(f) {
  let gender = f.get('gender', '').trim();
  if (!GENDER_VALUES.includes(gender)) gender = 'Unisex';
  return [
    f.require('brand').trim(), f.get('lens_type', '').trim(), f.get('power', '').trim(), gender,
    pyFloat(f.get('selling_price') || 0), pyInt(f.get('stock_qty') || 0), pyInt(f.get('low_stock_threshold') || 2),
    f.get('online_visible') ? 1 : 0, f.get('online_description', '').trim(),
    f.get('is_best_seller') ? 1 : 0, f.get('is_new_arrival') ? 1 : 0, f.get('is_featured') ? 1 : 0,
    f.get('meta_title', '').trim() || null, f.get('meta_description', '').trim() || null, f.get('slug', '').trim() || null,
  ];
}

bp.route('/contacts/new', ['GET', 'POST'], login_required(function contacts_new() {
  const db = get_db();
  if (request.method === 'POST') {
    const branch_id = _creator_branch_id();
    if (isAdmin() && !branch_id) {
      flash('Please select a branch to add this contact lens to.', 'error');
      return redirect(url_for('inventory.contacts_new'));
    }
    const cur = db.execute(`INSERT INTO contact_lenses (branch_id, brand, lens_type, power, gender, selling_price, stock_qty,
               low_stock_threshold, online_visible, online_description, is_best_seller, is_new_arrival, is_featured,
               meta_title, meta_description, slug)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [branch_id, ...contactValues(request.form)]);
    const contact_id = cur.lastrowid;
    const image_path = _save_product_image(request.files.get('image'), 'contact', contact_id);
    if (image_path) {
      db.execute('UPDATE contact_lenses SET image_path=? WHERE id=?', [image_path, contact_id]);
      db.execute("INSERT INTO product_images (item_type, item_id, image_path, sort_order, is_primary) VALUES ('contact_lens',?,?,0,1)", [contact_id, image_path]);
    }
    db.commit();
    flash('Contact lens added. You can add more photos to its gallery from here.', 'success');
    return redirect(url_for('inventory.contacts_edit', { item_id: contact_id }));
  }
  return render_template('inventory/contact_form.html', {
    contact: null, branches: isAdmin() ? list_branches(db) : null, default_branch_id: get_active_branch_id(), gallery: [],
  });
}));

bp.route('/contacts/<int:item_id>/edit', ['GET', 'POST'], login_required(function contacts_edit({ item_id }) {
  const db = get_db();
  const contact = db.execute('SELECT * FROM contact_lenses WHERE id=?', [item_id]).fetchone();
  if (!contact) {
    flash('Contact lens not found.', 'error');
    return redirect(url_for('inventory.contacts_index'));
  }
  if (request.method === 'POST') {
    const branch_id = isAdmin() ? _creator_branch_id() : contact.branch_id;
    db.execute(`UPDATE contact_lenses SET branch_id=?, brand=?, lens_type=?, power=?, gender=?, selling_price=?, stock_qty=?,
               low_stock_threshold=?, online_visible=?, online_description=?, is_best_seller=?, is_new_arrival=?, is_featured=?,
               meta_title=?, meta_description=?, slug=?
               WHERE id=?`, [branch_id, ...contactValues(request.form), item_id]);
    const image_path = _save_product_image(request.files.get('image'), 'contact', item_id);
    if (image_path) db.execute('UPDATE contact_lenses SET image_path=? WHERE id=?', [image_path, item_id]);
    db.commit();
    flash('Contact lens updated.', 'success');
    return redirect(url_for('inventory.contacts_index'));
  }
  return render_template('inventory/contact_form.html', {
    contact, branches: isAdmin() ? list_branches(db) : null, default_branch_id: contact.branch_id,
    gallery: _gallery_images(db, 'contact_lens', item_id),
  });
}));

bp.route('/contacts/<int:item_id>/delete', ['POST'], admin_required(function contacts_delete({ item_id }) {
  const db = get_db();
  _delete_gallery_for(db, 'contact_lens', item_id);
  db.execute('DELETE FROM contact_lenses WHERE id=?', [item_id]);
  db.commit();
  flash('Contact lens deleted.', 'success');
  return redirect(url_for('inventory.contacts_index'));
}));

module.exports = { bp, _frame_barcode_code };
