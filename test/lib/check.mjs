// A suite's checks. Each check has a stable name; the suite prints one line per
// check and, last, one machine-readable line the runner reads (@@RESULT).
// A step that throws counts as one failed check named after the step.

export function suite(name) {
  const t0 = Date.now();
  const checks = [];
  const extra = { servers: [], unanswered: [] };
  const seen = new Map();
  const check = (id, ok, detail = '') => {
    // Names repeat when a loop checks the same thing twice; keep them unique.
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    const key = n === 1 ? id : `${id} (#${n})`;
    const pass = Boolean(ok);
    checks.push({ id: key, ok: pass, detail: pass ? '' : String(detail).slice(0, 600) });
    console.log(`  ${pass ? '✓' : '✗'} ${key}${!pass && detail ? ` :: ${String(detail).slice(0, 400)}` : ''}`);
    return pass;
  };
  let current = null;
  const step = async (label, fn) => {
    current = label;
    console.log(`• ${label}`);
    try { await fn(); } catch (e) {
      check(`${label} (ran to the end)`, false, String(e?.stack || e).split('\n').slice(0, 4).join(' | '));
    }
    current = null;
  };
  // Records a world's servers and anything they asked the outside for that
  // nothing answered (there must be none).
  const world = (w) => {
    const note = () => {
      extra.servers.push({ dataDir: w.dataDir, port: w.srv.port });
      extra.unanswered.push(...w.unanswered());
    };
    const close = w.close.bind(w);
    w.close = async () => { note(); await close(); };
    return w;
  };
  const finish = () => {
    const failed = checks.filter((c) => !c.ok);
    const result = { suite: name, ms: Date.now() - t0, checks, ...extra };
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${name}`);
    // Exit once the line is written: a pipe on macOS takes it in pieces, and
    // exiting straight away cut a long one short (the runner then saw none).
    process.stdout.write(`@@RESULT ${JSON.stringify(result)}\n`, () => process.exit(failed.length ? 1 : 0));
  };
  return { name, check, step, finish, world, get current() { return current; } };
}
