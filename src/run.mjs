// src/run.mjs — the one place a scenario gets run + summarized.
//
// Both the sweep and `regenerate` go through here, so the seed-42 equivalence
// with gen-baseline lives in exactly one spot. summarize() is VERBATIM from
// vugg's tools/gen-js-baseline.mjs — do NOT "improve" it; if gen-baseline
// changes, mirror it here and the sweep's self-test will catch drift meanwhile.

export function summarize(sim) {
  const out = {};
  if (!sim || !sim.crystals) return out;
  for (const c of sim.crystals) {
    if (!out[c.mineral]) {
      out[c.mineral] = { active: 0, dissolved: 0, total: 0, max_um: 0 };
    }
    out[c.mineral].total++;
    if (c.dissolved) out[c.mineral].dissolved++;
    else out[c.mineral].active++;
    if (c.total_growth_um > out[c.mineral].max_um) {
      out[c.mineral].max_um = Math.round(c.total_growth_um * 10) / 10;
    }
  }
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

/**
 * Build a runner bound to a loaded bundle. runOne(name, seed) sets the chem
 * seed, runs the scenario at defaultSteps ?? 100 (matches gen-baseline), and
 * returns the summarized digest. Shape stays scenario-authored (decision A).
 */
export function makeRunner({ SCENARIOS, VugSimulator, setSeed }) {
  return function runOne(name, seed) {
    setSeed(seed);
    const s = SCENARIOS[name]();
    const sim = new VugSimulator(s.conditions, s.events);
    const steps = s.defaultSteps ?? 100;
    for (let i = 0; i < steps; i++) sim.run_step();
    return summarize(sim);
  };
}
