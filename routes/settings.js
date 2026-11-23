'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Blueprint, request, session, redirect, url_for, flash, send_file, pyInt, secure_filename,
  generate_password_hash, check_password_hash } = require('../lib/core');
const { render_template } = require('../lib/render');
const { strftime } = require('../lib/py');
const { extOf } = require('../lib/uploads');
const { get_db, get_setting, set_setting, DB_PATH, BASE_DIR, paginate } = require('../db');
const { login_required, admin_required, permission_required, PERMISSION_MODULES } = require('../auth');
const { list_branches } = require('../branches');

const bp = new Blueprint('settings', { url_prefix: '/settings' });

const { UPLOAD_STATIC, DATA_DIR } = require('../lib/storage');
const BANNER_UPLOAD_DIR = path.join(UPLOAD_STATIC, 'uploads', 'banner');
const ALLOWED_BANNER_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const LOGO_UPLOAD_DIR = path.join(UPLOAD_STATIC, 'uploads', 'logo');
const ALLOWED_LOGO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);

/** Save the storefront ad/banner image as static/uploads/banner/banner.<ext>. */
function _save_banner_image(fileStorage) {
  if (!fileStorage || !fileStorage.filename) return null;
  const ext = extOf(fileStorage.filename);
  if (!ALLOWED_BANNER_EXT.has(ext)) return null;
  fs.mkdirSync(BANNER_UPLOAD_DIR, { recursive: true });
  const filename = secure_filename(`banner.${ext}`);
  fileStorage.save(path.join(BANNER_UPLOAD_DIR, filename));
  return `uploads/banner/${filename}`;
}

/** Save the shop logo as static/uploads/logo/logo.<ext>. */
function _save_logo_image(fileStorage) {
  if (!fileStorage || !fileStorage.filename) return null;
  const ext = extOf(fileStorage.filename);
  if (!ALLOWED_LOGO_EXT.has(ext)) return null;
  fs.mkdirSync(LOGO_UPLOAD_DIR, { recursive: true });
  const filename = secure_filename(`logo.${ext}`);
  fileStorage.save(path.join(LOGO_UPLOAD_DIR, filename));
  return `uploads/logo/${filename}`;
}

bp.route('/', ['GET', 'POST'], permission_required('shop_setting')(function index() {
  const f = request.form;
  if (request.method === 'POST') {
    set_setting('shop_name', f.get('shop_name', '').trim());
    set_setting('shop_address', f.get('shop_address', '').trim());
    set_setting('shop_phone', f.get('shop_phone', '').trim());
    set_setting('gst_percent', f.get('gst_percent', '0').trim());
    set_setting('invoice_prefix', f.get('invoice_prefix', 'INV').trim());
    set_setting('order_prefix', f.get('order_prefix', 'ORD').trim());
    set_setting('currency_symbol', f.get('currency_symbol', 'Rs.').trim());

    if (f.get('remove_logo')) set_setting('shop_logo_path', '');
    else {
      const logo_path = _save_logo_image(request.files.get('shop_logo'));
      if (logo_path) set_setting('shop_logo_path', logo_path);
    }

    set_setting('store_enabled', f.get('store_enabled') ? '1' : '0');
    set_setting('store_tagline', f.get('store_tagline', '').trim());
    set_setting('store_delivery_charge', f.get('store_delivery_charge', '0').trim() || '0');
    set_setting('store_default_branch_id', f.get('store_default_branch_id', '').trim());
    set_setting('razorpay_key_id', f.get('razorpay_key_id', '').trim());
    set_setting('razorpay_key_secret', f.get('razorpay_key_secret', '').trim());
    set_setting('online_order_prefix', f.get('online_order_prefix', 'WEB').trim());

    if (f.get('remove_banner')) set_setting('store_banner_image', '');
    else {
      const banner_path = _save_banner_image(request.files.get('banner_image'));
      if (banner_path) set_setting('store_banner_image', banner_path);
    }
    set_setting('store_banner_link', f.get('store_banner_link', '').trim());

    flash('Settings saved.', 'success');
    return redirect(url_for('settings.index'));
  }
  const keys = [
    'shop_name', 'shop_address', 'shop_phone', 'gst_percent', 'invoice_prefix', 'order_prefix', 'currency_symbol',
    'shop_logo_path',
    'store_enabled', 'store_tagline', 'store_delivery_charge', 'store_default_branch_id',
    'razorpay_key_id', 'razorpay_key_secret', 'online_order_prefix',
    'store_banner_image', 'store_banner_link',
  ];
  const values = {};
  for (const k of keys) values[k] = get_setting(k, '');
  return render_template('settings/index.html', { values, branches: list_branches() });
}));

