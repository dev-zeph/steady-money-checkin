// Written rules. No AI here: same facts in, same answer out, and every
// decision carries the reason and the words it came from.
import type { Normalised, NoteFacts, Overrides, Reach } from "./types";

export type Action = "friday" | "tuesday" | "do not contact" | "none";

export interface Person {
  id: string;
  name: string;
  counsellor: string;
  status: "stalled" | "on track";
  action: Action;
  why: string; // one plain line for the list
  reach: Reach; // for the answer key: text | call | paper | do not contact | nothing noted
  reachText: string; // what Maya reads
  caution: string | null;
  reachTips: string[]; // timing and safety details from the notes, in plain words
  secondOpinion: string | null; // what the second reader said, when it was asked
  reachSource: string; // where the contact rule came from
  contactCheck: string; // plain note for the counsellor on how far to trust the contact way
  missedLastTwo: boolean;
  awayWithNotice: boolean;
  diaryWeeksCounted: { week: number; handedIn: string }[];
  thinWeeks: number[];
  scoreFirst: number | null;
  scoreLatest: number | null;
  needsCheck: string[]; // anything a person should look at before trusting this row
  lastTwoSessions: number[]; // the two most recent sessions, as session numbers
  lastTwoAttendance: string[]; // what the sheet says for them
}

export const RULES = [
  "Stalled: missed the last two sessions without telling the agency ahead of time, OR nothing came back for the last two weeks a diary actually went home.",
  "Weeks with no diary set, a diary on hold, and time away with notice never count against anyone.",
  "Reach out on Friday: stalled because they stopped coming. Tuesday word: still coming every week, but behind on diaries or handing in thin pages (one or two days filled).",
  "Contact: the counsellor's session notes win over the day-one sheet, and the list says when they differ. If only the day-one sheet says how to reach someone, the list says to check in person first: clients often answered it on day one without thinking.",
  "Anyone who has asked not to be contacted is never on the Friday list. They are listed separately to see in person.",
  "Shared phones are never decided for the counsellor: the list says \"shared phone, check notes\".",
];

function applyOverrides(n: Normalised, o: Overrides) {
  const notes = n.notes.map((x) =>
    x.index in o.noteClient ? { ...x, clientId: o.noteClient[x.index], match: "sure" as const, problems: [] } : x,
  );
  const diaries = n.diaries.map((d) =>
    d.key in o.diaryClient ? { ...d, clientId: o.diaryClient[d.key], match: "sure" as const } : d,
  );
  return { notes, diaries };
}

const byTime = (a: NoteFacts, b: NoteFacts) => (a.date ?? "").localeCompare(b.date ?? "") || a.index - b.index;

