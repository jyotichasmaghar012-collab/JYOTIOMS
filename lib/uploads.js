'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const { secure_filename } = core;
const { resizeIfWider } = require('./images');
const storage = require('./storage');

/** Writable root for uploaded static files (the project's static/ folder
 *  locally; a temp folder synced to MongoDB on Vercel). */
const STATIC_DIR = storage.UPLOAD_STATIC;
const DEFAULT_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

function extOf(filename) {
  return filename && filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
}

/**
 * Save an uploaded image under static/<relDir>/ as "<prefix>_<ms>.<ext>",
 * optionally downscaling it to maxWidth. Returns the static-relative path,
 * or null when there's no file / a disallowed extension.
 */
async function saveImageUpload(fileStorage, { relDir, prefix, maxWidth = null, allowed = DEFAULT_IMAGE_EXT, quality = 88 }) {
  if (!fileStorage || !fileStorage.filename) return null;
  const ext = extOf(fileStorage.filename);
  if (!allowed.has(ext)) return null;
  const dir = path.join(STATIC_DIR, ...relDir.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const filename = secure_filename(`${prefix}_${Date.now()}.${ext}`);
  const full = path.join(dir, filename);
  fileStorage.save(full);
  if (maxWidth) await resizeIfWider(full, maxWidth, quality);
  return `${relDir}/${filename}`;
}

/** Delete a static-relative file if it exists; never throws. */
function deleteStatic(rel) {
  if (!rel) return;
  for (const root of new Set([STATIC_DIR, storage.REPO_STATIC])) {
    const full = path.join(root, rel);
    try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch (_) { /* read-only on Vercel */ }
  }
  // MongoDB mode: also remove the saved copy once this request finishes.
  const c = core.hasContext() ? core.current() : null;
  if (c && c.syncTok) c.syncTok.deleted.add(String(rel).replace(/\\/g, '/').replace(/^\/+/, ''));
}

/** Shift existing display_order values >= requested up by one so the new
 *  value is unique (shared by brands / categories / promotions / banners). */
function assignUniqueOrder(db, table, requested, excludeId = null) {
  const clash = excludeId ? ' AND id != ?' : '';
  const params = excludeId ? [requested, excludeId] : [requested];
  const clashing = db.execute(`SELECT id FROM ${table} WHERE display_order >= ?${clash} ORDER BY display_order`, params).fetchall();
  if (clashing.length) {
    db.execute(`UPDATE ${table} SET display_order = display_order + 1 WHERE display_order >= ?${clash}`, params);
  }
  return requested;
}

function nextDisplayOrder(db, table) {
  return db.execute(`SELECT COALESCE(MAX(display_order), -1) AS m FROM ${table}`).fetchone().m + 1;
}

module.exports = { STATIC_DIR, DEFAULT_IMAGE_EXT, extOf, saveImageUpload, deleteStatic, assignUniqueOrder, nextDisplayOrder };