bp.route('/users', admin_required(function users_index() {
  const db = get_db();
  const users = db.execute('SELECT * FROM users ORDER BY created_at').fetchall();
  const all = list_branches(db);
  const branches = Object.fromEntries(all.map((b) => [b.id, b.name]));
  return render_template('settings/users.html', {
    users, branches, all_branches: all, permission_labels: Object.fromEntries(PERMISSION_MODULES),
  });
}));

const ALLOWED_PERMISSION_KEYS = new Set(PERMISSION_MODULES.map(([k]) => k));

bp.route('/users/new', ['GET', 'POST'], admin_required(function users_new() {
  const db = get_db();
  if (request.method === 'POST') {
    const f = request.form;
    const username = f.require('username').trim();
    if (db.execute('SELECT id FROM users WHERE username=?', [username]).fetchone()) {
      flash('This username is already taken.', 'error');
      return redirect(url_for('settings.users_new'));
    }
    const role = f.get('role', 'staff');
    const branch_id = f.get('branch_id', '').trim();
    if (role !== 'admin' && !branch_id) {
      flash('Please select a branch for the staff member.', 'error');
      return redirect(url_for('settings.users_new'));
    }
    const selected = f.getlist('permissions[]').filter((p) => ALLOWED_PERMISSION_KEYS.has(p));
    const permissions = role !== 'admin' ? selected.join(',') : '';
    db.execute('INSERT INTO users (username, password_hash, full_name, role, branch_id, permissions) VALUES (?,?,?,?,?,?)', [
      username, generate_password_hash(f.require('password')), f.get('full_name', '').trim() || username,
      role, branch_id ? pyInt(branch_id) : null, permissions,
    ]);
    db.commit();
    flash('Staff user added.', 'success');
    return redirect(url_for('settings.users_index'));
  }
  return render_template('settings/user_form.html', {
    user: null, branches: list_branches(db), permission_modules: PERMISSION_MODULES, selected_permissions: [],
  });
}));

bp.route('/users/<int:user_id>/permissions', ['GET', 'POST'], admin_required(function users_edit_permissions({ user_id }) {
  const db = get_db();
  const user = db.execute('SELECT * FROM users WHERE id=?', [user_id]).fetchone();
  if (!user) {
    flash('User not found.', 'error');
    return redirect(url_for('settings.users_index'));
  }
  if (user.role === 'admin') {
    flash("Admins always have full access - there's no need to set access separately.", 'error');
    return redirect(url_for('settings.users_index'));
  }
  if (request.method === 'POST') {
    const selected = request.form.getlist('permissions[]').filter((p) => ALLOWED_PERMISSION_KEYS.has(p));
    db.execute('UPDATE users SET permissions=? WHERE id=?', [selected.join(','), user_id]);
    db.commit();
    flash(`${user.full_name}'s access updated.`, 'success');
    return redirect(url_for('settings.users_index'));
  }
  const current = String(user.permissions || '').split(',').filter(Boolean);
  return render_template('settings/user_permissions.html', {
    user, permission_modules: PERMISSION_MODULES, selected_permissions: current,
  });
}));

bp.route('/users/<int:user_id>/set-branch', ['POST'], admin_required(function users_set_branch({ user_id }) {
  const db = get_db();
  const branch_id = request.form.get('branch_id', '').trim();
  db.execute('UPDATE users SET branch_id=? WHERE id=?', [branch_id ? pyInt(branch_id) : null, user_id]);
  db.commit();
  flash('Branch updated.', 'success');
  return redirect(url_for('settings.users_index'));
}));

bp.route('/users/<int:user_id>/toggle', ['POST'], admin_required(function users_toggle({ user_id }) {
  const db = get_db();
  const user = db.execute('SELECT * FROM users WHERE id=?', [user_id]).fetchone();
  if (!user) {
    flash('User not found.', 'error');
    return redirect(url_for('settings.users_index'));
  }
  if (user.id === session.user_id) {
    flash("You can't deactivate yourself.", 'error');
    return redirect(url_for('settings.users_index'));
  }
  db.execute('UPDATE users SET active = ? WHERE id=?', [user.active ? 0 : 1, user_id]);
  db.commit();
  flash('User status updated.', 'success');
  return redirect(url_for('settings.users_index'));
}));

bp.route('/users/<int:user_id>/reset-password', ['POST'], admin_required(function users_reset_password({ user_id }) {
  const db = get_db();
  const new_password = request.form.get('password', '').trim();
  if (!new_password) {
    flash("Password can't be empty.", 'error');
    return redirect(url_for('settings.users_index'));
  }
  db.execute('UPDATE users SET password_hash=? WHERE id=?', [generate_password_hash(new_password), user_id]);
  db.commit();
  flash('Password reset.', 'success');
  return redirect(url_for('settings.users_index'));
}));

