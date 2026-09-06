# Reel Picks

I have an AMC A-List membership and a recurring problem: four movies a week is a lot of
decisions, and I kept either wasting a slot on something mediocre or finding out too late
that the one I actually wanted to see had left the theatre on Wednesday. Reel Picks is my
answer. It pulls what's playing at my AMC, scores every film by blending public reviews
with my own taste, and tells me the four to see this week, with the booking link for the
showtime that fits my schedule.

It's a single Node process with a SQLite file, no accounts, no cloud dependency. It runs
on my machine and installs on my phone as a PWA. One user: me. If you want your own, you
run your own copy with your own keys.

## What it does

- Ranks the current lineup at my primary theatre and picks a weekly four, each with a
  one-line reason and its best-fitting showtime.
- Tracks how long each movie has left. AMC only publishes about a week of showtimes, so
  the app works out where the schedule genuinely stops being published and only says
  "leaving Thursday" when it actually knows. Hedged guesses look hedged.
- Learns my taste from star ratings (genre, director, and lead actors) and gets
  more opinionated the more I rate.
- Follows up to four extra theatres, shows drive times from home, and flags when a film
  leaving my theatre is still playing at one of them.
- Tracks A-List usage: money saved versus ticket prices, and whether my picks landed.
- Shares a read-only link over a Cloudflare tunnel so friends can see my picks without
  being able to touch anything.

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
  The free tier at omdbapi.com/apikey.aspx is plenty for one person.
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
films in a minute or two.

## Privacy

Everything lives in the local SQLite file. Two keyless OpenStreetMap services see
location data for the drive-time feature: OSRM gets home coordinates rounded to about a
kilometre, and Nominatim gets whatever I type into the home-base lookup box. Nothing
about location ever goes to TMDB, OMDb, or AMC, and the shared guest link never carries
home coordinates, drive times, or distances. Settings has a plain "where your location
data goes" note and a one-click way to clear it all.

## Sharing a read-only link

```bash
npm run share
```

Starts the server plus a Cloudflare quick tunnel and prints a public URL. Visitors see
the picks, the full list, and movie pages; rating, settings, imports, and stats are
hidden in the UI and rejected at the API. Guest requests are identified by Cloudflare's
edge headers, which a visitor can't strip and a local browser never sends. The link dies
when the process stops. `OWNER_TOKEN` in `.env` lets me unlock full access for myself
over the same tunnel.

## Deploying

The repo ships a Dockerfile. It's one process serving both API and frontend with one
SQLite file, so deploying is running the container with a persistent volume mounted at
`DATA_DIR` and the keys set as environment variables, plus `TZ`, because showtime math
happens in local time and containers default to UTC. Railway and Fly.io both work; each
person gets their own instance, own volume, own keys. There's no multi-tenancy and I'm
not planning any.

To make a fresh deployment an exact duplicate of a local instance, use **Settings →
Export full setup** locally and **Import full setup** on the deployment: one JSON file
carrying settings, theatres, home base, ratings, watchlist, watch history, and AMC match
decisions. The import is additive and kicks off a refresh, so the new instance pulls its
own showtimes. Caches and schedule history deliberately don't travel. Each instance
builds its own.

## Project layout

```
server/
  index.js            Express app (API + static PWA)
  routes.js           all /api endpoints
  db.js               node:sqlite schema + settings
  lib/                scoring, taste, ranking, runway, geocoding,
                      AMC/TMDB/OMDb clients, refresh pipeline
public/               buildless frontend (vanilla ESM + CSS, PWA)
scripts/              share tunnel, icon generation
data/                 SQLite db + backups (git-ignored)
```

## Scripts

- `npm run dev`: start with auto-reload
- `npm start`: start without watch
- `npm run share`: start plus a public read-only tunnel
- `npm run gen-icons`: regenerate the PWA icons

Deleting `data/` resets everything: ratings, watch history, caches. Keys in `.env`
survive.

## License

MIT — see [LICENSE](LICENSE).
