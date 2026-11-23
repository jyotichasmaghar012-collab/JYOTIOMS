'use strict';
/**
 * SQLite access layer - a thin wrapper around Node's built-in `node:sqlite`
 * that mimics the Python sqlite3 API the original app was written against:
 *
 *   db.execute(sql, params).fetchone() / .fetchall() / .lastrowid / .rowcount
 *   db.commit() / db.rollback()
 *
 * Transaction semantics also match Python's sqlite3 module defaults: a
 * BEGIN is issued lazily before the first INSERT/UPDATE/DELETE/REPLACE, and
 * nothing is persisted until commit(). A request that ends (or throws)
 * without committing is rolled back when its connection is closed - exactly
 * what happened in the Flask app when g.db was closed at teardown.
 */
const { DatabaseSync } = require('node:sqlite');

const DML_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

function normParam(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function toPlain(row) {
  // node:sqlite returns null-prototype objects - convert so templates/JSON/
  // spread all behave like ordinary objects (the Python code used dict(row)).
  return row ? Object.assign({}, row) : row;
}

class Cursor {
  constructor(rows, lastrowid, rowcount) {
    this.rows = rows;
    this.lastrowid = lastrowid;
    this.rowcount = rowcount;
    this._i = 0;
  }
  fetchone() {
    if (!this.rows || this._i >= this.rows.length) return null;
    return this.rows[this._i++];
  }
  fetchall() {
    if (!this.rows) return [];
    const out = this.rows.slice(this._i);
    this._i = this.rows.length;
    return out;
  }
  /** First column of the first row (Python: fetchone()[0]). */
  scalar() {
    const r = this.fetchone();
    if (!r) return null;
    const k = Object.keys(r)[0];
    return r[k];
  }
  [Symbol.iterator]() {
    return this.fetchall()[Symbol.iterator]();
  }
}

class Connection {
  constructor(path) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.inTx = false;
    this._stmts = new Map();
  }

  _prepare(sql) {
    let st = this._stmts.get(sql);
    if (!st) {
      st = this.raw.prepare(sql);
      this._stmts.set(sql, st);
    }
    return st;
  }

  execute(sql, params) {
    if (DML_RE.test(sql) && !this.inTx) {
      this.raw.exec('BEGIN');
      this.inTx = true;
    }
    const st = this._prepare(sql);
    let args;
    if (params == null) args = [];
    else if (Array.isArray(params)) args = params.map(normParam);
    else if (typeof params === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(params)) o[k] = normParam(v);
      args = [o];
    } else args = [normParam(params)];

    if (st.columns().length > 0) {
      const rows = st.all(...args).map(toPlain);
      return new Cursor(rows, null, -1);
    }
    const r = st.run(...args);
    return new Cursor([], Number(r.lastInsertRowid), Number(r.changes));
  }

  executemany(sql, seq) {
    let total = 0;
    for (const p of seq) total += this.execute(sql, p).rowcount;
    return new Cursor([], null, total);
  }

  executescript(script) {
    this.commit();
    this.raw.exec(script);
  }

  commit() {
    if (this.inTx) {
      this.raw.exec('COMMIT');
      this.inTx = false;
    }
  }

  rollback() {
    if (this.inTx) {
      try { this.raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      this.inTx = false;
    }
  }

  close() {
    this.rollback();
    this._stmts.clear();
    try { this.raw.close(); } catch (_) { /* ignore */ }
  }
}

function connect(path) {
  return new Connection(path);
}

/** Convert a SQLite constraint error into something callers can test for,
 *  mirroring `except sqlite3.IntegrityError`. */
function isIntegrityError(e) {
  return !!e && e.code === 'ERR_SQLITE_ERROR' && ((e.errcode & 0xff) === 19 || /constraint/i.test(String(e.errstr || e.message || '')));
}

module.exports = { connect, Connection, Cursor, isIntegrityError };
