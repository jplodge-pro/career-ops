# career-ops Full Workflow

---

## 1. Scanning — Finding Jobs

**Option A: Zero-token portal scanner (recommended)**
```bash
/career-ops scan
```
Hits Greenhouse, Ashby, and Lever public REST APIs directly — no LLM, no browser, no cost. Also queries Himalayas for cross-company remote roles. Configured in `portals.yml` (`tracked_companies`, `search_queries`, `title_filter`). New URLs land in `data/pipeline.md` as unchecked items. Deduplication via `data/scan-history.tsv`.

**Option B: Manual**
Add URLs directly to `data/pipeline.md`:
```
- [ ] https://... | Company | Role Title
```

**Option C: Scheduled**
```bash
/career-ops scan  # then ask "scan every 3 days" to automate
```

---

## 2. Batch Processing — Evaluating at Scale

Five steps, cheapest first:

**Step 1 — Convert inbox to batch queue**
```bash
node pipeline-to-batch.mjs
```
Reads all `- [ ]` items from `pipeline.md`, appends new ones to `batch/batch-input.tsv`, deduplicates.

**Step 2 — Zero-token pre-filter**
```bash
node batch/batch-prefilter.mjs [--dry-run]
```
Rejects obvious mismatches using title keywords and location blockers from `portals.yml`. No API cost. Marks failures as `triage_fail` immediately.

**Step 3 — Haiku triage** (cheap scoring)
```bash
./batch/batch-runner.sh --triage --parallel 5
```
Scores each remaining item on 4 axes (archetype match, hard requirement gaps, location fit, seniority). Items ≥ 3.3 → `triage_pass`. Items < 3.3 → `triage_fail`. Runs the pre-filter automatically before Haiku.

**Step 4 — Full A–G evaluation** (two options)

| Option | Command | Cost | When to use |
|--------|---------|------|-------------|
| **Batches API** (recommended) | `node batch/batch-api.mjs` | ~94% cheaper | Large batches, fetchable JDs |
| **batch-runner.sh** (fallback) | `./batch/batch-runner.sh --full --parallel 3` | Full price | JS-rendered pages, fallback items |

`batch-api.mjs` submits all items in one API call, polls until done, then writes reports and tracker additions. Items where HTTP fetch fails stay `triage_pass` for the `batch-runner.sh` fallback.

**Step 5 — Merge tracker**
```bash
node merge-tracker.mjs
```
Merges `batch/tracker-additions/*.tsv` into `data/applications.md`. `batch-api.mjs` does this automatically; run manually after `batch-runner.sh --full`.

---

## 3. Dashboard — Reviewing Results

```bash
cd dashboard && go run .
```
Bubbletea TUI. Shows all applications with score, status, archetype. Browse reports inline. Filter by status and score. Useful for a quick pass to identify what's worth applying to.

---

## 4. Single-Role Evaluation

For roles found outside the batch (LinkedIn, referrals, etc.):
```bash
/career-ops {URL or paste JD text}     # full pipeline: eval + report + PDF + tracker
/career-ops oferta                     # evaluation only, no auto-PDF
```

---

## 5. Comparing Roles

```bash
/career-ops ofertas
```
Side-by-side comparison and ranking of multiple evaluated roles.

---

## 6. Company Research

```bash
/career-ops deep
```
Deep research on a company before deciding to apply — funding, culture, team, recent news, red flags.

---

## 7. PDF Generation

```bash
/career-ops pdf
```
Generates an ATS-optimised CV tailored to the specific role. Reads the existing evaluation report for keywords, rewrites the professional summary, reorders experience bullets by relevance, injects keywords ethically. Outputs to `output/`.

---

## 8. Applying

```bash
/career-ops apply
```
Live application assistant. Loads the existing evaluation report for the role, then:
- With Playwright: reads the form from your browser directly
- Without Playwright: you paste form questions or share a screenshot

Generates copy-paste answers for every field (cover letter, free-text, dropdowns, salary). You review and paste. After you confirm submission it updates the tracker status to `Applied` and suggests LinkedIn outreach.

**Important:** `/career-ops apply` will not submit anything — you make the final call.

---

## 9. LinkedIn Outreach

```bash
/career-ops contacto
```
Finds relevant contacts at the company (hiring manager, team lead, recruiter), drafts a personalised outreach message tailored to the role and your profile.

---

## 10. Interview Prep

```bash
/career-ops interview-prep
```
Generates a company-specific prep document: STAR stories mapped to the JD, likely questions by interviewer type (technical, behavioural, hiring manager), red-flag Q&A, case study recommendations. Saved to `interview-prep/{company}-{role}.md`.

---

## 11. Follow-up Tracking

```bash
/career-ops followup
```
Shows overdue follow-ups across all active applications. Generates follow-up email drafts. Tracks history in `data/follow-ups.md`.

---

## 12. Pattern Analysis

```bash
/career-ops patterns
```
Analyses your rejection and skip patterns across all evaluated roles. Identifies which archetypes convert, which gaps keep appearing, and how to improve targeting.

---

## Full Cycle

```
scan → pipeline.md → pipeline-to-batch.mjs → pre-filter → triage → batch-api.mjs
     → merge-tracker → dashboard → pdf → apply → contacto → interview-prep → followup
```