const lower = (t: string) => { const s = t.trim().replace(/([^.!?])$/, "$1."); return s.charAt(0).toLowerCase() + s.slice(1); };
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function decide(n: Normalised, o: Overrides = { noteClient: {}, diaryClient: {} }): Person[] {
  const { notes, diaries } = applyOverrides(n, o);
  // "Last two sessions" = the last two session columns that have any data at all.
  const live = n.clients[0]?.sessions.map((_, i) => i).filter((i) => n.clients.some((c) => c.sessions[i] !== "unknown")) ?? [];
  const lastTwo = live.slice(-2);
  const checkKeys = Object.keys(n.clients[0]?.moneyCheck ?? {}).map(Number).sort((a, b) => a - b);

  return n.clients.map((c) => {
    const mine = notes.filter((x) => x.clientId === c.id).sort(byTime);
    const needsCheck: string[] = [];
    for (const x of mine) if (x.match === "unsure") needsCheck.push(`Note "${x.raw.slice(0, 60)}..." was matched to them as a guess (${x.matchReason}).`);
    for (const d of diaries.filter((d) => d.clientId === c.id && d.match === "unsure")) needsCheck.push(`Diary name "${d.key}" was matched to them as a guess.`);

    // Attendance
    // A blank in a session other people attended counts as missed: agencies have no
    // "left" column, so someone who has left just shows as blanks (Dana, Thursday call).
    const gone = (i: number) => c.sessions[i] === "missed" || c.sessions[i] === "unknown";
    const missedLastTwo = lastTwo.length === 2 && lastTwo.every(gone);
    const blankLastTwo = missedLastTwo && lastTwo.some((i) => c.sessions[i] === "unknown");
    const awayWithNotice = mine.some((x) => x.awayWithNotice);

    // Diaries: walk the sessions, carrying "on hold" forward until a note says the diary is set again.
    const noteBySession = new Map<number, NoteFacts>();
    for (const x of mine) if (x.session) noteBySession.set(x.session, x);
    const mineD = diaries.filter((d) => d.clientId === c.id).sort((a, b) => a.week - b.week);
    let hold = false;
    const counted: { week: number; handedIn: string }[] = [];
    const thinWeeks: number[] = [];
    const maxWeek = Math.max(0, ...mineD.map((d) => d.week));
    for (let w = 1; w <= maxWeek; w++) {
      const note = noteBySession.get(w);
      if (note?.diary === "on hold") hold = true;
      if (note?.diary === "set") hold = false;
      const d = mineD.find((x) => x.week === w);
      if (d?.handedIn === "yes" && d.daysFilled != null && d.daysFilled <= 2) thinWeeks.push(w);
      if (hold || note?.diary === "not set" || !d || d.handedIn === "not entered") continue;
      counted.push({ week: w, handedIn: d.handedIn });
    }
    const lastCounted = counted.slice(-2);
    const stalledDiary = lastCounted.length === 2 && lastCounted.every((x) => x.handedIn === "no");

    // Contact: newest instruction in the notes wins.
    const latest = [...mine].reverse().find((x) => x.contact.changed);
    let reach: Reach;
    let reachText: string;
    let caution: string | null = null;
    let reachSource: string;
    // Safety: once someone has asked not to be contacted (in the notes or on the sheet),
    // that stands until a later note clearly says they agree to be contacted again.
    const maybeMine = notes.filter((x) => x.contact.doNotContact && x.alsoCould?.includes(c.id));
    if (maybeMine.length) needsCheck.push("A do-not-contact note might be about them (the name fits more than one client). Treated as do not contact until checked.");
    const dncNotes = [...mine.filter((x) => x.contact.doNotContact), ...maybeMine].sort(byTime);
    const lastDnc = dncNotes[dncNotes.length - 1];
    const lifts = (x: NoteFacts) => !x.contact.doNotContact && x.match === "sure" && (x.contact.okAgain || x.contact.textsOk || x.contact.callsOk);
    const liftedAfter = (d: NoteFacts) => mine.some((x) => byTime(x, d) > 0 && lifts(x));
    const dncStands = lastDnc ? !liftedAfter(lastDnc) : c.sheetContact === "do not contact" && !mine.some(lifts);
    if (dncStands) {
      reach = "do not contact";
      reachText = "Do not contact (no calls, texts or mail)";
      reachSource = lastDnc ? `Note ${lastDnc.date ?? ""}: "${lastDnc.evidence || lastDnc.raw}"` : "Day-one sheet says do not contact.";
    } else if (latest) {
      const k = latest.contact;
      reachSource = `Note ${latest.date ?? ""}: "${latest.evidence || latest.raw}"`;
      if (k.doNotContact) { reach = "do not contact"; reachText = "Do not contact (no calls, texts or mail)"; }
      else if (k.paperOnly) { reach = "paper"; reachText = "Letter / paper only"; }
      else if (k.noTexts) { reach = "call"; reachText = "Call, no texts"; }
      else if (k.textsOk) { reach = "text"; reachText = "Text is fine"; }
      else if (k.sharedPhone) { reach = "call"; reachText = "Call, no texts"; }
      else if (k.callsOk) { reach = "call"; reachText = "Call, not text"; }
      else { reach = c.sheetContact; reachText = `Sheet says ${c.sheetContactRaw || "nothing"}`; }
      if (k.sharedPhone) caution = "Shared phone, check notes";
    } else {
      reach = c.sheetContact;
      reachSource = "Day-one sheet. Nothing newer in the notes.";
      reachText = c.sheetContactRaw ? `${c.sheetContactRaw} (day-one sheet, nothing newer noted)` : "Nothing noted";
    }

    // Timing and safety details. These matter as much as the channel: a call at the
    // wrong time on a shared phone can do harm. Like the contact way itself, they come
    // from the newest note about contact, so "own phone now" cancels an older "shared phone".
    const reachTips: string[] = [];
    if (reach !== "do not contact" && latest) {
      const timed = latest.contact.timeNote ? latest : undefined;
      const shared = latest.contact.sharedPhone ? latest : undefined;
      if (timed) reachTips.push(`When: ${cap(timed.contact.timeNote!.replace(/[.\s]+$/, ""))} (note ${timed.date ?? ""}). Stick to that time.`);
      if (shared) {
        if (!caution) caution = "Shared phone, check notes";
        reachTips.push(reach === "text"
          ? `Someone else may see their phone (note ${shared.date ?? ""}). Keep any text short and general, with nothing about money.`
          : `Shared phone at home (note ${shared.date ?? ""}). Never text. Someone else may answer, so ask for them by first name and keep it general until you know it's them.`);
        if (!timed) reachTips.push("No safe time is noted. Ask in person at the next session when a good time to call is.");
      }
    }

    // Second reader: if it reads the notes differently, take the safer answer and ask a person.
    let secondOpinion: string | null = null;
    const r2 = n.secondRead?.[c.id];
    if (r2) {
      const same = (a: Reach) => (a === "nothing noted" ? "call" : a);
      const when2 = r2.when ? `, ${r2.when}` : "";
      if (same(r2.way) === same(reach)) secondOpinion = null;
      else if (r2.way === "do not contact") {
        secondOpinion = `Unsure. Reading all their notes together, I think they may have asked not to be contacted: ${lower(r2.reason)} So they are held as do not contact until you check.`;
        needsCheck.push(`Unsure about contact. Reading all their notes together, I think they may have asked not to be contacted: ${lower(r2.reason)} Held as do not contact until you check the notes.`);
        reach = "do not contact"; reachText = "Do not contact (held until checked)"; reachTips.length = 0;
      } else {
        secondOpinion = `Unsure. Reading all their notes together, I think the way to reach them may be ${r2.way}${when2}: ${lower(r2.reason)} The list says ${reach}. Check the notes before reaching out.`;
        needsCheck.push(`Unsure about contact. The list says ${reach}, but reading all their notes together, I think it may be ${r2.way}${when2}: ${lower(r2.reason)} Check the notes before reaching out.`);
      }
      if (reach !== "do not contact") {
        if (r2.when && !reachTips.some((t) => t.startsWith("When:"))) reachTips.push(`I think the best time may be ${r2.when}. Check the note before relying on it.`);
        if (r2.sharedPhone && !reachTips.some((t) => /shared phone|may see their phone/i.test(t))) reachTips.push("I think someone else may answer or see this phone. Check the note, and keep it general.");
      }
    }

    // Be open about where the contact way came from. Maya's notes beat the day-one sheet,
    // but the sheet is often out of date and the notes only know what clients said.
    const fromSheet = reachSource.startsWith("Day-one");
    const contactCheck = fromSheet
      ? `Only the day-one sheet says ${c.sheetContactRaw || "nothing"}; nothing newer in the notes. Maya should check to be sure, and ask in person how and when is best to reach them.`
      : reach !== c.sheetContact
        ? `Notes override the day-one sheet (sheet said ${c.sheetContactRaw || "nothing"}).`
        : "Notes agree with the day-one sheet.";

    const stopped = missedLastTwo && !awayWithNotice;
    if (blankLastTwo) needsCheck.push("Attendance is blank for the last two sessions, so they were treated as no longer coming. Check whether they left.");
    const status = stopped || stalledDiary ? "stalled" : "on track";
    let action: Action = "none";
    let why = "Coming and keeping up";
    if (stopped) { action = "friday"; why = blankLastTwo ? "Last two sessions blank on the sheet (may have left), no notice given" : "Missed the last two sessions, no notice given"; }
    else if (stalledDiary) { action = "tuesday"; why = "Comes every week, nothing back for the last two diary weeks. Start with what the diary is for, not \"you didn't do it\""; }
    else if (thinWeeks.length) { action = "tuesday"; why = `Thin diary page (1 or 2 days) in week ${thinWeeks.join(", ")}. Start with what the diary is for`; }
    else if (missedLastTwo && awayWithNotice) why = "Away with notice";
    if (reach === "do not contact" && action !== "none") action = "do not contact";

    const scoreFirst = checkKeys.length ? c.moneyCheck[String(checkKeys[0])] : null;
    const later = checkKeys.slice(1).reverse().map((k) => c.moneyCheck[String(k)]).find((v) => v != null) ?? null;

    return {
      id: c.id, name: c.name, counsellor: c.counsellor, status, action, why,
      reach, reachText, caution, reachTips, secondOpinion, reachSource, contactCheck, missedLastTwo, awayWithNotice,
      diaryWeeksCounted: counted, thinWeeks, scoreFirst, scoreLatest: later, needsCheck,
      lastTwoSessions: lastTwo.map((i) => i + 1), lastTwoAttendance: lastTwo.map((i) => c.sessions[i]),
    };
  });
}

