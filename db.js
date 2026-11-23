'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./lib/db');
const core = require('./lib/core');
const { generate_password_hash } = core;

const BASE_DIR = __dirname;
// Local: data/oms.db. On Vercel / MongoDB mode: a working copy in the temp
// folder, kept saved in MongoDB Atlas by lib/mongosync.js.
const storage = require('./lib/storage');
const { DB_PATH, DATA_DIR } = storage;
const SCHEMA_PATH = path.join(BASE_DIR, 'schema.sql');

/** Per-request connection (Flask: g.db), closed - and rolled back if
 *  uncommitted - when the response finishes. */
function get_db() {
  const c = core.current();
  if (!c.g.db) {
    c.g.db = connect(DB_PATH);
    c.g.db.execute('PRAGMA foreign_keys = ON');
  }
  return c.g.db;
}

function close_db(ctx) {
  const db = ctx && ctx.g && ctx.g.db;
  if (db) {
    delete ctx.g.db;
    db.close();
  }
}

const DEFAULT_PAGE_SIZE = 20;

/** Shared server-side pagination helper - see the Python original for the
 *  full contract. Returns [total, total_pages, page, offset]. */
function paginate(db, count_sql, count_params, page_arg, per_page = DEFAULT_PAGE_SIZE) {
  const total = db.execute(count_sql, count_params).scalar() || 0;
  const total_pages = Math.max(1, Math.floor((total + per_page - 1) / per_page));
  let page = parseInt(String(page_arg ?? '').trim(), 10);
  if (!/^\s*[+-]?\d+\s*$/.test(String(page_arg ?? '')) || Number.isNaN(page)) page = 1;
  page = Math.max(1, page);
  page = Math.min(page, total_pages);
  const offset = (page - 1) * per_page;
  return [total, total_pages, page, offset];
}

function withConn(fn) {
  const conn = connect(DB_PATH);
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

function _table_has_column(conn, table, column) {
  const cols = conn.execute(`PRAGMA table_info(${table})`).fetchall().map((r) => r.name);
  return cols.includes(column);
}

function _table_exists(conn, table) {
  return conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]).fetchone() !== null;
}

function init_db() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const fresh = !fs.existsSync(DB_PATH);
  withConn((conn) => {
    conn.executescript(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    conn.commit();
  });
  if (fresh) seed_admin();
  ensure_default_settings();
  ensure_branch_columns();
  ensure_default_branch();
  ensure_po_columns();
  ensure_prescription_columns();
  ensure_permissions_column();
  ensure_online_store_columns();
  ensure_online_store_settings();
  ensure_legacy_logo_setting();
  ensure_frame_taxonomy();
  ensure_homepage_banners();
  ensure_product_images();
  ensure_purchase_requests_table();
  ensure_po_supplier_optional();
  ensure_purchase_requests_merged_into_orders();
  ensure_frame_extra_fields();
  ensure_coupons_tables();
  ensure_reviews_tables();
  ensure_side_posters();
  ensure_gender_filtering();
  ensure_product_groups();
  ensure_membership_tables();
  ensure_points_tables();
  ensure_activity_notifications_table();
  ensure_brand_showcase_columns();
  ensure_category_showcase_columns();
  ensure_product_flags();
  ensure_promotions_table();
  ensure_trust_and_services_tables();
  ensure_seo_fields();
  ensure_wishlist_table();
}

