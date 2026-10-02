// Demo mode (DEMO_MODE=1): the server runs on a sample database built fresh
// at every start, with made-up people and a made-up theater, and every
// visitor gets a private copy of it (server/demo/). It never opens DATA_DIR
// or ./data, never reads .env or an API key, and nothing leaves the process:
// AMC, TMDB and OMDb are answered from the film snapshot in this folder.
//
// Read once, from the real environment only (never from .env), so a key file
// can't switch it on or off.
const on = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

export const DEMO = on(process.env.DEMO_MODE);

// The visitor is the sample owner. Set before server/db.js creates the owner
// row, so the sample database never carries anyone's real name.
const DEMO_OWNER = 'Sam';
if (DEMO) process.env.OWNER_NAME = DEMO_OWNER;
// The made-up theaters' clock, unless the host sets one.
if (DEMO && !process.env.TZ) process.env.TZ = 'America/Chicago';

export const DEMO_REPO = 'https://github.com/TawfiqA05/reel-picks';
export const DEMO_OFF = 'Off in the demo.';
