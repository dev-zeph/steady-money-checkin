# Steady Money Check-in: after I step away

## Who looks after it

Maya owns the Friday list. She decides who to call, and she is the one who hears about and fixes a wrong call, because she knows the people. Tess looks after the tool itself, for about an hour a month, without touching code. Her job is to run each agency's three files through the page, look at the "Check these" tab, and tell Maya or Dana if a run stopped. Dana owns the agency pages. She checks the arithmetic herself and calls each director before any page goes out, starting with Cole Street's director in January.

## What it costs to run

It uses the cheapest Claude model (Haiku). One run for an agency of about 48 clients costs about 3 cents and takes under a minute. Across 40 agencies every week, that is about $5 a month, well under Dana's $150 limit. No agency pays extra and no developer is needed to run it. It is hosted on the Vercel free plan, so hosting costs nothing. There are no logins, so the link is kept inside Steady Money and Cole Street and never shared further. Nothing is stored: files are read, sent to Claude, and shown on the page, then gone.

## What happens when it gets one wrong

The tool only suggests. Maya makes every call and can skip anyone. Every name can be clicked to show exactly why that person is on the list, so a wrong reason is easy to spot. When it is unsure, it plays safe: if a "no contact" note could be about two people, both are treated as no contact until someone checks, and anything it could not read goes to "Check these" instead of being guessed. If fewer than half the notes can be read, it stops and writes nothing. If Maya finds a wrong call, she tells Tess, Tess notes it, and the fix is made in the notes or the sheet, not in the tool. A wrong number on an agency page is caught by Dana's check before it goes out.

## What it can't fix

- A change in how to reach someone that nobody wrote down. The day-one sheet goes out of date, and one client at Cole Street told us theirs says text when it should not. The tool marks these people with "Maya should check to be sure", but only asking in person fixes it. At Cole Street, 35 of 48 contacts rely only on the day-one sheet.
- Diary pages sitting in a folder that nobody typed up. They show as "no" even if they were handed in.
- Weeks when the diary was never mentioned at the session. Nothing in the records shows those.
- Changes the Money Check does not measure, like someone feeling more on top of things day to day.
- Whether counsellors score the Money Check the same way. That is still a question for Tess.

## Test results (Friday 13 November, Haiku)

- Cole Street: 48 of 48 right.
- Bayfield: 6 of 6 right against the official marks.
- Renamed columns: 48 of 48. Reworded notes: 48 of 48.
- Renamed files and everything changed: 47 of 48. The one miss is a safe one: an unclear "no contact" note was applied to both people it could mean.
- Unreadable notes: the run stopped and wrote nothing, as it should.
- No one marked do not contact was ever given a way to reach them.
