# Batch API Evaluator — batch/batch-api.mjs

## Context

`batch-runner.sh` spawns one `claude -p` process per item. Each is a cold multi-turn session that re-sends the system prompt on every API round and reads `cv.md`/`_profile.md` as tool calls. Measurement: ~85–90% of tokens per session are fixed overhead. For 84 full-eval items this is ~10.5M tokens.

The Anthropic Message Batches API accepts up to 10,000 single-turn requests in one HTTP call with explicit prompt caching. Injecting `cv.md` + `_profile.md` + eval instructions into the system prompt as an identical prefix means only the first item pays full price — every subsequent item pays ~10% for a cache read. Projected saving: ~88%.

This is a **companion** to `batch-runner.sh`, not a replacement. Items where JD pre-fetch fails stay `triage_pass` and fall back to the existing runner. PDF generation is excluded — use `/career-ops pdf` per role.

---

## Files

| File | Change |
|------|--------|
| `batch/batch-api.mjs` | NEW — Node.js orchestrator |
| `batch/batch-prompt-api.md` | NEW — single-turn prompt (no file I/O, JSON output) |
| `batch/batch-api-state.json` | NEW (runtime) — batch ID + status for resumption |
| `package.json` | ADD `@anthropic-ai/sdk` |
| `batch/batch-state.tsv` | NO SCHEMA CHANGE |
| `batch/batch-runner.sh` | NO CHANGE — kept for triage + JD-fetch fallback |
| `batch/batch-prefilter.mjs` | NO CHANGE |

---

## 1. batch/batch-prompt-api.md (new)

Restructured from `batch-prompt.md` for single-turn API use:

- **Remove:** All `Read`/`Write`/`WebFetch` tool-call instructions — orchestrator handles I/O
- **Remove:** PDF generation instructions
- **Add:** Candidate context injected by orchestrator directly into system prompt (not via tool calls). Sections: `## Candidate CV` and `## Candidate Profile`
- **Keep:** Full A–G evaluation logic, archetype detection, scoring rubric, legitimacy block, `_shared.md` framing rules
- **Output:** Strict JSON only — no prose outside the JSON block

```json
{
  "company": "Anthropic",
  "role": "Staff Software Engineer, Inference",
  "company_slug": "anthropic",
  "score": 3.9,
  "skip": false,
  "legitimacy": "High Confidence",
  "report_markdown": "# Evaluation: Anthropic — ...",
  "tracker_line": "126\t2026-05-23\tAnthropic\t...",
  "error": null
}
```

---

## 2. batch/batch-api.mjs — Four phases

### Phase 1: Setup

```
Read batch-input.tsv → filter to triage_pass items not yet completed
Read once: batch-prompt-api.md + cv.md + _profile.md  (system prompt prefix, identical for all)
Pre-assign report numbers (same logic as batch-runner.sh reserve_report_num)
  → write status=processing to batch-state.tsv

Pre-fetch JDs via Node.js fetch():
  Success → store JD text for user message
  Failure → reset item to triage_pass, add to fallback list, exclude from batch
```

### Phase 2: Build & Submit

Each request in the batch:
```json
{
  "custom_id": "{batch_input_id}",
  "params": {
    "model": "claude-sonnet-4-6",
    "max_tokens": 8192,
    "system": [{
      "type": "text",
      "text": "{batch-prompt-api.md}\n\n## Candidate CV\n{cv.md}\n\n## Candidate Profile\n{_profile.md}",
      "cache_control": { "type": "ephemeral" }
    }],
    "messages": [{
      "role": "user",
      "content": "Evaluate this job posting.\n\nURL: {url}\nReport: {report_num}\nDate: {date}\n\n## Job Description\n{jd_text}"
    }]
  }
}
```

Submit via `anthropic.messages.batches.create()`. Save `batch/batch-api-state.json`:
```json
{ "batch_id": "msgbatch_xxx", "submitted_at": "...", "status": "in_progress" }
```

### Phase 3: Poll

```
Every 60s: anthropic.messages.batches.retrieve(batch_id)
Print request_counts (succeeded / errored / processing)
Until processing_status === 'ended'
```

### Phase 4: Post-process

```
For each result in anthropic.messages.batches.results(batch_id):
  Parse JSON from content[0].text

  Success:
    Write reports/{report_num}-{slug}-{date}.md   ← report_markdown
    Write batch/tracker-additions/{id}.tsv         ← tracker_line
    Update batch-state.tsv: status=completed, score, report_num

  Error or parse failure:
    Reset batch-state.tsv: status=triage_pass      ← falls back to batch-runner.sh
    Write error to batch/logs/{id}.log

After all results:
  Print fallback list
  node merge-tracker.mjs
  node verify-pipeline.mjs
```

---

## 3. CLI

```bash
node batch/batch-api.mjs                              # submit + poll + post-process
node batch/batch-api.mjs --dry-run                    # show items, no API call
node batch/batch-api.mjs --resume                     # resume from batch-api-state.json
node batch/batch-api.mjs --model claude-haiku-4-5-20251001
```

---

## 4. Workflow Integration

```
batch-prefilter.mjs            (zero-token, unchanged)
    ↓
batch-runner.sh --triage       (Haiku triage, unchanged)
    ↓
node batch/batch-api.mjs       (NEW — replaces --full for fetchable JDs)
    ↓
batch-runner.sh --full         (fallback for JD-fetch failures only)
    ↓
/career-ops pdf                (PDF per role, manual)
```

---

## 5. Token Cost Projection (84 items)

| Approach | Effective tokens | Notes |
|----------|-----------------|-------|
| `batch-runner.sh --full` | ~10.5M | All input, re-sent per round |
| `batch-api.mjs` item 1 | ~32K | Cache write — full price |
| `batch-api.mjs` items 2–84 | ~15K each | 4K cached @10% + 11K new |
| **batch-api.mjs total** | **~1.3M** | **~88% reduction** |

---

## 6. Verification

1. `--dry-run` prints item list without calling API
2. Submit 3 items → `batch-api-state.json` written, items show `processing` in `batch-state.tsv`
3. Poll completes → `reports/` has new `.md` files, `tracker-additions/` has new `.tsv` files
4. `node merge-tracker.mjs` → `applications.md` updated, no duplicates
5. `node verify-pipeline.mjs` → passes
6. Items where JD fetch failed → remain `triage_pass` → `batch-runner.sh --full` handles them
