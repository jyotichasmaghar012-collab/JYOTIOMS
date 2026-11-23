'use strict';
/**
 * Read-only MongoDB connection check: pings the cluster and lists databases
 * and collections with document counts. Never prints the connection string.
 *
 *   node scripts/check-mongo.js
 *
 * Reads MONGODB_URI from the environment, .env, or .secrets/atlas-credentials.env.
 */
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');

const root = path.join(__dirname, '..');
for (const f of ['.env', path.join('.secrets', 'atlas-credentials.env')]) {
  const p = path.join(root, f);
  if (!process.env.MONGODB_URI && fs.existsSync(p) && fs.statSync(p).isFile()) process.loadEnvFile(p);
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('MONGODB_URI not found.');
    process.exitCode = 1;
    return;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('CONNECTED OK');
    const { databases } = await client.db('admin').admin().listDatabases();
    for (const d of databases) {
      if (['admin', 'local', 'config'].includes(d.name)) continue;
      console.log(`db: ${d.name}  (${(d.sizeOnDisk / 1048576).toFixed(1)} MB)`);
      const cols = await client.db(d.name).listCollections().toArray();
      for (const c of cols) {
        const n = await client.db(d.name).collection(c.name).estimatedDocumentCount();
        console.log(`   - ${c.name}: ${n} docs`);
      }
    }
  } catch (e) {
    // Error messages never include the password.
    console.log('CONNECTION FAILED:', e.name, '-', String(e.message).split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
})();
