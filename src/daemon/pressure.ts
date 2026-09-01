import { readFileSync } from 'node:fs';

/**
 * CPU pressure from Linux PSI (`/proc/pressure/cpu`).
 *
 * The `some avg10` figure is the percentage of the last 10 seconds in which
 * at least one runnable task was stalled waiting for a CPU. Unlike the
 * 1-minute loadavg — a slow EMA that also counts uninterruptible I/O waits —
 * it reacts within seconds and measures actual scheduling starvation, which
 * is what makes concurrently running test suites miss their deadlines.
 */
const pressurePath = '/proc/pressure/cpu';

const someAvg10Pattern = /^some .*\bavg10=(\d+(?:\.\d+)?)/mu;

/**
 * The `some avg10` CPU stall percentage, or `null` where PSI is unavailable
 * (non-Linux, kernel without CONFIG_PSI, restricted /proc).
 */
export const cpuSomeAvg10 = (
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number | null => {
  let content: string;
  try {
    content = read(pressurePath);
  } catch {
    return null;
  }
  const match = someAvg10Pattern.exec(content);
  if (match === null) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
};