bp.route('/my-password', ['GET', 'POST'], login_required(function my_password() {
  if (request.method === 'POST') {
    const db = get_db();
    const user = db.execute('SELECT * FROM users WHERE id=?', [session.user_id]).fetchone();
    const current = request.form.get('current_password', '');
    const nw = request.form.get('new_password', '');
    if (!user || !check_password_hash(user.password_hash, current)) {
      flash('Current password is incorrect.', 'error');
      return redirect(url_for('settings.my_password'));
    }
    if (nw.length < 4) {
      flash('New password must be at least 4 characters long.', 'error');
      return redirect(url_for('settings.my_password'));
    }
    db.execute('UPDATE users SET password_hash=? WHERE id=?', [generate_password_hash(nw), user.id]);
    db.commit();
    flash('Password changed.', 'success');
    return redirect(url_for('dashboard'));
  }
  return render_template('settings/my_password.html');
}));

bp.route('/store-analytics', permission_required('shop_setting')(async function store_analytics() {
  const db = get_db();
  const mongosync = require('../lib/mongosync');
  if (mongosync.enabled()) {
    // MongoDB mode: storefront visits are stored in MongoDB, not SQLite.
    let page = parseInt(request.args.get('page', 1), 10);
    if (Number.isNaN(page)) page = 1;
    const s = await mongosync.visitStats({ page, perPage: 20 });
    // Attach customer names for logged-in visitors.
    const ocIds = [...new Set(s.recent.map((v) => v.online_customer_id).filter((x) => x !== null && x !== undefined))];
    const names = {};
    if (ocIds.length) {
      for (const r of db.execute(`SELECT oc.id, c.name FROM online_customers oc JOIN customers c ON c.id = oc.customer_id
               WHERE oc.id IN (${ocIds.map(() => '?').join(',')})`, ocIds).fetchall()) names[r.id] = r.name;
    }
    const recent_visits = s.recent.map((v) => ({ ...v, customer_name: names[v.online_customer_id] || null }));
    return render_template('settings/store_analytics.html', {
      total_visits: s.total, unique_visitors: s.unique, today_visits: s.today, week_visits: s.week,
      registered_customers: db.execute('SELECT COUNT(*) c FROM online_customers').fetchone().c,
      popular_pages: s.popular, recent_visits,
      visits_page: s.page, visits_total_pages: s.totalPages, visits_total: s.total,
      visits_page_url: (p) => url_for('settings.store_analytics', { page: p }),
    });
  }
  const c = (sql) => db.execute(sql).fetchone().c;
  const total_visits = c('SELECT COUNT(*) c FROM site_visits');
  const unique_visitors = c('SELECT COUNT(DISTINCT ip_address) c FROM site_visits WHERE ip_address IS NOT NULL');
  const today_visits = c("SELECT COUNT(*) c FROM site_visits WHERE date(visited_at) = date('now')");
  const week_visits = c("SELECT COUNT(*) c FROM site_visits WHERE visited_at >= datetime('now', '-7 days')");
  const registered_customers = c('SELECT COUNT(*) c FROM online_customers');
  const popular_pages = db.execute('SELECT path, COUNT(*) c FROM site_visits GROUP BY path ORDER BY c DESC LIMIT 10').fetchall();

  const visits_page_size = 20;
  const [visits_total, visits_total_pages, visits_page, visits_offset] = paginate(
    db, 'SELECT COUNT(*) FROM site_visits', [], request.args.get('page', 1), visits_page_size);
  const recent_visits = db.execute(`SELECT sv.*, c.name AS customer_name FROM site_visits sv
           LEFT JOIN online_customers oc ON oc.id = sv.online_customer_id
           LEFT JOIN customers c ON c.id = oc.customer_id
           ORDER BY sv.visited_at DESC LIMIT ? OFFSET ?`, [visits_page_size, visits_offset]).fetchall();
  const visits_page_url = (p) => url_for('settings.store_analytics', { page: p });

  return render_template('settings/store_analytics.html', {
    total_visits, unique_visitors, today_visits, week_visits, registered_customers,
    popular_pages, recent_visits, visits_page, visits_total_pages, visits_total, visits_page_url,
  });
}));

bp.route('/backup', permission_required('backup')(function backup_page() {
  const backups_dir = path.join(DATA_DIR, 'backups');
  let files = [];
  if (fs.existsSync(backups_dir) && fs.statSync(backups_dir).isDirectory()) {
    files = fs.readdirSync(backups_dir).sort().reverse();
  }
  return render_template('settings/backup.html', { files });
}));

bp.route('/backup/download', permission_required('backup')(function backup_download() {
  get_db().commit(); // flush any pending writes before copying the file
  const ts = strftime(new Date(), '%Y%m%d_%H%M%S');
  const tmp_path = path.join(DATA_DIR, `oms_backup_${ts}.db`);
  fs.copyFileSync(DB_PATH, tmp_path);
  return send_file(tmp_path, { as_attachment: true, download_name: `optical_oms_backup_${ts}.db` });
}));

module.exports = { bp };