// ---------- Renewal page: whole-group totals only ----------

export interface Summary {
  started: number;
  stillComing: number;
  stoppedComing: number;
  firstCheck: number | null;
  latestCheck: number | null;
  bands: { label: string; count: number }[];
  noLatestScore: number;
  tookBoth: number;
  improved: number;
  rules: string[];
}

export const SMALL_GROUP = 5;
export const shown = (k: number) => (k > 0 && k < SMALL_GROUP ? `fewer than ${SMALL_GROUP}` : String(k));

export function summarise(n: Normalised, people: Person[]): Summary {
  const keys = Object.keys(n.clients[0]?.moneyCheck ?? {}).map(Number).sort((a, b) => a - b);
  const withData = keys.filter((k) => n.clients.some((c) => c.moneyCheck[String(k)] != null));
  const both = people.filter((p) => p.scoreFirst != null && p.scoreLatest != null);
  const diff = both.map((p) => p.scoreLatest! - p.scoreFirst!);
  const stopped = people.filter((p) => p.missedLastTwo && !p.awayWithNotice).length;
  return {
    started: people.length,
    stillComing: people.length - stopped,
    stoppedComing: stopped,
    firstCheck: withData[0] ?? null,
    latestCheck: withData.length > 1 ? withData[withData.length - 1] : null,
    bands: [
      { label: "went down", count: diff.filter((d) => d < 0).length },
      { label: "stayed the same", count: diff.filter((d) => d === 0).length },
      { label: "went up 1 or 2 points", count: diff.filter((d) => d === 1 || d === 2).length },
      { label: "went up 3 points or more", count: diff.filter((d) => d >= 3).length },
    ],
    noLatestScore: people.length - both.length,
    tookBoth: both.length,
    improved: diff.filter((d) => d > 0).length,
    rules: [
      `"Started" = everyone on the agency's attendance sheet for this group.`,
      `"Took both Money Checks" = has a score at the first check and at the latest one so far.`,
      `"Better off" = their latest Money Check score is higher than their first, by at least 1 point out of 25. Same or lower does not count as better off. The Money Check may miss changes clients feel day to day, such as stopping to think before spending.`,
      `"Stuck with it" = came to at least one of the last two sessions, or told the agency ahead of time they'd be away.`,
      `Scores are the Money Check (5 questions, each 1 to 5, out of 25), compared between the first and latest check so far, only for people who took both.`,
      `Any group smaller than ${SMALL_GROUP} people is shown as "fewer than ${SMALL_GROUP}" so no one can be identified.`,
      `Diary numbers are not shown: the diary records aren't reliable enough yet.`,
    ],
  };
}

