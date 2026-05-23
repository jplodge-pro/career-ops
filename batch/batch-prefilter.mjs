#!/usr/bin/env node
// batch/batch-prefilter.mjs
// Zero-token pre-filter: rejects obvious mismatches before Haiku triage.
//
// Checks (in order, short-circuit on first fail):
//   1. Title filter  — positive/negative keywords from portals.yml title_filter
//   2. Location lock — company notes in portals.yml signal a hard on-site location
//                      incompatible with the candidate's remote/UAE/Singapore preference
//
// Writes triage_fail directly into batch-state.tsv for matched entries.
// Only touches entries whose current status is pending/none.
//
// Usage:
//   node batch/batch-prefilter.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dir      = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dir, '..');
const DRY_RUN    = process.argv.includes('--dry-run');
const NOW        = new Date().toISOString();

const PORTALS_PATH = resolve(ROOT, 'portals.yml');
const INPUT_PATH   = resolve(ROOT, 'batch/batch-input.tsv');
const STATE_PATH   = resolve(ROOT, 'batch/batch-state.tsv');

// ── Location blockers ────────────────────────────────────────────────────────
// Conservative list — only block on unambiguous on-site signals in locations
// outside the candidate's acceptable set (remote / UAE / Singapore).
// Ambiguous notes fall through to Haiku.

const LOCATION_BLOCK_RE = [
  /\bon-?site\b/i,
  /\bin[- ]office\b/i,
  /\bUS[/ ]London\b/i,
  /\bon[- ]site\s+US\b/i,
  /\bEU\s+only\b/i,
  /\bEurope\s+only\b/i,
  /\bUK\s+only\b/i,
  /\bLondon\s+UK\b/i,
  /\bUnited States\s+only\b/i,
];

// If any of these appear the note is NOT a blocker (overrides block list).
const LOCATION_ALLOW_RE = [
  /\bremote\b/i,
  /\bSingapore\b/i,
  /\bUAE\b/i,
  /\bDubai\b/i,
  /\bAPAC\b/i,
];

function isLocationBlocker(notes) {
  if (!notes) return false;
  const blocked = LOCATION_BLOCK_RE.some(re => re.test(notes));
  if (!blocked) return false;
  const allowed = LOCATION_ALLOW_RE.some(re => re.test(notes));
  return !allowed;
}

// ── URL → company domain matching ───────────────────────────────────────────

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function buildCompanyIndex(companies) {
  const index = new Map(); // domain → notes
  for (const c of companies) {
    if (!c.careers_url && !c.api) continue;
    const urls = [c.careers_url, c.api].filter(Boolean);
    for (const u of urls) {
      const d = domainOf(u);
      if (d) index.set(d, c.notes || '');
      // Also index slug-level paths for Ashby/Lever/Greenhouse patterns
      try {
        const parsed = new URL(u);
        const slug = parsed.pathname.split('/').filter(Boolean)[0];
        if (slug) index.set(`${d}/${slug}`, c.notes || '');
      } catch { /* ignore */ }
    }
  }
  return index;
}

function lookupNotes(url, index) {
  const d = domainOf(url);
  // Try slug-level first (more specific)
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (slug) {
      const key = `${d}/${slug}`;
      if (index.has(key)) return index.get(key);
    }
  } catch { /* ignore */ }
  return index.get(d) ?? null;
}

// ── Title filter ─────────────────────────────────────────────────────────────

function buildTitleFilter(tf) {
  const pos = (tf?.positive || []).map(k => k.toLowerCase());
  const neg = (tf?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    if (!title) return { pass: false, reason: 'no title available' };
    const lower = title.toLowerCase();
    if (neg.some(k => lower.includes(k)))
      return { pass: false, reason: `negative keyword match` };
    if (pos.length > 0 && !pos.some(k => lower.includes(k)))
      return { pass: false, reason: `no positive keyword match` };
    return { pass: true };
  };
}

// ── batch-state.tsv helpers ──────────────────────────────────────────────────

function readState() {
  if (!existsSync(STATE_PATH)) return { header: 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries', rows: new Map() };
  const lines = readFileSync(STATE_PATH, 'utf-8').split('\n');
  const header = lines[0];
  const rows = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    rows.set(parts[0], parts); // keyed by id
  }
  return { header, rows };
}

function writeState(header, rows) {
  const lines = [header, ...[...rows.values()].map(r => r.join('\t'))];
  writeFileSync(STATE_PATH, lines.join('\n') + '\n');
}

function isPending(row) {
  if (!row) return true; // not in state yet = pending
  const status = row[2] || 'none';
  return status === 'pending' || status === 'none';
}

// ── Main ─────────────────────────────────────────────────────────────────────

const portals  = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
const tf       = buildTitleFilter(portals.title_filter);
const companies = portals.tracked_companies || [];
const noteIdx  = buildCompanyIndex(companies);

// Load batch-input: id → { url, source, notes }
const inputLines = readFileSync(INPUT_PATH, 'utf-8').split('\n').slice(1);
const inputMap = new Map();
for (const line of inputLines) {
  if (!line.trim()) continue;
  const [id, url, source, ...rest] = line.split('\t');
  inputMap.set(id, { url: url?.trim(), source: source?.trim(), notes: rest.join('\t').trim() });
}

const { header, rows } = readState();

let autoFailed = 0;
let alreadyDecided = 0;
let toProcess = 0;

const ts = NOW;

for (const [id, entry] of inputMap) {
  const existing = rows.get(id);
  if (!isPending(existing)) { alreadyDecided++; continue; }

  const { url, notes } = entry;
  // Extract title: notes format is "Company — Role" or just role
  const title = notes?.includes(' — ') ? notes.split(' — ').slice(1).join(' — ') : notes;

  // Check 1: title filter
  const titleResult = tf(title);
  if (!titleResult.pass) {
    const reason = `Pre-filter: title filter fail — ${titleResult.reason} ("${title}")`;
    rows.set(id, [id, url, 'triage_fail', ts, ts, '-', '1.0', reason, '0']);
    autoFailed++;
    if (DRY_RUN) console.log(`  ❌ #${id} ${reason}`);
    continue;
  }

  // Check 2: company location blocker via portals.yml notes
  const companyNotes = lookupNotes(url, noteIdx);
  if (companyNotes !== null && isLocationBlocker(companyNotes)) {
    const reason = `Pre-filter: location blocker — company notes: "${companyNotes}"`;
    rows.set(id, [id, url, 'triage_fail', ts, ts, '-', '1.0', reason, '0']);
    autoFailed++;
    if (DRY_RUN) console.log(`  ❌ #${id} ${reason}`);
    continue;
  }

  toProcess++;
}

console.log(`\n=== Pre-filter results ===`);
console.log(`Already decided  : ${alreadyDecided}`);
console.log(`Auto-failed      : ${autoFailed}`);
console.log(`Passing to Haiku : ${toProcess}`);

if (!DRY_RUN && autoFailed > 0) {
  writeState(header, rows);
  console.log(`\nWrote ${autoFailed} triage_fail entries to batch-state.tsv`);
}

if (DRY_RUN) console.log('\n(dry run — no files written)');
