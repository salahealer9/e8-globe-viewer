#!/usr/bin/env node
/* verify_bundle.mjs — integrity checks for the viewer's data/ bundle.
   Run after dropping in a new bundle:  node verify_bundle.mjs
   Exits non-zero on any failure. */

import fs from "fs";

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else { console.error("  ✗ " + msg); fails++; }
};
const pairKey = (a, b) => (a < b ? a + "-" + b : b + "-" + a);
const tier = (s) => (s >= 3 ? 3 : s >= 2 ? 2 : 1);

/* manifest must parse in STRICT mode (catches NaN/Infinity leaks) */
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync("data/manifest.json", "utf8"));
  console.log("manifest.json parses in strict mode");
} catch (e) {
  console.error("✗ manifest.json is not valid strict JSON: " + e.message);
  process.exit(1);
}

ok(manifest.schema_version === "1.0", "schema_version 1.0");
ok(!!manifest.provenance?.engine_commit, "provenance has engine commit");
ok(!!manifest.provenance?.catalog_sha256, "provenance has catalog sha256");

const N = manifest.catalog.n_sites;
const statuses = { bh_significant: 0, elite_nonsignificant: 0, control: 0 };

for (const s of manifest.seeds) {
  console.log(`\nseed ${s.seed} (${s.family}, ${s.status})`);
  statuses[s.status] = (statuses[s.status] || 0) + 1;

  const grid = JSON.parse(fs.readFileSync(s.files.grid, "utf8"));
  const sites = JSON.parse(fs.readFileSync(s.files.sites, "utf8"));
  const nulls = JSON.parse(fs.readFileSync(s.files.null, "utf8"));

  /* grid parallel arrays aligned */
  const ef = grid.features.find((f) => f.properties.kind === "grid_edges");
  const lines = ef.geometry.coordinates,
    pairs = ef.properties.pairs,
    sup = ef.properties.support_counts;
  ok(lines.length === pairs.length && pairs.length === sup.length,
     `grid arrays aligned (${lines.length} edges)`);

  /* counts consistent with support_counts */
  const derived = {
    supported: sup.length,
    shared2: sup.filter((c) => c >= 2).length,
    shared3: sup.filter((c) => c >= 3).length,
  };
  ok(JSON.stringify(derived) === JSON.stringify(s.counts),
     `manifest counts match grid (${JSON.stringify(derived)})`);

  /* every shared edge joins to a named site pair */
  const sharedMap = new Map(
    (s.shared_edges || []).map((e) => [pairKey(e.vertex_pair[0], e.vertex_pair[1]), e]));
  let joined = 0;
  for (let i = 0; i < sup.length; i++)
    if (tier(sup[i]) >= 2 && sharedMap.has(pairKey(pairs[i][0], pairs[i][1]))) joined++;
  ok(joined === derived.shared2 && sharedMap.size === derived.shared2,
     `shared-edge site pairs join ${joined}/${derived.shared2}`);

  /* sites: full catalog, classes match manifest, distances authoritative */
  ok(sites.features.length === N, `${N} site features`);
  const cls = { close: 0, medium: 0, far: 0 };
  let ksSource = true;
  for (const f of sites.features) {
    cls[f.properties.class]++;
    if (f.properties.dist_source !== "ks_full_grid") ksSource = false;
  }
  ok(JSON.stringify(cls) === JSON.stringify(s.site_classes),
     `site classes match manifest (${JSON.stringify(cls)})`);
  ok(ksSource, "all site distances sourced from KS full-grid test");

  /* null trials reproduce the reported Monte-Carlo p */
  ok(nulls.null_rms_deg.length === s.stats.n_trials,
     `${s.stats.n_trials} null trials present`);
  const k = nulls.null_rms_deg.filter((v) => v <= nulls.real_rms_deg).length;
  const p = (k + 1) / (nulls.null_rms_deg.length + 1);
  ok(Math.abs(p - s.stats.p_value) < 1e-6,
     `null trials reproduce p = ${s.stats.p_value.toFixed(6)} (k=${k})`);

  /* BH bookkeeping */
  if (s.family === "elite")
    ok(s.bh && s.bh.rejected === (s.status === "bh_significant"),
       "BH status consistent with rejection flag");
}

console.log(`\nfamilies: ${JSON.stringify(statuses)}`);
const bh = manifest.bh;
ok(statuses.bh_significant === bh.n_rejected,
   `bh_significant seeds = manifest n_rejected (${bh.n_rejected})`);
ok(statuses.bh_significant + statuses.elite_nonsignificant === bh.family_size,
   `elite family size ${bh.family_size}`);
ok(statuses.control === bh.n_controls, `${bh.n_controls} controls`);

if (fails) { console.error(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
console.log("\nAll checks passed — bundle is consistent.");
