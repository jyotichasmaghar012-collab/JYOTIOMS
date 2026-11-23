-- Optical Shop OMS Database Schema

-- ===== Branches (multi-branch support) =====
CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff', -- admin | staff
    active INTEGER NOT NULL DEFAULT 1,
    branch_id INTEGER REFERENCES branches(id), -- NULL for admin = sees all branches
    permissions TEXT NOT NULL DEFAULT '', -- comma-separated module keys staff can access (admin ignores this, always full access)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prescriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    od_sph TEXT, od_cyl TEXT, od_axis TEXT,   -- right eye (OD)
    os_sph TEXT, os_cyl TEXT, os_axis TEXT,   -- left eye (OS)
    add_power TEXT,
    pd TEXT,
    rx_number TEXT, -- optional eye-test/prescription reference number (from the eye-test slip)
    prescribed_by TEXT,
    prescribed_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Frame attribute taxonomies =====
-- Master lists behind the Frame form's dropdowns (Inventory > Attributes in
-- the admin UI). Each is a simple named list with a case-insensitive unique
-- name and a soft "is_active" flag (deactivating hides it from new-frame
-- dropdowns without breaking frames that already reference it).
CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_name_nocase ON brands (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS colours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_colours_name_nocase ON colours (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sizes_name_nocase ON sizes (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_name_nocase ON materials (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS frame_shapes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_frame_shapes_name_nocase ON frame_shapes (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS frame_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_frame_types_name_nocase ON frame_types (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_nocase ON categories (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS genders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_genders_name_nocase ON genders (name COLLATE NOCASE);

-- Product Variants (Phase 2): a product_groups row is the "parent" product
-- (shared display fields only - price/stock/color deliberately stay on each
-- variant frame row, per the shop owner's choice to keep pricing
-- independent per color). Grouping frames into one is manual/opt-in via the
-- admin Product Groups screen; a frame with no product_group_id is a
-- standalone product, unaffected by this table's existence.
CREATE TABLE IF NOT EXISTS product_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brand_id INTEGER REFERENCES brands(id),
    category_id INTEGER REFERENCES categories(id),
    gender_id INTEGER REFERENCES genders(id),
    size_id INTEGER REFERENCES sizes(id),
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    brand TEXT NOT NULL,
    model TEXT,
    color TEXT,
    size TEXT,
    cost_price REAL DEFAULT 0,
    selling_price REAL NOT NULL DEFAULT 0,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 2,
    category TEXT NOT NULL DEFAULT 'Eyeglasses', -- Eyeglasses | Sunglasses
    online_visible INTEGER NOT NULL DEFAULT 0,   -- shown on the public online store?
    image_path TEXT,                             -- static/uploads/products/... relative path
    online_description TEXT,
    brand_id INTEGER REFERENCES brands(id),
    colour_id INTEGER REFERENCES colours(id),
    size_id INTEGER REFERENCES sizes(id),
    category_id INTEGER REFERENCES categories(id),
    material_id INTEGER REFERENCES materials(id),
    frame_shape_id INTEGER REFERENCES frame_shapes(id),
    frame_type_id INTEGER REFERENCES frame_types(id),
    gender_id INTEGER REFERENCES genders(id),
    model_name TEXT,                             -- Model Name, distinct from the "model" (Frame ID) column
    sku TEXT,
    barcode TEXT,                                 -- optional custom barcode; falls back to auto-generated FRM###### if blank
    is_active INTEGER NOT NULL DEFAULT 1,
    product_group_id INTEGER REFERENCES product_groups(id), -- NULL = standalone product (default); set = this frame is a color variant of that parent
    grouped_at TEXT,                             -- when attached to its group; first-attached variant supplies the group's card photo
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    lens_type TEXT NOT NULL,   -- Single Vision, Bifocal, Progressive, etc.
    material TEXT,
    brand TEXT,
    selling_price REAL NOT NULL DEFAULT 0,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_lenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    brand TEXT NOT NULL,
    lens_type TEXT,
    power TEXT,
    selling_price REAL NOT NULL DEFAULT 0,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 2,
    online_visible INTEGER NOT NULL DEFAULT 0,   -- shown on the public online store?
    image_path TEXT,
    online_description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    order_no TEXT UNIQUE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    prescription_id INTEGER REFERENCES prescriptions(id),
    status TEXT NOT NULL DEFAULT 'Order Placed', -- Order Placed, Lens Fitting, Ready for Pickup, Delivered, Cancelled
    order_date TEXT NOT NULL DEFAULT (datetime('now')),
    expected_delivery_date TEXT,
    delivered_date TEXT,
    notes TEXT,
    created_by TEXT,
    source TEXT NOT NULL DEFAULT 'in_store',   -- in_store | online
    delivery_type TEXT,                         -- pickup | delivery (online orders only)
    delivery_address TEXT,
    payment_method TEXT,                        -- cod | online (online orders only)
    online_payment_status TEXT,                 -- pending | paid | failed (online payment_method only)
    online_payment_ref TEXT,                     -- razorpay payment id, once paid
    coupon_id INTEGER REFERENCES coupons(id),
    coupon_code TEXT,                            -- denormalized so the code still shows even if the coupon is later deleted
    discount_amount REAL NOT NULL DEFAULT 0,
    membership_tier_id INTEGER REFERENCES membership_tiers(id),   -- tier the membership discount (if any) was resolved from
    membership_plan_id INTEGER REFERENCES membership_plans(id),   -- set instead of tier when an active paid plan gave the bigger discount
    membership_discount_amount REAL NOT NULL DEFAULT 0,
    points_earned REAL NOT NULL DEFAULT 0,        -- loyalty points credited from this order (active Premium members only)
    points_redeemed REAL NOT NULL DEFAULT 0,       -- loyalty points spent on this order (from balance earned on PRIOR orders)
    points_discount_amount REAL NOT NULL DEFAULT 0, -- Rs. discount that points_redeemed converted to
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,  -- frame | lens | contact_lens | other
    item_id INTEGER,
    description TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    total_price REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT UNIQUE NOT NULL,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    gst_percent REAL NOT NULL DEFAULT 0,
    gst_amount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'Due', -- Paid | Partial | Due
    amount_paid REAL NOT NULL DEFAULT 0,
    payment_mode TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- ===== Suppliers / Purchase Orders =====
CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    po_number TEXT UNIQUE NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    purchase_type TEXT NOT NULL DEFAULT 'frame', -- frame | lens | contact_lens
    status TEXT NOT NULL DEFAULT 'Ordered', -- Ordered | Partially Received | Received | Cancelled
    payment_status TEXT NOT NULL DEFAULT 'Due', -- Due | Partial | Paid
    amount_paid REAL NOT NULL DEFAULT 0,
    payment_mode TEXT,
    supplier_invoice_no TEXT,
    order_date TEXT NOT NULL DEFAULT (datetime('now')),
    expected_delivery_date TEXT,
    received_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL, -- frame | lens | contact_lens
    item_id INTEGER,
    prescription_id INTEGER REFERENCES prescriptions(id), -- for lens / contact_lens orders placed against a customer prescription
    description TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    received_qty INTEGER NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0
);

-- ===== Returns / Exchanges =====
CREATE TABLE IF NOT EXISTS returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    order_item_id INTEGER NOT NULL REFERENCES order_items(id),
    item_type TEXT NOT NULL,
    item_id INTEGER,
    qty INTEGER NOT NULL DEFAULT 1,
    return_type TEXT NOT NULL DEFAULT 'Return', -- Return | Exchange
    reason TEXT,
    refund_amount REAL NOT NULL DEFAULT 0,
    exchange_description TEXT,
    exchange_item_type TEXT,
    exchange_item_id INTEGER,
    exchange_price REAL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Notifications Log =====
CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    order_id INTEGER REFERENCES orders(id),
    channel TEXT NOT NULL,   -- sms | whatsapp
    phone TEXT,
    message TEXT,
    status TEXT NOT NULL,    -- sent | failed | skipped_not_configured
    response_info TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Prescribers (Doctor / Optometrist names, reused across prescription forms) =====
CREATE TABLE IF NOT EXISTS prescribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Online Store: customer accounts (separate login from staff `users`) =====
-- Links to the same `customers` table used everywhere else in the OMS, so an
-- online order shows up against the exact same customer record staff already
-- see in Customers/Orders - there's no separate "web customer" silo.
CREATE TABLE IF NOT EXISTS online_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Homepage Banner Slider (Website Management > Homepage Banners) =====
-- Each row is one slide in the storefront homepage's Swiper carousel. Fully
-- admin-managed - if this table has no active/in-date rows, the storefront
-- falls back to the original static hero (shop name + tagline + Start
-- Shopping button), so an un-configured shop looks exactly like it did
-- before this feature existed.
CREATE TABLE IF NOT EXISTS homepage_banners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,                  -- admin-facing label only, never shown to customers
    desktop_image_path TEXT NOT NULL,      -- static/uploads/banners/... relative path
    mobile_image_path TEXT,                -- optional - falls back to desktop image if blank
    heading TEXT,
    subheading TEXT,
    button_text TEXT,
    button_url TEXT,
    overlay_enabled INTEGER NOT NULL DEFAULT 1,  -- dark gradient overlay behind heading/subheading/button text
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    start_date TEXT,                       -- optional YYYY-MM-DD - hidden before this date
    end_date TEXT,                         -- optional YYYY-MM-DD - hidden after this date
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Product Image Gallery (Amazon-style multi-image product pages) =====
-- One row per gallery image for a frame or contact lens. The existing
-- frames.image_path / contact_lenses.image_path column is kept in sync with
-- whichever row here has is_primary=1, so all pre-existing code that reads
-- that single column (listing-card "Featured Image", barcodes, CSV/reports)
-- keeps working unchanged - this table is purely additive.
CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,               -- frame | contact_lens
    item_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_images_item ON product_images (item_type, item_id);

-- ===== Online Store: visitor analytics =====
-- One row per storefront pageview so the shop owner can see how much traffic
-- the online store is getting (total visits, unique visitors, popular pages)
-- without needing a third-party analytics service.
CREATE TABLE IF NOT EXISTS site_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    online_customer_id INTEGER REFERENCES online_customers(id),
    visited_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== Website Management: Coupons & Discounts =====
CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,                     -- e.g. WELCOME100, stored/matched case-insensitively
    name TEXT NOT NULL,
    description TEXT,
    discount_type TEXT NOT NULL DEFAULT 'percentage', -- percentage | fixed
    discount_value REAL NOT NULL DEFAULT 0,
    min_order_value REAL NOT NULL DEFAULT 0,
    max_discount_amount REAL,                      -- optional cap, only meaningful for discount_type=percentage
    start_date TEXT,                                -- YYYY-MM-DD, NULL = no start restriction
    expiry_date TEXT,                               -- YYYY-MM-DD, NULL = no expiry
    usage_limit_total INTEGER,                      -- NULL = unlimited
    usage_limit_per_customer INTEGER,                -- NULL = unlimited
    applicable_categories TEXT,                     -- comma-separated categories.id (frames only); blank = all categories
    applicable_brands TEXT,                         -- comma-separated brands.id (frames only); blank = all brands
    applicable_products TEXT,                       -- comma-separated "frame:<id>" / "contact_lens:<id>" tokens; blank = all products
    customer_eligibility TEXT NOT NULL DEFAULT 'all', -- all | new_customers
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons (code);

CREATE TABLE IF NOT EXISTS coupon_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id),
    discount_amount REAL NOT NULL DEFAULT 0,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupon_usages_coupon ON coupon_usages (coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_usages_customer ON coupon_usages (customer_id);

-- ===== Membership Program (Website Management > Memberships) =====
-- Free auto-tiers resolved off a customer's lifetime spend, plus optional
-- paid plans (e.g. "Premium") a customer buys/is granted for a fixed
-- duration. Both are fully admin-editable - see db.py's
-- ensure_membership_tables() for the recommended starting defaults
-- (Silver/Gold/Platinum, and a Premium plan) that a fresh install seeds.
CREATE TABLE IF NOT EXISTS membership_tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    min_spend REAL NOT NULL DEFAULT 0,           -- lifetime spend (non-cancelled orders) needed to reach this tier
    discount_percent REAL NOT NULL DEFAULT 0,     -- applied automatically at checkout once reached
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS membership_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    duration_days INTEGER NOT NULL DEFAULT 365,
    discount_percent REAL NOT NULL DEFAULT 0,
    benefits TEXT,                                -- free-text, one perk per line, shown to customers
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES membership_plans(id),
    status TEXT NOT NULL DEFAULT 'requested',      -- requested | active | cancelled
    started_at TEXT,
    expires_at TEXT,
    amount_paid REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_memberships_customer ON customer_memberships (customer_id);

-- Points/Loyalty Program: row-per-event ledger (not a single running-balance
-- column) so a customer's balance is always auditable as SUM(points) - see
-- db.py's ensure_points_tables() for the full design notes. Only active
-- Premium members earn points; redemption doesn't require currently-active
-- Premium status. Rates (points per Rs.1 earned / points per Rs.1 redeemed)
-- are admin-editable settings (points_earn_rate/points_redeem_rate), not
-- columns here.
CREATE TABLE IF NOT EXISTS points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    order_id INTEGER REFERENCES orders(id),
    points REAL NOT NULL DEFAULT 0,               -- positive for 'earned' rows, negative for 'redeemed' rows
    reason TEXT NOT NULL,                          -- earned | redeemed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_points_ledger_customer ON points_ledger (customer_id);

-- In-app Activity Notifications ("Notifications" sidebar tab, routes/alerts.py)
-- - an inbound, in-app feed for staff (new order, delivery due, review
-- submitted, membership requested). Separate from `notifications_log`
-- (outbound SMS-to-customers history, routes/notifications.py) - see
-- db.py's ensure_activity_notifications_table() for full design notes.
CREATE TABLE IF NOT EXISTS activity_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    link_url TEXT,
    branch_id INTEGER REFERENCES branches(id),
    related_type TEXT,
    related_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_notifications_unread ON activity_notifications (is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_notifications_branch ON activity_notifications (branch_id);
CREATE INDEX IF NOT EXISTS idx_activity_notifications_related ON activity_notifications (type, related_type, related_id);
