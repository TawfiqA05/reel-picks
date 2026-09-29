// Help, under You: the guided tour again, and a short guide to how the app
// works. Owner and friends only (the guest link has no You tab).
import { h, clear, icon } from '../ui.js';

const GUIDE = [
  ['Your four', 'Each week Reel Picks picks the four films at your theaters you\'re most likely to love. They stay put all week, so you can plan around them. The first is the big one at the top of Picks.'],
  ['The match', 'The match is how likely you are to enjoy a film, from public reviews and your own ratings. Early means there are no public scores yet, so it leans on your taste alone. You can change the balance in Settings.'],
  ['Showtimes', 'Book opens that showtime on AMC. Seat by is when the film itself starts after the previews, and out around is when it lets out. A check means the time is inside your preferred showtimes.'],
  ['Rating', 'Rate the films you\'ve seen on the Rate tab or on any film\'s page. Every rating sharpens next week\'s four.'],
  ['Save and Not for me', 'Save puts a film on your watchlist and gives it a boost. Not for me hides it from your picks. Hidden films are listed in Settings, where you can bring them back.'],
  ['Watchlist alerts', 'Turn on Watchlist alerts in Settings for a notification when a film on your watchlist starts showing at your theaters, and again in its last week. Late at night they wait until 9\u00a0AM. Films you\'ve rated, seen, hidden or planned to go to don\'t get one.'],
  ['I\'m going', 'Tap I\'m going on a showing to plan it. You get a reminder two hours before, and the next morning Picks asks whether you saw it. Yes logs it seen on that day. Pick another showing to move the plan, or cancel it any time.'],
  ['Send a pick', 'Send shares a film, with a short note if you like. It waits at the top of their Picks until they save it, see it, rate it or dismiss it. You can send ten a day.'],
  ['At home', 'At home on Picks shows your best matches on the streaming services you choose in Settings, scored the same way.'],
  ['Together', 'Together lists films you and a friend would both enjoy at a theater you both follow. It only shows people who turned it on.'],
];

// Who sees your plans depends on who you are: said in the I'm going line.
function guide(ctx) {
  const status = ctx.getStatus?.();
  const owner = status?.ownerName || 'the owner';
  const who = ctx.isOwner?.()
    ? 'Friends who turned on Together see your plans, and you see theirs.'
    : `With Together on, you and ${owner} see each other's plans. Nobody else sees yours.`;
  return GUIDE.map(([term, text]) => [term, term === 'I\'m going' ? `${text} ${who}` : text]);
}

export async function render(root, params, ctx) {
  clear(root);
  const page = h('div', { class: 'page help' },
    h('section', { class: 'group' },
      h('div', { class: 'group-body' },
        h('div', { class: 'row-line' },
          h('div', { class: 'row-text' },
            h('div', { class: 'row-title' }, 'Guided tour'),
            h('p', { class: 'muted small' }, 'A quick walk through Picks, Schedule, Rate, Watchlist and You.')),
          h('button', { class: 'btn soft tour-replay', type: 'button', onClick: () => ctx.startTour() }, icon('play', { size: 16 }), 'Replay tour')))),
    h('section', { class: 'group', 'aria-labelledby': 'guide-title' },
      h('h2', { class: 'group-title', id: 'guide-title' }, 'How it works'),
      h('dl', { class: 'group-body guide' },
        ...guide(ctx).flatMap(([term, text]) => [h('dt', {}, term), h('dd', {}, text)]))),
  );
  root.appendChild(page);
}
