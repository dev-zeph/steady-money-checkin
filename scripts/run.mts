// Run the whole pipeline on a folder of agency files and score it against a
// counsellor's marked list (status + how to reach). Usage:
//   npx tsx --env-file=.env.local scripts/run.ts <folder> [marks.csv] [--cache]
import fs from "node:fs";
import path from "node:path";
import { normalise, usage, costOf } from "../lib/normalize";
import { decide, summarise, resultsRows, shown } from "../lib/rules";
import { agencyFromFiles } from "../lib/agency";
import { parseCsv, toCsv } from "../lib/csv";
import type { Normalised } from "../lib/types";

const [folder, marksPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const useCache = process.argv.includes("--cache");
const outDir = path.join("out", path.basename(folder));
fs.mkdirSync(outDir, { recursive: true });
const cacheFile = path.join(outDir, "normalised.json");

const files = fs.readdirSync(folder)
  .filter((f) => /\.(csv|txt)$/i.test(f) && (!marksPath || path.resolve(folder, f) !== path.resolve(marksPath)))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(folder, f), "utf8") }));

console.log(`Agency (from the file names): ${agencyFromFiles(files.map((f) => f.name)) ?? "not found in the file names"}`);
const t0 = Date.now();
let n: Normalised;
try {
  n = useCache && fs.existsSync(cacheFile)
    ? JSON.parse(fs.readFileSync(cacheFile, "utf8"))
    : await normalise(files);
} catch (e) {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
console.log(`Clients on the attendance sheet: ${n.clients.length}\n`);
if (usage.calls) console.log(`AI use: ${usage.calls} calls, ${usage.input} in, ${usage.cacheWrite} cache write, ${usage.cacheRead} cache read, ${usage.output} out = US$${costOf(usage).toFixed(2)}`);
fs.writeFileSync(cacheFile, JSON.stringify(n, null, 2));
console.log(`Read ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, n.fileRoles.map((f) => `${f.file}=${f.role}`).join(", "));
if (n.warnings.length) console.log("Warnings:", n.warnings);
const problems = n.notes.filter((x) => x.problems.length);
console.log(`Notes: ${n.notes.length}, with problems: ${problems.length}`);
for (const p of problems.slice(0, 10)) console.log("  -", p.raw.slice(0, 70), "|", p.problems.join("; "));

const people = decide(n);
fs.writeFileSync(path.join(outDir, "people.csv"), toCsv([
  ["client_id", "name", "status", "action", "why", "how_to_reach", "reach_text", "caution"],
  ...people.map((p) => [p.id, p.name, p.status, p.action, p.why, p.reach, p.reachText, p.caution]),
]));
fs.writeFileSync(path.join(outDir, "results.csv"), toCsv(resultsRows(people)));
const s = summarise(n, people);
const page = [
  `${n.agency}: what the first results show (halfway view)`,
  ``,
  `This is a halfway view. It covers sessions ${s.firstCheck ?? 1} to ${s.latestCheck ?? "-"} of the six-session program, not the whole program.`,
  `Whole-group totals only. No client is named.`,
  ``,
  `Started (everyone on the attendance sheet): ${s.started}`,
  `Stuck with it (still coming at session ${n.sessionCount}): ${shown(s.stillComing)} of ${s.started}`,
  `Took both Money Checks (session ${s.firstCheck ?? 1} and session ${s.latestCheck ?? "-"}): ${s.tookBoth} of ${s.started}`,
  `Better off (Money Check score up by 1 point or more out of 25): ${s.improved} of the ${s.tookBoth} who took both checks (${s.started} started)`,
  ``,
  `How much scores moved, for the ${s.tookBoth} who took both checks:`,
  ...s.bands.map((b) => `  Score ${b.label}: ${shown(b.count)}`),
  ``,
  `How this was counted:`,
  ...s.rules.map((r) => `  - ${r}`),
].join("\n");
fs.writeFileSync(path.join(outDir, "agency-page.txt"), page + "\n");
console.log(`Wrote ${outDir}/results.csv and ${outDir}/agency-page.txt`);
console.log("Actions:", Object.fromEntries(["friday", "tuesday", "do not contact", "none"].map((a) => [a, people.filter((p) => p.action === a).length])));
console.log("Summary:", JSON.stringify(summarise(n, people).bands));

if (marksPath) {
  const rows = parseCsv(fs.readFileSync(marksPath, "utf8"));
  const h = rows[0];
  const col = (k: RegExp) => h.findIndex((x) => k.test(x));
  const [ci, si, ri] = [col(/id|client_no|^client/i), col(/says|status/i), col(/reach/i)];
  const norm = (r: string) => (/do not/i.test(r) ? "do not contact" : /paper|letter|mail/i.test(r) ? "paper" : /text|sms/i.test(r) ? "text" : /call|phone/i.test(r) ? "call" : "nothing noted");
  let right = 0;
  for (const r of rows.slice(1)) {
    const p = people.find((x) => x.id === r[ci]);
    const okS = p?.status === r[si];
    const okR = p?.reach === norm(r[ri]);
    if (okS && okR) right++;
    else console.log(`  WRONG ${r[ci]} ${p?.name}: status ${p?.status} vs ${r[si]}; reach ${p?.reach} vs ${norm(r[ri])} | ${p?.why} | ${p?.reachSource}`);
  }
  console.log(`\nRight (status and how to reach): ${right}/${rows.length - 1}`);
}
