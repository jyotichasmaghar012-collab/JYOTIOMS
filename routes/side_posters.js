'use strict';
/**
 * Website Management > Side Posters - two tall promotional poster images in
 * the empty left/right gutters beside the homepage content on wide desktop
 * screens. The `side_posters` table is seeded with exactly two rows ('left'
 * and 'right'); this blueprint only ever updates those two rows in place.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Blueprint, request, redirect, url_for, flash, secure_filename } = require('../lib/core');
const { render_template } = require('../lib/render');
const { resizeIfWider } = require('../lib/images');
const { get_db, BASE_DIR } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('side_posters', { url_prefix: '/website/side-posters' });

const { UPLOAD_STATIC } = require('../lib/storage');
const { deleteStatic } = require('../lib/uploads');
const POSTER_UPLOAD_DIR = path.join(UPLOAD_STATIC, 'uploads', 'side_posters');
const ALLOWED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const POSTER_MAX_WIDTH = 600;
const VALID_SIDES = ['left', 'right'];

function _save_poster_image(fileStorage, side) {
  if (!fileStorage || !fileStorage.filename) return null;
  const fn = fileStorage.filename;
  const ext = fn.includes('.') ? fn.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_IMAGE_EXT.has(ext)) return null;
  fs.mkdirSync(POSTER_UPLOAD_DIR, { recursive: true });
  const filename = secure_filename(`poster_${side}_${Date.now()}.${ext}`);
  fileStorage.save(path.join(POSTER_UPLOAD_DIR, filename));
  return `uploads/side_posters/${filename}`;
}

async function _resize_if_huge(rel) {
  if (!rel) return;
  await resizeIfWider(path.join(UPLOAD_STATIC, rel), POSTER_MAX_WIDTH, 88);
}

function _delete_poster_file(rel) {
  if (!rel) return;
  deleteStatic(rel);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

bp.route('/', admin_required(function index() {
  const rows = get_db().execute('SELECT * FROM side_posters ORDER BY side').fetchall();
  const posters = {};
  for (const r of rows) posters[r.side] = r;
  return render_template('website/side_posters.html', { posters });
}));

bp.route('/<side>/edit', ['POST'], admin_required(async function edit({ side }) {
  if (!VALID_SIDES.includes(side)) {
    flash('Invalid poster side.', 'error');
    return redirect(url_for('side_posters.index'));
  }
  const db = get_db();
  const poster = db.execute('SELECT * FROM side_posters WHERE side=?', [side]).fetchone();
  if (!poster) {
    flash('Poster slot not found.', 'error');
    return redirect(url_for('side_posters.index'));
  }
  const link_url = request.form.get('link_url', '').trim();
  const is_active = request.form.get('is_active') ? 1 : 0;

  let image_path = poster.image_path;
  const new_image = _save_poster_image(request.files.get('image'), side);
  if (new_image) {
    _delete_poster_file(image_path);
    image_path = new_image;
    await _resize_if_huge(image_path);
  } else if (request.form.get('remove_image')) {
    _delete_poster_file(image_path);
    image_path = null;
  }

  if (is_active && !image_path) {
    flash(`Upload a poster image before activating the ${side} poster.`, 'error');
    return redirect(url_for('side_posters.index'));
  }
  db.execute(`UPDATE side_posters SET image_path=?, link_url=?, is_active=?, updated_at=datetime('now')
           WHERE side=?`, [image_path, link_url, is_active, side]);
  db.commit();
  flash(`${capitalize(side)} poster updated.`, 'success');
  return redirect(url_for('side_posters.index'));
}));

bp.route('/<side>/toggle', ['POST'], admin_required(function toggle({ side }) {
  if (!VALID_SIDES.includes(side)) {
    flash('Invalid poster side.', 'error');
    return redirect(url_for('side_posters.index'));
  }
  const db = get_db();
  const poster = db.execute('SELECT * FROM side_posters WHERE side=?', [side]).fetchone();
  if (poster) {
    const new_state = poster.is_active ? 0 : 1;
    if (new_state && !poster.image_path) {
      flash(`Upload a poster image before activating the ${side} poster.`, 'error');
      return redirect(url_for('side_posters.index'));
    }
    db.execute('UPDATE side_posters SET is_active=? WHERE side=?', [new_state, side]);
    db.commit();
    flash(new_state ? `${capitalize(side)} poster activated.` : `${capitalize(side)} poster deactivated.`, 'success');
  }
  return redirect(url_for('side_posters.index'));
}));

module.exports = { bp };
