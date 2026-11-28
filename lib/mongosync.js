'use strict';
/**
 * MongoDB Atlas persistence for serverless hosting (Vercel).
 *
 * The app keeps running its SQL against a local SQLite copy (in the temp
 * folder), and this module makes MongoDB the permanent, shared copy:
 *
 *  - Database: the SQLite file is stored in GridFS (bucket "oms_sqlite").
 *    A state document (collection "oms_state", _id "sqlite") holds the
 *    current version number, which GridFS file holds it, and a write lock.
 *  - Before every request the local copy is refreshed if another instance
 *    has saved a newer version.
 *  - Write requests (POST etc.) take the lock first, so two people saving at
 *    the same moment are applied one after the other - nothing is lost.
 *    Read requests that happen to write (e.g. a reminder notification) save
 *    optimistically and simply skip saving if someone else saved first.
 *  - Uploaded images are stored in GridFS (bucket "oms_uploads") by their
 *    static path, and downloaded on demand when an instance needs one.
 *  - Storefront visit analytics go straight into the "site_visits"
 *    collection, so a page view never has to re-save the whole database.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');

const STATE_ID = 'sqlite';
const LOCK_LEASE_MS = 120000;
const LOCK_WAIT_MS = 30000;

let mongodb = null;
let clientPromise = null;

function enabled() {
  return storage.MONGO_MODE;
}

async function getDb() {
  if (!mongodb) mongodb = require('mongodb');
  if (!clientPromise) {
    // Tolerate a value pasted with surrounding quotes or spaces.
    const uri = String(process.env.MONGODB_URI || '').trim().replace(/^["']+|["']+$/g, '');
    // Cached on globalThis so warm serverless invocations reuse the connection.
    globalThis.__omsMongoClient = globalThis.__omsMongoClient ||
      new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 8000 }).connect();
    clientPromise = globalThis.__omsMongoClient;
  }
  let client;
  try {
    client = await clientPromise;
  } catch (e) {
    // Don't keep a failed connection cached - retry on the next request.
    clientPromise = null;
    globalThis.__omsMongoClient = null;
    throw e;
  }
  return client.db(process.env.OMS_MONGODB_DB || undefined);
}

async function col(name) { return (await getDb()).collection(name); }
async function bucket(name) {
  const db = await getDb();
  return new mongodb.GridFSBucket(db, { bucketName: name });
}

/* ---------------- local state ---------------- */
const local = { version: -1, hash: null };
const instanceId = crypto.randomBytes(8).toString('hex');

/**
 * Cheap "has the database file changed?" signature - no full-file read.
 * SQLite bumps the 4-byte "file change counter" in its header (offset 24) on
 * every committed write (rollback-journal mode, which this app uses); size and
 * nanosecond mtime are added as a safety net.
 */
function fileHash(p) {
  let st;
  try { st = fs.statSync(p, { bigint: true }); } catch (_) { return null; }
  let counter = '';
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const hdr = Buffer.alloc(4);
    if (fs.readSync(fd, hdr, 0, 4, 24) === 4) counter = hdr.readUInt32BE(0);
  } catch (_) { /* fall back to size + mtime */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return `${counter}:${st.size}:${st.mtimeNs}`;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function uploadBuffer(b, filename, buf, metadata) {
  return new Promise((resolve, reject) => {
    const up = b.openUploadStream(filename, { metadata });
    up.on('error', reject);
    up.on('finish', () => resolve(up.id));
    up.end(buf);
  });
}

/* ---------------- in-process request queue ---------------- */
// One request at a time per instance: the local SQLite file may be replaced
// by a newer download between requests, so nothing may hold it open then.
let queue = Promise.resolve();
function acquireMutex() {
  let release;
  const next = new Promise((r) => { release = r; });
  const prev = queue;
  queue = queue.then(() => next);
  return prev.then(() => release);
}

/* ---------------- database snapshot ---------------- */
async function ensureFresh() {
  const state = await (await col('oms_state')).findOne({ _id: STATE_ID });
  if (!state || !state.fileId) return state;
  if (state.version === local.version && fs.existsSync(storage.DB_PATH)) return state;
  const b = await bucket('oms_sqlite');
  const buf = await streamToBuffer(b.openDownloadStream(state.fileId));
  fs.mkdirSync(path.dirname(storage.DB_PATH), { recursive: true });
  const tmp = `${storage.DB_PATH}.download`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, storage.DB_PATH);
  local.version = state.version;
  local.hash = fileHash(storage.DB_PATH);
  return state;
}

