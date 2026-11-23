'use strict';
/**
 * Multi-branch helpers.
 *
 * - Staff users are permanently locked to the branch they were created under
 *   (session.branch_id) - they never see a switcher and every query is
 *   filtered to that branch automatically.
 * - Admin users have session.branch_id = null, meaning "sees everything".
 *   They additionally get a branch switcher in the sidebar that sets
 *   session.active_branch_id - either a specific branch or null ("All Branches").
 */
const { session } = require('./lib/core');
const { get_db } = require('./db');

function get_active_branch_id() {
  if (session.role === 'admin') return session.active_branch_id ?? null;
  return session.branch_id ?? null;
}

function is_all_branches_view() {
  return session.role === 'admin' && (session.active_branch_id === null || session.active_branch_id === undefined);
}

function list_branches(db) {
  db = db || get_db();
  return db.execute('SELECT * FROM branches ORDER BY name').fetchall();
}

function get_branch_name(branch_id, db) {
  if (!branch_id) return null;
  db = db || get_db();
  const row = db.execute('SELECT name FROM branches WHERE id=?', [branch_id]).fetchone();
  return row ? row.name : null;
}

module.exports = { get_active_branch_id, is_all_branches_view, list_branches, get_branch_name };