function ensure_activity_notifications_table() {
  withConn((conn) => {
    conn.execute(`CREATE TABLE IF NOT EXISTS activity_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,             -- order_placed | delivery_due | review_submitted | membership_requested
            title TEXT NOT NULL,
            message TEXT,
            link_url TEXT,
            branch_id INTEGER REFERENCES branches(id),  -- NULL = visible to every branch (storefront-wide events)
            related_type TEXT,              -- 'order' | 'review' | 'membership', for de-duplication
            related_id INTEGER,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
    conn.execute('CREATE INDEX IF NOT EXISTS idx_activity_notifications_unread ON activity_notifications (is_read, created_at)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_activity_notifications_branch ON activity_notifications (branch_id)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_activity_notifications_related ON activity_notifications (type, related_type, related_id)');
    conn.commit();
  });
}

function ensure_branch_columns() {
  withConn((conn) => {
    for (const t of ['users', 'frames', 'lenses', 'contact_lenses', 'orders', 'purchase_orders']) {
      if (!_table_has_column(conn, t, 'branch_id')) {
        conn.execute(`ALTER TABLE ${t} ADD COLUMN branch_id INTEGER REFERENCES branches(id)`);
      }
    }
    conn.commit();
  });
}

function ensure_default_branch() {
  withConn((conn) => {
    const count = conn.execute('SELECT COUNT(*) c FROM branches').fetchone().c;
    if (count === 0) {
      const cur = conn.execute("INSERT INTO branches (name) VALUES ('Main Branch')");
      const branch_id = cur.lastrowid;
      for (const t of ['frames', 'lenses', 'contact_lenses', 'orders', 'purchase_orders']) {
        conn.execute(`UPDATE ${t} SET branch_id = ? WHERE branch_id IS NULL`, [branch_id]);
      }
      conn.execute("UPDATE users SET branch_id = ? WHERE branch_id IS NULL AND role != 'admin'", [branch_id]);
      conn.commit();
    }
  });
}

function addCols(conn, table, cols) {
  for (const [col, ddl] of cols) {
    if (!_table_has_column(conn, table, col)) conn.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

function ensure_po_columns() {
  withConn((conn) => {
    addCols(conn, 'purchase_orders', [
      ['payment_status', "TEXT NOT NULL DEFAULT 'Due'"],
      ['amount_paid', 'REAL NOT NULL DEFAULT 0'],
      ['payment_mode', 'TEXT'],
      ['supplier_invoice_no', 'TEXT'],
      ['expected_delivery_date', 'TEXT'],
      ['purchase_type', "TEXT NOT NULL DEFAULT 'frame'"],
    ]);
    if (!_table_has_column(conn, 'purchase_order_items', 'received_qty')) {
      conn.execute('ALTER TABLE purchase_order_items ADD COLUMN received_qty INTEGER NOT NULL DEFAULT 0');
      conn.execute(`UPDATE purchase_order_items SET received_qty = qty
               WHERE po_id IN (SELECT id FROM purchase_orders WHERE status = 'Received')`);
    }
    if (!_table_has_column(conn, 'purchase_order_items', 'prescription_id')) {
      conn.execute('ALTER TABLE purchase_order_items ADD COLUMN prescription_id INTEGER REFERENCES prescriptions(id)');
    }
    conn.commit();
  });
}

function ensure_prescription_columns() {
  withConn((conn) => {
    addCols(conn, 'prescriptions', [['rx_number', 'TEXT']]);
    conn.commit();
  });
}

function ensure_permissions_column() {
  withConn((conn) => {
    addCols(conn, 'users', [['permissions', "TEXT NOT NULL DEFAULT ''"]]);
    conn.commit();
  });
}

function ensure_online_store_columns() {
  withConn((conn) => {
    addCols(conn, 'frames', [
      ['category', "TEXT NOT NULL DEFAULT 'Eyeglasses'"],
      ['online_visible', 'INTEGER NOT NULL DEFAULT 0'],
      ['image_path', 'TEXT'],
      ['online_description', 'TEXT'],
    ]);
    addCols(conn, 'contact_lenses', [
      ['online_visible', 'INTEGER NOT NULL DEFAULT 0'],
      ['image_path', 'TEXT'],
      ['online_description', 'TEXT'],
    ]);
    addCols(conn, 'orders', [
      ['source', "TEXT NOT NULL DEFAULT 'in_store'"],
      ['delivery_type', 'TEXT'],
      ['delivery_address', 'TEXT'],
      ['payment_method', 'TEXT'],
      ['online_payment_status', 'TEXT'],
      ['online_payment_ref', 'TEXT'],
    ]);
    conn.commit();
  });
}

function insertDefaults(conn, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    conn.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', [k, v]);
  }
}

function ensure_online_store_settings() {
  withConn((conn) => {
    insertDefaults(conn, {
      store_enabled: '1',
      store_tagline: 'Order glasses and contact lenses online now',
      store_delivery_charge: '0',
      store_default_branch_id: '',
      razorpay_key_id: '',
      razorpay_key_secret: '',
      online_order_prefix: 'WEB',
      store_banner_image: '',
      store_banner_link: '',
    });
    conn.commit();
  });
}

function ensure_legacy_logo_setting() {
  withConn((conn) => {
    const row = conn.execute("SELECT value FROM settings WHERE key='shop_logo_path'").fetchone();
    const cur = row ? row.value : '';
    if (!cur && fs.existsSync(path.join(BASE_DIR, 'static', 'img', 'logo.png'))) {
      conn.execute("INSERT INTO settings (key, value) VALUES ('shop_logo_path', 'img/logo.png') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      conn.commit();
    }
  });
}

const FRAME_TAXONOMIES = [
  ['brand_id', 'brands', 'Brand'],
  ['colour_id', 'colours', 'Colour'],
  ['size_id', 'sizes', 'Size'],
  ['category_id', 'categories', 'Category'],
  ['material_id', 'materials', 'Material'],
  ['frame_shape_id', 'frame_shapes', 'Frame Shape'],
  ['frame_type_id', 'frame_types', 'Frame Type'],
  ['gender_id', 'genders', 'Gender'],
];

const LEGACY_TEXT_MIRROR = {
  brand_id: ['brands', 'brand'],
  colour_id: ['colours', 'color'],
  size_id: ['sizes', 'size'],
  category_id: ['categories', 'category'],
};

function ensure_frame_taxonomy() {
  withConn((conn) => {
    for (const [, table] of FRAME_TAXONOMIES) {
      if (!_table_exists(conn, table)) {
        conn.execute(`CREATE TABLE ${table} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )`);
      }
      conn.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_name_nocase ON ${table} (name COLLATE NOCASE)`);
    }
    for (const [col] of FRAME_TAXONOMIES) {
      if (!_table_has_column(conn, 'frames', col)) conn.execute(`ALTER TABLE frames ADD COLUMN ${col} INTEGER`);
    }
    conn.commit();
    for (const name of ['Eyeglasses', 'Sunglasses']) {
      conn.execute('INSERT OR IGNORE INTO categories (name) VALUES (?)', [name]);
    }
    conn.commit();
    for (const [col, [table, legacy]] of Object.entries(LEGACY_TEXT_MIRROR)) {
      const values = conn.execute(
        `SELECT DISTINCT ${legacy} AS ${legacy} FROM frames WHERE ${legacy} IS NOT NULL AND TRIM(${legacy}) != ''`,
      ).fetchall().map((r) => r[legacy]);
      for (const v of values) conn.execute(`INSERT OR IGNORE INTO ${table} (name) VALUES (?)`, [String(v).trim()]);
      conn.commit();
      conn.execute(`UPDATE frames SET ${col} = (
                    SELECT id FROM ${table} WHERE ${table}.name = TRIM(frames.${legacy}) COLLATE NOCASE
                )
                WHERE ${col} IS NULL AND ${legacy} IS NOT NULL AND TRIM(${legacy}) != ''`);
      conn.commit();
    }
  });
}

