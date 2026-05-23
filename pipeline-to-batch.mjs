#!/usr/bin/env node
// pipeline-to-batch.mjs
// Converts pending items from data/pipeline.md into batch/batch-input.tsv entries.
// Skips URLs already present in batch-input.tsv or batch-state.tsv.
// Usage: node pipeline-to-batch.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'fs';

const PIPELINE_PATH = 'data/pipeline.md';
const INPUT_PATH    = 'batch/batch-input.tsv';
const STATE_PATH    = 'batch/batch-state.tsv';
const DRY_RUN       = process.argv.includes('--dry-run');

// ── Load existing URLs to dedup ──────────────────────────────────────────────

function loadExistingUrls() {
  const seen = new Set();
  for (const path of [INPUT_PATH, STATE_PATH]) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf-8').split('\n').slice(1); // skip header
    for (const line of lines) {
      const url = line.split('\t')[1]?.trim();
      if (url) seen.add(url);
    }
  }
  return seen;
}

// ── Find max existing ID ──────────────────────────────────────────────────────

function maxExistingId() {
  if (!existsSync(INPUT_PATH)) return 0;
  const lines = readFileSync(INPUT_PATH, 'utf-8').split('\n').slice(1);
  let max = 0;
  for (const line of lines) {
    const id = parseInt(line.split('\t')[0], 10);
    if (!isNaN(id) && id > max) max = id;
  }
  return max;
}

// ── Parse pipeline.md pending items ─────────────────────────────────────────
// Line format: - [ ] {URL} | {Company} | {Role}
//          or: - [ ] {URL}

function parsePending(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('- [ ]')) continue;
    const rest = line.slice(5).trim();
    const parts = rest.split('|').map(s => s.trim());
    const url     = parts[0] || '';
    const company = parts[1] || '';
    const role    = parts[2] || '';
    if (url.startsWith('http')) entries.push({ url, company, role });
  }
  return entries;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pipeline = readFileSync(PIPELINE_PATH, 'utf-8');
const pending  = parsePending(pipeline);
const seen     = loadExistingUrls();
const newItems = pending.filter(e => !seen.has(e.url));

if (newItems.length === 0) {
  console.log('Nothing to add — all pending URLs already in batch-input.tsv.');
  process.exit(0);
}

let nextId = maxExistingId() + 1;
const rows = newItems.map(e => {
  const id = nextId++;
  // notes = "Company — Role" if both present, else whichever exists
  const notes = e.company && e.role
    ? `${e.company} — ${e.role}`
    : e.company || e.role || '';
  return `${id}\t${e.url}\t${e.company}\t${notes}`;
});

console.log(`Pending in pipeline.md : ${pending.length}`);
console.log(`Already in batch       : ${seen.size}`);
console.log(`New entries to add     : ${newItems.length}`);

if (DRY_RUN) {
  console.log('\n-- dry run (first 10) --');
  rows.slice(0, 10).forEach(r => console.log(r));
  process.exit(0);
}

// Ensure file ends with newline before appending
let existing = existsSync(INPUT_PATH) ? readFileSync(INPUT_PATH, 'utf-8') : 'id\turl\tsource\tnotes\n';
if (!existing.endsWith('\n')) existing += '\n';
writeFileSync(INPUT_PATH, existing + rows.join('\n') + '\n');

console.log(`\nDone. Added ${newItems.length} entries to ${INPUT_PATH} (IDs ${nextId - newItems.length}–${nextId - 1}).`);
console.log('Next: ./batch/batch-runner.sh --triage --parallel 5');
