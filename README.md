# Reel Picks

I have an AMC A-List membership and a recurring problem: four movies a week is a lot of
decisions, and I kept either wasting a slot on something mediocre or finding out too late
that the one I actually wanted to see had left the theatre on Wednesday. Reel Picks is my
answer. It pulls what's playing at my AMC, scores every film by blending public reviews
with my own taste, and tells me the four to see this week, with the booking link for the
showtime that fits my schedule.

It's a single Node process with a SQLite file and no cloud dependency beyond the movie
APIs. It runs on my machine or on one small server, and installs on my phone as a PWA.
I'm the owner, and I can invite up to nine friends onto the same instance. Each of them
gets their own ratings and their own four. If you want your own, you run your own copy
with your own keys.

## What it does

- Ranks the current lineup at my primary theatre and picks a weekly four, each with a
  one-line reason and its best-fitting showtime. The top pick fills a full-width hero
  with its backdrop, a Book button for that day's best showtime, and when to be in my
  seat. The other three sit under it as cards.
- Lets me pick the day from a strip of date tiles, and every showtime on the page follows.
- Tracks how long each movie has left. AMC only publishes about a week of showtimes, so
  the app works out where the schedule genuinely stops being published and only says
  "leaving Thursday" when it actually knows. Hedged guesses look hedged.
- Shows a Last chance row when a film I'd like is confirmed to be leaving soon. Real
  departures get a loud "Last day today" or "Leaving Fri" pill. Anything hedged stays
  quiet, and the row disappears when nothing qualifies.
- Learns my taste from star ratings (genre, director, and lead actors) and gets
  more opinionated the more I rate.
- Follows up to four extra theatres, shows drive times from home, and flags when a film
  leaving my theatre is still playing at one of them.
- Tracks A-List usage: money saved versus ticket prices, and whether my picks landed.
  Marking a film seen on its page turns the button into "Seen · Undo".
- Shares a read-only guest link so other people can see my picks without touching anything.

A few smaller things make the lists easier to read:

- **Not for me.** Any pick can be hidden with one tap. It drops out of the four, Also
  worth seeing, Last chance, Also nearby, and Coming soon, and the next-best film moves
  up. Hiding doesn't touch my ratings, my taste profile, or anyone's scores. There's an
  Undo on the toast, a "Show hidden" list to bring films back, and hidden films stay in
  Everything playing, dimmed, with an Unhide link.
- **Back in theaters.** An older film on the current lineup gets a quiet "Back in
  theaters" label, and a re-release in Coming soon shows "Re-release · 1993" instead of
  its original release date.
- **Opens <date>.** A film that isn't out in the US yet, where every showtime this week
  is an early screening, is labelled "Opens Oct 2". It can't take the hero slot unless
  one of those screenings is within the next two days. It keeps its rank either way.
- **Stats drill-downs.** Tapping a genre, director or actor on Stats opens the films I
  rated there, and under them the rest: "More from Phil Lord" lists every other feature
  they directed or acted in (no TV, no "Self" or uncredited parts, and for actors the
  little-seen films wait behind "Show smaller films"), and "Drama playing now" lists that
  genre at my theatres and opening soon. I can rate or watchlist any of them in place,
  and a rated film moves up into my list. Filmographies come from TMDB, cached for a
  week and shared between everyone on the instance.
- **Trailers.** A movie page's Trailer button plays the trailer in a dialog inside the
  app. It never starts on its own and stops the moment the dialog closes. The pick is
  TMDB's official English trailer when there is one, and a foreign film with only its
  own-language trailers still gets one.
- **Where to watch.** Movie pages list where a film streams, rents and sells in the US,
  with provider logos, from TMDB's watch providers (data from JustWatch). Films that
  aren't in theaters get a one-line "Stream on …" in search and in "More from". Each
  film's answer is cached for three days and fetched through the shared TMDB throttle.
