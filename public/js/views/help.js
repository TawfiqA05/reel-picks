// Help, under You: the guided tour again, and a short guide to how the app
// works. Owner and friends only (the guest link has no You tab).
import { h, clear, icon } from '../ui.js';

const GUIDE = [
  ['Your four', 'Each week Reel Picks picks the four films at your theaters you\'re most likely to love. They stay put all week, so you can plan around them. The first is the big one at the top of Picks.'],
  ['The match', 'The match is how likely you are to enjoy a film, from public reviews and your own ratings. Early means there are no public scores yet, so it leans on your taste alone. You can change the balance in Settings.'],
  ['Showtimes', 'Book opens that showtime on AMC. Seat by is when the film itself starts after the previews, and out around is when it lets out. A check means the time is inside your preferred showtimes.'],
  ['Rating', 'Rate the films you\'ve seen on the Rate tab or on any film\'s page. Every rating sharpens next week\'s four.'],
  ['Save and Not for me', 'Save puts a film on your watchlist and gives it a boost. Not for me hides it from your picks. Hidden films are listed in Settings, where you can bring them back.'],
  ['At home', 'At home on Picks shows your best matches on the streaming services you choose in Settings, scored the same way.'],
  ['Together', 'Together lists films you and a friend would both enjoy at a theater you both follow. It only shows people who turned it on.'],
];

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
        ...GUIDE.flatMap(([term, text]) => [h('dt', {}, term), h('dd', {}, text)]))),
  );
  root.appendChild(page);
}
