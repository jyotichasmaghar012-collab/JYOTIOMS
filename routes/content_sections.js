'use strict';
/**
 * Admin CRUD for two small homepage content sections (Website Management >
 * Trust & Benefits / Optical Services): `trust_items` and `store_services`.
 * Both are simple icon+title+text rows with no image upload.
 */
const { Blueprint, request, redirect, url_for, flash } = require('../lib/core');
const { render_template } = require('../lib/render');
const { get_db } = require('../db');
const { admin_required } = require('../auth');

const bp = new Blueprint('content_sections', { url_prefix: '/website' });

function _next_display_order(db, table) {
  return db.execute(`SELECT COALESCE(MAX(display_order), -1) AS m FROM ${table}`).fetchone().m + 1;
}

/** Registers list/new/edit/toggle/delete for one simple content table. */
function registerSection({ prefix, table, textField, template, nounAdded, nounUpdated, nounDeleted, ep }) {
  const indexEp = `content_sections.${ep}_index`;

  bp.route(`/${prefix}/`, admin_required(function index() {
    const items = get_db().execute(`SELECT * FROM ${table} ORDER BY display_order, id`).fetchall();
    return render_template(template, { items });
  }), { endpoint: `${ep}_index` });

  bp.route(`/${prefix}/new`, ['POST'], admin_required(function create() {
    const db = get_db();
    const icon = request.form.get('icon', '').trim();
    const title = request.form.get('title', '').trim();
    const text = request.form.get(textField, '').trim();
    if (!title) {
      flash('Title is required.', 'error');
      return redirect(url_for(indexEp));
    }
    db.execute(`INSERT INTO ${table} (icon, title, ${textField}, display_order, is_active) VALUES (?,?,?,?,1)`,
      [icon, title, text, _next_display_order(db, table)]);
    db.commit();
    flash(nounAdded, 'success');
    return redirect(url_for(indexEp));
  }), { endpoint: `${ep}_new` });

  bp.route(`/${prefix}/<int:item_id>/edit`, ['POST'], admin_required(function edit({ item_id }) {
    const db = get_db();
    const icon = request.form.get('icon', '').trim();
    const title = request.form.get('title', '').trim();
    const text = request.form.get(textField, '').trim();
    if (!title) {
      flash('Title is required.', 'error');
      return redirect(url_for(indexEp));
    }
    db.execute(`UPDATE ${table} SET icon=?, title=?, ${textField}=? WHERE id=?`, [icon, title, text, item_id]);
    db.commit();
    flash(nounUpdated, 'success');
    return redirect(url_for(indexEp));
  }), { endpoint: `${ep}_edit` });

  bp.route(`/${prefix}/<int:item_id>/toggle`, ['POST'], admin_required(function toggle({ item_id }) {
    const db = get_db();
    const row = db.execute(`SELECT is_active FROM ${table} WHERE id=?`, [item_id]).fetchone();
    if (row) {
      db.execute(`UPDATE ${table} SET is_active=? WHERE id=?`, [row.is_active ? 0 : 1, item_id]);
      db.commit();
    }
    return redirect(url_for(indexEp));
  }), { endpoint: `${ep}_toggle` });

  bp.route(`/${prefix}/<int:item_id>/delete`, ['POST'], admin_required(function remove({ item_id }) {
    const db = get_db();
    db.execute(`DELETE FROM ${table} WHERE id=?`, [item_id]);
    db.commit();
    flash(nounDeleted, 'success');
    return redirect(url_for(indexEp));
  }), { endpoint: `${ep}_delete` });
}

registerSection({
  prefix: 'trust-items', table: 'trust_items', textField: 'text', template: 'website/trust_items.html',
  nounAdded: 'Trust item added.', nounUpdated: 'Trust item updated.', nounDeleted: 'Trust item deleted.', ep: 'trust_items',
});
registerSection({
  prefix: 'services', table: 'store_services', textField: 'description', template: 'website/services.html',
  nounAdded: 'Service added.', nounUpdated: 'Service updated.', nounDeleted: 'Service deleted.', ep: 'services',
});

module.exports = { bp };
