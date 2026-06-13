// src/fingerprint.mjs — reduce N per-seed run digests into a per-scenario
// frequency table. This is the generalization of the one-off
// mottramite-frequency-sweep that caught the v196 RNG-cascade regression:
// for each species, how often it appears across the seed sweep, how abundant,
// and its size spread. The frequency table — not the raw runs — is the product.

const sum = (a) => a.reduce((x, y) => x + y, 0);
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : round1((s[m - 1] + s[m]) / 2);
}

/**
 * @param {Array<Object>} perSeed - one summarize() digest per swept seed.
 *   Each digest: { mineral: { active, dissolved, total, max_um } }.
 * @returns {{ n_seeds:number, species:Object }}
 */
export function fingerprintScenario(perSeed) {
  const N = perSeed.length;
  const acc = {}; // mineral -> { present, counts[], maxes[] }  (counts/maxes only over present seeds)

  for (const digest of perSeed) {
    for (const [mineral, d] of Object.entries(digest)) {
      if (!acc[mineral]) acc[mineral] = { present: 0, counts: [], maxes: [] };
      acc[mineral].present++;
      acc[mineral].counts.push(d.total);
      acc[mineral].maxes.push(d.max_um);
    }
  }

  const species = {};
  for (const mineral of Object.keys(acc).sort()) {
    const a = acc[mineral];
    species[mineral] = {
      seeds_present: a.present,
      pct_present: round1((100 * a.present) / N),
      // mean over ALL seeds (absent counts as 0) — the abundance signal
      mean_count: round2(sum(a.counts) / N),
      // mean over only the seeds where it appeared — the "when it shows up" size
      mean_count_when_present: round2(sum(a.counts) / a.present),
      size_um: {
        min: a.maxes.length ? Math.min(...a.maxes) : 0,
        median: median(a.maxes),
        max: a.maxes.length ? Math.max(...a.maxes) : 0,
      },
    };
  }

  return { n_seeds: N, species };
}
