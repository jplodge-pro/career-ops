// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Himalayas provider — cross-company remote job aggregator.
// Public API, no auth required. Max 20 results per page; paginates up to
// `himalayas_max_pages` (default 3) to cap token-free fetch volume.
//
// portals.yml entry shape:
//
//   - name: Himalayas — Senior Engineer
//     provider: himalayas
//     himalayas_query: 'software engineer'
//     himalayas_seniority: 'Senior'          # Entry-level | Mid-level | Senior | Manager | Director | Executive
//     himalayas_employment_type: 'Full Time'  # Full Time | Part Time | Contractor | Intern
//     himalayas_max_pages: 3                  # optional, default 3 (max 60 results)
//     enabled: true

const BASE_URL = 'https://himalayas.app/jobs/api/search';
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 3;

function buildUrl(entry, offset) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (entry.himalayas_query)          params.set('q', entry.himalayas_query);
  if (entry.himalayas_seniority)      params.set('seniority', entry.himalayas_seniority);
  if (entry.himalayas_employment_type) params.set('employmentType', entry.himalayas_employment_type);
  return `${BASE_URL}?${params}`;
}

/** @type {Provider} */
export default {
  id: 'himalayas',

  detect(entry) {
    return entry.careers_url?.includes('himalayas.app') ? { url: entry.careers_url } : null;
  },

  async fetch(entry, ctx) {
    const maxPages = Number(entry.himalayas_max_pages ?? DEFAULT_MAX_PAGES);
    const jobs = [];

    for (let page = 0; page < maxPages; page++) {
      const url = buildUrl(entry, page * PAGE_SIZE);
      const json = await ctx.fetchJson(url);
      const batch = Array.isArray(json?.jobs) ? json.jobs : [];
      if (batch.length === 0) break;

      for (const j of batch) {
        jobs.push({
          title:    j.title || '',
          url:      j.applicationLink || j.guid || '',
          company:  j.companyName || '',
          location: Array.isArray(j.locationRestrictions) ? j.locationRestrictions.join(', ') : '',
        });
      }

      // Stop early if we've seen all available results
      if (jobs.length >= (json.totalCount ?? 0)) break;
    }

    return jobs;
  },
};
