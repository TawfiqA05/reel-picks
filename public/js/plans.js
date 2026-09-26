// Movie plans: what a person pays for going to the movies, and the words and
// math that follow from it. Showtimes always come from AMC theaters; only the
// allowance, the savings figure and the wording change with the plan.
//
// DOM-free and import-free: the browser and the server (server/lib/alist.js,
// PUT /api/settings) load this same file, so the two can't disagree.
//
// A plan's terms live in three per-user settings that predate plans (their
// names say A-List because A-List was the only plan then):
//   alistWeeklyLimit   visits allowed per period (0 = no limit)
//   alistMonthlyFee    the monthly fee
//   avgTicketPrice     what a ticket would cost without the plan
// plus moviePlan (one of PLAN_IDS) and planPeriod ('week' | 'month').

export const PLANS = {
  'amc-alist': {
    name: 'AMC A-List', short: 'A-List', unit: 'reservation', units: 'reservations', subscription: true,
    defaults: { limit: 3, period: 'week', fee: 25.99, ticket: 14.5 },
    note: 'Your plan\'s terms. AMC varies the allowance by region and raises the fee from time to time. Change them here when it does.',
  },
  'regal-unlimited': {
    name: 'Regal Unlimited', short: 'Regal Unlimited', unit: 'visit', units: 'visits', subscription: true,
    defaults: { limit: 0, period: 'week', fee: 21.99, ticket: 15 },
    note: 'Regal Unlimited has no visit limit (0 here). The fee depends on your tier and region.',
  },
  'cinemark-movie-club': {
    name: 'Cinemark Movie Club', short: 'Movie Club', unit: 'credit', units: 'credits', subscription: true,
    defaults: { limit: 1, period: 'month', fee: 10.99, ticket: 13 },
    note: 'Movie Club gives one ticket credit a month. Unused credits roll over; count them in here if you like.',
  },
  other: {
    name: 'Other subscription', short: 'your plan', unit: 'visit', units: 'visits', subscription: true,
    defaults: { limit: 2, period: 'week', fee: 20, ticket: 14 },
    note: 'Any other movie subscription: set how many visits it allows, how often, and what it costs.',
  },
  none: {
    name: 'None (pay per ticket)', short: null, unit: 'ticket', units: 'tickets', subscription: false,
    defaults: { limit: 0, period: 'week', fee: 0, ticket: 14.5 },
    note: 'No subscription: Stats shows what you spend on tickets instead of an allowance and savings.',
  },
};
export const PLAN_IDS = Object.keys(PLANS);
export const DEFAULT_PLAN = 'amc-alist';
export const PERIODS = ['week', 'month'];

// The plan in force for a user's settings, with its terms.
export function planOf(settings = {}) {
  const id = PLANS[settings.moviePlan] ? settings.moviePlan : DEFAULT_PLAN;
  const p = PLANS[id];
  const period = PERIODS.includes(settings.planPeriod) ? settings.planPeriod : p.defaults.period;
  const rawLimit = settings.alistWeeklyLimit ?? 4;
  const limit = Math.max(0, Math.round(Number(rawLimit) || 0));
  return {
    id,
    name: p.name,
    short: p.short,
    unit: p.unit,
    units: p.units,
    subscription: p.subscription,
    period,
    limit: p.subscription ? limit : 0,
    unlimited: !p.subscription || limit === 0,
  };
}

const plural = (n, one, many) => (n === 1 ? one : many);

// Every piece of plan wording the app shows, in one place.
export function planWords(plan) {
  const per = plan.period === 'month' ? 'month' : 'week';
  if (!plan.subscription) {
    return {
      statsTitle: 'Your tickets',
      markSeen: 'Mark seen',
      notCounted: 'not toward your ticket spend',
      removeNote: 'It stops counting toward this month\'s ticket spend and the pick hit-rate. Your rating, if you left one, is not touched.',
    };
  }
  const isAList = plan.id === 'amc-alist';
  return {
    statsTitle: isAList && per === 'week' ? 'This A-List week'
      : plan.id === 'other' ? `This ${per} on your plan` : `This ${plan.short} ${per}`,
    markSeen: `Mark seen (${plan.short})`,
    notCounted: `not toward your ${plan.short} ${per}`,
    removeNote: `It stops counting toward this ${per}'s ${plan.units}, this month's savings, and the pick hit-rate. Your rating, if you left one, is not touched.`,
  };
}

// "Logged. …" after Mark seen. week: the server's /api/alist answer.
export function loggedLine(week, money = (n) => `$${Number(n).toFixed(2)}`) {
  const plan = week.plan;
  if (!plan?.subscription) return `Logged. ${money(week.savings.ticketValue)} on tickets this month.`;
  const per = plan.period === 'month' ? 'month' : 'week';
  if (plan.id === 'amc-alist' && per === 'week') return `Logged. ${week.used} of ${week.limit} A-List this week.`;
  const what = (u) => (plan.id === 'other' ? `${u} on your plan` : `${plan.short} ${u}`);
  if (plan.unlimited) return `Logged. ${week.used} ${what(plural(week.used, plan.unit, plan.units))} this ${per}.`;
  return `Logged. ${week.used} of ${week.limit} ${what(plan.units)} this ${per}.`;
}

// Settings problems for the plan keys of a patch, as [{ key, message }].
export function planProblems(patch) {
  const out = [];
  if ('moviePlan' in patch && !PLANS[patch.moviePlan]) out.push({ key: 'moviePlan', message: `Pick one of: ${PLAN_IDS.join(', ')}.` });
  if ('planPeriod' in patch && !PERIODS.includes(patch.planPeriod)) out.push({ key: 'planPeriod', message: 'Use week or month.' });
  return out;
}
