'use strict';
const { Blueprint, request, session, redirect, url_for, flash, pyInt, pyFloat } = require('../lib/core');
const { get_db } = require('../db');
const { login_required } = require('../auth');

const bp = new Blueprint('returns');

const STOCK_TABLES = { frame: 'frames', lens: 'lenses', contact_lens: 'contact_lenses' };

bp.route('/orders/<int:order_id>/items/<int:item_id>/return', ['POST'], login_required(function create_return({ order_id, item_id }) {
  const db = get_db();
  const f = request.form;
  const order_item = db.execute('SELECT * FROM order_items WHERE id=? AND order_id=?', [item_id, order_id]).fetchone();
  if (!order_item) {
    flash('Order item not found.', 'error');
    return redirect(url_for('orders.detail', { order_id }));
  }

  const already_returned = db.execute('SELECT COALESCE(SUM(qty),0) q FROM returns WHERE order_item_id=?', [item_id]).fetchone().q;
  const remaining_qty = order_item.qty - already_returned;

  const return_type = f.get('return_type', 'Return');
  const reason = f.get('reason', '').trim();
  let qty; try { qty = pyInt(f.get('qty') || 1); } catch (_) { qty = 1; }
  let refund_amount; try { refund_amount = pyFloat(f.get('refund_amount') || 0); } catch (_) { refund_amount = 0; }

  if (qty < 1 || qty > remaining_qty) {
    flash(`Invalid quantity. Only ${remaining_qty} item(s) available for return/exchange.`, 'error');
    return redirect(url_for('orders.detail', { order_id }));
  }

  const exchange_item_type = f.get('exchange_item_type', '').trim();
  const exchange_item_ref = f.get('exchange_item_ref', '').trim();
  const exchange_description = f.get('exchange_description', '').trim();
  let exchange_price; try { exchange_price = pyFloat(f.get('exchange_price') || 0); } catch (_) { exchange_price = 0; }

  // Restock the original item back into inventory
  const table = STOCK_TABLES[order_item.item_type];
  if (table && order_item.item_id) {
    db.execute(`UPDATE ${table} SET stock_qty = stock_qty + ? WHERE id=?`, [qty, order_item.item_id]);
  }

  let exchange_item_id = null;
  if (return_type === 'Exchange' && exchange_item_type) {
    const ex_table = STOCK_TABLES[exchange_item_type];
    if (exchange_item_ref) {
      exchange_item_id = pyInt(exchange_item_ref);
      if (ex_table) {
        const row = db.execute(`SELECT stock_qty FROM ${ex_table} WHERE id=?`, [exchange_item_id]).fetchone();
        if (row && row.stock_qty < qty) {
          flash('Not enough stock for the item selected for exchange.', 'error');
          return redirect(url_for('orders.detail', { order_id }));
        }
        db.execute(`UPDATE ${ex_table} SET stock_qty = stock_qty - ? WHERE id=?`, [qty, exchange_item_id]);
      }
    }
  }

  db.execute(`INSERT INTO returns
           (order_id, order_item_id, item_type, item_id, qty, return_type, reason, refund_amount,
            exchange_description, exchange_item_type, exchange_item_id, exchange_price, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    order_id, item_id, order_item.item_type, order_item.item_id, qty, return_type, reason,
    refund_amount, exchange_description, exchange_item_type || null, exchange_item_id, exchange_price,
    session.get('full_name'),
  ]);
  db.commit();
  flash(`${return_type} recorded and stock updated.`, 'success');
  return redirect(url_for('orders.detail', { order_id }));
}));

module.exports = { bp };