// ---------- results.csv: the file Friday's run is scored on ----------
// way_to_reach must be one of call, text, paper, do not contact.
export function wayToReach(p: Person): "call" | "text" | "paper" | "do not contact" {
  return p.reach === "nothing noted" ? "call" : p.reach;
}
export function resultsRows(people: Person[]): string[][] {
  return [
    ["client_id", "status", "way_to_reach", "why", "contact_check"],
    ...people.map((p) => [
      p.id, p.status, wayToReach(p),
      p.why.split(". Start with")[0] + (p.reach === "do not contact" ? "; asked not to be contacted" : p.caution ? "; shared phone, check notes" : p.reach === "nothing noted" ? "; no contact way noted, call" : ""),
      p.contactCheck,
    ]),
  ];
}

// ---------- Plain-English reasons, shown when someone clicks a person ----------
export interface Explanation { verdict: string; steps: { label: string; text: string }[] }

const listName: Record<Action, string> = {
  friday: "on the Reach out on Friday list",
  tuesday: "on the Tuesday list (a word in person, no call)",
  "do not contact": "in the do-not-contact section (see in person only)",
  none: "not on any list this week",
};

export function explain(p: Person): Explanation {
  const steps: { label: string; text: string }[] = [];
  const [a, b] = p.lastTwoSessions;
  const said = (x: string) => (x === "came" ? "came" : x === "missed" ? "missed" : "blank");

  // 1. Coming to sessions?
  if (p.lastTwoSessions.length < 2) steps.push({ label: "Coming to sessions", text: "There aren't two sessions on the sheet yet, so attendance can't make anyone stalled." });
  else if (p.missedLastTwo && p.awayWithNotice) steps.push({ label: "Coming to sessions", text: `Missed sessions ${a} and ${b}, but told the agency ahead of time. That doesn't count against them.` });
  else if (p.missedLastTwo) steps.push({ label: "Coming to sessions", text: `The sheet shows sessions ${a} and ${b} as ${said(p.lastTwoAttendance[0])} and ${said(p.lastTwoAttendance[1])}, with no notice given. That means they have stopped coming.` });
  else steps.push({ label: "Coming to sessions", text: `Came to at least one of the last two sessions (${a}: ${said(p.lastTwoAttendance[0])}, ${b}: ${said(p.lastTwoAttendance[1])}). Attendance is fine.` });

  // 2. Diaries
  const w = p.diaryWeeksCounted;
  const lastTwo = w.slice(-2);
  if (w.length < 2) steps.push({ label: "Diaries", text: `Only ${w.length === 0 ? "no" : "one"} diary week counts so far. Weeks with no diary set, or on hold, are skipped. So diaries can't make them stalled.` });
  else {
    const list = lastTwo.map((x) => `week ${x.week}: ${x.handedIn === "yes" ? "handed in" : "nothing back"}`).join(", ");
    steps.push({ label: "Diaries", text: lastTwo.every((x) => x.handedIn === "no")
      ? `The last two weeks a diary actually went home (${list}) both came back empty-handed. That means they are behind on diaries.`
      : `The last two weeks a diary went home: ${list}. At least one came back, so diaries are fine.` });
  }
  if (p.thinWeeks.length) steps.push({ label: "Thin pages", text: `In week ${p.thinWeeks.join(" and ")} the page came back with only 1 or 2 days filled in. Not stalled, but worth a word on Tuesday.` });

  // 3. Contact
  steps.push({ label: "How to reach", text: `${p.reachText}. ${p.contactCheck}` });
  if (p.secondOpinion) steps.push({ label: "Unsure", text: p.secondOpinion });
  for (const t of p.reachTips) steps.push(t.startsWith("When: ") ? { label: "When to reach", text: t.slice(6) } : { label: "Be careful", text: t });

  const verdict = `${p.status === "stalled" ? "Stalled" : "On track"}, so they are ${listName[p.action]}.`;
  return { verdict, steps };
}
