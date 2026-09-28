# Reel Picks

I have an AMC A-List membership and a recurring problem: four movies a week is a lot of
decisions, and I kept either wasting a slot on something mediocre or finding out too late
that the one I actually wanted to see had left the theater on Wednesday. Reel Picks is my
answer. It pulls what's playing at my AMC, scores every film by blending public reviews
with my own taste, and tells me the four to see this week, with the booking link for the
showtime that fits my schedule.

It's a single Node process with one SQLite file. Movie data comes from TMDB, OMDb and AMC.
A few other services see small, specific things: OpenStreetMap for drive times, Letterboxd
if someone links an account, the browser's push service if someone turns notifications on,
and S3-compatible storage if I set up the off-site backup. It runs on my machine or on one
small server, and installs on my phone as a PWA. I'm the owner, and I can invite up to nine
friends onto the same instance. Each of them gets their own ratings and their own four. If
you want your own, you run your own copy with your own keys.

## What it does

- Ranks the current lineup at my primary theater and picks a weekly four, each with a
  one-line reason and its best-fitting showtime. The top pick fills a full-width hero
  with its backdrop, a Book button for that day's best showtime, and when to be in my
  seat. The other three sit under it as cards ("The rest of your four").
- Locks the four for the week. See "The weekly four" below.
- Lets me pick the day from a strip of date tiles, and every showtime on the page follows.
- Tracks how long each movie has left. AMC only publishes about a week of showtimes, so
  the app works out where the schedule genuinely stops being published and only says
  "leaving Thursday" when it actually knows. Hedged guesses look hedged.
- Shows a Last chance row when a film I'd like is confirmed to be leaving soon. Real
  departures get a loud "Last day today" or "Leaving Fri" tag. Anything hedged stays
  quiet, and the row disappears when nothing qualifies.
- Under the four: Also worth seeing (everything else above my good-match cutoff), Also
  nearby (films playing only at one of my other theaters), and Everything playing, the
  whole ranked lineup with a filter box. Everything playing remembers whether I left it
  collapsed.
- Learns my taste from star ratings (genre, director, and lead actors) and gets
  more opinionated the more I rate.
- Follows up to four extra theaters, shows drive times from home, and flags when a film
  leaving my theater is still playing at one of them.
- Tracks my movie plan: money saved versus ticket prices, and whether my picks landed.
  Mark seen on a movie page logs it, and the button turns into "Seen · Undo". Each person
  picks their own plan in Settings: AMC A-List, Regal Unlimited, Cinemark Movie Club,
  another subscription, or none. A preset fills in the usual visits, fee and ticket price
  (all editable), and the allowance, savings and wording on Stats and movie pages follow
  it: Movie Club counts credits per month, Regal Unlimited has no limit, and with no plan
  Stats shows ticket spend instead of an allowance and savings. Showtimes still come from
  AMC theaters for everyone. Anyone who had the app before plans existed is on A-List with
  the values they already had.
- Has an "At home" segment on Picks for nights in. Each person picks the streaming
  services they have in Settings (Netflix, HBO Max, Disney+, Hulu, Prime Video, Apple TV+,
  Peacock, Paramount+, and "Free with ads" for Tubi, Pluto TV and the like), and gets their
  4 best matches this week from films included with them in the US, never rentals. Films
  are scored with the same taste model and weights as the theater picks, need 50+ TMDB
  votes, and skip anything rated, seen or hidden. Each card has the service's logo, the
  match score, a one-line reason ("Because you loved Interstellar") and Rate, Save and
  Not for me. The list is worked out once a week (from Friday) and stays put; every
  candidate is confirmed with TMDB's watch providers, and all of it goes through the shared
  TMDB throttle and cache. No services chosen means a one-tap prompt to pick them.
- Answers "What should I watch?" from a button on Picks and in the search sheet. Three
  one-tap questions, each skippable: where (Theater, At home, Either), how long (Under 2h,
  Any length) and the mood (Funny, Intense, Feel-good, Mind-bending, Scary, Romantic,
  Surprise me). Out come three good films that fit, from what's playing at my theaters and
  what's on my services, each with its match, its best public score and a reason. It keeps
  my place when I open one of them, and it doesn't show me the same film twice in a week
  while there are others to show (see What should I watch? below).
