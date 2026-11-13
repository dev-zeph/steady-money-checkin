import { agencyFromFiles } from "./agency";
// AI normalisation. Server-side only (uses the API key).
// Claude reads the messy files and returns plain, checkable facts.
// It never decides who goes on the Friday list: rules.ts does that.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { parseCsv, looksLikeCsv } from "./csv";
import type { Attend, Client, DiaryEntry, MarkRow, NoteFacts, Normalised, Reach, SecondRead } from "./types";

// Claude Haiku 5.5: same results as larger models on every test, about 3 cents a run.
export const MODEL = "claude-haiku-5-5";
const NOTES_PER_CALL = 40;

export interface InFile { name: string; text: string }

let client: Anthropic | null = null;
function ai() {
  if (!client) client = new Anthropic();
  return client;
}

// Token counts for the whole run, to work out what a run costs.
export const usage = { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
// Claude Opus 5.5 prices, US dollars per million tokens (cache write = 1.25x input).
// Haiku 5.5 prices, US dollars per million tokens (prompts under 100K tokens): input $0.10, output $0.50.
export const costOf = (u: typeof usage) => (u.input * 0.1 + u.output * 0.5 + u.cacheWrite * 0.125 + u.cacheRead * 0.01) / 1e6;

async function ask<T>(system: string, user: string, schema: z.ZodType<T>, maxTokens = 16000): Promise<T> {
  const res = await ai().beta.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const u = res.usage as unknown as Record<string, number | null>;
  usage.calls++;
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  usage.cacheRead += u.cache_read_input_tokens ?? 0;
  if (res.stop_reason === "refusal") throw new Error("The AI declined to read this file.");
  if (res.stop_reason === "max_tokens") throw new Error("The AI ran out of room reading this file.");
  if (!res.parsed_output) throw new Error("The AI's answer could not be read.");
  return res.parsed_output as T;
}

// ---------- Step 1: what is each file, and what do its columns and values mean ----------

const Col = z.string().nullable();
const MapSchema = z.object({
  files: z.array(z.object({
    file_name: z.string(),
    role: z.enum(["attendance", "diaries", "notes", "marks", "other"]),
  })),
  attendance: z.object({
    client_id_col: Col, name_col: z.string(), counsellor_col: Col, contact_col: Col,
    session_cols: z.array(z.object({ col: z.string(), session: z.number() })),
    money_check_cols: z.array(z.object({ col: z.string(), session: z.number() })),
  }).nullable(),
  diaries: z.object({
    name_col: z.string(), counsellor_col: Col, week_col: z.string(),
    handed_in_col: z.string(), days_col: Col,
  }).nullable(),
  marks: z.object({ client_id_col: Col, name_col: Col, status_col: z.string(), reach_col: Col }).nullable(),
  attendance_values: z.array(z.object({ raw: z.string(), meaning: z.enum(["came", "missed", "unknown"]) })),
  contact_values: z.array(z.object({ raw: z.string(), meaning: z.enum(["text", "call", "paper", "do not contact", "nothing noted"]) })),
  handed_in_values: z.array(z.object({ raw: z.string(), meaning: z.enum(["yes", "no", "not entered"]) })),
  status_values: z.array(z.object({ raw: z.string(), meaning: z.enum(["on track", "stalled"]) })),
});

const MAP_SYSTEM = `You help a community money-coaching agency make sense of its own record files for a six-session budgeting program.
Files you may see: an attendance sheet (one row per client: id, name, counsellor, phone, how to reach them, one column per session, and Money Check scores out of 25 taken at some sessions), a typed diary sheet (one row per client per week: handed in or not, days filled in, an amount), session notes (free text, one line per note), and sometimes a counsellor's own marked-up list (on track / stalled) which is only used for comparison.
Column names and values differ between agencies. Map them carefully. Use the exact header text for every column name you return.
Session columns may be called s1, Mtg 1, Wk 1, Session 1 and so on. Number them in order.
The Money Check is a score out of 25 taken at sessions 1, 4 and 6. Its columns may be called money_check_s1, Check A / Check B, MC start / MC mid, Score 1, or similar: any column of numbers from 5 to 25 per client is almost certainly a Money Check. If the session isn't written, the first one is session 1, the second is session 4 and the third is session 6.
For values: "came" = the person attended (present, P, late...). "missed" = absent, A, no show. "unknown" = blank or anything else.
Contact values: "text" (text, SMS), "call" (call, phone), "paper" (mail, letter, paper), "do not contact", "nothing noted" (blank).
Diary handed-in values: "yes", "no", or "not entered" (e.g. "not typed yet", blank).
List every distinct value you were shown in each value list. Never drop a file or a value.`;

function describeFile(f: InFile): string {
  if (looksLikeCsv(f.text)) {
    const rows = parseCsv(f.text);
    const head = rows[0];
    const distinct = head.map((h, ci) => {
      const vals = Array.from(new Set(rows.slice(1).map((r) => r[ci] ?? ""))).slice(0, 40);
      return `  - "${h}": ${vals.map((v) => JSON.stringify(v)).join(", ")}`;
    });
    return `FILE "${f.name}" (spreadsheet, ${rows.length - 1} rows)\nFirst rows:\n${rows.slice(0, 4).map((r) => r.join(" | ")).join("\n")}\nDistinct values per column:\n${distinct.join("\n")}`;
  }
  const lines = f.text.split(/\r?\n/).filter((l) => l.trim());
  return `FILE "${f.name}" (text, ${lines.length} lines)\nFirst lines:\n${lines.slice(0, 8).join("\n")}`;
}

// ---------- Step 2: read every note into facts ----------

const NoteSchema = z.object({
  notes: z.array(z.object({
    i: z.number(),
    date_as_written: z.string().nullable(),
    date: z.string().nullable(),
    name_as_written: z.string(),
    counsellor_as_written: z.string(),
    client_id: z.string().nullable(),
    match: z.enum(["sure", "unsure", "none"]),
    match_reason: z.string(),
    attended: z.enum(["came", "missed", "not stated"]),
    diary: z.enum(["set", "not set", "on hold", "not stated"]),
    away_with_notice: z.boolean(),
    contact: z.object({
      changed: z.boolean(), do_not_contact: z.boolean(), shared_phone: z.boolean(),
      no_texts: z.boolean(), texts_ok: z.boolean(), calls_ok: z.boolean(),
      paper_only: z.boolean(), ok_to_contact_again: z.boolean(), time_note: z.string().nullable(),
    }),
    evidence: z.string(),
  })),
});

function notesSystem(roster: Client[]): string {
  return `You read a counsellor's session notes for a six-session budgeting program and turn each note into plain facts. You do not judge anyone or decide who to call.

CLIENT LIST (id | full name | counsellor):
${roster.map((c) => `${c.id} | ${c.name} | ${c.counsellor}`).join("\n")}

For EVERY note line you are given, return exactly one entry with the same i. Never skip a line, never merge two lines.
- date_as_written: the session date copied exactly as it appears in the note, character for character, or null.
- date: your reading of that date as YYYY-MM-DD, or null.
- name_as_written / counsellor_as_written: exactly as the note writes them.
- client_id: which client on the list this note is about. Notes use first names and nicknames (Liz = Elizabeth, Bill = William, Tony = Anthony, Gord = Gordon, Terry = Terrence, Ron = Ronald, Ray = Raymond and so on). Use the counsellor to tell apart two clients with the same first name. match = "sure" only when exactly one client fits both the name and the counsellor; "unsure" if you had to guess; "none" (client_id null) if nobody fits. Explain in match_reason in a few words.
- attended: "missed" only if the note says they were not there (no show, not here today, away); "came" if the note describes work done with them; otherwise "not stated".
- diary: the diary/homework (HW) for the coming week. "set" (diary set, HW set), "not set" (ran long, HW not set, did not set the diary, no homework went home), "on hold" (diary on hold, still on hold, agreed pause), else "not stated".
- away_with_notice: true only if the client told the agency ahead of time they would miss sessions.
- contact: set changed=true only if the note says something about how or whether to reach them.
  do_not_contact: asked for no calls, texts or mail at all. shared_phone: phone is shared at home. no_texts: asked not to be texted. texts_ok: says text is fine. calls_ok: says calls / being phoned is fine or wanted. paper_only: letter or paper only, or phone cut off / out of service. ok_to_contact_again: true if the note says the client is now okay to be contacted, or ready to hear from us again (for example "texting her is okay, she's ready to hear from us" or "calls are fine again"), even if the earlier request is not in this note. time_note: any words about WHEN to reach them, such as "calling in the evening is fine", "daytime only, on their break", "mornings", "not before 5", "weekends". Copy the note's own words briefly. Null if the note says nothing about timing.
- evidence: copy the exact words from the note that support the attended, diary, away and contact facts. Copy them character for character. Empty string if nothing applies.`;
}

const DiaryKeySchema = z.object({
  keys: z.array(z.object({
    k: z.number(), client_id: z.string().nullable(),
    match: z.enum(["sure", "unsure", "none"]), match_reason: z.string(),
  })),
});

// ---------- Main ----------

function pick(row: string[], head: string[], col: string | null): string {
  if (!col) return "";
  const i = head.indexOf(col);
  return i < 0 ? "" : row[i] ?? "";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Look at every date in the file together and pick one reading for all of them.
export function dateReader(samples: string[]): (s: string | null) => string | null {
  const nums = samples.map((s) => s.match(/^\D*(\d{1,4})\D+(\d{1,2})(?:\D+(\d{2,4}))?/)).filter(Boolean) as RegExpMatchArray[];
  const firstBig = nums.some((m) => m[1].length <= 2 && Number(m[1]) > 12);
  const secondBig = nums.some((m) => Number(m[2]) > 12);
  const dayFirst = firstBig && !secondBig; // otherwise assume month first (North American)
  const yearGuess = new Date().getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (s) => {
    if (!s) return null;
    const t = s.trim();
    let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    m = t.match(/(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/);
    if (m) {
      const a = +m[1], b = +m[2];
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : yearGuess;
      const [mo, d] = dayFirst ? [b, a] : [a, b];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
    }
    m = t.toLowerCase().match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:\D+(\d{4}))?/);
    if (m && MONTHS.includes(m[1])) return `${m[3] ?? yearGuess}-${pad(MONTHS.indexOf(m[1]) + 1)}-${pad(+m[2])}`;
    return null;
  };
}

function firstWord(s: string) { return s.trim().split(/\s+/)[0]?.toLowerCase() ?? ""; }

// Words that always mean "do not contact": no calls together with no texts or mail,
// or a plain "do not contact". "No texts please" alone does not match.
const NO_CONTACT = /\b(do not|don't|dont)\s+contact\b|\bno contact\b|\bnot to be contacted\b|\bnot to (reach out|contact|call\s*(,|or|and)\s*text)\b|\bno calls?\s*(,|\/|and|or|&)?\s*(no\s+)?(texts?|sms|mail|letters?)\b/i;

// A Money Check score out of 25. Accepts "18", " 18 ", "18/25", "18 / 25".
// Anything else (blank, n/a, a typo like 180) is treated as missing, never guessed.
function score(v: string, who: string, warnings: string[]): number | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})(?:\s*\/\s*25)?$/);
  const n = m ? Number(m[1]) : NaN;
  if (n >= 5 && n <= 25) return n;
  warnings.push(`${who}'s Money Check score "${t}" isn't a number from 5 to 25, so it is treated as missing. Check the sheet.`);
  return null;
}