- **Add to calendar.** Every showtime has a calendar button that downloads an `.ics`
  event: the film as the title, AMC's start time in the theater's own time zone, "be
  there by" and the end time in the notes, and the theater's name and address as the
  location. It opens straight in Calendar on an iPhone.
- **Schedule.** Leaving soon and Coming soon share one tab as two segments, and it
  reopens the one I used last. Old `#/coming` and `#/leaving` links still land on the
  right one.
- **Poster fallbacks.** When a poster is missing or fails to load, the film's title goes
  on a plain gradient tile instead of a broken image.

## Quick start

```bash
npm install
cp .env.example .env   # then add your keys (see below)
npm run dev            # http://localhost:5170
```

Node 24 or newer. The app uses the built-in `node:sqlite`, so there's no native build
step and no database server. Data lives in `data/reelpicks.db`. Open Settings to confirm
the keys are connected, hit Refresh, and rate about twenty movies so the taste side of
the scoring has something to work with.

## The three API keys

Keys go in `.env` (git-ignored). A missing key just disables that source; the app
degrades instead of breaking.

- **TMDB** (`TMDB_API_KEY`), required. Posters, metadata, cast, trailers, and the
  fallback now-playing list. Free from themoviedb.org → Settings → API ("API Key (v3 auth)").
- **OMDb** (`OMDB_API_KEY`), recommended. IMDb, Rotten Tomatoes, and Metacritic scores.
  The free tier at omdbapi.com/apikey.aspx is plenty for a handful of people.
- **AMC** (`AMC_API_KEY`), optional. And the honest caveat: AMC's developer program at
  developers.amctheatres.com is gated. You apply, a human approves it, and keys are only
  provisioned in AMC's weekly deploy, which lands on Thursdays, so even an approved
  request can sit for days before the key works. Without one, Reel Picks falls back to
  TMDB's current US releases: you still get rankings, just not your theatre's exact
  showtimes, IMAX flags, or booking links.

## How the scoring works

Every film playing gets two numbers on a 0–100 scale.

The **public score** blends whatever sources exist: Rotten Tomatoes and Metacritic on
the critic side, IMDb and TMDB on the audience side, each normalized and averaged. When
critics and audiences disagree by 25 points or more, the card says so. New releases get
a "scores settling" badge for two weeks while reviews land.

A TMDB rating only counts once at least 50 people have voted and the film is out in the
US. Before that, a 9.5 from six early voters is noise, not "Excellent reviews". A film
whose only score is a thin TMDB rating is treated as having no scores yet: it gets a
neutral default, a dashed score pill, and a "No scores yet" badge, and its movie page
says why the rating isn't counted. The app re-checks those films weekly, so the rating
starts counting once enough people have voted.

The **taste match** comes from my ratings. Genres, directors, and top-billed actors each
carry an average of what I've rated before, weighted a little toward recent ratings. With
under ten ratings the app leans on public scores and says so.

The final score is a weighted blend of the two (50/50 by default, adjustable) plus
small boosts: a watchlisted film, an IMAX showing, a showtime inside my preferred
windows. On top of that sits **urgency**: a film whose run is confirmed to be ending
gets up to six extra points, scaled by how soon it leaves, and more if I starred it.
Urgency only fires on a committed end date. A schedule that merely stops at the edge of
what AMC has published is not scarcity, and treating it as scarcity would make every
Monday look like a crisis. The defaults are tuned so urgency breaks ties without letting
a mediocre film outrank a great one.

That last distinction, committed versus hedged, runs through the whole app. AMC posts
roughly a week ahead, and a handful of advance-sale titles post weeks out. Reel Picks
finds where each theatre's schedule stops being densely published and treats everything
past that as unknown, so "Through Thursday" and "Through at least Thursday" mean
different things everywhere they appear.

## Bringing ratings in

