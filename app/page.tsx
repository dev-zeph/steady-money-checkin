"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Normalised, Overrides } from "@/lib/types";
import { decide, summarise, shown, explain, RULES, resultsRows, type Person } from "@/lib/rules";
import { agencyFromFiles } from "@/lib/agency";
import { toCsv, looksLikeCsv } from "@/lib/csv";

type Tab = "friday" | "check" | "page" | "everyone";
const TABS: [Tab, string][] = [["friday", "Friday list"], ["check", "Check these"], ["page", "One page for the agency"], ["everyone", "Everyone"]];

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
const today = () => new Date().toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const Corners = () => <><i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" /></>;

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Normalised | null>(null);
  const [tab, setTab] = useState<Tab>("friday");
  const [over, setOver] = useState<Overrides>({ noteClient: {}, diaryClient: {} });
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [q, setQ] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const people = useMemo(() => (data ? decide(data, over) : []), [data, over]);
  const summary = useMemo(() => (data ? summarise(data, people) : null), [data, people]);

  // New files always clear the old results, so one agency's answers never sit under another's files.
  const addFiles = useCallback((incoming: File[]) => {
    const ok = incoming.filter((f) => /\.(csv|txt)$/i.test(f.name));
    if (!ok.length) return;
    setFiles((cur) => [...cur.filter((c) => !ok.some((n) => n.name === c.name)), ...ok]);
    setData(null); setError(null);
  }, []);

  // Paste: files copied in Finder or Explorer, or text copied straight from a spreadsheet or notes file.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (data || busy) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const pasted = Array.from(cd.files);
      if (pasted.length) { e.preventDefault(); addFiles(pasted); return; }
      const text = cd.getData("text/plain");
      if (text && text.trim().split(/\r?\n/).length > 1) {
        e.preventDefault();
        const n = files.filter((f) => f.name.startsWith("pasted-")).length + 1;
        const isCsv = looksLikeCsv(text) || text.includes("\t");
        const body = text.includes("\t") ? text.split(/\r?\n/).map((l) => l.split("\t").map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") : text;
        addFiles([new File([body], `pasted-${n}.${isCsv ? "csv" : "txt"}`, { type: "text/plain" })]);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles, data, busy, files]);

  async function run() {
    setBusy(true); setError(null); setData(null);
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
      const res = await fetch("/api/normalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: payload }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json); setOver({ noteClient: {}, diaryClient: {} }); setOpenIds(new Set()); setQ(""); setTab("friday");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally { setBusy(false); }
  }
  function startOver() { setData(null); setFiles([]); setError(null); }
  const toggle = (id: string) => setOpenIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const found = q.trim() ? people.filter((p) => matches(p, q)) : [];
  const visible = q.trim() ? found : people;
  const friday = people.filter((p) => p.action === "friday");
  const tuesday = people.filter((p) => p.action === "tuesday");
  const dnc = people.filter((p) => p.action === "do not contact");
  const toCheck = data ? data.notes.filter((x) => x.problems.length || x.match === "unsure") : [];
  const diaryCheck = data ? Array.from(new Map(data.diaries.filter((d) => d.match !== "sure").map((d) => [d.key, d])).values()) : [];
  const flagged = people.filter((p) => p.needsCheck.length);
  const checkCount = toCheck.length + diaryCheck.length + (data?.warnings.length ?? 0);
  const agree = data?.marks ? people.filter((p) => {
    const m = data.marks!.find((x) => x.clientId === p.id);
    return m && m.status === p.status && m.reach === p.reach;
  }).length : null;
  const agencyGuess = files.length ? agencyFromFiles(files.map((f) => f.name)) : null;
  const slug = (data?.agency || "agency").replace(/\s+/g, "-");

  function fridayCsv() {
    download(`friday-list-${slug}.csv`, toCsv([
      ["section", "client_id", "name", "counsellor", "why", "how_to_reach", "contact_check", "wrong_why"],
      ...friday.map((p) => ["Reach out on Friday", p.id, p.name, p.counsellor, p.why, p.reachText, p.contactCheck, ""]),
      ...tuesday.map((p) => ["Word on Tuesday", p.id, p.name, p.counsellor, p.why, "", "", ""]),
      ...dnc.map((p) => ["Do not contact: see in person", p.id, p.name, p.counsellor, p.why, "Do not call, text or write", "", ""]),
    ]));
  }
  function everyoneCsv() {
    download(`everyone-${slug}.csv`, toCsv([
      ["client_id", "name", "counsellor", "status", "list", "why", "how_to_reach", "reach_text", "caution", "contact_check", "contact_source"],
      ...people.map((p) => [p.id, p.name, p.counsellor, p.status, p.action, p.why, p.reach, p.reachText, p.caution, p.contactCheck, p.reachSource]),
    ]));
  }

  return (
    <>
      <nav className="navbar" aria-label="Main">
        <div className="wrap">
          <button className="brand navlink" style={{ paddingLeft: 0, color: "var(--ink)" }} onClick={() => data && !busy && startOver()} title={data ? "Start over with new files" : undefined}>
            <span className="brand-mark" aria-hidden /> Steady Money check-in
          </button>
          <div className="navlinks" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k && !!data} className={`navlink ${tab === k && data ? "on" : ""}`} disabled={!data} onClick={() => setTab(k)}>
                {label}
                {k === "check" && data && <span className={`count ${checkCount ? "warn" : ""}`}>{checkCount}</span>}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {!data && (
        <main className="wrap">
          <section className="hero">
            <span className="label green">This week&apos;s records</span>
            <h1 style={{ marginTop: 10 }}>Who to call on Friday, and how the group is doing.</h1>
            <p>Add the agency&apos;s attendance sheet, typed diaries and session notes. You get a printable Friday list and a one-page halfway view with no names on it. Nothing is saved.</p>
          </section>

          <div className="box">
            <Corners />
            <div
              className={`drop ${dragging ? "over" : ""}`}
              role="button" tabIndex={0}
              onClick={() => picker.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") picker.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
            >
              <span className="label">Drop, paste or choose</span>
              <strong>Drop the files here, or paste them (Ctrl or Cmd + V)</strong>
              <span className="muted small">Or click to choose. Spreadsheets saved as .csv, and notes as .txt. You can also paste text copied straight from a spreadsheet.</span>
              <input ref={picker} type="file" multiple accept=".csv,.txt" hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            </div>

            {files.length > 0 && (
              <>
                <div className="filelist">
                  {files.map((f) => (
                    <div key={f.name} className="filerow">
                      <span>{f.name} <span className="muted small num">{(f.size / 1024).toFixed(1)} KB</span></span>
                      <button onClick={() => setFiles((cur) => cur.filter((c) => c !== f))} disabled={busy}>Remove</button>
                    </div>
                  ))}
                </div>
                <p style={{ marginTop: 16 }}>
                  <span className="label">Agency</span>{" "}
                  {agencyGuess ? <b>{agencyGuess}</b> : <span className="muted">The file names don&apos;t include an agency name, so the results will say so.</span>}
                </p>
                <div className="actions" style={{ marginTop: 20 }}>
                  <button className="btn btn-green" disabled={busy} onClick={run}>{busy ? "Reading the files, about a minute..." : "Read the files"}</button>
                  <button className="btn" disabled={busy} onClick={() => setFiles([])}>Clear</button>
                </div>
              </>
            )}
            {error && <p className="notice bad" style={{ marginTop: 20 }}>{error}</p>}
          </div>

          <div className="steps3">
            <div><span className="label green">01 · Read</span><h3 style={{ marginTop: 6 }}>AI reads the notes</h3><p>Who each note is about, whether a diary went home, and any change in how to reach someone.</p></div>
            <div><span className="label green">02 · Check</span><h3 style={{ marginTop: 6 }}>You check the guesses</h3><p>Anything it wasn&apos;t sure about is listed under &quot;Check these&quot; for you to confirm.</p></div>
            <div><span className="label green">03 · Decide</span><h3 style={{ marginTop: 6 }}>Written rules decide</h3><p>Maya&apos;s rules, printed on every list, decide who is stalled. Click any name to see why.</p></div>
          </div>
        </main>
      )}

      {data && (
        <main className="wrap">
          <div className="box strip noprint">
            <Corners />
            <div className="facts">
              <div className="fact"><span className="label">Agency</span><b>{data.agency}</b></div>
              <div className="fact"><span className="label">Clients</span><b className="num">{data.clients.length}</b></div>
              <div className="fact"><span className="label">Records up to</span><b>Session {data.sessionCount}</b></div>
            </div>
            <div className="actions">
              <button className="btn btn-green" onClick={() => download("results.csv", toCsv(resultsRows(people)))}>Download results.csv</button>
              <button className="btn" onClick={startOver}>New files</button>
            </div>
          </div>

          {tab === "friday" && (
            <section style={{ marginTop: 32 }}>
              <div className="section-head">
                <div>
                  <span className="label green">Friday follow-up</span>
                  <h2 style={{ marginTop: 6 }}>{data.agency}: who to reach this week</h2>
                  <p>Made {today()}. Click a name to see why they are on the list.</p>
                </div>
                <div className="actions noprint">
                  <button className="btn btn-green" onClick={() => window.print()}>Print the list</button>
                  <button className="btn" onClick={fridayCsv}>Download spreadsheet</button>
                </div>
              </div>
              {checkCount > 0 && <p className="notice noprint">{checkCount} thing{checkCount === 1 ? "" : "s"} the tool wasn&apos;t sure about. Look at <button className="who" onClick={() => setTab("check")} style={{ textDecoration: "underline", fontWeight: 600, color: "inherit" }}>Check these</button> before calling.</p>}

              <Search value={q} onChange={setQ} placeholder="Search anyone at this agency by name, ID or counsellor" />
              {q.trim() && (
                <div className="group noprint">
                  <div className="group-head"><span className="label green">Search</span><h3>Results <span className="num muted">({found.length})</span></h3><span className="hint">Full details are open below each name.</span></div>
                  {!found.length ? <p className="empty">Nobody matches &quot;{q}&quot;.</p> : (
                    <table>
                      <thead><tr><th>Name</th><th>On which list</th><th>Why</th><th>How to reach</th></tr></thead>
                      <tbody>{found.map((p) => (
                        <Fragment key={p.id}>
                          <tr>
                            <td style={{ width: "22%" }}><b>{p.name}</b><span className="sub">{p.id} · {p.counsellor}</span></td>
                            <td><span className={`tag ${p.status === "stalled" ? "stalled" : "ok"}`}>{LIST_LABEL[p.action]}</span></td>
                            <td>{p.why}</td>
                            <td><Reach p={p} /></td>
                          </tr>
                          <WhyRow p={p} span={4} />
                        </Fragment>
                      ))}</tbody>
                    </table>
                  )}
                </div>
              )}

              <Group n={1} title="Reach out on Friday" hint="They stopped coming. Use the way and time in How to reach." rows={friday} cols={["name", "why", "reach", "wrong"]} empty="Nobody to reach out to this week." open={openIds} toggle={toggle} />
              <Group n={2} title="A word on Tuesday" hint="Still coming, so no call. Start with what the diary is for." rows={tuesday} cols={["name", "why", "wrong"]} empty="Nobody this week." open={openIds} toggle={toggle} />
              <Group n={3} title="Do not contact" hint="They asked not to be contacted. See them in person if they come in." rows={dnc} cols={["name", "why"]} empty="Nobody this week." open={openIds} toggle={toggle} />

              <div className="rules"><span className="label">Rules used</span><ol>{RULES.map((r) => <li key={r}>{r}</li>)}</ol></div>
            </section>
          )}

          {tab === "check" && (
            <section style={{ marginTop: 32 }}>
              <div className="section-head">
                <div>
                  <span className="label green">Before you trust the list</span>
                  <h2 style={{ marginTop: 6 }}>Check these</h2>
                  <p>Notes and diary names the AI matched as a guess, or that failed a check. Pick the right person and the lists update straight away.</p>
                </div>
              </div>
              <div className="stack">
                {agree != null && <p className="notice good">Compared with the counsellor&apos;s own marked list: <b>{agree} of {people.length}</b> match on status and how to reach.</p>}
                {data.warnings.map((w) => <p key={w} className="notice">{w}</p>)}
                {checkCount === 0 && <p className="notice good">Every note and diary line was matched to someone with no guesses. Nothing to check.</p>}
              </div>
              <div style={{ marginTop: 20 }}>
                {toCheck.map((x) => (
                  <div key={x.index} className="item">
                    <p className="quote">&ldquo;{x.raw}&rdquo;</p>
                    <p className="small muted" style={{ marginTop: 8 }}>{[...x.problems, x.match === "unsure" ? `Matched as a guess: ${x.matchReason}.` : ""].filter(Boolean).join(" ")}</p>
                    <div style={{ marginTop: 10 }}>
                      <ClientPicker data={data} value={x.index in over.noteClient ? over.noteClient[x.index] : x.clientId}
                        onChange={(v) => setOver((o) => ({ ...o, noteClient: { ...o.noteClient, [x.index]: v } }))} />
                    </div>
                  </div>
                ))}
                {diaryCheck.map((d) => (
                  <div key={d.key} className="item">
                    <p className="quote">Diary name: {d.key}</p>
                    <p className="small muted" style={{ marginTop: 8 }}>{d.matchReason}</p>
                    <div style={{ marginTop: 10 }}>
                      <ClientPicker data={data} value={d.key in over.diaryClient ? over.diaryClient[d.key] : d.clientId}
                        onChange={(v) => setOver((o) => ({ ...o, diaryClient: { ...o.diaryClient, [d.key]: v } }))} />
                    </div>
                  </div>
                ))}
              </div>
              {flagged.length > 0 && (
                <div className="group">
                  <div className="group-head"><h3>People to check before reaching out</h3></div>
                  <table><tbody>{flagged.map((p) => <tr key={p.id}><td style={{ width: "28%" }}><b>{p.name}</b><span className="sub">{p.counsellor}</span></td><td>{p.needsCheck.join(" ")}</td></tr>)}</tbody></table>
                </div>
              )}
            </section>
          )}

          {tab === "page" && summary && (
            <section style={{ marginTop: 32 }}>
              <div className="section-head noprint">
                <div><span className="label green">For the agency&apos;s director, then the funder</span></div>
                <div className="actions"><button className="btn btn-green" onClick={() => window.print()}>Print this page</button></div>
              </div>
              <div className="box">
                <Corners />
                <span className="label">Steady Money program · {data.agency}</span>
                <h2 className="page-title" style={{ marginTop: 8 }}>What the first results show</h2>
                <span className="halfway">Halfway view: sessions {summary.firstCheck ?? 1} to {summary.latestCheck ?? data.sessionCount} of 6</span>
                <p className="muted" style={{ marginTop: 14, maxWidth: 680 }}>The program has six sessions. These numbers cover the first {summary.latestCheck ?? data.sessionCount}, so the final picture may be different. Totals for the whole group only. No one is named.</p>

                <div className="stats">
                  <div className="stat"><span className="label">Started</span><div className="big num">{summary.started}</div><p>Everyone on the attendance sheet.</p></div>
                  <div className="stat"><span className="label">Stuck with it</span><div className="big num">{shown(summary.stillComing)}<span className="of"> of {summary.started}</span></div><p>Still coming at session {data.sessionCount}.</p></div>
                  <div className="stat"><span className="label">Took both checks</span><div className="big num">{summary.tookBoth}<span className="of"> of {summary.started}</span></div><p>Did the Money Check at session {summary.firstCheck ?? 1} and session {summary.latestCheck ?? "-"}.</p></div>
                  <div className="stat lead"><span className="label">Better off</span><div className="big num">{summary.improved}<span className="of"> of {summary.tookBoth}</span></div><p>Of those who took both checks, their score went up.</p></div>
                </div>

                {summary.latestCheck != null && summary.tookBoth > 0 ? (
                  <div style={{ marginTop: 32 }}>
                    <h3>How much the Money Check moved</h3>
                    <p className="muted small" style={{ marginTop: 4 }}>For the {summary.tookBoth} people who took both checks. The Money Check is scored out of 25.</p>
                    <div className="bars">
                      {summary.bands.map((b) => (
                        <div key={b.label} className="bar">
                          <span>Score {b.label}</span>
                          <span className="track"><span className={`fill ${b.label.includes("up") ? "up" : ""}`} style={{ display: "block", width: `${b.count > 0 && b.count < 5 ? 0 : (b.count / summary.tookBoth) * 100}%` }} /></span>
                          <span className="num" style={{ textAlign: "right" }}>{shown(b.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <p className="notice" style={{ marginTop: 24 }}>Only one Money Check so far, so no change can be shown yet.</p>}

                <div className="counted">
                  <span className="label">How this was counted</span>
                  <ul>{summary.rules.map((r) => <li key={r}>{r}</li>)}</ul>
                </div>
                <p className="muted small" style={{ marginTop: 20 }}>Numbers come straight from the agency&apos;s own attendance sheet. Check them against the sheet before this page goes anywhere.</p>
              </div>
            </section>
          )}

          {tab === "everyone" && (
            <section style={{ marginTop: 32 }}>
              <div className="section-head">
                <div>
                  <span className="label green">All clients</span>
                  <h2 style={{ marginTop: 6 }}>Everyone at {data.agency}</h2>
                  <p>Click a name to see, step by step, why they are or aren&apos;t on a list.</p>
                </div>
                <div className="actions noprint"><button className="btn" onClick={everyoneCsv}>Download spreadsheet</button><button className="btn" onClick={() => window.print()}>Print</button></div>
              </div>
              <Search value={q} onChange={setQ} placeholder="Search by name, ID or counsellor" />
              {q.trim() && <p className="small noprint" style={{ margin: "0 0 12px" }}>Showing {found.length} of {people.length}.</p>}
              <table>
                <thead><tr><th>Name</th><th>Status</th><th>Why</th><th>How to reach</th></tr></thead>
                <tbody>{visible.map((p) => (
                  <Fragment key={p.id}>
                    <tr>
                      <td><Who p={p} open={openIds.has(p.id)} toggle={toggle} /><span className="sub">{p.id} · {p.counsellor}</span></td>
                      <td><span className={`tag ${p.status === "stalled" ? "stalled" : "ok"}`}>{p.status}</span></td>
                      <td>{p.why}</td>
                      <td><Reach p={p} /></td>
                    </tr>
                    {openIds.has(p.id) && <WhyRow p={p} span={4} />}
                  </Fragment>
                ))}</tbody>
              </table>
            </section>
          )}
        </main>
      )}
    </>
  );
}

function Who({ p, open, toggle }: { p: Person; open: boolean; toggle: (id: string) => void }) {
  return <button className="who" aria-expanded={open} onClick={() => toggle(p.id)}>{p.name}<span className="chev" aria-hidden>▶</span></button>;
}

const LIST_LABEL: Record<Person["action"], string> = { friday: "Reach out on Friday", tuesday: "A word on Tuesday", "do not contact": "Do not contact", none: "Not on a list" };

function matches(p: Person, q: string) {
  const t = q.trim().toLowerCase();
  return [p.name, p.id, p.counsellor].some((x) => x.toLowerCase().includes(t));
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search noprint">
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label="Search clients" />
      {value && <button className="btn" onClick={() => onChange("")}>Clear</button>}
    </div>
  );
}

// How to reach: the way, then timing and safety details, then how far to trust it.
function Reach({ p }: { p: Person }) {
  return (
    <>
      <b>{p.reachText}</b>
      {p.caution && <span className="sub"><span className="tag check">{p.caution}</span></span>}
      {p.reachTips.map((t) => <span key={t} className="sub tip">{t}</span>)}
      {p.contactCheck.includes("check to be sure") ? <span className="sub"><span className="tag check">Check in person</span> Only the day-one sheet says this. Ask in person how and when to reach them.</span> : <span className="sub">{p.contactCheck}</span>}
    </>
  );
}

function WhyRow({ p, span }: { p: Person; span: number }) {
  const e = explain(p);
  return (
    <tr className="why-row"><td colSpan={span}>
      <div className="why">
        <p className="verdict">{e.verdict}</p>
        <dl>{e.steps.map((s) => <Fragment key={s.label}><dt>{s.label}</dt><dd>{s.text}</dd></Fragment>)}</dl>
        {p.needsCheck.length > 0 && <p className="small" style={{ marginTop: 10, color: "var(--amber)" }}>{p.needsCheck.join(" ")}</p>}
      </div>
    </td></tr>
  );
}

type Col = "name" | "why" | "reach" | "wrong";
function Group({ n, title, hint, rows, cols, empty, open, toggle }: { n: number; title: string; hint: string; rows: Person[]; cols: Col[]; empty: string; open: Set<string>; toggle: (id: string) => void }) {
  const head: Record<Col, string> = { name: "Name", why: "Why they're here", reach: "How to reach", wrong: "Wrong? Write why" };
  return (
    <div className="group">
      <div className="group-head"><span className="label green">0{n}</span><h3>{title} <span className="num muted">({rows.length})</span></h3><span className="hint">{hint}</span></div>
      {!rows.length ? <p className="empty">{empty}</p> : (
        <table>
          <thead><tr>{cols.map((c) => <th key={c} className={c === "wrong" ? "write-in" : ""}>{head[c]}</th>)}</tr></thead>
          <tbody>{rows.map((p) => (
            <Fragment key={p.id}>
              <tr>
                {cols.includes("name") && <td style={{ width: "24%" }}><Who p={p} open={open.has(p.id)} toggle={toggle} /><span className="sub">{p.counsellor}</span></td>}
                {cols.includes("why") && <td>{p.why}</td>}
                {cols.includes("reach") && <td><Reach p={p} /></td>}
                {cols.includes("wrong") && <td className="write-in"></td>}
              </tr>
              {open.has(p.id) && <WhyRow p={p} span={cols.length} />}
            </Fragment>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function ClientPicker({ data, value, onChange }: { data: Normalised; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <label className="small noprint">This is about:{" "}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Nobody / not sure</option>
        {data.clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.counsellor})</option>)}
      </select>
    </label>
  );
}
