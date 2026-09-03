import { fstatSync } from 'node:fs';

/**
 * Whether two descriptors name the same open file (dev+inode), which is what
 * `cargo run 2>&1`, `| tee`, and a shared terminal look like from inside the
 * process. When they do, the caller cannot tell the channels apart and direct
 * cargo would have preserved the program's write order across them; the
 * broker is asked to run the child with one merged pipe so it can too (#38).
 * Any descriptor that cannot be inspected keeps the channels separate.
 */
export const sharesOutputTarget = (stdoutFd: number, stderrFd: number): boolean => {
  try {
    const out = fstatSync(stdoutFd);
    const err = fstatSync(stderrFd);
    return out.dev === err.dev && out.ino === err.ino;
  } catch {
    return false;
  }
};
