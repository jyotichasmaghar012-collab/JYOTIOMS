'use strict';
const { Blueprint, request, session, redirect, url_for, flash, pyInt } = require('../lib/core');
const { render_template } = require('../lib/render');
const { get_db } = require('../db');
const { admin_required, permission_required } = require('../auth');

const bp = new Blueprint('branches', { url_prefix: '/branches' });
const branchPerm = permission_required('branch_setting');

bp.route('/', branchPerm(function index() {
  const db = get_db();
  const rows = db.execute('SELECT * FROM branches ORDER BY name').fetchall();
  const branches = rows.map((b) => ({
    branch: b,
    staff_count: db.execute('SELECT COUNT(*) c FROM users WHERE branch_id = ?', [b.id]).fetchone().c,
    frame_count: db.execute('SELECT COUNT(*) c FROM frames WHERE branch_id = ?', [b.id]).fetchone().c,
    order_count: db.execute('SELECT COUNT(*) c FROM orders WHERE branch_id = ?', [b.id]).fetchone().c,
  }));
  return render_template('branches/index.html', { branches });
}));

bp.route('/new', ['GET', 'POST'], branchPerm(function new_() {
  if (request.method === 'POST') {
    const db = get_db();
    const name = request.form.get('name', '').trim();
    if (!name) {
      flash('Branch name is required.', 'error');
      return redirect(url_for('branches.new'));
    }
    db.execute('INSERT INTO branches (name, address, phone) VALUES (?,?,?)',
      [name, request.form.get('address', '').trim(), request.form.get('phone', '').trim()]);
    db.commit();
    flash('New branch added.', 'success');
    return redirect(url_for('branches.index'));
  }
  return render_template('branches/form.html', { branch: null });
}), { endpoint: 'new' });

bp.route('/<int:branch_id>/edit', ['GET', 'POST'], branchPerm(function edit({ branch_id }) {
  const db = get_db();
  const branch = db.execute('SELECT * FROM branches WHERE id=?', [branch_id]).fetchone();
  if (!branch) {
    flash('Branch not found.', 'error');
    return redirect(url_for('branches.index'));
  }
  if (request.method === 'POST') {
    const name = request.form.get('name', '').trim();
    if (!name) {
      flash('Branch name is required.', 'error');
      return redirect(url_for('branches.edit', { branch_id }));
    }
    db.execute('UPDATE branches SET name=?, address=?, phone=? WHERE id=?',
      [name, request.form.get('address', '').trim(), request.form.get('phone', '').trim(), branch_id]);
    db.commit();
    flash('Branch updated.', 'success');
    return redirect(url_for('branches.index'));
  }
  return render_template('branches/form.html', { branch });
}));

/** Lets an admin switch their active branch view (or go back to 'All
 *  Branches'). Staff are always locked to their own branch. */
bp.route('/switch', ['POST'], admin_required(function switch_() {
  const branch_id = request.form.get('branch_id', '').trim();
  session.active_branch_id = branch_id ? pyInt(branch_id) : null;
  const next_url = request.form.get('next') || url_for('dashboard');
  return redirect(next_url);
}), { endpoint: 'switch' });

module.exports = { bp };
