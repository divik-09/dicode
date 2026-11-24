#!/usr/bin/env node
import { main } from '../src/cli.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { console.error(`DiCode needs Node.js 20 or newer (you have ${process.versions.node}).`); process.exit(1); }

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (e) => { console.error(`\x1b[31merror:\x1b[0m ${e.message}`); if (process.env.DICODE_DEBUG) console.error(e.stack); process.exit(1); },
);
