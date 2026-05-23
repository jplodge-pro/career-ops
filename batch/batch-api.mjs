#!/usr/bin/env node
// batch/batch-api.mjs
// Batch API evaluator — companion to batch-runner.sh
// Uses Anthropic Message Batches API: ~94% token cost reduction
// (88% prompt caching + 50% batch discount vs claude -p workers)
//
// Processes triage_pass items. Items where JD fetch fails stay triage_pass
// for batch-runner.sh --full fallback.
//
// Usage:
//   node batch/batch-api.mjs               # submit + poll + post-process
//   node batch/batch-api.mjs --dry-run     # show items, no API call
//   node batch/batch-api.mjs --resume      # resume existing batch from batch-api-state.json
//   node batch/batch-api.mjs --model claude-haiku-4-5-20251001

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

const __dir      = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dir, '..');
const INPUT_PATH = resolve(ROOT, 'batch/batch-input.tsv');
const STATE_PATH = resolve(ROOT, 'batch/batch-state.tsv');
const API_STATE  = resolve(__dir, 'batch-api-state.json');
const PROMPT     = resolve(__dir, 'batch-prompt-api.md');
const CV_PATH    = resolve(ROOT, 'cv.md');
const PROFILE    = resolve(ROOT, 'modes/_profile.md');
const PROF_YML   = resolve(ROOT, 'config/profile.yml');
const REPORTS    = resolve(ROOT, 'reports');
const TRACKER    = resolve(__dir, 'tracker-additions');
const LOGS       = resolve(__dir, 'logs');
const APPS       = resolve(ROOT, 'data/applications.md');

const DRY_RUN  = process.argv.includes('--dry-run');
const RESUME   = process.argv.includes('--resume');
const modelIdx = process.argv.indexOf('--model');
const MODEL    = modelIdx !== -1 && process.argv[modelIdx + 1]
  ? process.argv[modelIdx + 1]
  : 'claude-sonnet-4-6';

const NOW   = new Date().toISOString();
const TODAY = NOW.slice(0, 10);

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// ── State helpers ─────────────────────────────────────────────────────────────

function readState() {
  if (!existsSync(STATE_PATH)) {
    return {
      header: 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
      rows: new Map(),
    };
  }
  const lines = readFileSync(STATE_PATH, 'utf-8').split('\n');
  const rows = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    rows.set(parts[0], parts);
  }
  return { header: lines[0], rows };
}

function writeState(header, rows) {
  const lines = [header, ...[...rows.values()].map(r => r.join('\t'))];
  writeFileSync(STATE_PATH, lines.join('\n') + '\n');
}

// ── Report number ─────────────────────────────────────────────────────────────

