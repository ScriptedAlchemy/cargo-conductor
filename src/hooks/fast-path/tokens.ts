/**
 * The pre-parse test the `tool/before` and `tool/after` hook entries apply
 * before anything heavy loads: does the shell command name `cargo`, `hauler`,
 * or `conductor` as a token? Boundaries are any character outside
 * `[A-Za-z0-9_]`, so `cargo-hauler`, `~/.cargo/bin/cargo`, `cargo.exe`,
 * `./scripts/cargo-wrapper`, and `echo cargo` all match while `mycargo` and
 * `CARGO_HOME=/x ls` do not. The match is case-insensitive (`Cargo.toml`
 * matches): false positives cost one parse of the command in-process, false
 * negatives would let a cargo invocation bypass the hauler, so the test errs
 * toward matching.
 *
 * This is a superset of the check `before-shell.ts` itself applies
 * (`command.includes('cargo')`): every command the rewrite could govern, and
 * every command `after-shell.ts` records, mentions one of these tokens.
 */
const haulerToken = /(?:^|[^A-Za-z0-9_])(?:cargo|hauler|conductor)(?![A-Za-z0-9_])/iu;

/** True when the command mentions cargo, hauler, or conductor as a token; `undefined` and `''` never do. */
export const commandMentionsHauler = (command: string | undefined): boolean =>
  command !== undefined && command.length > 0 && haulerToken.test(command);
