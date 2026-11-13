# Steady Money weekly check-in

Volta Anchor Sprint 4. Upload an agency's attendance sheet, typed diaries and session notes. You get:

- **Friday list**, printable: who to call on Friday, who to have a word with on Tuesday, and who must not be contacted (see in person). Each person shows why they are there and the newest way to reach them from the notes. A "Wrong? Write why" column is left blank for the counsellor.
- **Check these**: every note or diary line the AI matched as a guess, or that failed a check, with a picker to correct it. Corrections re-run the rules straight away.
- **One page for the agency**, printable (a halfway view): whole-group totals only, sessions 1 to 4, score movement in bands, rules printed on the page, groups under 5 hidden.
- **Everyone**: one row per client with status, reason, how to reach and where that came from. Downloadable as CSV.

## How it works

1. **AI normalises** (lib/normalize.ts, Claude Haiku 5.5 (claude-haiku-5-5), structured output). It works out which file is which and what each column and value means, then reads every note into plain facts: who it's about, diary set / not set / on hold, away with notice, and contact instructions (do not contact, shared phone, no texts, text ok, letter only). It must return every note. The code checks that it did, that each quote is word for word in the note, and that the counsellor matches.
2. **People check** anything the AI guessed, on the "Check these" tab.
3. **Written rules decide** (lib/rules.ts, no AI): stalled, Friday or Tuesday, and how to reach. The rules are printed on the list.

Nothing is stored. Files are read in memory, sent to the Claude API (not used for training), and returned to the page.

## Run it

    cd web
    npm install
    echo "ANTHROPIC_API_KEY=..." > .env.local
    npm run dev            # then open http://localhost:3000

Command-line check against a counsellor's marked list:

    npx tsx --env-file=.env.local scripts/run.mts ../data/cole-street ../data/cole-street/maya-marks.csv

## Test results (13 November 2026)

- Cole Street: 48 of 48 right on status and how to reach.
- Bayfield: 6 of 6 against the official marks.
- Renamed columns, reworded notes: 48 of 48. Renamed files and everything changed: 47 of 48 (one safe miss: an unclear "no contact" note is applied to both people it could mean).
- Unreadable notes: the run stops and writes nothing.
- Nobody marked do not contact was ever given a way to reach them.
- About US$0.03 per run on Haiku, about $5 a month for 40 agencies weekly.

## After handoff

See [HANDOFF.md](HANDOFF.md): who looks after it, what it costs, what happens when it gets one wrong, and what it can't fix.

Client data is not in this repository.
