// The clean, normalised shape every agency's files are turned into.
// The AI fills this in; the written rules in rules.ts only ever read this.

export type Attend = "came" | "missed" | "unknown";
export type Reach = "text" | "call" | "paper" | "do not contact" | "nothing noted";

export interface Client {
  id: string;
  name: string;
  counsellor: string;
  sheetContactRaw: string; // as typed on the day-one sheet
  sheetContact: Reach; // normalised
  sessions: Attend[]; // index 0 = session 1
  moneyCheck: Record<string, number | null>; // "1" | "4" | "6" -> score out of 25
}

export interface DiaryEntry {
  key: string; // name as written in the diary file + counsellor
  clientId: string | null;
  match: "sure" | "unsure" | "none";
  matchReason: string;
  week: number;
  handedIn: "yes" | "no" | "not entered";
  daysFilled: number | null;
}

export interface ContactFacts {
  changed: boolean; // does this note say anything about how/whether to reach them?
  doNotContact: boolean;
  sharedPhone: boolean;
  noTexts: boolean;
  textsOk: boolean;
  callsOk: boolean;
  paperOnly: boolean; // letter / paper note only, or phone out of service
  okAgain: boolean; // someone who asked for no contact now agrees to be contacted again
  timeNote: string | null; // e.g. "evenings"
}

export interface NoteFacts {
  index: number; // position in the notes file (every note must come back)
  raw: string;
  date: string | null; // YYYY-MM-DD
  session: number | null; // filled in by code from the date order
  nameAsWritten: string;
  counsellorAsWritten: string;
  clientId: string | null;
  match: "sure" | "unsure" | "none";
  matchReason: string;
  attended: "came" | "missed" | "not stated";
  diary: "set" | "not set" | "on hold" | "not stated";
  awayWithNotice: boolean;
  contact: ContactFacts;
  evidence: string; // exact words from the note the facts came from
  problems: string[]; // checks the code ran that failed (shown to a person)
  alsoCould?: string[]; // other clients a do-not-contact note might be about (all protected)
}

export interface MarkRow {
  clientId: string;
  status: string; // "on track" | "stalled"
  reach: string;
}

export interface Normalised {
  agency: string;
  sessionCount: number;
  clients: Client[];
  diaries: DiaryEntry[];
  notes: NoteFacts[];
  marks: MarkRow[] | null; // only if a counsellor's marked list was uploaded (used to compare, never to decide)
  fileRoles: { file: string; role: string }[];
  warnings: string[];
}

// A person's correction from the "Check these" tab. Re-running the rules applies them.
export interface Overrides {
  noteClient: Record<number, string | null>; // note index -> client id
  diaryClient: Record<string, string | null>; // diary key -> client id
}