const GENDER_VALUES = ['Men', 'Women', 'Kids', 'Unisex'];

function ensure_gender_filtering() {
  withConn((conn) => {
    const ids = {};
    for (const name of GENDER_VALUES) {
      conn.execute('INSERT OR IGNORE INTO genders (name) VALUES (?)', [name]);
      conn.commit();
      const row = conn.execute('SELECT id FROM genders WHERE name = ? COLLATE NOCASE', [name]).fetchone();
      if (row) ids[name] = row.id;
    }
    if (ids.Unisex !== undefined) {
      conn.execute('UPDATE frames SET gender_id=? WHERE gender_id IS NULL', [ids.Unisex]);
      conn.commit();
    }
    if (!_table_has_column(conn, 'contact_lenses', 'gender')) {
      conn.execute("ALTER TABLE contact_lenses ADD COLUMN gender TEXT NOT NULL DEFAULT 'Unisex'");
      conn.commit();
    }
    conn.execute('CREATE INDEX IF NOT EXISTS idx_frames_gender_id ON frames (gender_id)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_frames_category ON frames (category)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_frames_brand ON frames (brand)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_frames_stock_qty ON frames (stock_qty)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_contact_lenses_gender ON contact_lenses (gender)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_contact_lenses_brand ON contact_lenses (brand)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_contact_lenses_stock_qty ON contact_lenses (stock_qty)');
    conn.commit();
  });
}

