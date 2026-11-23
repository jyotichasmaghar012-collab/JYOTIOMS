'use strict';
const { session, request, redirect, url_for, flash, wraps } = require('./lib/core');

// Granular per-staff-user module permissions. Admin always has every module -
// these keys are only ever checked for staff accounts. Keep this list and the
// ones used by templates/settings/user_form.html + routes/settings.js in sync.
const PERMISSION_MODULES = [
  ['customer', 'Customer'],
  ['order', 'Order'],
  ['billing', 'Billing'],
  ['supplier', 'Supplier'],
  ['po_generation', 'PO Generation'],
  ['shop_setting', 'Shop Setting'],
  ['branch_setting', 'Branch Setting'],
  ['backup', 'Backup'],
];
const PERMISSION_KEYS = PERMISSION_MODULES.map(([k]) => k);

/** Admin always has full access. Staff are checked against the permissions
 *  list stored in their session at login time. */
function has_permission(perm_key) {
  if (session.role === 'admin') return true;
  return (session.permissions || []).includes(perm_key);
}

function loginRedirect() {
  return redirect(url_for('login', { next: request.path }));
}

/** Gate a whole view (or, via before_request, a whole blueprint) behind one
 *  of the PERMISSION_MODULES keys. Admin always passes. */
function permission_required(perm_key) {
  return (f) => wraps(f, function wrapper(...args) {
    if (!('user_id' in session)) return loginRedirect();
    if (!has_permission(perm_key)) {
      flash("You don't have access to this module. Please contact the admin.", 'error');
      return redirect(url_for('dashboard'));
    }
    return f(...args);
  });
}

function login_required(f) {
  return wraps(f, function wrapper(...args) {
    if (!('user_id' in session)) return loginRedirect();
    return f(...args);
  });
}

function admin_required(f) {
  return wraps(f, function wrapper(...args) {
    if (!('user_id' in session)) return loginRedirect();
    if (session.role !== 'admin') {
      flash('Only an admin can perform this action.', 'error');
      return redirect(url_for('dashboard'));
    }
    return f(...args);
  });
}

module.exports = { PERMISSION_MODULES, PERMISSION_KEYS, has_permission, permission_required, login_required, admin_required };