async function ensureFreshWithRetry() {
  try {
    return await ensureFresh();
  } catch (e) {
    // The file we were told about may have just been replaced - try once more.
    return ensureFresh();
  }
}

/**
 * Save the local database to MongoDB as version base+1.
 * lockOwner set  -> only succeeds while we still hold the write lock.
 * lockOwner null -> optimistic: only succeeds if nobody saved since `base`.
 * Returns true on success; on failure the local copy is marked stale.
 */
async function saveSnapshot(base, lockOwner) {
  const states = await col('oms_state');
  const b = await bucket('oms_sqlite');
  const buf = fs.readFileSync(storage.DB_PATH);
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const newVersion = (base || 0) + 1;
  const fileId = await uploadBuffer(b, `oms-v${newVersion}.db`, buf, { version: newVersion, hash });
  const set = { version: newVersion, fileId, hash, size: buf.length, updatedAt: new Date() };

  const before = await states.findOne({ _id: STATE_ID });
  let ok = false;
  if (!before) {
    try {
      await states.insertOne({ _id: STATE_ID, ...set, lockOwner: null, lockUntil: null });
      ok = true;
    } catch (_) { ok = false; }
  } else {
    const filter = lockOwner
      ? { _id: STATE_ID, lockOwner }
      : { _id: STATE_ID, version: base, $or: [{ lockOwner: null }, { lockUntil: { $lt: new Date() } }] };
    if (!lockOwner && base === 0) filter.version = { $in: [0, null] };
    const r = await states.updateOne(filter, { $set: set });
    ok = r.modifiedCount === 1;
  }
  if (ok) {
    local.version = newVersion;
    local.hash = fileHash(storage.DB_PATH);
    if (before && before.fileId) b.delete(before.fileId).catch(() => {});
  } else {
    b.delete(fileId).catch(() => {});
    local.version = -1; // force a fresh download on the next request
  }
  return ok;
}

async function acquireLock() {
  const states = await col('oms_state');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      const r = await states.findOneAndUpdate(
        { _id: STATE_ID, $or: [{ lockOwner: null }, { lockOwner: { $exists: false } }, { lockUntil: { $lt: now } }] },
        { $set: { lockOwner: instanceId + ':' + crypto.randomBytes(4).toString('hex'), lockUntil: new Date(now.getTime() + LOCK_LEASE_MS) } },
        { upsert: true, returnDocument: 'after' },
      );
      const doc = r && r.value !== undefined ? r.value : r;
      if (doc && doc.lockOwner) return doc.lockOwner;
    } catch (e) {
      if (!(e && e.code === 11000)) throw e; // 11000 = locked by someone else
    }
    if (Date.now() > deadline) {
      const err = new Error('The shop database is busy. Please try again in a moment.');
      err.code = 'OMS_BUSY';
      throw err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function releaseLock(owner) {
  if (!owner) return;
  await (await col('oms_state')).updateOne({ _id: STATE_ID, lockOwner: owner }, { $set: { lockOwner: null, lockUntil: null } }).catch(() => {});
}

/* ---------------- uploaded files ---------------- */
function walk(dir, base = dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else {
      const st = fs.statSync(full);
      out.set(path.relative(base, full).split(path.sep).join('/'), `${st.size}:${st.mtimeMs}`);
    }
  }
  return out;
}

const uploadsRoot = () => path.join(storage.UPLOAD_STATIC, 'uploads');

async function pushUploadChanges(before, deleted) {
  const after = walk(uploadsRoot());
  const b = await bucket('oms_uploads');
  for (const [rel, sig] of after) {
    if (before.get(rel) === sig) continue;
    const filename = `uploads/${rel}`;
    const old = await b.find({ filename }).toArray();
    await uploadBuffer(b, filename, fs.readFileSync(path.join(uploadsRoot(), rel)), {});
    for (const f of old) await b.delete(f._id).catch(() => {});
  }
  const gone = new Set(deleted);
  for (const rel of before.keys()) if (!after.has(rel)) gone.add(`uploads/${rel}`);
  for (const filename of gone) {
    for (const f of await b.find({ filename }).toArray()) await b.delete(f._id).catch(() => {});
  }
}

/** Fetch an uploaded file from MongoDB into the local cache. Returns its
 *  local path, or null if MongoDB doesn't have it. */
