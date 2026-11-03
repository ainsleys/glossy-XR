#!/usr/bin/env node
// Record that a Turkish speaker has read the client's Turkish strings:
//   node scripts/sign-off-tr.mjs --by "<name>"
// writes every current Turkish key and the hash of its string into TR_REVIEWED
// in shared/strings.js, with the reader's name and the date, and prints the keys
// it recorded. Commit the change with the reader's name in the message. A string
// edited later no longer matches its hash, and the unit test names it again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, TR_REVIEWED, hash } from '../shared/strings.js';

const i = process.argv.indexOf('--by');
const by = i > 0 ? String(process.argv[i + 1] || '').trim() : '';
if (!by) { console.error('usage: node scripts/sign-off-tr.mjs --by "<name>"'); process.exit(2); }

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../shared/strings.js');
const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf('export const TR_REVIEWED = {'), end = src.indexOf('\n};', start);
if (start < 0 || end < 0) { console.error('TR_REVIEWED not found in shared/strings.js'); process.exit(1); }

const keys = Object.keys(STRINGS.tr);
const changed = keys.filter((k) => TR_REVIEWED[k] !== hash(STRINGS.tr[k]));
const date = new Date().toISOString().slice(0, 10);
const body = [`  // read by ${by.replace(/\n/g, ' ')}, ${date}`, ...keys.map((k) => `  '${k}': '${hash(STRINGS.tr[k])}',`)].join('\n');
fs.writeFileSync(file, src.slice(0, start) + 'export const TR_REVIEWED = {\n' + body + src.slice(end));

console.log(`recorded ${keys.length} Turkish strings as read by ${by}; * marks the ${changed.length} new or changed since the last sign-off:`);
for (const k of keys) console.log(`${changed.includes(k) ? '*' : ' '} ${k}  ${STRINGS.tr[k]}`);
