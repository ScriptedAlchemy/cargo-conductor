/**
 * Loading `node:sqlite` schedules an ExperimentalWarning on the next tick. On
 * the shim/hook path that line lands in every agent's cargo output, so the
 * default printer is replaced with one that drops exactly that warning and
 * keeps Node's format for everything else. Importing this module once from the
 * module that imports `node:sqlite` is enough because the warning is emitted
 * asynchronously.
 */
const isSqliteExperimentalWarning = (warning: Error): boolean =>
  warning.name === 'ExperimentalWarning' && warning.message.startsWith('SQLite');

const installed = Symbol.for('cargo-hauler.quiet-sqlite-warning');

if (Reflect.get(process, installed) !== true) {
  Reflect.set(process, installed, true);
  for (const listener of process.listeners('warning')) {
    process.removeListener('warning', listener);
  }
  process.on('warning', (warning) => {
    if (!isSqliteExperimentalWarning(warning)) {
      process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
    }
  });
}