The Rate tab has a guided importer for Letterboxd and IMDb exports: a one-time file
upload, no account linking. It walks through both services' actual export flows, with
separate paths for desktop and phone, and explains the traps I hit myself: the export is
a ZIP and you want `ratings.csv` from inside it, and on Letterboxd marking a film
watched is not rating it. Only star ratings export. Wrong files get a specific
explanation instead of a generic error, and after an import you see exactly what was
imported, skipped, and left unmatched. IMDb's 1–10 scores convert to half-star ratings.
You can also just search and rate in the app; a quick-rate flow covers about twenty popular
films in a minute or two. Under all that, my ratings list opens on the newest 60, with
Show all for the rest and a forgiving filter box that searches every one of them.

## Friends

One instance holds me and up to nine friends. I add a friend in **Settings → Friends**
by typing a name, and the app makes a one-time invite link. It's shown once, with a Copy
button, and only a hash of it is stored.

Opening the link doesn't sign anyone in. It shows a small Join page, and only the Join
button uses the invite. That matters because iMessage, Slack and friends fetch every
link they see to draw a preview, and those fetches used to burn invites before anyone
tapped them. After Join, my friend gets a signed cookie that lasts a year and lands in
the quick-rate onboarding. The Join page also tells iPhone users to open the link in
Safari so they stay signed in.

Each person has their own ratings, watchlist, hidden films, A-List log, theatres, home
base, showtime windows, weights, and stats, and their own weekly four. Showtimes, public
scores, and movie data are shared, and one refresh covers every theatre anyone follows,
up to eight in total. A friend adding a theatre nobody follows queues an ordinary
refresh. Friends can't force one.

Some tools stay mine: API key status, AMC title matching, the friend list, the
full-setup import, forced refreshes, and the shared tuning (the good-match cutoff,
Last chance, and the fallback window). Friends can export their own data.

Revoking a friend stops their cookie on the next request and keeps everything they
rated. A new link brings them back, and cookies from before stay dead, so an old link or
cookie can't come back to life.

## Privacy

Everything lives in the SQLite file. Two keyless OpenStreetMap services see location
data for the drive-time feature: OSRM gets home coordinates rounded to about a
kilometre, and Nominatim gets whatever gets typed into the home-base lookup box. Nothing
about location ever goes to TMDB, OMDb, or AMC. Each friend's drive times are measured
from their own home base, and nobody else sees it. The read-only guest link never carries
home coordinates, drive times, or distances. Settings has a plain "where your location
data goes" note and a one-click way to clear it all.

## Notifications

Anyone with an account (me or a friend, never the guest link) can turn on "Notify me
when my weekly picks are ready" in Settings. It's off by default, it's per device, and the
browser only asks for permission when the switch is turned on. On iPhone it works once
Reel Picks is added to the Home Screen; before that, Settings says so instead of showing
a switch. On Friday, right after the first refresh of the new A-List week, each
subscribed person gets one push: "Your 4 for this week are ready" and their #1 title.
Tapping it opens Picks. Nothing else is in it, no scores or ratings.

It's once per person per week even across restarts and deploys: the send is recorded in
the database before it goes out. A device the push service reports as gone (404/410) is
deleted. The owner can run the week's send by hand with `POST /api/push/weekly/send`,
and it skips anyone who already got this week's.

It's plain Web Push with VAPID keys, no extra dependency. Without `VAPID_PUBLIC_KEY` and
`VAPID_PRIVATE_KEY` the feature is off and the switch never appears.

## The guest link

Anyone who reaches the app from outside without a cookie gets the read-only guest view:
my picks, the full list, Schedule (Leaving soon and Coming soon), and movie pages. At localhost it's always
me. Rating, settings, imports, stats and
everything else are hidden in the UI and rejected at the API. On a deployment,
`GUEST_MODE=1` turns this on for every request that isn't addressed to localhost.
Visiting `/?owner=<OWNER_TOKEN>` once in a browser sets a signed cookie that unlocks full
access for me there, and the token itself never stays in the URL.

