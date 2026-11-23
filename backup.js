'use strict';
/**
 * Standalone daily backup script for the Optical Shop OMS.
 *
 * Copies data/oms.db into data/backups/ with a timestamp, and deletes backups
 * older than KEEP_DAYS so the backups folder doesn't grow forever.
 *
 *   node backup.js        (or: npm run backup)
 *
 * Safe to run anytime - it only reads and copies the live database.
 */
const fs = require('node:fs');
const path = require('node:path');
const { strftime } = require('./lib/py');

const BASE_DIR = __dirname;
const DB_PATH = path.join(BASE_DIR, 'data', 'oms.db');
const BACKUPS_DIR = path.join(BASE_DIR, 'data', 'backups');
const KEEP_DAYS = 30;

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`No database found at ${DB_PATH} - nothing to back up.`);
    return;
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = strftime(new Date(), '%Y%m%d_%H%M%S');
  const dest = path.join(BACKUPS_DIR, `oms_${ts}.db`);
  fs.copyFileSync(DB_PATH, dest);
  console.log(`Backed up database to ${dest}`);

  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let removed = 0;
  for (const fname of fs.readdirSync(BACKUPS_DIR)) {
    const fpath = path.join(BACKUPS_DIR, fname);
    const st = fs.statSync(fpath);
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) { fs.unlinkSync(fpath); removed++; }
  }
  if (removed) console.log(`Removed ${removed} backup(s) older than ${KEEP_DAYS} days.`);
}

if (require.main === module) main();
module.exports = { main };
