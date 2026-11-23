'use strict';
/**
 * Where the app keeps its writable files.
 *
 * Local (default): data/oms.db and static/uploads/ inside the project, as before.
 *
 * MongoDB mode (MONGODB_URI set AND running on Vercel or OMS_STORAGE=mongodb):
 * the project folder is treated as read-only. The working SQLite copy and
 * newly uploaded images live in the OS temp folder, and lib/mongosync.js keeps
 * them saved in MongoDB Atlas (the permanent copy).
 */
const os = require('node:os');
const path = require('node:path');

const BASE_DIR = path.join(__dirname, '..');
const IS_VERCEL = !!process.env.VERCEL;
const MONGO_MODE = !!process.env.MONGODB_URI &&
  (IS_VERCEL || String(process.env.OMS_STORAGE || '').toLowerCase() === 'mongodb');

const RUNTIME_DIR = (MONGO_MODE || IS_VERCEL) ? path.join(os.tmpdir(), 'jyotioms') : null;

/** Static files shipped with the project (CSS, JS, icons, existing images). */
const REPO_STATIC = path.join(BASE_DIR, 'static');
/** Writable root for newly uploaded static files (uploads/...). */
const UPLOAD_STATIC = RUNTIME_DIR ? path.join(RUNTIME_DIR, 'static') : REPO_STATIC;
/** Writable folder for the database, backups and generated PDFs. */
const DATA_DIR = RUNTIME_DIR ? path.join(RUNTIME_DIR, 'data') : path.join(BASE_DIR, 'data');
const DB_PATH = process.env.OMS_DB_PATH || path.join(DATA_DIR, 'oms.db');

module.exports = { BASE_DIR, IS_VERCEL, MONGO_MODE, RUNTIME_DIR, REPO_STATIC, UPLOAD_STATIC, DATA_DIR, DB_PATH };