`npm run share` still works locally. It starts the server plus a Cloudflare quick tunnel
and prints a temporary public URL that serves the same read-only view. The link dies when
the process stops.

## Deploying

The repo ships a Dockerfile. It's one process serving both API and frontend with one
SQLite file. I run it on Railway with a persistent volume mounted at `/data`, which is
where the Dockerfile points `DATA_DIR`. Railway builds from `main` on every push.

Every night at 3am (the server's `TZ`) it writes a consistent copy of the database to
`/data/backups/reelpicks-YYYY-MM-DD.db` and keeps the last 14; it also takes one right
before any schema migration. The owner can download the newest from Settings → Data,
and `/api/status` shows its time and size under `backup`.

Variables to set:

- `TMDB_API_KEY`, `OMDB_API_KEY`, `AMC_API_KEY`: the keys above.
- `OWNER_TOKEN`: a long random string, for the owner unlock.
- `GUEST_MODE=1`: without it, anyone who opens the site gets full owner access.
- `TZ`: your local time zone, such as `America/New_York`. Showtime math happens in local
  time and containers default to UTC.
- `OWNER_NAME` is optional and sets the name on the guest link and the Join page.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: optional, turn on weekly picks notifications.
  Make a pair with `node -e "const e=require('crypto').createECDH('prime256v1');e.generateKeys();console.log(e.getPublicKey('base64url'),e.getPrivateKey('base64url'))"`
  (public first). Changing them later means everyone turns the switch on again.
  `VAPID_SUBJECT` optionally overrides the contact URL sent to push services.

One thing to know: AMC rejected my key with "Unauthorized VendorKey" when the service
ran in an EU region, even though the same key worked from home. Moving the service to a
US region fixed it.

`RP_DISABLE_REFRESH=1` turns every refresh into a no-op. It's for test servers that must
never call AMC. Don't set it on a real deployment, or showtimes stop updating.

A deploy reaches phones that already have the app open. The service worker checks for
a new version when the app opens, when it comes back to the foreground, and every 30
minutes. A new version takes over as soon as it installs, and the page reloads onto it
once, unless a sheet is open or a save is in flight. Then it shows "Update ready" with a
Refresh button and reloads at the next quiet moment. App code always comes from the
server when online, and the offline copy holds exactly one version. Bump `CACHE` in
`public/sw.js` with every frontend change, and add any new file under `public/js/` to
its `CORE` list, so offline has it too.

Migrations that reshape data write a copy of the database next to it first
(`reelpicks.pre-<change>-<time>.db`), and running them a second time changes nothing.

To make a fresh deployment an exact duplicate of a local instance, use **Settings →
Export full setup** locally and **Import full setup** on the deployment: one JSON file
carrying my settings, theatres, home base, ratings, watchlist, watch history, hidden
films, and AMC match decisions. The import is additive and kicks off a refresh, so the new
instance pulls its own showtimes. Caches and schedule history deliberately don't travel.
Each instance builds its own. Friends don't travel either; I invite them on the instance
they'll use.

## Project layout

```
server/
  index.js            Express app (API + static PWA), invite Join flow
  routes.js           all /api endpoints
  db.js               node:sqlite schema, migrations, settings
  lib/                scoring, taste, ranking, runway, geocoding, accounts,
                      AMC/TMDB/OMDb clients, refresh pipeline
public/               buildless frontend (vanilla ESM + CSS, PWA)
scripts/              share tunnel, icon generation
data/                 SQLite db + backups (git-ignored)
```

## Scripts

- `npm run dev`: start with auto-reload
- `npm start`: start without watch
- `npm run share`: start plus a temporary public read-only tunnel
- `npm run gen-icons`: regenerate the PWA icons

Deleting `data/` resets everything: ratings, friends, watch history, caches. Keys in
`.env` survive.

## License

MIT. See [LICENSE](LICENSE).
