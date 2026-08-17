// Structured JSON logger: one line per event, machine-greppable. This runs
// headless on a VPS — `journalctl | grep needs_attention` has to work.
//
// Lines go to stdout/stderr AND (when configured) to a rotating log file. The
// file is the durable copy: journald retention is not guaranteed, and under
// pm2/nohup/docker-without-a-driver stdout can be discarded outright — which
// leaves no record at all of a webhook that failed after we already 200'd it.
// Razorpay never redelivers those, so the log line is the only evidence there
// is. Writes are synchronous so a line is on disk before a crash can eat it;
// volume here is a handful of webhooks a day, so the cost is irrelevant.

import fs from 'node:fs';
import path from 'node:path';

// Size-rotating append-only sink. Keeps `maxFiles` rotated generations
// (membership.log.1 … .N); the oldest is dropped.
export function createFileSink({ filePath, maxBytes = 10 * 1024 * 1024, maxFiles = 5 }) {
  const resolved = path.resolve(filePath);
  let fd = null;
  let size = 0;
  let broken = false;

  function open() {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fd = fs.openSync(resolved, 'a');
    size = fs.fstatSync(fd).size;
  }

  function rotate() {
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const from = `${resolved}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${resolved}.${i + 1}`);
    }
    if (fs.existsSync(resolved)) fs.renameSync(resolved, `${resolved}.1`);
    open();
  }

  open(); // Throws to the caller — openLogSink() decides whether that's fatal.

  return {
    path: resolved,
    write(line) {
      // A broken log file must never take the service down with it: after the
      // first failure we stop trying and let stdout carry on alone.
      if (broken) return;
      try {
        const buf = Buffer.from(line, 'utf8');
        if (size > 0 && size + buf.length > maxBytes) rotate();
        fs.writeSync(fd, buf);
        size += buf.length;
      } catch (err) {
        broken = true;
        process.stderr.write(
          JSON.stringify({
            level: 'error',
            time: new Date().toISOString(),
            msg: 'file logging stopped after a write error — stdout only from here',
            file: resolved,
            error: err.message,
          }) + '\n'
        );
      }
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* closing a dead fd is not worth failing shutdown over */
        }
        fd = null;
      }
    },
  };
}

// Config -> sink, or null when disabled/unopenable. Never throws: losing the
// log file is bad, but refusing to boot over it is worse.
export function openLogSink({ file, maxBytes, maxFiles } = {}) {
  if (!file) return null;
  try {
    return createFileSink({ filePath: file, maxBytes, maxFiles });
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'file logging disabled: cannot open log file — logging to stdout only',
        needs_attention: true,
        file,
        error: err.message,
      }) + '\n'
    );
    return null;
  }
}

function write(level, base, msg, fields, options) {
  const line =
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg,
      ...base,
      ...fields,
    }) + '\n';

  if (options.stdout !== false) {
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(line);
  }
  options.sink?.write(line);
}

// options: { sink, stdout } — carried through child() so every logger in the
// tree writes to the same file.
export function createLogger(base = {}, options = {}) {
  return {
    info(msg, fields = {}) {
      write('info', base, msg, fields, options);
    },
    warn(msg, fields = {}) {
      write('warn', base, msg, fields, options);
    },
    error(msg, fields = {}) {
      write('error', base, msg, fields, options);
    },
    child(extra = {}) {
      return createLogger({ ...base, ...extra }, options);
    },
  };
}