function maxReportNum(rows) {
  let max = 0;
  if (existsSync(REPORTS)) {
    for (const f of readdirSync(REPORTS)) {
      if (!f.endsWith('.md')) continue;
      const n = parseInt(f.split('-')[0], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  for (const row of rows.values()) {
    const n = parseInt(row[5], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

// ── Tracker number ────────────────────────────────────────────────────────────

function maxTrackerNum() {
  if (!existsSync(APPS)) return 0;
  const lines = readFileSync(APPS, 'utf-8').split('\n');
  let max = 0;
  for (const line of lines) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

// ── JD fetch ──────────────────────────────────────────────────────────────────

async function fetchJD(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40_000);
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(TRACKER, { recursive: true });
  mkdirSync(LOGS, { recursive: true });

  // ── Resume existing batch ────────────────────────────────────────────────────
  if (RESUME) {
    if (!existsSync(API_STATE)) {
      console.error('No batch-api-state.json found. Nothing to resume.');
      process.exit(1);
    }
    const apiState = JSON.parse(readFileSync(API_STATE, 'utf-8'));
    console.log(`Resuming batch ${apiState.batch_id} (submitted ${apiState.submitted_at})`);
    await pollAndProcess(apiState.batch_id);
    return;
  }

  // ── Phase 1: Setup ───────────────────────────────────────────────────────────
  const { header, rows } = readState();

  const pending = [];
  if (existsSync(INPUT_PATH)) {
    for (const line of readFileSync(INPUT_PATH, 'utf-8').split('\n').slice(1)) {
      if (!line.trim()) continue;
      const [id, url, source, ...rest] = line.split('\t');
      if (!id || !url) continue;
      const row = rows.get(id);
      const status = row ? (row[2] || 'none') : 'none';
      if (status === 'triage_pass') {
        pending.push({ id, url: url.trim(), notes: rest.join('\t').trim() });
      }
    }
  }

  console.log('=== career-ops Batch API Evaluator ===');
  console.log(`Model   : ${MODEL}`);
  console.log(`Pending : ${pending.length} triage_pass items`);
  console.log('');

  if (pending.length === 0) {
    console.log('No triage_pass items. Run ./batch/batch-runner.sh --triage first.');
    return;
  }

  if (DRY_RUN) {
    console.log('=== DRY RUN — no API calls ===');
    for (const { id, url, notes } of pending) {
      console.log(`  #${id}: ${url}`);
      if (notes) console.log(`        ${notes}`);
    }
    console.log(`\nWould submit ${pending.length} requests to Batches API.`);
    return;
  }

  // Build system prompt (identical prefix for all items → cached by Anthropic)
  const promptText  = readFileSync(PROMPT, 'utf-8');
  const cvText      = readFileSync(CV_PATH, 'utf-8');
  const profileText = existsSync(PROFILE) ? readFileSync(PROFILE, 'utf-8') : '';
  const profYml     = existsSync(PROF_YML) ? readFileSync(PROF_YML, 'utf-8') : '';
  const systemText  = [
    promptText,
    '## Candidate CV',
    '',
    cvText,
    '## Candidate Profile',
    '',
    profileText,
    profYml ? '## Candidate Profile Configuration (profile.yml)\n\n' + profYml : '',
  ].filter(Boolean).join('\n\n');

  // Pre-assign report and tracker numbers
  let nextReport  = maxReportNum(rows) + 1;
  let nextTracker = maxTrackerNum() + 1;

  // ── Pre-fetch JDs ────────────────────────────────────────────────────────────
  console.log('Pre-fetching JDs...');
  const fetchable = [];
  const fallback  = [];

  for (const item of pending) {
    const short = item.url.length > 70 ? item.url.slice(0, 67) + '...' : item.url;
    process.stdout.write(`  #${item.id.padStart(4)} ${short} `);
    const jd = await fetchJD(item.url);
    if (jd && jd.length > 200) {
      const reportNum  = String(nextReport++).padStart(3, '0');
      const trackerNum = nextTracker++;
      fetchable.push({ ...item, jd, reportNum, trackerNum });
      process.stdout.write(`✓ ${Math.round(jd.length / 1000)}KB\n`);
    } else {
      fallback.push(item);
      process.stdout.write(`✗ fetch failed\n`);
    }
  }

  console.log(`\nFetchable : ${fetchable.length}`);
  console.log(`Fallback  : ${fallback.length} (will remain triage_pass for batch-runner.sh --full)`);

  if (fetchable.length === 0) {
    console.log('\nNothing to submit. All items fell back.');
    return;
  }

  // Mark items as processing
  for (const { id, url, reportNum } of fetchable) {
    rows.set(id, [id, url, 'processing', NOW, '-', reportNum, '-', '-', '0']);
  }
  writeState(header, rows);

  // ── Phase 2: Build & Submit ──────────────────────────────────────────────────
  const requests = fetchable.map(({ id, url, jd, reportNum, trackerNum, notes }) => ({
    custom_id: id,
    params: {
      model: MODEL,
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: systemText,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            'Evaluate this job posting. Output only the JSON object — no prose, no markdown fences.',
            '',
            `URL: ${url}`,
            `Report number: ${reportNum}`,
            `Tracker number: ${trackerNum}`,
            `Date: ${TODAY}`,
            `Batch ID: ${id}`,
            notes ? `Notes: ${notes}` : '',
            '',
            '## Job Description',
            '',
            jd,
          ].filter(l => l !== undefined).join('\n'),
        },
      ],
    },
  }));

  console.log(`\nSubmitting ${requests.length} requests...`);
  const batch = await client.messages.batches.create({ requests });

  const apiState = {
    batch_id:     batch.id,
    submitted_at: NOW,
    status:       batch.processing_status,
    item_count:   requests.length,
    model:        MODEL,
  };
  writeFileSync(API_STATE, JSON.stringify(apiState, null, 2) + '\n');
  console.log(`Batch ID : ${batch.id}`);
  console.log(`Status   : ${batch.processing_status}`);
  console.log(`Saved    : batch/batch-api-state.json`);

  if (fallback.length > 0) {
    console.log(`\nFallback (run ./batch/batch-runner.sh --full for these):`);
    for (const { id, url } of fallback) console.log(`  #${id}: ${url}`);
  }

  await pollAndProcess(batch.id);
}

// ── Poll + Post-process ───────────────────────────────────────────────────────

async function pollAndProcess(batchId) {
  console.log('\nPolling (60s interval)...');

  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);
    const { processing_status, request_counts } = batch;
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(
      `\r  ${ts} ${processing_status} | ` +
      `processing: ${request_counts.processing}  succeeded: ${request_counts.succeeded}  errored: ${request_counts.errored}   `
    );
    if (processing_status === 'ended') { console.log(''); break; }
    await new Promise(r => setTimeout(r, 60_000));
  }

  console.log('\nProcessing results...');

  const { header, rows } = readState();
  let succeeded = 0;
  let failed    = 0;
  const failIds = [];

  for await (const result of client.messages.batches.results(batchId)) {
    const id  = result.custom_id;
    const row = rows.get(id);
    const reportNum  = row?.[5] ?? '???';
    const startedAt  = row?.[3] ?? NOW;

    // Helper to mark fallback
    const markFallback = (err) => {
      const safeUrl = row?.[1] ?? '';
      rows.set(id, [id, safeUrl, 'triage_pass', startedAt, NOW, reportNum, '-', err.slice(0, 200), '0']);
      writeFileSync(resolve(__dir, 'logs', `${reportNum}-${id}-error.log`), err);
      failIds.push(id);
      failed++;
    };

    if (result.result.type !== 'succeeded') {
      const err = result.result.type === 'errored'
        ? (result.result.error?.message ?? result.result.type)
        : result.result.type;
      console.log(`  ✗ #${id}: ${err} → triage_pass`);
      markFallback(err);
      continue;
    }

    // Parse JSON from model response
    const raw = result.result.message.content?.[0]?.text ?? '';
    let parsed;
    try {
      const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```\s*$/m, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      console.log(`  ✗ #${id}: JSON parse error → triage_pass`);
      markFallback(`JSON parse error. Raw (first 500): ${raw.slice(0, 500)}`);
      continue;
    }

    if (parsed.error) {
      console.log(`  ✗ #${id}: model error: ${parsed.error} → triage_pass`);
      markFallback(parsed.error);
      continue;
    }

    const { company, role, company_slug, score, report_markdown, tracker_line } = parsed;
    const safeUrl = row?.[1] ?? '';

    // Write report
    const slug       = (company_slug || company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const reportFile = `${reportNum}-${slug}-${TODAY}.md`;
    writeFileSync(resolve(REPORTS, reportFile), report_markdown ?? '');

    // Write tracker addition
    writeFileSync(resolve(TRACKER, `${id}.tsv`), (tracker_line ?? '') + '\n');

    // Update state
    rows.set(id, [id, safeUrl, 'completed', startedAt, NOW, reportNum, String(score ?? '-'), '-', '0']);

    console.log(`  ✓ #${id}: ${company} — ${role} (${score}/5, report ${reportNum})`);
    succeeded++;
  }

  writeState(header, rows);

  console.log('\n=== Results ===');
  console.log(`Succeeded : ${succeeded}`);
  console.log(`Failed    : ${failed}`);
  if (failIds.length > 0) {
    console.log(`\nFallback IDs: ${failIds.join(', ')}`);
    console.log('Run: ./batch/batch-runner.sh --full');
  }

  if (succeeded > 0) {
    console.log('\n=== Merging tracker additions ===');
    try { execSync(`node "${resolve(ROOT, 'merge-tracker.mjs')}"`, { stdio: 'inherit' }); } catch { /* logged by script */ }
    console.log('\n=== Verifying pipeline ===');
    try { execSync(`node "${resolve(ROOT, 'verify-pipeline.mjs')}"`, { stdio: 'inherit' }); } catch { /* logged by script */ }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