function ensure_product_groups() {
  withConn((conn) => {
    if (!_table_exists(conn, 'product_groups')) {
      conn.execute(`CREATE TABLE product_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                brand_id INTEGER REFERENCES brands(id),
                category_id INTEGER REFERENCES categories(id),
                gender_id INTEGER REFERENCES genders(id),
                size_id INTEGER REFERENCES sizes(id),
                description TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.commit();
    }
    addCols(conn, 'frames', [
      ['product_group_id', 'INTEGER REFERENCES product_groups(id)'],
      ['grouped_at', 'TEXT'],
    ]);
    conn.execute('CREATE INDEX IF NOT EXISTS idx_frames_product_group_id ON frames (product_group_id)');
    conn.execute('CREATE INDEX IF NOT EXISTS idx_product_groups_brand_id ON product_groups (brand_id)');
    conn.commit();
  });
}

function ensure_membership_tables() {
  withConn((conn) => {
    conn.execute(`CREATE TABLE IF NOT EXISTS membership_tiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            min_spend REAL NOT NULL DEFAULT 0,
            discount_percent REAL NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
    conn.commit();
    if (conn.execute('SELECT COUNT(*) FROM membership_tiers').scalar() === 0) {
      for (const t of [['Silver', 0, 0, 1], ['Gold', 10000, 5, 2], ['Platinum', 25000, 10, 3]]) {
        conn.execute('INSERT INTO membership_tiers (name, min_spend, discount_percent, sort_order) VALUES (?,?,?,?)', t);
      }
      conn.commit();
    }
    conn.execute(`CREATE TABLE IF NOT EXISTS membership_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            duration_days INTEGER NOT NULL DEFAULT 365,
            discount_percent REAL NOT NULL DEFAULT 0,
            benefits TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
    conn.commit();
    if (conn.execute('SELECT COUNT(*) FROM membership_plans').scalar() === 0) {
      conn.execute(`INSERT INTO membership_plans (name, price, duration_days, discount_percent, benefits)
               VALUES (?,?,?,?,?)`, ['Premium', 499, 365, 15,
        '15% off every order\nPriority eye checkup booking\nExtra warranty on frames\nEarly access to sale offers']);
      conn.commit();
    }
    if (!_table_exists(conn, 'customer_memberships')) {
      conn.execute(`CREATE TABLE customer_memberships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                plan_id INTEGER NOT NULL REFERENCES membership_plans(id),
                status TEXT NOT NULL DEFAULT 'requested', -- requested | active | cancelled
                started_at TEXT,
                expires_at TEXT,
                amount_paid REAL NOT NULL DEFAULT 0,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_customer_memberships_customer ON customer_memberships (customer_id)');
      conn.commit();
    }
    addCols(conn, 'orders', [
      ['membership_tier_id', 'INTEGER REFERENCES membership_tiers(id)'],
      ['membership_plan_id', 'INTEGER REFERENCES membership_plans(id)'],
      ['membership_discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ]);
    conn.commit();
  });
}

function ensure_points_tables() {
  withConn((conn) => {
    conn.execute(`CREATE TABLE IF NOT EXISTS points_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            order_id INTEGER REFERENCES orders(id),
            points REAL NOT NULL DEFAULT 0,
            reason TEXT NOT NULL, -- earned | redeemed
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
    conn.execute('CREATE INDEX IF NOT EXISTS idx_points_ledger_customer ON points_ledger (customer_id)');
    conn.commit();
    addCols(conn, 'orders', [
      ['points_earned', 'REAL NOT NULL DEFAULT 0'],
      ['points_redeemed', 'REAL NOT NULL DEFAULT 0'],
      ['points_discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ]);
    conn.commit();
  });
}

function taxonomy_table_for(kind) {
  const valid = new Set(FRAME_TAXONOMIES.map((t) => t[1]));
  return valid.has(kind) ? kind : null;
}

function ensure_homepage_banners() {
  withConn((conn) => {
    if (!_table_exists(conn, 'homepage_banners')) {
      conn.execute(`CREATE TABLE homepage_banners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                desktop_image_path TEXT NOT NULL,
                mobile_image_path TEXT,
                heading TEXT,
                subheading TEXT,
                button_text TEXT,
                button_url TEXT,
                overlay_enabled INTEGER NOT NULL DEFAULT 1,
                display_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                start_date TEXT,
                end_date TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.commit();
    }
  });
}

function ensure_side_posters() {
  withConn((conn) => {
    if (!_table_exists(conn, 'side_posters')) {
      conn.execute(`CREATE TABLE side_posters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                side TEXT NOT NULL UNIQUE,
                image_path TEXT,
                link_url TEXT,
                is_active INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute("INSERT INTO side_posters (side, is_active) VALUES ('left', 0)");
      conn.execute("INSERT INTO side_posters (side, is_active) VALUES ('right', 0)");
      conn.commit();
    }
  });
}

function ensure_product_images() {
  withConn((conn) => {
    if (!_table_exists(conn, 'product_images')) {
      conn.execute(`CREATE TABLE product_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_type TEXT NOT NULL,
                item_id INTEGER NOT NULL,
                image_path TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_primary INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_product_images_item ON product_images (item_type, item_id)');
      conn.commit();
    }
    for (const [itemType, table] of [['frame', 'frames'], ['contact_lens', 'contact_lenses']]) {
      const rows = conn.execute(
        `SELECT id, image_path FROM ${table} WHERE image_path IS NOT NULL AND TRIM(image_path) != ''`).fetchall();
      for (const row of rows) {
        const existing = conn.execute('SELECT id FROM product_images WHERE item_type=? AND item_id=?', [itemType, row.id]).fetchone();
        if (!existing) {
          conn.execute('INSERT INTO product_images (item_type, item_id, image_path, sort_order, is_primary) VALUES (?,?,?,0,1)',
            [itemType, row.id, row.image_path]);
        }
      }
      conn.commit();
    }
  });
}

function ensure_purchase_requests_table() {
  withConn((conn) => {
    if (!_table_exists(conn, 'purchase_requests')) {
      conn.execute(`CREATE TABLE purchase_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch_id INTEGER REFERENCES branches(id),
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
                item_type TEXT NOT NULL,
                item_id INTEGER,
                prescription_id INTEGER REFERENCES prescriptions(id),
                description TEXT NOT NULL,
                qty INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'Pending',
                po_id INTEGER REFERENCES purchase_orders(id),
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests (status)');
      conn.commit();
    }
  });
}

function ensure_po_supplier_optional() {
  withConn((conn) => {
    if (!_table_has_column(conn, 'purchase_orders', 'order_id')) {
      conn.execute('PRAGMA foreign_keys = OFF');
      conn.execute(`CREATE TABLE purchase_orders_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch_id INTEGER REFERENCES branches(id),
                po_number TEXT UNIQUE NOT NULL,
                supplier_id INTEGER REFERENCES suppliers(id),
                purchase_type TEXT NOT NULL DEFAULT 'frame',
                status TEXT NOT NULL DEFAULT 'Ordered',
                payment_status TEXT NOT NULL DEFAULT 'Due',
                amount_paid REAL NOT NULL DEFAULT 0,
                payment_mode TEXT,
                supplier_invoice_no TEXT,
                order_date TEXT NOT NULL DEFAULT (datetime('now')),
                expected_delivery_date TEXT,
                received_date TEXT,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                order_id INTEGER REFERENCES orders(id),
                order_item_id INTEGER REFERENCES order_items(id)
            )`);
      conn.execute(`INSERT INTO purchase_orders_new
               (id, branch_id, po_number, supplier_id, purchase_type, status, payment_status,
                amount_paid, payment_mode, supplier_invoice_no, order_date, expected_delivery_date,
                received_date, notes, created_at)
               SELECT id, branch_id, po_number, supplier_id, purchase_type, status, payment_status,
                      amount_paid, payment_mode, supplier_invoice_no, order_date, expected_delivery_date,
                      received_date, notes, created_at
               FROM purchase_orders`);
      conn.execute('DROP TABLE purchase_orders');
      conn.execute('ALTER TABLE purchase_orders_new RENAME TO purchase_orders');
      conn.execute('PRAGMA foreign_keys = ON');
      conn.commit();
    }
  });
}

function ensure_purchase_requests_merged_into_orders() {
  withConn((conn) => {
    if (conn.execute("SELECT value FROM settings WHERE key='pr_merged_into_po'").fetchone()) return;
    if (_table_exists(conn, 'purchase_requests')) {
      const prefixRow = conn.execute("SELECT value FROM settings WHERE key='po_prefix'").fetchone();
      const poPrefix = prefixRow && prefixRow.value ? prefixRow.value : 'PO';
      const prs = conn.execute('SELECT * FROM purchase_requests').fetchall();
      for (const pr of prs) {
        if (pr.status === 'Converted' && pr.po_id) {
          conn.execute('UPDATE purchase_orders SET order_id=?, order_item_id=? WHERE id=?', [pr.order_id, pr.order_item_id, pr.po_id]);
        } else if (pr.status === 'Pending' || pr.status === 'Cancelled') {
          const count = conn.execute('SELECT COUNT(*) c FROM purchase_orders').fetchone().c;
          const poNumber = `${poPrefix}-${String(count + 1).padStart(4, '0')}`;
          const cur = conn.execute(`INSERT INTO purchase_orders
                       (branch_id, po_number, supplier_id, purchase_type, status, order_id, order_item_id)
                       VALUES (?,?,NULL,?,?,?,?)`,
          [pr.branch_id, poNumber, pr.item_type, pr.status, pr.order_id, pr.order_item_id]);
          conn.execute(`INSERT INTO purchase_order_items
                       (po_id, item_type, item_id, prescription_id, description, qty)
                       VALUES (?,?,?,?,?,?)`,
          [cur.lastrowid, pr.item_type, pr.item_id, pr.prescription_id, pr.description, pr.qty]);
        }
      }
    }
    conn.execute("INSERT INTO settings (key, value) VALUES ('pr_merged_into_po', '1') " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    conn.commit();
  });
}

function ensure_frame_extra_fields() {
  withConn((conn) => {
    addCols(conn, 'frames', [
      ['model_name', 'TEXT'], ['sku', 'TEXT'], ['barcode', 'TEXT'], ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ]);
    addCols(conn, 'contact_lenses', [['is_active', 'INTEGER NOT NULL DEFAULT 1']]);
    conn.commit();
  });
}

function ensure_coupons_tables() {
  withConn((conn) => {
    if (!_table_exists(conn, 'coupons')) {
      conn.execute(`CREATE TABLE coupons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                discount_type TEXT NOT NULL DEFAULT 'percentage',
                discount_value REAL NOT NULL DEFAULT 0,
                min_order_value REAL NOT NULL DEFAULT 0,
                max_discount_amount REAL,
                start_date TEXT,
                expiry_date TEXT,
                usage_limit_total INTEGER,
                usage_limit_per_customer INTEGER,
                applicable_categories TEXT,
                applicable_brands TEXT,
                applicable_products TEXT,
                customer_eligibility TEXT NOT NULL DEFAULT 'all',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons (code)');
    }
    if (!_table_exists(conn, 'coupon_usages')) {
      conn.execute(`CREATE TABLE coupon_usages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                customer_id INTEGER REFERENCES customers(id),
                discount_amount REAL NOT NULL DEFAULT 0,
                used_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_coupon_usages_coupon ON coupon_usages (coupon_id)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_coupon_usages_customer ON coupon_usages (customer_id)');
    }
    addCols(conn, 'orders', [
      ['coupon_id', 'INTEGER REFERENCES coupons(id)'],
      ['coupon_code', 'TEXT'],
      ['discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ]);
    conn.commit();
  });
}

function ensure_reviews_tables() {
  withConn((conn) => {
    if (!_table_exists(conn, 'product_reviews')) {
      conn.execute(`CREATE TABLE product_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_type TEXT NOT NULL,
                item_id INTEGER NOT NULL,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                online_customer_id INTEGER REFERENCES online_customers(id) ON DELETE SET NULL,
                order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
                rating INTEGER NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                display_name TEXT,
                is_anonymous INTEGER NOT NULL DEFAULT 0,
                is_verified_purchase INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                is_featured INTEGER NOT NULL DEFAULT 0,
                helpful_count INTEGER NOT NULL DEFAULT 0,
                admin_reply TEXT,
                admin_reply_at TEXT,
                edited_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_product_reviews_unique ON product_reviews (item_type, item_id, customer_id)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_product_reviews_item ON product_reviews (item_type, item_id, status)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_product_reviews_status ON product_reviews (status)');
    }
    if (!_table_exists(conn, 'review_media')) {
      conn.execute(`CREATE TABLE review_media (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_id INTEGER NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
                media_type TEXT NOT NULL,
                file_path TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_review_media_review ON review_media (review_id)');
    }
    if (!_table_exists(conn, 'review_helpful_votes')) {
      conn.execute(`CREATE TABLE review_helpful_votes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                review_id INTEGER NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
                voter_key TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_review_votes_unique ON review_helpful_votes (review_id, voter_key)');
    }
    conn.commit();
    insertDefaults(conn, {
      google_review_url: '',
      google_review_popup_enabled: '1',
      review_auto_approve: '0',
      review_min_length: '10',
      review_allow_images: '1',
      review_allow_videos: '1',
      review_request_on_delivery: '0',
      review_edit_window_hours: '24',
      google_rating_value: '',
      google_rating_count_label: '',
    });
    conn.commit();
  });
}

function seed_admin() {
  withConn((conn) => {
    conn.execute('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)',
      ['admin', generate_password_hash('admin123'), 'Shop Admin', 'admin']);
    conn.commit();
  });
}

function ensure_default_settings() {
  withConn((conn) => {
    insertDefaults(conn, {
      shop_name: 'My Optical Shop',
      shop_address: 'Shop No. 1, Main Market',
      shop_phone: '9999999999',
      shop_logo_path: '',
      gst_percent: '12',
      invoice_prefix: 'INV',
      order_prefix: 'ORD',
      po_prefix: 'PO',
      currency_symbol: 'Rs.',
      notify_provider: 'none',
      notify_api_key: '',
      notify_sender_id: '',
      notify_webhook_url: '',
      notify_on_ready: '1',
      notify_on_delivered: '0',
      checkup_reminder_months: '12',
      points_earn_rate: '1',
      points_redeem_rate: '10',
    });
    conn.commit();
  });
}

function get_setting(key, dflt = null) {
  const row = get_db().execute('SELECT value FROM settings WHERE key = ?', [key]).fetchone();
  return row ? row.value : dflt;
}

function set_setting(key, value) {
  const db = get_db();
  db.execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  db.commit();
}

/** Generate a simple sequential number like ORD-0001 based on row count. */
function next_number(prefix, table) {
  const count = get_db().execute(`SELECT COUNT(*) c FROM ${table}`).fetchone().c;
  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
}

function ensure_brand_showcase_columns() {
  withConn((conn) => {
    addCols(conn, 'brands', [['logo_path', 'TEXT'], ['description', 'TEXT'], ['display_order', 'INTEGER NOT NULL DEFAULT 0']]);
    conn.commit();
  });
}

function ensure_category_showcase_columns() {
  withConn((conn) => {
    addCols(conn, 'categories', [['image_path', 'TEXT'], ['description', 'TEXT'], ['display_order', 'INTEGER NOT NULL DEFAULT 0']]);
    conn.commit();
  });
}

function ensure_product_flags() {
  withConn((conn) => {
    for (const table of ['frames', 'contact_lenses']) {
      addCols(conn, table, [
        ['is_best_seller', 'INTEGER NOT NULL DEFAULT 0'],
        ['is_new_arrival', 'INTEGER NOT NULL DEFAULT 0'],
        ['is_featured', 'INTEGER NOT NULL DEFAULT 0'],
      ]);
    }
    conn.commit();
  });
}

function ensure_promotions_table() {
  withConn((conn) => {
    if (!_table_exists(conn, 'promotions')) {
      conn.execute(`CREATE TABLE promotions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                image_path TEXT,
                button_text TEXT,
                button_url TEXT,
                display_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.commit();
    }
  });
}

function ensure_trust_and_services_tables() {
  withConn((conn) => {
    if (!_table_exists(conn, 'trust_items')) {
      conn.execute(`CREATE TABLE trust_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                icon TEXT,
                title TEXT NOT NULL,
                text TEXT,
                display_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.commit();
    }
    if (!_table_exists(conn, 'store_services')) {
      conn.execute(`CREATE TABLE store_services (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                icon TEXT,
                title TEXT NOT NULL,
                description TEXT,
                display_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.commit();
    }
  });
}

function ensure_seo_fields() {
  withConn((conn) => {
    for (const table of ['frames', 'contact_lenses', 'categories']) {
      addCols(conn, table, [['meta_title', 'TEXT'], ['meta_description', 'TEXT'], ['slug', 'TEXT']]);
    }
    conn.commit();
  });
}

function ensure_wishlist_table() {
  withConn((conn) => {
    if (!_table_exists(conn, 'wishlist_items')) {
      conn.execute(`CREATE TABLE wishlist_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                item_type TEXT NOT NULL,
                item_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`);
      conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_items_unique ON wishlist_items (customer_id, item_type, item_id)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_wishlist_items_customer ON wishlist_items (customer_id)');
    }
    conn.commit();
  });
}

module.exports = {
  BASE_DIR, DB_PATH, DATA_DIR, SCHEMA_PATH, DEFAULT_PAGE_SIZE, FRAME_TAXONOMIES, LEGACY_TEXT_MIRROR, GENDER_VALUES,
  get_db, close_db, paginate, init_db, get_setting, set_setting, next_number, taxonomy_table_for,
  _table_has_column, _table_exists,
};
