/**
 * Orders release versions (`major.minor.patch`, optional `-prerelease`)
 * without pulling in a semver library: numeric components compare
 * numerically, a prerelease sorts below its release, and anything that
 * does not parse sorts below everything that does. Used by the one-version
 * rule to make replacement directional: a newer client replaces an older
 * daemon; an older client must never take a newer daemon down.
 */
const parse = (value: string): { numbers: number[]; prerelease: string | null } | null => {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    value.trim(),
  );
  if (match === null) {
    return null;
  }
  return {
    numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] ?? null,
  };
};

/** -1 when `left` is older than `right`, 1 when newer, 0 when equal. */
export const compareVersions = (left: string, right: string): -1 | 0 | 1 => {
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) {
    if (a === null && b === null) {
      return left === right ? 0 : left < right ? -1 : 1;
    }
    return a === null ? -1 : 1;
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (a.prerelease === null) {
    return 1;
  }
  if (b.prerelease === null) {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
};

/** True when `candidate` is strictly newer than `reference`. */
export const isNewerVersion = (candidate: string, reference: string): boolean =>
  compareVersions(candidate, reference) > 0;
