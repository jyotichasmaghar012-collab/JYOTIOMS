'use strict';
/** Compiles every template so syntax incompatibilities surface up front.
 *  Usage: node scripts/check-templates.js */
const path = require('node:path');
const fs = require('node:fs');
const { createEnv } = require('../lib/templates');

const root = path.join(__dirname, '..', 'templates');
const env = createEnv(root);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

let bad = 0;
for (const f of walk(root).filter((x) => x.endsWith('.html'))) {
  const name = path.relative(root, f).split(path.sep).join('/');
  try {
    env.getTemplate(name, true);
  } catch (e) {
    bad++;
    console.log('FAIL', name, '::', String(e.message).split('\n').slice(-2).join(' | '));
  }
}
console.log(bad ? `${bad} template(s) failed to compile` : 'All templates compile.');
process.exitCode = bad ? 1 : 0;
