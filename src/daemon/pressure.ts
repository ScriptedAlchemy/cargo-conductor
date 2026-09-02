import { execFileSync } from 'node:child_process';
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
const cpuPressurePath = '/proc/pressure/cpu';
const memoryPressurePath = '/proc/pressure/memory';
const meminfoPath = '/proc/meminfo';

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
    content = read(cpuPressurePath);
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

export interface MemoryPsiSample {
  readonly fullAvg10: number;
  readonly someAvg10: number;
  readonly fullAvg60: number;
}

interface ReadPressureOptions {
  readonly platform?: NodeJS.Platform;
  readonly read?: (path: string) => string;
}

const psiValue = (line: string, field: 'avg10' | 'avg60'): number | null => {
  const match = new RegExp(`\\b${field}=(\\d+(?:\\.\\d+)?)`, 'u').exec(line);
  if (match === null) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
};

/**
 * Linux memory PSI, or `null` when the platform/kernel does not expose it.
 * `full` means every non-idle task was stalled and is the admission signal;
 * `some` is reported for diagnosis.
 */
export const memoryPsi = (options: ReadPressureOptions = {}): MemoryPsiSample | null => {
  if ((options.platform ?? process.platform) !== 'linux') {
    return null;
  }
  let content: string;
  try {
    content = (options.read ?? ((path) => readFileSync(path, 'utf8')))(memoryPressurePath);
  } catch {
    return null;
  }
  const lines = content.split('\n');
  const someLine = lines.find((line) => line.startsWith('some '));
  const fullLine = lines.find((line) => line.startsWith('full '));
  if (someLine === undefined || fullLine === undefined) {
    return null;
  }
  const someAvg10 = psiValue(someLine, 'avg10');
  const fullAvg10 = psiValue(fullLine, 'avg10');
  const fullAvg60 = psiValue(fullLine, 'avg60');
  return someAvg10 === null || fullAvg10 === null || fullAvg60 === null
    ? null
    : { fullAvg10, fullAvg60, someAvg10 };
};

/** Linux `MemAvailable` from `/proc/meminfo`, converted from KiB to bytes. */
export const memoryAvailableBytes = (options: ReadPressureOptions = {}): number | null => {
  if ((options.platform ?? process.platform) !== 'linux') {
    return null;
  }
  let content: string;
  try {
    content = (options.read ?? ((path) => readFileSync(path, 'utf8')))(meminfoPath);
  } catch {
    return null;
  }
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/mu.exec(content);
  if (match === null) {
    return null;
  }
  const kibibytes = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(kibibytes) ? kibibytes * 1024 : null;
};

export type MemoryPressureLevel = 1 | 2 | 4;

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number },
) => string | Buffer;

const defaultExecFile: ExecFile = (file, args, options) =>
  execFileSync(file, args, options);

interface MemoryPressureLevelOptions {
  readonly execFile?: ExecFile;
  readonly nowMs?: () => number;
  readonly platform?: NodeJS.Platform;
}

const memoryPressureCacheMs = 2_000;
let cachedMemoryPressure:
  | {
      readonly atMs: number;
      readonly execFile: ExecFile;
      readonly level: MemoryPressureLevel | null;
    }
  | undefined;

/**
 * macOS VM pressure level from sysctl. This key is readable without root and
 * stable across macOS 10.9–15: 1=normal, 2=warn, 4=critical.
 *
 * SHIPPED UNTESTED (no Mac available), so unexpected output strictly becomes
 * `null`. The result is cached for two seconds to avoid double-spawning sysctl
 * on the admission poll cadence.
 */
export const memoryPressureLevel = (
  options: MemoryPressureLevelOptions = {},
): MemoryPressureLevel | null => {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return null;
  }
  const execFile = options.execFile ?? defaultExecFile;
  const nowMs = (options.nowMs ?? Date.now)();
  if (
    cachedMemoryPressure !== undefined &&
    cachedMemoryPressure.execFile === execFile &&
    nowMs - cachedMemoryPressure.atMs < memoryPressureCacheMs
  ) {
    return cachedMemoryPressure.level;
  }
  let level: MemoryPressureLevel | null = null;
  try {
    const output = String(
      execFile('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
        timeout: 1_000,
      }),
    ).trim();
    if (output === '1' || output === '2' || output === '4') {
      level = Number.parseInt(output, 10) as MemoryPressureLevel;
    }
  } catch {
    level = null;
  }
  cachedMemoryPressure = { atMs: nowMs, execFile, level };
  return level;
};
