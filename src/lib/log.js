// Structured JSON logger: one line per event, machine-greppable. This runs
// headless on a VPS — `journalctl | grep needs_attention` has to work.

function write(level, base, msg, fields) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...base,
    ...fields,
  });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export function createLogger(base = {}) {
  return {
    info(msg, fields = {}) {
      write('info', base, msg, fields);
    },
    warn(msg, fields = {}) {
      write('warn', base, msg, fields);
    },
    error(msg, fields = {}) {
      write('error', base, msg, fields);
    },
    child(extra = {}) {
      return createLogger({ ...base, ...extra });
    },
  };
}