- Lets me say "I'm going" to a showing and reminds me before it (see I'm going below).
- Sends a film to a friend with a short note (see Send a pick below).
- Shares a read-only guest link so other people can see my picks without touching anything.

## The weekly four

The four locks once a week, at the first good refresh of the A-List week (normally just
after midnight on Friday), separately for me and for each friend. The guest link shows
mine. Until the new four locks, last week's stays up. The four that locks is exactly what
the ranking would pick at that moment; after that, the scores keep moving but the four
doesn't.

During the week a film leaves my four only when I rate it, mark it seen, tap Not for me,
or it has no showtimes left this week at any of my theaters. The next best film by its
current score takes the free place, and the others keep theirs. There's one exception, at
most once a week: a film that had no public score when the four locked (too few reviews
yet) and has since earned one can take #4's place if it now beats #4 by 5 points or more.
That film gets a small "New this week" tag. There's no push for it.

I picked 5 points from the real scores: neighbouring films in a top eight sit 0 to 3
points apart, and #1 to #4 spans 5 to 9, so 5 is past the day-to-day drift and puts the
film at or near the top of the four.

Everything else on Picks (Also worth seeing, Last chance, Everything playing) keeps
updating as before. The Friday push waits for the lock and names the locked #1, and the
hit-rate's record of what I was offered is written when the four locks, plus any film
that joins it during the week.

## The tabs

There are five, along the bottom on a phone and across the top on a computer.

- **Picks** is everything above: the four, At home, What should I watch?, Last chance, and
  the rest of the lineup. On a phone I pull the page down to refresh it: for me that runs
  a real refresh, for a friend it just reloads the picks.
- **Schedule** holds Leaving soon and Coming soon as two segments, and it reopens the one
  I used last. Old `#/coming` and `#/leaving` links still land on the right one.
- **Rate** is where ratings come in: search and rate, the Letterboxd and IMDb importer,
  and my full ratings list (more on that below).
- **Watchlist** is every film I saved, as a poster grid. A saved film that's confirmed to
  be leaving gets a line at the top. A long list gets a filter box. Saved films get a
  ranking boost on Picks.
- **You** holds four segments, and reopens the one I used last:
  - **Stats** shows this period's plan usage and savings (or ticket spend with no plan),
    films seen this year, my average rating, the pick hit-rate (how I rated the weekly
    picks I actually went to), a tip when my picks keep rating below my average, and my
    top genres, directors and actors.
  - **Together** is for planning a movie with one friend (see Watch together below).
  - **Settings** is every setting (see Settings below).
  - **Help** has Replay tour and a short guide to how the app works.

  Old `#/stats`, `#/together` and `#/settings` links open the right segment inside You.
  Anyone who used the app before You existed gets a one-time note saying Stats, Together
  and Settings moved there. The guest link has no You tab.

The header holds only the logo and Search. Search opens a sheet that searches TMDB and the
films I already have around (playing, coming soon, rated, saved, hidden) as I type.
It forgives typos, ranks well-known films first, and badges what's playing, rated,
saved or hidden. It finds people too: type a director's or an actor's full name, just the
last name, or a close typo ("tarentino") and up to two people show above the films, each
with a photo, Director or Actor, and two or three films they're known for. A typo is fixed
against the names the app already knows (the directors and casts of the films it has, and
of the 100 films with the most TMDB votes, fetched once a week), and a person never goes
above a well-known film whose title is what I typed. With the box empty it shows my
recents: the last 10 searches and the last 8 films and people I opened, kept per person on
the server, with Clear all and an Undo. Pressing `/` anywhere outside a text field opens it.

A person page (`#/person/<TMDB id>`) opens from search and from the director and cast
names on a movie page. It shows their films playing at my theaters this week, then the ones
I rated with my stars, then everything else they directed or acted in, most popular first,
with a Directed / Acted switch for someone who has done both. TV isn't in it. Every film can
be rated and saved right there, like in the Stats sheets, and a film I rate moves up into
my rated ones. Their films come from the same 7-day TMDB credits cache the Stats "More from"
sheets use, shared by everyone, so a second person opening the same page costs no TMDB call.

A movie page has the hero, a Trailer button, Mark seen, the public score broken down by
source, the taste match broken down by the genres, director and actors I've rated, and
every showtime at each theater I follow, with how long it has left there. For me there's
also a small "Matched to '<AMC title>' · Fix" line for when AMC's title was matched to
the wrong TMDB film.

## How it looks

It follows the device's light or dark setting. Dark is "Midnight marquee": deep navy with
warm amber for the things I tap, gold for saved films and stars, and a soft glow behind
the top of the Picks hero and a movie page in the main color of that film's poster. The
server works that color out once per film and stores it; a film without one gets a faint
amber glow. Light is "Ticket stub": cream paper, dark ink and teal, with no glow.

Titles, film names and section headings are set in Big Shoulders Display, and everything
else in IBM Plex Sans. Both are served from Google Fonts with fallbacks sized to match, so
nothing jumps when they arrive.

A few rules hold everywhere. Every showtime row is the same grid (time, format, when it
ends, whether it fits my preferred times, Book), and tapping anywhere on the row books.
Format tags are tinted by kind (IMAX blue, Dolby purple, RealD 3D teal, 70mm amber), and
so are status tags (Back in theaters teal, Last chance red, New this week amber). The main
button on a screen is filled, other choices are soft, and anything that removes or hides
is soft red. Stats and Settings are plain grouped lists; only the hero, sheets and dialogs
sit in boxes. The seat line reads like "Seat by 12:05 PM · out around 3:06 PM".

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
  genre at my theaters and opening soon. I can rate or watchlist any of them in place,
  and a rated film moves up into my list. Filmographies come from TMDB, cached for a
  week and shared between everyone on the instance.
- **Trailers.** A movie page's Trailer button plays the trailer in a dialog inside the
  app. It never starts on its own and stops the moment the dialog closes. The pick is
  TMDB's official English trailer when there is one, and a foreign film with only its
  own-language trailers still gets one.
- **Where to watch.** Movie pages list where a film streams, rents and sells in the US,
  with provider logos, from TMDB's watch providers (data from JustWatch). When the same
  services rent and sell it, the two lists become one "Rent or buy" row. Films that
  aren't in theaters get a one-line "Stream on …" in search and in "More from". Each
  film's answer is cached for three days and fetched through the shared TMDB throttle.
- **Add to calendar.** Every showtime row has a small calendar button that downloads an `.ics`
  event: the film as the title, AMC's start time in the theater's own time zone, "be
  there by" and the end time in the notes, and the theater's name and address as the
  location. It opens straight in Calendar on an iPhone.
- **Poster fallbacks.** When a poster is missing or fails to load, the film's title goes
  on a plain gradient tile instead of a broken image.
- **Guided tour.** The first time anyone opens Picks they get a short tour: a spotlight
  on the real thing on screen (the four, Book, Save and Not for me, the day strip, the
  stars, What should I watch?, At home, Schedule, Rate, Watchlist, Search and You) and a
  small card with Next, Back and Skip tour. It works with arrow keys, Enter and Escape,
  never closes on a stray tap, and holds still for reduced motion. Finishing or skipping
  is remembered per person; Replay tour under You, Help brings it back.

## Quick start

```bash
npm install
cp .env.example .env   # then add your keys (see below)
npm start              # http://localhost:5170
```

Node 24 or newer. The app uses the built-in `node:sqlite`, so there's no native build
step and no database server. Data lives in `data/reelpicks.db` (or in `DATA_DIR` when
it's set). The server starts without any keys; Settings then says which ones are missing.
Keys are read once at startup, so after editing `.env`, restart the server. Then open
Settings to confirm the keys are connected, set your theater and home base, hit Refresh,
and rate about twenty movies so the taste side of the scoring has something to work with.

Out of the box the primary theater, the home base and `OWNER_NAME` in `.env.example` are
mine. Change the theater and home base in Settings and the name in `.env`.

`npm run dev` does the same with auto-reload. Every reload is a fresh start, and every
start runs the database migrations against `data/reelpicks.db`, so I don't point it at
data I care about while I'm editing migrations.

## The three API keys

Keys go in `.env` (git-ignored). A real environment variable wins over the same name in
`.env`. A missing key just disables that source; the app degrades instead of breaking.

- **TMDB** (`TMDB_API_KEY`), required. Posters, metadata, cast, trailers, and the
  fallback now-playing list. Free from themoviedb.org → Settings → API ("API Key (v3 auth)").
- **OMDb** (`OMDB_API_KEY`), recommended. IMDb, Rotten Tomatoes, and Metacritic scores.
  The free tier at omdbapi.com/apikey.aspx is plenty for a handful of people.
- **AMC** (`AMC_API_KEY`), optional. And the honest caveat: AMC's developer program at
  developers.amctheatres.com is gated. You apply, a human approves it, and keys are only
  provisioned in AMC's weekly deploy, which lands on Thursdays, so even an approved
  request can sit for days before the key works. Without one, Reel Picks falls back to
  TMDB's current US releases: you still get rankings, just not your theater's exact
  showtimes, IMAX flags, or booking links.

In `.env` they look like `TMDB_API_KEY=your-tmdb-key`. Never commit the real file.

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
small boosts: a saved film, an IMAX showing, a showtime inside my preferred
windows. On top of that sits **urgency**: a film whose run is confirmed to be ending
gets up to six extra points, scaled by how soon it leaves, and more if I saved it.
Urgency only fires on a committed end date. A schedule that merely stops at the edge of
what AMC has published is not scarcity, and treating it as scarcity would make every
Monday look like a crisis. The defaults are tuned so urgency breaks ties without letting
a mediocre film outrank a great one.

That last distinction, committed versus hedged, runs through the whole app. AMC posts
roughly a week ahead, and a handful of advance-sale titles post weeks out. Reel Picks
finds where each theater's schedule stops being densely published and treats everything
past that as unknown, so "Through Thursday" and "Through at least Thursday" mean
different things everywhere they appear.

## Bringing ratings in

The Rate tab has a guided importer for Letterboxd and IMDb exports: a one-time file
upload, no account linking. It walks through both services' actual export flows, with
separate paths for desktop and phone, and explains the traps I hit myself: the export is
a ZIP and you want `ratings.csv` from inside it, and on Letterboxd marking a film
watched is not rating it. Only star ratings export. Wrong files get a specific
explanation instead of a generic error, and after an import you see exactly what was
imported, skipped, and left unmatched. IMDb's 1–10 scores convert to half-star ratings. A file can hold up to 20,000 ratings; a bigger one gets split and imported in parts.
The same importer takes back the file from Export backup CSV (Settings → Data), which
restores ratings and watch history.

You can also just search and rate in the app. The quick rate flow covers about twenty
popular films in a minute or two, and Re-run quick rate in Settings → Data brings it back.
Under all that, my ratings list opens on the newest 60, with Show all for the rest and a
forgiving filter box that searches every one of them. Every star rating works from the
keyboard as well: Tab to the stars, arrow keys move half a star at a time, Enter or Space
saves, Delete or Backspace clears, and a screen reader hears the value ("3.5 stars") as
it changes.

Letterboxd can also stay in sync on its own. Anyone with an account (me or a friend, never
the guest link) can put their Letterboxd username in Settings. Once a day, and whenever
they press Sync now, the app reads their public diary feed (`letterboxd.com/<name>/rss/`,
the newest 50 or so entries) and brings in new star ratings and films logged as watched.
Films are matched to TMDB by the id Letterboxd includes, or by title and year when it
doesn't. Each diary entry comes in once, so a re-sync adds nothing and a rating or watch
deleted here isn't brought back. A rating changed in Reel Picks after the Letterboxd entry
was logged is never overwritten; one changed on Letterboxd later comes across. Films
logged there count as seen but never toward the A-List week or savings, since they may not
have been a ticket. Settings shows the last sync time and how many films it added, or a
plain message for a username with no public profile. Imports start the credits backfill
like any other import. For a whole history, the ratings.csv import is still the way.

## Friends

One instance holds me and up to nine friends. I add a friend in **Settings → Friends**
by typing a name, and the app makes a one-time invite link. It's shown once, with a Copy
button, and only a hash of it is stored.

Opening the link doesn't sign anyone in. It shows a small Join page, and only the Join
button uses the invite. That matters because iMessage, Slack and friends fetch every
link they see to draw a preview, and those fetches used to burn invites before anyone
tapped them. After Join, my friend gets a signed cookie that lasts a year and lands in
a short welcome setup: pick a theater, rate at least ten films (search, a Letterboxd or
IMDb import, and a grid of films most people have seen), and one screen on what the
app does. Anyone with fewer than five ratings gets it too, until they finish or skip
it; the guided tour follows. The Join page also tells iPhone users to open the link in
Safari so they stay signed in.

Each person has their own ratings, watchlist, hidden films, watch log, movie plan,
streaming services, theaters, home base, showtime windows, weights, Letterboxd link,
notification devices, search recents, and stats, and their own weekly four. Showtimes,
public scores, and movie data are shared, and one refresh covers every theater anyone
follows, up to eight in total. A friend adding a theater nobody follows queues an ordinary
refresh. Friends can't force one.

Some tools stay mine: API key status, AMC title matching, the friend list, the
full-setup import, forced refreshes, backups (Download latest backup and the off-site
upload), Alerts, Schedule diagnostics, and the shared tuning (the Also worth seeing
cutoff, Last chance, and the Now-playing fallback window). Friends can export their own
data.

Friends and the guest link have hourly limits on the lookups that spend the shared keys:
about 200 films the app hasn't stored yet, 300 rating searches and 30 home-base lookups an
hour for a friend, less for the guest link. Looking up a person TMDB hasn't answered about
yet counts as one of the 200 (over the limit, search still finds films, just not people). Over a limit the app says "Slow down a bit, try
again in a few minutes." A busy evening doesn't come close. I have no limits.

Revoking a friend stops their cookie on the next request and keeps everything they
rated. A new link brings them back, and cookies from before stay dead, so an old link or
cookie can't come back to life. A revoked friend still holds one of the nine places.

## Watch together

The Together tab finds films two people could see together. It's always me and one
friend, never two friends. A friend turns it on from the tab ("Let Tawfiq plan movies
with me") or with the Watch together switch in their Settings, and can turn it off any
time. I pick one of the friends who turned it on; a friend only ever sees me.

A film shows up when it plays in the next 14 days at a theater we both follow, neither of
us has rated it, logged it or hidden it, and it's on both watchlists, on one watchlist and
a strong match for the other, or a strong match for both. Each film gets one short label
("On both watchlists", "Strong match for both") and the next few showtimes, weekend
evenings first. Neither person's ratings, scores or full watchlist are ever sent.

## What should I watch?

It's for the evening I don't know what I want. The button sits under the four on Picks,
and there's a "Not sure? What should I watch?" link in the search sheet. Three questions,
one tap each, and I can skip any of them: where I'm watching (Theater, At home, Either),
how much time I have (Under 2h, Any length) and the mood (Funny, Intense, Feel-good,
Mind-bending, Scary, Romantic, Surprise me). Then three films.

Only good films make it. A film needs a match of 65 or more (the same match every other
page shows me) and a solid public score: TMDB 7.0 or better from at least 200 votes, or
Rotten Tomatoes 75% or better, or IMDb 7.0 or better. A film with no scores yet only
counts when it's a theater film showing in the next 48 hours, and then on its match alone.
I tried a floor of 75 first, on a copy of the real database with Either, Any length and
Surprise me. That left my friend with 700 ratings only 5 films at their theater, and 70
left 9, so the floor came down to 65, the lowest I allow. What holds them back is how few
films are left that they haven't rated, not the floor.

The films that clear the bar are ranked by a blend of my match (60%) and the public score
(40%). With 5 to 19 ratings it's half and half, and under 5 ratings it's the public score
alone, since the match doesn't know me yet. The three are then drawn at random, with the
better ones more likely, so the same answers don't always give the same three. No two in
a set share a director, and a Surprise me set never has three of the same main genre.

It remembers every film it has shown me, on the server, for 7 days. A film I was shown
doesn't come back that week unless fewer than three others would clear the bar. "Show me
3 more" never repeats anything from the same run, and when nothing is left it says that's
everything.

When fewer than three clear the bar, it lowers it a step (TMDB 6.5, Rotten Tomatoes 70%,
IMDb 6.5), then another (6.0, 65%, 6.0), and says so above the results in plain words:
"Not much great for this mood in theaters. These are the closest." When nothing fits even
then, it says "Nothing fits right now. Try another mood or At home." and names whatever
else I could change.

Each card shows the match and the score that cleared the bar in one pill, like "88% match ·
RT 92%", then the year, genres and length, where to see it (the theater and next showing,
or the service), and a one-line reason. Seen it (a star rating), Save and Not for me work
right on the card.

It keeps my place. If I open one of the films (its page, the trailer on its page, anyone
in its cast) and come back with the back button, the back swipe in the installed app, or
by tapping Picks, the sheet opens again on the same answers and the same three, and "Show
me 3 more" carries on from there. Anything I did on the film's page, like saving it, shows
on its card. The place is kept on that device only, separately for each person who uses
it, and ends when I tap Start over, close the sheet, or leave it for 30 minutes. The guest
link has no way in.

## I'm going

When I've decided on a showing, I tap I'm going. On the Picks hero it's the showing the
Book button points at; on a movie page and in Schedule's Leaving list it opens a sheet
of the showings still to come, by theater and day. There's one plan per film: picking
another showing of the same film moves it, and I can change it or cancel it any time.
The plan shows in the soft accent as "You're going · Tonight 7:10 PM · Maple Grove" on
the hero, on the movie page and on that showing's own row.

Two hours before the showing I get a reminder push (none if I made the plan with less than
two hours to go). The next morning at 10 a push and a card at the top of Picks ask "Did you
see it?". Yes logs the film seen on the day of the showing, the same way Mark seen does,
so it counts toward my movie plan, and then offers the star rating. No just clears the
plan. If I don't answer, the card stays for three days and then goes. Marking the film
seen or rating it any other way clears the plan and the question on their own.

Plans follow the Together rule. When a friend has Together turned on, I see "(name) is going
Sat 7:10 PM" on that film and they see my plans. A friend never sees another friend's plan,
and nobody sees anyone's plan without Together. The guest link sees none of it.

The reminders and questions are checked every minute and recorded in the database before
they go out, so a restart or a deploy never sends one twice and a cancelled plan never
sends anything.

## Send a pick

Send on a movie page or on the Picks hero opens a small sheet. I can send a film to any
friend; a friend can send only to me, so a friend never sees another friend's name. There's
an optional note of up to 140 characters, kept as plain text.

The person it's for gets a push (if they have push on), "(my name) thinks you'd like
(the film)", and a "Sent to you" row at the top of Picks with the note. The row goes
when they dismiss it, save the film, mark it seen or rate it, and the movie page shows
"Sent by" with the note while it's there. Each person can send ten a day. The guest link
can't send or receive, and sending never changes a score or a pick.

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
deleted. I can run the week's send by hand with `POST /api/push/weekly/send`,
and it skips anyone who already got this week's.

The same devices get the I'm going reminders and next-morning questions, and the pushes
for picks sent to me. Each goes only to the person it's about.

It's plain Web Push with VAPID keys, no extra dependency. Without `VAPID_PUBLIC_KEY` and
`VAPID_PRIVATE_KEY` the feature is off and the switch never appears.

The same devices get my owner alerts, which friends never do. If the nightly backup or the
off-site upload fails, or AMC answers with no showtimes at all for my primary theater, my
devices get one push with a one-line reason. It's at most one alert per problem per day,
however many times it fails, and one "back to normal" when it works again.

A failed daily refresh (AMC doesn't answer for my primary theater, TMDB's lists fail, or
the run breaks) is tried again every hour, up to six times, and stops as soon as one
works. Only one refresh ever runs at a time, and the retries carry on across a restart. I
only get the alert if all six retries fail too. If that happens on a Friday before the
week's four has locked, the four locks from the lineup it already had. The last 10 alerts, and anything failing right now, are in
my Alerts card in Settings, which also works with push turned off.

## The guest link

With `GUEST_MODE` on, anyone who reaches a deployment from outside without a cookie gets
the read-only guest view. The same goes for anyone coming through the `npm run share`
tunnel. They see one banner ("You're viewing Tawfiq's picks. Ask him for an invite to
get your own.") instead of the setup and tour, and they get my picks, the full list,
Schedule (Leaving soon and Coming soon), and movie pages. A person page opened from a movie
page or a link works too, read only: no stars, no Save, and none of my ratings. Rating,
settings, imports, search, stats and everything else are hidden in the UI and rejected at
the API. At localhost it's always me.

On Railway the app fails closed: if `GUEST_MODE` is missing or not 1 there, it treats every
visitor as a guest anyway, and sends me an owner alert each time it starts until I set it.
My owner link and friends' logins keep working. Railway is detected from the variables
Railway sets itself, so a copy on my Mac behaves as it always has.

When it isn't on Railway, the server only answers requests addressed to `localhost`,
`127.0.0.1` or `[::1]`, so a web page can't point its own address at my machine and reach
it as me. `RP_ALLOW_LAN` opens it to other devices on my network. The share tunnel below
still works without it.

Visiting `/?owner=<OWNER_TOKEN>` once in a browser sets a signed cookie that unlocks full
access for me there, and the token itself never stays in the URL.

`npm run share` still works locally. It starts the server plus a Cloudflare quick tunnel
and prints a temporary public URL that serves the same read-only view. The link dies when
the process stops.

## Installing it on a phone

On an iPhone, open the site in Safari, tap Share, then Add to Home Screen. On Android and
desktop Chrome, use the browser's Install option. It opens full screen like an app.

A service worker keeps exactly one copy of the app for offline use. Offline, a page that
needs the server says "You're offline" with a Retry button instead of breaking.

A deploy reaches phones that already have the app open. Each page knows the version it
was built from, and asks the server (`/api/version`) which one is live: when the app
opens, every time it comes back to the foreground, when the network returns, and every
five minutes. An installed iPhone app is mostly resumed rather than relaunched, and its
first requests after waking often fail, so each check keeps retrying for about half a
minute instead of giving up after one try. That single try was why my Home Screen app
used to sit on an old version. When the page is behind, it reloads onto the new version
once, unless a sheet is open, a save is in flight or I'm typing. Then it shows "Update
ready" with a Refresh button and reloads at the next quiet moment. It never reloads twice
for the same version, so it can't loop.

Two more things keep a launch on a waking network from getting stuck. The service worker
treats an error reply (a 408 or a 5xx) like no reply and uses its cached copy, since one
script arriving as an error would stop the whole app from starting. And if the app still
hasn't started 12 seconds after a launch from the Home Screen, a tiny script at the top
of `index.html` loads the page again, at most twice a minute.

Bump `CACHE` in `public/sw.js` with every frontend change, and add any new file under
`public/js/` to its `CORE` list, so offline has it too.

## Settings

Settings is under You. Every group, top to bottom. Groups marked "mine" are only on my
Settings page. A Save bar slides up above the tab bar only when something has changed.

- **API keys** (mine): which keys are connected. On Railway it says to change them in
  Railway's variables and redeploy; locally it points at `.env`.
- **Theaters**: the primary plus up to four followed ones, with drive times; search AMC
  theaters to follow one or make it primary.
- **Friends** (mine): add a friend, copy their one-time link, revoke, or re-issue.
- **AMC title matching** (mine): AMC titles that couldn't be matched to TMDB, matches that
  look wrong (Keep, or search and re-point), and Ignore for one-offs.
- **Watch together** (friends): the switch for the Together tab.
- **Notifications**: the weekly picks switch, per device. Only there when the VAPID keys are set.
- **Streaming services**: which services At home and What should I watch? use.
- **Letterboxd**: the username to sync, Sync now, and how the last sync went.
- **Home base**: where drive times are measured from. Look up a place or use my current
  location, and Clear home base.
- **Ranking balance**: public reviews versus my taste.
- **Preferences**: Prefer IMAX, and genres and ratings (like NC-17) never to recommend.
- **Hidden films**: everything marked Not for me, with Unhide.
- **Now-playing fallback** (mine): how recent a film has to be when there's no AMC key.
- **Preferred showtimes**: weekday and weekend windows; a showing inside one gets a boost.
- **Movie plan & pricing**: the plan, its allowance, fee and ticket price, and the preview
  length that sets the Seat by time and the "out around" time.
- **Score boosts (advanced)**: the watchlist, IMAX, window-fit and urgency boosts.
- **Also worth seeing** (mine): the minimum score for that section.
- **Last chance** (mine): the minimum score, how far before the horizon counts as a real
  departure, and how many to show.
- **Schedule diagnostics** (mine): where each theater's schedule stops being published,
  day by day.
- **Alerts** (mine): the last 10 alerts and anything failing now.
- **Data**: Export full setup (friends: Export my data), Import full setup (mine), Export
  backup CSV, Download latest backup (mine), the off-site backup status with Upload now
  (mine), Refresh now (mine), Re-run quick rate, and the last refresh's warnings.

## Deploying

The repo ships a Dockerfile. It's one process serving both API and frontend with one
SQLite file. I run it on Railway with a persistent volume mounted at `/data`, which is
where the Dockerfile points `DATA_DIR`. Railway builds from `main` on every push and
injects `PORT`. Variables go in the service's Variables tab, and changing one needs a
redeploy.

Every night at 3am (the server's `TZ`), or at the first check after that if the server was
down, it writes a consistent copy of the database to
`/data/backups/reelpicks-YYYY-MM-DD.db` and keeps the last 14. It also takes one right
before any schema migration, as `backups/reelpicks-pre-<change>-<time>.db`, and keeps the
last 14 of those. Running a migration a second time changes nothing. Right after a
nightly copy succeeds, and only then, cached API answers more than three times past their
lifetime are deleted; nothing but the cache is touched. The first time that happened, a
one-time VACUUM gave the space back, and it never runs on its own again. I can
download the newest copy with Download latest backup in Settings → Data, and
`/api/status` shows its time and size under `backup`.

Once a week, Sunday at 4am (the server's `TZ`), the newest nightly copy also goes off-site
to S3-compatible storage, Cloudflare R2 in my case, as
`reel-picks/weekly/reelpicks-YYYY-MM-DD.db`. The last 8 weekly copies are kept and older
ones are deleted, and only objects under that prefix with exactly that name pattern are
ever touched. The first copy goes up as soon as the variables are set and a nightly copy
exists, and a server that was down at 4am on Sunday sends it at its next check. Settings →
Data shows the last upload's time and size and has an Upload now button. A failed upload
is retried an hour later and sends an owner alert. Requests are signed (AWS Signature
Version 4) with Node's own crypto, so there's no SDK. Without the variables the feature
doesn't exist: nothing is scheduled and nothing shows.

One thing to know: AMC rejected my key with "Unauthorized VendorKey" when the service
ran in an EU region, even though the same key worked from home. Moving the service to a
US region fixed it.

To make a fresh deployment an exact duplicate of a local instance, use **Settings →
Export full setup** locally and **Import full setup** on the deployment: one JSON file
carrying my settings, theaters, home base, ratings, watchlist, watch history, hidden
films, and AMC match decisions. The import is additive and kicks off a refresh, so the new
instance pulls its own showtimes. Caches and schedule history deliberately don't travel.
Each instance builds its own. Friends don't travel either; I invite them on the instance
they'll use.

## Environment variables

Every variable the code reads, by name. Values go in `.env` locally or in Railway's
variables when deployed. None of them belong in the repo.

The keys:

- `TMDB_API_KEY`, `OMDB_API_KEY`, `AMC_API_KEY`: the three keys above.

Running it:

- `PORT`: the port to listen on. 5170 unless set; Railway sets it.
- `DATA_DIR`: where `reelpicks.db` and `backups/` live. `./data` unless set; the
  Dockerfile sets `/data`.
- `TZ`: your local time zone, such as `America/New_York`. Showtime math, the 3am backup
  and the Friday week all use local time, and containers default to UTC.
- `NODE_ENV`: the Dockerfile sets `production`. It only changes the startup line to show
  the port instead of a localhost link.

Sharing and the owner:

- `GUEST_MODE`: `1` (or `true`, `yes`, `on`) makes every request that isn't addressed to
  localhost the read-only guest, unless it has a friend or owner cookie. Set it on every
  deployment. On Railway, leaving it off doesn't open the site: everyone gets the guest
  view and I get an alert.
- `OWNER_TOKEN`: a long random string for the owner unlock (`/?owner=<OWNER_TOKEN>`).
  Leave it blank to turn the unlock off. `.env.example` shows a one-line way to make one.
- `OWNER_NAME`: the name on the guest banner and the Join page. It defaults to mine.
- `RP_ALLOW_LAN`: when the app runs off Railway, it only answers at localhost. Turning
  this on lets other devices on my network reach it. Railway never needs it.

Notifications (optional):

- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: turn on weekly picks notifications and owner
  alerts. Make a pair with
  `node -e "const e=require('crypto').createECDH('prime256v1');e.generateKeys();console.log(e.getPublicKey('base64url'),e.getPrivateKey('base64url'))"`
  (public first). Changing them later means everyone turns the switch on again.
- `VAPID_SUBJECT`: optionally overrides the contact URL sent to push services.

Off-site backup (optional, all four or nothing):

- `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`: turn on
  the weekly off-site backup. For R2 the endpoint is
  `https://<account id>.r2.cloudflarestorage.com`, and the key is an R2 API token's
  access key id and secret, with Object Read & Write on that bucket.
- `BACKUP_S3_REGION`: defaults to `auto`, which is what R2 wants.

Set by Railway, never by me:

- `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_ENVIRONMENT`, `RAILWAY_PROJECT_ID`,
  `RAILWAY_SERVICE_ID`: when any of them is present, the app knows it's on Railway. The
  API keys card then says the keys are Railway variables, every visitor without a cookie
  is the guest even if `GUEST_MODE` is off, and any Host is answered. Only their presence
  is read, never their values.

For test servers only. Never set these on a real deployment:

- `RP_DISABLE_REFRESH`: `1` turns every refresh into a no-op, so a test server never
  calls AMC. On a real deployment showtimes would stop updating.
- `RP_AMC_BASE`: points the AMC client at a stand-in AMC.
- `RP_LETTERBOXD_ORIGIN`: points the Letterboxd sync at a local copy of the feed.
- `RP_PUSH_TEST_ORIGIN`: lets push subscriptions point at a local fake push service.
- `RP_WSW_SEED`: any text. "What should I watch?" draws its three films from it, so the
  same answers give the same films on every run.

## Project layout

```
server/
  index.js            Express app (API + static PWA), invite Join flow
  routes.js           all /api endpoints
  db.js               node:sqlite schema, migrations, settings
  env.js              the .env loader
  lib/                scoring, taste, ranking, runway, geocoding, accounts,
                      AMC/TMDB/OMDb clients, refresh pipeline, backups,
                      push, Letterboxd, At home, Together, search, people,
                      I'm going plans and sent picks
public/               buildless frontend (vanilla ESM + CSS, PWA)
scripts/              share tunnel, icon generation
test/                 the fast and browser test suites and their made-up sample data
data/                 SQLite db + backups (git-ignored)
```

## Scripts

- `npm start`: start without watch
- `npm run dev`: start with auto-reload
- `npm run share`: start plus a temporary public read-only tunnel (needs `cloudflared`)
- `npm run gen-icons`: regenerate the PWA icons
- `npm test`: the fast checks (see Tests)
- `npm run test:ui`: the browser checks (see Tests)

Deleting `data/` resets everything: ratings, friends, watch history, caches. Keys in
`.env` survive.

## Tests

I keep two test commands. Both build their own sample database in a temp folder, with
made-up friends, theaters and films, and start the app from a copy of the code on a free
port. Nothing reaches TMDB, OMDb or AMC: the tests answer from saved sample responses,
so they run with no keys and no network, and they never touch `data/`. The clock is fixed
to one Wednesday, so every run gives the same result.

`npm test` runs the fast checks in about 2 minutes: the function suite drives every feature
through the app (rate, watchlist, Not for me, filters, Schedule, Stats, search and recents, trailer,
calendar, every Settings save, CSV import, setup export and import, the invite flow, the
person page), search ranking on real TMDB answers, scores and picks against saved expected
values, security for every API route, the owner, friend and guest roles, privacy between
friends, the hourly limits, the weekly lock, the background jobs on a mocked timeline,
I'm going plans (reminders, the next morning's question, restarts) on a mocked clock, and
sending picks.

`npm run test:ui` runs the browser checks in about 10 minutes: accessibility (keyboard,
focus rings, names, dialogs, reduced motion, 200% zoom), layout at 320, 390 and 1280 in
light and dark for every role with no sideways scroll, clipped text, contrast problem or
console error, the design itself (tokens, fonts, buttons, cards, showtime rows), the
installed iPhone app, service worker updates and offline, size budgets, and I'm going and
Send a pick for every role, width and theme.

The first time, I install the browsers with `npx playwright install chromium webkit`.
Real app bugs the tests have found but I haven't fixed yet are listed in
`test/known-bugs.json`; they're expected to fail and don't fail the run, and a run fails
if one of them starts passing, so the list stays honest. When a change is meant to move
scores, I rerun the scores suite with `RP_UPDATE_EXPECTED=1` to save the new values.

Checks that need the real friend accounts run against a copy of the Railway database
from a local folder, `~/reel-picks-qa`, which is never committed.

## License

MIT. See [LICENSE](LICENSE).
