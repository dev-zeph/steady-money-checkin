// Score the tool against a hand-written answer key: status, how to reach, timing,
// shared phone, check-in-person, and the agency page numbers.
// Usage: npx tsx --env-file=.env.local scripts/trap-test.mts ../stress/traps [--cache]
import fs from "node:fs";
import path from "node:path";
import { normalise } from "../lib/normalize";
import { decide, summarise, wayToReach } from "../lib/rules";
import { parseCsv } from "../lib/csv";
import type { Normalised } from "../lib/types";

const folder = process.argv[2];
const outDir = path.join("out", path.basename(folder));
fs.mkdirSync(outDir, { recursive: true });
const cache = path.join(outDir, "normalised.json");
const files = fs.readdirSync(folder).filter((f) => /\.(csv|txt)$/i.test(f) && f !== "answer-key.csv")
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(folder, f), "utf8") }));
const n: Normalised = process.argv.includes("--cache") && fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : await normalise(files);
fs.writeFileSync(cache, JSON.stringify(n, null, 2));
const people = decide(n);
const [h, ...rows] = parseCsv(fs.readFileSync(path.join(folder, "answer-key.csv"), "utf8"));
const col = (r: string[], k: string) => r[h.indexOf(k)] ?? "";

let all = 0, statusReach = 0, dncFail = 0;
const checks: Record<string, [number, number]> = { status: [0, 0], reach: [0, 0], when: [0, 0], shared: [0, 0], check: [0, 0] };
const tick = (k: string, ok: boolean) => { checks[k][1]++; if (ok) checks[k][0]++; return ok; };
for (const r of rows) {
  const id = col(r, "client_id"); const p = people.find((x) => x.id === id);
  if (!p) { console.log(`MISSING ${id}`); continue; }
  const tips = p.reachTips.join(" ").toLowerCase();
  const fails: string[] = [];
  if (!tick("status", p.status === col(r, "status"))) fails.push(`status ${p.status} (key ${col(r, "status")})`);
  const way = wayToReach(p);
  if (!tick("reach", way === col(r, "how_to_reach"))) fails.push(`reach ${way} (key ${col(r, "how_to_reach")})`);
  if (col(r, "how_to_reach") === "do not contact" && way !== "do not contact") dncFail++;
  const when = col(r, "when"), notWhen = col(r, "not_when");
  const hasWhen = /when:/.test(tips);
  const whenOk = when ? hasWhen && new RegExp(when, "i").test(tips) && !(notWhen && new RegExp(notWhen, "i").test(tips)) : !hasWhen;
  if (!tick("when", whenOk)) fails.push(`timing "${p.reachTips.find((t) => t.startsWith("When")) ?? "none"}" (key ${when || "none"})`);
  const shared = col(r, "shared_phone");
  if (shared) { const has = /shared phone/.test(tips); if (!tick("shared", has === (shared === "yes"))) fails.push(`shared phone ${has ? "shown" : "not shown"} (key ${shared})`); }
  const chk = p.contactCheck.includes("check to be sure");
  if (!tick("check", chk === (col(r, "check_in_person") === "yes"))) fails.push(`check in person ${chk ? "yes" : "no"} (key ${col(r, "check_in_person")})`);
  if (!fails.length) all++;
  if (p.status === col(r, "status") && way === col(r, "how_to_reach")) statusReach++;
  console.log(`${fails.length ? "WRONG" : "ok   "} ${id} ${p.name}${fails.length ? ": " + fails.join("; ") : ""}`);
}
console.log(`\nStatus and how to reach (the Friday scoring): ${statusReach}/${rows.length}`);
console.log(`Everything right, including timing and safety details: ${all}/${rows.length}`);
for (const [k, [a, b]] of Object.entries(checks)) console.log(`  ${k}: ${a}/${b}`);
console.log(`Do-not-contact people given a way to reach them: ${dncFail} ${dncFail ? "(FAILS THE RUN)" : ""}`);

const key = JSON.parse(fs.readFileSync(path.join(folder, "page-key.json"), "utf8"));
const s = summarise(n, people);
const got: Record<string, number> = { started: s.started, stillComing: s.stillComing, tookBoth: s.tookBoth, improved: s.improved };
let pageOk = 0, pageN = 0;
console.log("\nAgency page:");
for (const k of ["started", "stillComing", "tookBoth", "improved"]) { pageN++; const ok = got[k] === key[k]; if (ok) pageOk++; console.log(`  ${ok ? "ok   " : "WRONG"} ${k}: ${got[k]} (key ${key[k]})`); }
for (const b of s.bands) { pageN++; const ok = b.count === key.bands[b.label]; if (ok) pageOk++; console.log(`  ${ok ? "ok   " : "WRONG"} ${b.label}: ${b.count} (key ${key.bands[b.label]})`); }
console.log(`Agency page numbers right: ${pageOk}/${pageN}`);
if (n.warnings.length) console.log("\nWarnings:", n.warnings);