// If the AI didn't map a contact value, read the plain words ourselves.
function contactWord(mapped: Reach, raw: string): Reach {
  if (mapped !== "nothing noted") return mapped;
  const v = raw.toLowerCase();
  if (/do not|don't|no contact/.test(v)) return "do not contact";
  if (/mail|letter|paper|post/.test(v)) return "paper";
  if (/text|sms|message/.test(v)) return "text";
  if (/call|phone|cell|ring/.test(v)) return "call";
  return "nothing noted";
}

export async function normalise(files: InFile[], agencyName?: string): Promise<Normalised> {
  const warnings: string[] = [];
  const map = await ask(MAP_SYSTEM, files.map(describeFile).join("\n\n"), MapSchema);
  const byRole = (role: string) => {
    const hit = map.files.find((f) => f.role === role);
    return hit ? files.find((f) => f.name === hit.file_name) ?? null : null;
  };
  const vmap = <T extends string>(list: { raw: string; meaning: T }[], raw: string, fallback: T): T => {
    const k = raw.trim().toLowerCase();
    return list.find((v) => v.raw.trim().toLowerCase() === k)?.meaning ?? fallback;
  };

  // Attendance sheet -> roster
  const attFile = byRole("attendance");
  if (!attFile || !map.attendance) throw new Error("Could not find the attendance sheet among the files.");
  const ar = parseCsv(attFile.text);
  const ah = ar[0];
  const am = map.attendance;
  for (const c of [am.client_id_col, am.name_col, am.counsellor_col, am.contact_col, ...am.session_cols.map((s) => s.col), ...am.money_check_cols.map((s) => s.col)]) {
    if (c && !ah.includes(c)) warnings.push(`The AI named a column "${c}" that is not in the attendance sheet.`);
  }
  const sessionCols = [...am.session_cols].sort((a, b) => a.session - b.session);
  if (!am.money_check_cols.length) warnings.push("No Money Check score columns were found in the attendance sheet, so the renewal page can't show score changes. Check the sheet has them.");
  if (!sessionCols.length) warnings.push("No session attendance columns were found in the attendance sheet.");
  const clients: Client[] = ar.slice(1).map((r, idx) => {
    const raw = pick(r, ah, am.contact_col);
    const mc: Record<string, number | null> = {};
    for (const m of am.money_check_cols) {
      const v = pick(r, ah, m.col);
      mc[String(m.session)] = score(v, pick(r, ah, am.name_col), warnings);
    }
    return {
      id: pick(r, ah, am.client_id_col) || `row-${idx + 1}`,
      name: pick(r, ah, am.name_col),
      counsellor: pick(r, ah, am.counsellor_col),
      sheetContactRaw: raw,
      sheetContact: raw ? contactWord(vmap(map.contact_values, raw, "nothing noted") as Reach, raw) : "nothing noted",
      sessions: sessionCols.map((s) => vmap(map.attendance_values, pick(r, ah, s.col), "unknown") as Attend),
      moneyCheck: mc,
    };
  });

  // Notes -> facts, in parallel batches. Every line must come back.
  const notesFile = byRole("notes");
  const lines = notesFile ? notesFile.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  if (!notesFile || !lines.length) throw new Error("Stopped: no session notes file was found, so who asked not to be contacted can't be read. No results were written.");
  const sys = notesSystem(clients);
  const batches: number[][] = [];
  for (let i = 0; i < lines.length; i += NOTES_PER_CALL) batches.push(lines.slice(i, i + NOTES_PER_CALL).map((_, k) => i + k));
  const readBatch = async (idx: number[]) => {
    const out = await ask(sys, `NOTE LINES:\n${idx.map((i) => `${i}: ${lines[i]}`).join("\n")}`, NoteSchema);
    return out.notes;
  };
  const got = (await Promise.all(batches.map(readBatch))).flat();
  // Retry any line the AI skipped, once.
  const seen = new Set(got.map((n) => n.i));
  const missing = lines.map((_, i) => i).filter((i) => !seen.has(i));
  if (missing.length) got.push(...(await readBatch(missing)));

  const ids = new Set(clients.map((c) => c.id));
  // Dates: the code, not the AI, decides the date format once for the whole file,
  // so "11/03" can't mean November in one batch and March in another.
  const fixDate = dateReader(got.map((n) => n.date_as_written ?? "").filter(Boolean));
  for (const n of got) n.date = fixDate(n.date_as_written) ?? n.date;
  const dates = Array.from(new Set(got.map((n) => n.date).filter((d): d is string => !!d))).sort();
  if (dates.length > sessionCols.length + 2) {
    warnings.push(`The notes have ${dates.length} different dates but the attendance sheet has ${sessionCols.length} sessions. Session order may be wrong: check the dates.`);
  }
  const notes: NoteFacts[] = lines.map((raw, i) => {
    const n = got.find((g) => g.i === i);
    const problems: string[] = [];
    if (!n) {
      return {
        index: i, raw, date: null, session: null, nameAsWritten: "", counsellorAsWritten: "", clientId: null,
        match: "none", matchReason: "", attended: "not stated", diary: "not stated", awayWithNotice: false,
        contact: { changed: false, doNotContact: false, sharedPhone: false, noTexts: false, textsOk: false, callsOk: false, paperOnly: false, okAgain: false, timeNote: null },
        evidence: "", problems: ["The AI did not read this note. Check it by hand."],
      };
    }
    let clientId = n.client_id && ids.has(n.client_id) ? n.client_id : null;
    if (n.client_id && !clientId) problems.push(`The AI named a client id (${n.client_id}) that isn't on the attendance sheet.`);
    let match = clientId ? n.match : "none";
    const c = clients.find((x) => x.id === clientId);
    if (c && n.counsellor_as_written && c.counsellor && firstWord(c.counsellor) !== firstWord(n.counsellor_as_written)) {
      problems.push(`Note is by ${n.counsellor_as_written} but ${c.name}'s counsellor is ${c.counsellor}.`);
      match = "unsure";
    }
    if (n.evidence && !raw.includes(n.evidence)) problems.push("The AI's quoted evidence isn't word for word in the note.");
    if (!clientId) problems.push("This note isn't linked to anyone.");
    // Safety net in plain code: if the note's own words ask for no contact, it is a
    // do-not-contact note, whatever the AI said. This can only make a result safer.
    const askedNoContact = NO_CONTACT.test(raw) && !n.contact.ok_to_contact_again;
    if (askedNoContact && !n.contact.do_not_contact) problems.push("The note's words ask for no contact, so it is treated as do not contact (the AI had missed this).");
    return {
      index: i, raw, date: n.date, session: n.date ? dates.indexOf(n.date) + 1 : null,
      nameAsWritten: n.name_as_written, counsellorAsWritten: n.counsellor_as_written,
      clientId, match, matchReason: n.match_reason, attended: n.attended, diary: n.diary,
      awayWithNotice: n.away_with_notice,
      contact: {
        changed: n.contact.changed || askedNoContact, doNotContact: n.contact.do_not_contact || askedNoContact, sharedPhone: n.contact.shared_phone,
        noTexts: n.contact.no_texts, textsOk: n.contact.texts_ok, callsOk: n.contact.calls_ok,
        paperOnly: n.contact.paper_only, okAgain: n.contact.ok_to_contact_again, timeNote: n.contact.time_note,
      },
      evidence: n.evidence, problems,
    };
  });

  // If most notes can't be read or linked to a client, stop rather than write results.
  const readable = notes.filter((x) => x.clientId && x.date).length;
  if (readable < notes.length / 2) {
    throw new Error(`Stopped: only ${readable} of ${notes.length} notes could be read and linked to a client, so the results can't be trusted. No results were written. Check the notes file is the right one.`);
  }
  if (readable < notes.length) warnings.push(`${notes.length - readable} of ${notes.length} notes could not be read or linked to a client. See "Check these".`);
  // A do-not-contact note whose name fits more than one client protects all of them.
  const lc = (t: string) => t.toLowerCase().replace(/[^a-z\u00c0-\u024f'-]/g, "");
  for (const x of notes) {
    if (!x.contact.doNotContact) continue;
    const nm = lc(x.nameAsWritten.split(/\s+/)[0] ?? "");
    if (!nm) continue;
    const fits = clients.filter((c) => c.name.split(/\s+/).some((w) => lc(w) === nm)
      && (!x.counsellorAsWritten || !c.counsellor || firstWord(c.counsellor) === firstWord(x.counsellorAsWritten)));
    x.alsoCould = fits.map((c) => c.id).filter((id) => id !== x.clientId);
    if (x.alsoCould.length) {
      x.match = "unsure";
      warnings.push(`A note asking for no contact could be about more than one client (${[x.clientId, ...x.alsoCould].filter(Boolean).map((id) => clients.find((c) => c.id === id)?.name).join(", ")}). All of them are treated as do not contact until someone checks: "${x.raw.slice(0, 80)}"`);
    }
  }
  for (const x of notes) if (x.contact.doNotContact && x.match !== "sure" && !x.alsoCould?.length) warnings.push(`A note asking for no contact is not firmly linked to a client: "${x.raw.slice(0, 80)}". Check it before anyone is contacted.`);

  // Second reader: reread each person's contact notes together, in date order.
  let secondRead: Record<string, SecondRead> | undefined;
  try { secondRead = await readContactHistory(clients, notes); }
  catch { warnings.push("The contact notes could only be read one line at a time this week, so messy wording may have been missed. Check contact details by hand before reaching out."); }

  // Diaries -> entries, with names matched by the AI.
  const diaries: DiaryEntry[] = [];
  const dFile = byRole("diaries");
  if (dFile && map.diaries) {
    const dr = parseCsv(dFile.text);
    const dh = dr[0];
    const dm = map.diaries;
    const keyOf = (r: string[]) => `${pick(r, dh, dm.name_col)} | ${pick(r, dh, dm.counsellor_col)}`;
    const keys = Array.from(new Set(dr.slice(1).map(keyOf)));
    // First, the code matches "First L." + counsellor where exactly one client fits.
    const km = new Map<string, { client_id: string | null; match: "sure" | "unsure" | "none"; match_reason: string }>();
    const leftover: string[] = [];
    for (const key of keys) {
      const [nm, couns] = key.split(" | ");
      const [first, init] = nm.trim().split(/\s+/);
      const hits = clients.filter((c) => {
        const [cf, ...rest] = c.name.split(/\s+/);
        const last = rest[rest.length - 1] ?? "";
        return cf.toLowerCase() === (first ?? "").toLowerCase()
          && (!init || last[0]?.toLowerCase() === init[0]?.toLowerCase())
          && (!couns || !c.counsellor || firstWord(c.counsellor) === firstWord(couns));
      });
      if (hits.length === 1) km.set(key, { client_id: hits[0].id, match: "sure", match_reason: "Same first name, last initial and counsellor" });
      else leftover.push(key);
    }
    // Then the AI handles nicknames and anything unclear, answering by line number.
    if (leftover.length) {
      const res = await ask(
        `Match each name from a typed diary sheet to one client on this list. Diary names are usually written like "First L." with the counsellor, sometimes with nicknames. Use the counsellor to tell apart two people with the same first name and initial. "sure" only if exactly one client fits; else "unsure" or "none".\n\nCLIENT LIST (id | full name | counsellor):\n${clients.map((c) => `${c.id} | ${c.name} | ${c.counsellor}`).join("\n")}`,
        `DIARY NAMES (k: name | counsellor):\n${leftover.map((k, i) => `${i}: ${k}`).join("\n")}\n\nReturn one entry for every k.`,
        DiaryKeySchema,
      );
      for (const r of res.keys) if (leftover[r.k] != null) km.set(leftover[r.k], r);
    }
    for (const r of dr.slice(1)) {
      const k = km.get(keyOf(r));
      const cid = k?.client_id && ids.has(k.client_id) ? k.client_id : null;
      const days = pick(r, dh, dm.days_col);
      diaries.push({
        key: keyOf(r), clientId: cid, match: cid ? (k!.match) : "none", matchReason: k?.match_reason ?? "Not matched",
        week: Number(pick(r, dh, dm.week_col)) || 0,
        handedIn: vmap(map.handed_in_values, pick(r, dh, dm.handed_in_col), "not entered"),
        daysFilled: days && !isNaN(Number(days)) ? Number(days) : null,
      });
    }
    const unlinked = diaries.filter((d) => !d.clientId).length;
    if (unlinked) warnings.push(`${unlinked} of ${diaries.length} diary lines could not be linked to anyone, so those diaries are ignored. Check the names on the "Check these" tab before trusting who is stalled.`);
  } else warnings.push("No diary sheet found.");

  // A counsellor's marked list, if uploaded: used only to compare.
  let marks: MarkRow[] | null = null;
  const mFile = byRole("marks");
  if (mFile && map.marks) {
    const mr = parseCsv(mFile.text);
    const mh = mr[0];
    const mm = map.marks;
    marks = mr.slice(1).map((r) => {
      const id = pick(r, mh, mm.client_id_col);
      const nm = pick(r, mh, mm.name_col);
      const cid = id && ids.has(id) ? id : clients.find((c) => c.name.toLowerCase() === nm.toLowerCase())?.id ?? id;
      return { clientId: cid, status: vmap(map.status_values, pick(r, mh, mm.status_col), "on track"), reach: vmap(map.contact_values, pick(r, mh, mm.reach_col), "nothing noted") };
    });
  }

  return {
    agency: agencyFromFiles(map.files.filter((f) => f.role !== "marks" && f.role !== "other").map((f) => f.file_name)) || agencyName || "Agency (name not in the file names)",
    sessionCount: sessionCols.length,
    clients, diaries, notes, marks,
    fileRoles: map.files.map((f) => ({ file: f.file_name, role: f.role })),
    warnings,
    secondRead,
  };
}

const SECOND_SYSTEM = `You are the second reader of a money-coaching agency's session notes. A first reader has already gone through each note line by line. Your job is to read ALL of one client's notes together, oldest first, and say what the CURRENT instruction is for reaching them.
Read for meaning, not keywords. Be careful with messy wording:
- The newest instruction wins over older ones and over the day-one sheet, unless the newer note is about something else.
- "No contact with the old landline" or "do not contact at the work number" is about a phone number, not the person. "Please don't call the house, text only" means text. "Do not discuss things with her mother" is not a request to stop contact. A client texting the counsellor is not an instruction.
- If a client asked for no contact and a later note says they are fine to hear from us again, or names a way to reach them, the request is lifted.
- A shared phone means someone else may answer or see messages.
- Self-corrections count as the final version ("after 4? No, before 3" means before 3).
way: "do not contact", "paper" (letter only, or phone cut off), "call", "text", or "nothing noted" if nothing says how to reach them and the sheet is blank.
when: any timing in the current instruction, in a few words (for example "daytime, on lunch break", "before 3", "evenings"), else null.
"do not contact" only when the client (or a note on their behalf) asked not to be contacted. A shared phone, no texts, or no safe time given is NOT a reason for do not contact: say call, set shared_phone, and mention the care needed in reason. Only if a note is genuinely unclear about whether the client asked for no contact, pick do not contact and say why. reason: one short plain sentence.`;

const SecondSchema = z.object({ people: z.array(z.object({
  client_id: z.string(),
  way: z.enum(["do not contact", "paper", "call", "text", "nothing noted"]),
  when: z.string().nullable(),
  shared_phone: z.boolean(),
  reason: z.string(),
})) });

// Only people whose contact is in question: a contact note, a no-contact word, or a no-contact sheet.
async function readContactHistory(clients: Client[], notes: NoteFacts[]): Promise<Record<string, SecondRead>> {
  const who = clients.filter((c) => c.sheetContact === "do not contact"
    || notes.some((x) => x.clientId === c.id && (x.contact.changed || NO_CONTACT.test(x.raw))));
  const out: Record<string, SecondRead> = {};
  for (let i = 0; i < who.length; i += 30) {
    const chunk = who.slice(i, i + 30);
    const text = chunk.map((c) => {
      const mine = notes.filter((x) => x.clientId === c.id).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.index - b.index);
      return `CLIENT ${c.id}
Day-one sheet says: ${c.sheetContactRaw || "(blank)"}
Notes, oldest first:
${mine.map((x) => `- [${x.date ?? "no date"}] ${x.raw}`).join("\n")}`;
    }).join("\n\n");
    const res = await ask(SECOND_SYSTEM, text, SecondSchema);
    for (const p of res.people) if (chunk.some((c) => c.id === p.client_id)) out[p.client_id] = { way: p.way, when: p.when, sharedPhone: p.shared_phone, reason: p.reason };
  }
  return out;
}