async function fetchUpload(rel) {
  const clean = path.posix.normalize(String(rel)).replace(/^\/+/, '');
  if (!clean.startsWith('uploads/') || clean.includes('..')) return null;
  const b = await bucket('oms_uploads');
  const files = await b.find({ filename: clean }).sort({ uploadDate: -1 }).limit(1).toArray();
  if (!files.length) return null;
  const buf = await streamToBuffer(b.openDownloadStream(files[0]._id));
  const dest = path.join(storage.UPLOAD_STATIC, ...clean.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}

/* ---------------- request lifecycle ---------------- */
/**
 * Called before a route handler runs. Returns a token for endRequest().
 */
async function beginRequest(isWrite) {
  const release = await acquireMutex();
  const tok = { release, lockOwner: null, base: -1, uploadsBefore: null, deleted: new Set(), done: false };
  try {
    if (isWrite) tok.lockOwner = await acquireLock();
    const state = await ensureFreshWithRetry();
    tok.base = state && state.version ? state.version : 0;
    tok.hashBefore = fileHash(storage.DB_PATH); // cheap now - always read fresh
    if (isWrite) tok.uploadsBefore = walk(uploadsRoot());
    return tok;
  } catch (e) {
    await releaseLock(tok.lockOwner);
    release();
    throw e;
  }
}

/**
 * Called after the handler finished and the request's DB connection was
 * closed, BEFORE the response is sent (serverless functions may be frozen
 * right after responding). Returns false if a write could not be saved.
 */
async function endRequest(tok, { failed = false } = {}) {
  if (!tok || tok.done) return true;
  tok.done = true;
  let ok = true;
  try {
    if (!failed) {
      const hashAfter = fileHash(storage.DB_PATH);
      if (hashAfter && hashAfter !== tok.hashBefore) ok = await saveSnapshot(tok.base, tok.lockOwner);
      if (ok && tok.uploadsBefore) await pushUploadChanges(tok.uploadsBefore, tok.deleted);
    } else if (fileHash(storage.DB_PATH) !== tok.hashBefore) {
      local.version = -1; // discard partial local changes on the next request
    }
    // A read request that couldn't save (someone else saved first) is fine -
    // its only writes are regenerable bookkeeping. A write request holding
    // the lock that can't save is a real failure.
    if (!ok && !tok.lockOwner) ok = true;
  } finally {
    await releaseLock(tok.lockOwner);
    tok.release();
  }
  return ok;
}

/** Startup: pull the latest saved database, run migrations, save if they changed anything. */
async function startup(initDb) {
  const release = await acquireMutex();
  try {
    const state = await ensureFreshWithRetry();
    const base = state && state.version ? state.version : 0;
    const before = fs.existsSync(storage.DB_PATH) ? fileHash(storage.DB_PATH) : null;
    initDb();
    const after = fileHash(storage.DB_PATH);
    if (!state || !state.fileId || after !== before) await saveSnapshot(base, null);
  } finally {
    release();
  }
}

/* ---------------- storefront visit analytics ---------------- */
async function logVisit(doc) {
  await (await col('site_visits')).insertOne(doc);
}

async function visitStats({ page, perPage }) {
  const c = await col('site_visits');
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const utc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const today = utc(now).slice(0, 10);
  const weekAgo = utc(new Date(now.getTime() - 7 * 86400000));
  const total = await c.countDocuments();
  const unique = (await c.distinct('ip_address', { ip_address: { $ne: null } })).length;
  const todayCount = await c.countDocuments({ visited_at: { $gte: `${today} 00:00:00`, $lte: `${today} 23:59:59` } });
  const week = await c.countDocuments({ visited_at: { $gte: weekAgo } });
  const popular = await c.aggregate([
    { $group: { _id: '$path', c: { $sum: 1 } } }, { $sort: { c: -1 } }, { $limit: 10 },
  ]).toArray();
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page), totalPages);
  const recent = await c.find({}, { projection: { _id: 0 } }).sort({ visited_at: -1, _id: -1 })
    .skip((p - 1) * perPage).limit(perPage).toArray();
  return {
    total, unique, today: todayCount, week,
    popular: popular.map((r) => ({ path: r._id, c: r.c })),
    recent, page: p, totalPages,
  };
}

module.exports = {
  enabled, beginRequest, endRequest, startup, fetchUpload, logVisit, visitStats, getDb,
};
