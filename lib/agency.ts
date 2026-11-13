// The agency name, taken from the file names (e.g. "bayfield-attendance.csv" -> "Bayfield").
// The words the files share, minus words that only say what kind of file it is.
const ROLE_WORDS = new Set([
  "attendance", "attend", "register", "roster", "sheet", "sheets", "diary", "diaries", "log", "logs", "typed",
  "notes", "note", "counsellor", "counselor", "counsellors", "case", "session", "sessions", "marks", "marked",
  "list", "export", "copy", "final", "fall", "spring", "winter", "summer", "data", "records", "record", "file", "files",
]);
const words = (f: string) => f.replace(/\.[a-z0-9]+$/i, "").split(/[\s_\-.()]+/).filter(Boolean);
const isNoise = (w: string) => ROLE_WORDS.has(w.toLowerCase()) || /^\d+$/.test(w) || /^v\d+$/i.test(w);

export function agencyFromFiles(names: string[]): string | null {
  const lists = names.map((n) => words(n).filter((w) => !isNoise(w)));
  if (!lists.length) return null;
  // Words that appear in every file name, in the order of the first file.
  let shared = lists[0].filter((w) => lists.every((l) => l.some((x) => x.toLowerCase() === w.toLowerCase())));
  // With only one usable file, or nothing shared, fall back to the most common words.
  if (!shared.length) {
    const count = new Map<string, number>();
    for (const l of lists) for (const w of new Set(l.map((x) => x.toLowerCase()))) count.set(w, (count.get(w) ?? 0) + 1);
    const best = Math.max(0, ...count.values());
    if (best < 2) return null;
    shared = lists.flat().filter((w, i, a) => count.get(w.toLowerCase()) === best && a.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === i);
  }
  if (!shared.length) return null;
  return shared.map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
