# Old gates and where they live now

Every gate the earlier runs used, from their ledgers (final-polish, decisions,
real-app, person-search, plus fixes-3 and the two palette runs), and the test
that covers the same behavior now. A quoted name is part of a check's name in
that suite file. Gates that checked the run itself (its report, screenshots,
the push, the real database staying untouched, the ledger's own lint) were
one-off and aren't app behavior, so they aren't ported. Checks that need the
real friend accounts live in `~/reel-picks-qa`, outside the repo.

## final-polish

| Ledger | Gate | What it checked | Now |
|---|---|---|---|
| final-polish | G0 | the ledger lints | not ported (lint) |
| final-polish | G1 | PROBLEMS.md written first, every entry resolved | not ported (report) |
| final-polish | G2 | every screen, theme, width and role: no sideways scroll, clipping, cover-up, AA, 44px taps | `ui/layout.mjs` "no layout, contrast, tap or error findings" |
| final-polish | G3 | only the old light and dark fonts, font shift, type tokens | not ported (superseded) by real-app G5, now `ui/design.mjs` "font-swap layout shift under 0.01" |
| final-polish | G4 | every user flow works with no console error | `fast/function.mjs` "cross:", "wsw:", "schedule:", "stats:", "invite:", "imports:" |
| final-polish | G5 | search keeps the famous film in the top 3, recents private | `fast/search.mjs` "in the first 3 rows, people counted", "recents are private per person"; `fast/function.mjs` "shows exactly the API's rows, people first" |
| final-polish | G6 | security, roles, privacy, secrets, bad inputs, limits | `fast/security.mjs` "every route in routes.js and index.js is in the route table", "bad inputs are refused and store nothing"; `fast/privacy.mjs` "no one else ever reads friend A"; `fast/roles.mjs` "the invite flow" |
| final-polish | G7 | weekly picks and every score identical | `fast/scores.mjs` "scores, the four and every list equal the expected values" |
| final-polish | G8 | service-worker update, offline, backups | `ui/sw.mjs` "update:", "offline:"; `fast/jobs.mjs` "the owner downloads the newest backup", "the import brings the removed rating back" |
| final-polish | G9 | background jobs on a mocked timeline | `fast/jobs.mjs` "refresh:", "backup:", "offsite:", "letterboxd:", "push:", "alerts:" |
| final-polish | G10 | Railway keys text, no stale glow, hero seat line | `ui/shell.mjs` "keys ", "stale glow", "seat line" |
| final-polish | G11 | standalone PWA with iPhone insets | `ui/iphone.mjs` "keeps clear of the notch and the home indicator", "the status-bar style is default" |
| final-polish | G12 | accessibility: keyboard, focus, names, dialogs, reduced motion, 200% zoom | `ui/a11y.mjs` "Tab reaches every control", "nothing moves with reduced motion on", "no sideways scroll, clipped or overlapping text" |
| final-polish | G13 | speed measured before and after | `ui/speed.mjs` "cold Picks:", "second load:" (budgets instead of a base commit) |
| final-polish | G14 | the two real friends, every page, own data only | ~/reel-picks-qa (real friend accounts) |
| final-polish | G15 | README matches the app, env vars by name, first person | `fast/readme.mjs` "every environment variable the server", "first person" |
| final-polish | G16 | screenshots kept outside git | not ported (screenshots) |
| final-polish | G17 | fast-forward, one-area commits, pushed | not ported (ship) |
| final-polish | G18 | the real database was never written | not ported (real database) |
| final-polish | G19 | the final report | not ported (manual review) |

## decisions

| Ledger | Gate | What it checked | Now |
|---|---|---|---|
| decisions | D0 | the ledger lints | not ported (lint) |
| decisions | D1 | weekly lock, midweek refills, one swap, next Friday | `fast/lock.mjs` "Friday: each user", "at most one swap per user this week", "next Friday:" |
| decisions | D2 | weekly4_log writes only after the lock | `fast/lock.mjs` "log:" |
| decisions | D3 | the Friday push after the lock, swaps send none | `fast/lock.mjs` "push:" |
| decisions | D4 | AMC retried hourly up to 6 times, one alert, fallback lock | `fast/lock.mjs` "retry:" |
| decisions | D5 | cache cleanup after a good nightly backup, one VACUUM | `fast/housekeeping.mjs` "exactly the rows more than 3x past their lifetime were deleted", "the one-time VACUUM ran", "a failed backup deletes nothing" |
| decisions | D6 | plan month, savings month, seen this year in local time | `fast/jobs.mjs` "Sept 30, 10:30 pm", "Oct 1, 12:30 am", "Dec 31, 9 pm" |
| decisions | D7 | Railway guest safety | `fast/roles.mjs` "on Railway with GUEST_MODE missing, everyone is the guest", "GUEST_MODE=0 is" |
| decisions | D8 | hourly limits per friend, 429 message, owner exempt | `fast/limits.mjs` "friend: 200 new-film lookups", "friend: 300 rating searches", "guests have stricter caps"; `ui/shell.mjs` "the Rate search shows" |
| decisions | D9 | only localhost off Railway, RP_ALLOW_LAN, any host on Railway | `fast/security.mjs` "off Railway only a localhost Host is answered", "RP_ALLOW_LAN=1 opens it to the network", "on Railway any Host is answered" |
| decisions | D10 | local keys card text | `ui/shell.mjs` "keys " |
| decisions | D11 | scores, the four, movie pages, Coming Soon identical | `fast/scores.mjs` "scores, the four and every list equal the expected values"; real friends in ~/reel-picks-qa |
| decisions | D12 | the two real friends see their own lock and data | ~/reel-picks-qa (real friend accounts) |
| decisions | D13 | New this week tag inside its card | `ui/picks.mjs` "one New this week tag" |
| decisions | D14 | PROBLEMS.md marks the decisions fixed | not ported (report) |
| decisions | D15 | README covers the decisions | `fast/readme.mjs` "README covers" |
| decisions | D16 | screenshots kept outside git | not ported (screenshots) |
| decisions | D17 | the branch shipped | not ported (ship) |
| decisions | D18 | the real database was never written | not ported (real database) |
| decisions | D19 | the final report | not ported (manual review) |
| decisions | R2 | regression of old G2 | `ui/layout.mjs` "no layout, contrast, tap or error findings" |
| decisions | R4 | regression of old G4 | `fast/function.mjs` "cross:", "picks:" |
| decisions | R5 | regression of old G5 | `fast/search.mjs` "in the first 3 rows, people counted" |
| decisions | R6 | regression of old G6 | `fast/security.mjs` "every route in routes.js and index.js is in the route table" |
| decisions | R7 | every read endpoint answers as before | `fast/scores.mjs` "still equal after people searches and person pages" |
| decisions | R8 | regression of old G8 | `ui/sw.mjs` "update:", "offline:" |
| decisions | R9 | background jobs with the lock and retry | `fast/jobs.mjs` "refresh:", "weekly:" |
| decisions | R12 | regression of old G12 | `ui/a11y.mjs` "Tab reaches every control" |
| decisions | R13 | regression of old G13 | `ui/speed.mjs` "cold Picks:" |
| decisions | R14 | regression of old G14 | ~/reel-picks-qa (real friend accounts) |
| decisions | R15 | regression of old G15 | `fast/readme.mjs` "every environment variable the server" |

## real-app

| Ledger | Gate | What it checked | Now |
|---|---|---|---|
| real-app | G0 | the ledger lints | not ported (lint) |
| real-app | G1 | scrolling to the end clears the tab bar on iPhone, pages scroll after sheets | `ui/iphone.mjs` "last content clears the", "the page still scrolls and takes taps after the" |
| real-app | G2 | the movie-page header still paints when scrolled | `ui/shell.mjs` "the logo and search still paint"; `ui/iphone.mjs` "still paints scrolled to" |
| real-app | G3 | Midnight marquee and Ticket stub tokens, metas, manifest, no old palette | `ui/design.mjs` "dark tokens are the Midnight marquee values", "light --accent is teal", "iOS status bar" |
| real-app | G4 | poster colour glow in dark | `ui/picks.mjs` "glow:" |
| real-app | G5 | only Big Shoulders Display and IBM Plex Sans, font shift, type tokens | `ui/design.mjs` "only Big Shoulders Display and IBM Plex Sans paint", "font-swap layout shift under 0.01", "every font size and line height" |
| real-app | G6 | header contents per role, pull to refresh | `ui/shell.mjs` "header ", "pull:" |
| real-app | G7 | one button system | `ui/design.mjs` "one button system" |
| real-app | G8 | five tabs, You holds Stats, Together, Settings, Help, the note, the tour | `ui/shell.mjs` "tabs ", "the tour lights a real, on-screen element" |
| real-app | G9 | grouped lists, no outlined boxes | `ui/design.mjs` "no outlined boxes", "grouped lists with divided rows" |
| real-app | G10 | wording: sentence case, reason lines, no em dash | `ui/design.mjs` "words " |
| real-app | G11 | the installed app picks up a new version | `ui/sw.mjs` "installed app:" |
| real-app | G12 | the Picks hero | `ui/picks.mjs` "hero " |
| real-app | G13 | the rest-of-four cards and match badges | `ui/picks.mjs` "cards " |
| real-app | G14 | showtime rows, format chips, status tags | `ui/picks.mjs` "rows ", "one grid per list, tinted tags at AA" |
| real-app | G15 | match line, Rent or buy, day chips, Settings fields, Save bar | `ui/picks.mjs` "Rent or buy", "details " |
| real-app | G16 | nothing left in the old style or unused | `ui/design.mjs` "every class in styles.css is used" |
| real-app | G17 | every screen and state: AA, 44px, no sideways scroll or errors | `ui/layout.mjs` "no layout, contrast, tap or error findings" |
| real-app | G18 | accessibility | `ui/a11y.mjs` "Tab reaches every control", "dialog " |
| real-app | G19 | every feature still works after the redesign | `fast/function.mjs` "cross:", "settings:", "together:" |
| real-app | G20 | the four and every score identical | `fast/scores.mjs` "scores, the four and every list equal the expected values" |
| real-app | G21 | the two real friends see only their own data | ~/reel-picks-qa (real friend accounts) |
| real-app | G22 | the real database was never written | not ported (real database) |
| real-app | G22b | nothing written after the migration incident | not ported (real database) |
| real-app | G23 | the before and after compare page | not ported (compare page) |
| real-app | G24 | README describes the new look and tabs | `fast/readme.mjs` "README covers" |
| real-app | G25 | the branch shipped in two pushes | not ported (ship) |
| real-app | G26 | the final report | not ported (manual review) |

## person-search

| Ledger | Gate | What it checked | Now |
|---|---|---|---|
| person-search | S0 | the ledger lints | not ported (lint) |
| person-search | S1 | the header search gate passes as written | `fast/search.mjs` "in the first 3 rows, people counted" |
| person-search | S2 | the right person first, at most 2 people, films below | `fast/search.mjs` "as the first row", "has at most 2 person rows"; `fast/function.mjs` "shows exactly the API's rows, people first" |
| person-search | S3 | the person page: sections, toggle, rate and save in place | `fast/people.mjs` "sections, lists and order", "writes only that user"; `fast/function.mjs` "person friend:" |
| person-search | S4 | person credits only through the shared cache | `fast/people.mjs` "one place asks TMDB for movie credits", "a second user costs no TMDB call" |
| person-search | S5 | director and cast link to person pages | `fast/function.mjs` "the director links to #/person/", "every billed actor links to their page" |
| person-search | S6 | a person lands in that user's own recents | `fast/function.mjs` "recents:" |
| person-search | S7 | the guest has no search and a read-only person page | `fast/roles.mjs` "the guest reads a person page with no one"; `fast/search.mjs` "the guest link can" |
| person-search | S8 | friends never see each other's ratings on a person page | `fast/privacy.mjs` "on a person page each person sees only their own ratings and saves" |
| person-search | S9 | a person lookup counts as one new-film lookup | `fast/limits.mjs` "the 201st lookup, a person, gets 429", "film lookups and person lookups share the bucket" |
| person-search | S10 | scores identical after people searches | `fast/scores.mjs` "still equal after people searches and person pages" |
| person-search | S11 | person row and page accessibility | `ui/a11y.mjs` "person " |
| person-search | S12 | search, person page and movie page render in every role, width and theme | `ui/layout.mjs` "search-person", "person-directed", "person-acted" |
| person-search | S13 | no new failures in old G4 | `fast/function.mjs` "cross:" (the suite now passes on main) |
| person-search | S14 | security with GET /person/:id and GET /version in the route table | `fast/security.mjs` "every route in routes.js and index.js is in the route table", "the coverage check notices a route missing from the table" |
| person-search | S15 | the hourly limits still hold | `fast/limits.mjs` "a heavy but normal hour" |
| person-search | S16 | no new failures in old G12 | `ui/a11y.mjs` "Tab reaches every control" (the suite now passes on main apart from the known bugs) |
| person-search | S17 | README covers person search | `fast/readme.mjs` "README covers" |
| person-search | S18 | screenshots kept outside git | not ported (screenshots) |
| person-search | S19 | the branch shipped | not ported (ship) |
| person-search | S20 | the real database was never written | not ported (real database) |
| person-search | S21 | the final report | not ported (manual review) |

## fixes-3, palette and palette-final

| Ledger | Gate | What it checked | Now |
|---|---|---|---|
| fixes-3 | X0 | the ledger lints | not ported (lint) |
| fixes-3 | X1 | the Railway keys text | `ui/shell.mjs` "keys " |
| fixes-3 | X2 | no stale focus ring on an inactive tab | `ui/shell.mjs` "stale glow" |
| fixes-3 | X3 | the hero seat line spacing and calendar tap area | `ui/shell.mjs` "seat line" |
| fixes-3 | X4 | no contrast or sideways-scroll regressions | `ui/layout.mjs` "no layout, contrast, tap or error findings" |
| fixes-3 | X5 | screenshots | not ported (screenshots) |
| fixes-3 | X6 | shipped | not ported (ship) |
| fixes-3 | X7 | the real database was never written | not ported (real database) |
| fixes-3 | X8 | visual review of the screenshots | not ported (manual review) |
| palette | G0 | the ledger lints | not ported (lint) |
| palette | G1 | the palette branch and candidates | not ported (ship) |
| palette | G2 | only colour and font declarations changed | not ported (superseded) by real-app G3 |
| palette | G3 | palette rules per theme | not ported (superseded) by real-app G3, now `ui/design.mjs` "token pair passes AA" |
| palette | G4 | token contrast matrix | `ui/design.mjs` "token pair passes AA" |
| palette | G5 | Ticket stub accent chosen by measurement | `ui/design.mjs` "light --accent is teal" |
| palette | G6 | rendered contrast on every screen | `ui/layout.mjs` "no layout, contrast, tap or error findings" |
| palette | G7 | candidate screenshots | not ported (screenshots) |
| palette | G8 | the real database was never written | not ported (real database) |
| palette | G9 | visual review | not ported (manual review) |
| palette-final | F0 | the ledger lints | not ported (lint) |
| palette-final | F1 | final light and dark tokens | `ui/design.mjs` "dark tokens are the Midnight marquee values" |
| palette-final | F2 | index.html loads exactly the theme fonts | `ui/design.mjs` "only Big Shoulders Display and IBM Plex Sans paint" |
| palette-final | F3 | only styles, index, manifest and sw.js changed | not ported (ship) |
| palette-final | F4 | palette rules and contrast matrix | `ui/design.mjs` "token pair passes AA" |
| palette-final | F5 | rendered contrast in both modes | `ui/layout.mjs` "no layout, contrast, tap or error findings" |
| palette-final | F6 | screenshots | not ported (screenshots) |
| palette-final | F7 | sw.js bumped by one | not ported (ship) |
| palette-final | F8 | shipped | not ported (ship) |
| palette-final | F9 | the real database was never written | not ported (real database) |
| palette-final | F10 | visual review | not ported (manual review) |
