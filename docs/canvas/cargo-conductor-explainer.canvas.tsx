import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

function FlowBox({
  title,
  detail,
  accent,
}: {
  title: string;
  detail: string;
  accent?: boolean;
}) {
  const theme = useHostTheme();
  return (
    <div
      style={{
        background: accent ? theme.fill.secondary : theme.fill.tertiary,
        border: `1px solid ${accent ? theme.accent.primary : theme.stroke.secondary}`,
        borderRadius: 8,
        padding: "10px 12px",
        minWidth: 130,
        flex: "1 1 0",
      }}
    >
      <div style={{ color: theme.text.primary, fontSize: 13, fontWeight: 590 }}>{title}</div>
      <div style={{ color: theme.text.tertiary, fontSize: 12, marginTop: 4, lineHeight: "16px" }}>
        {detail}
      </div>
    </div>
  );
}

function FlowArrow({ label }: { label?: string }) {
  const theme = useHostTheme();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 46 }}>
      <div style={{ color: theme.text.quaternary, fontSize: 18, lineHeight: "18px" }}>&rarr;</div>
      {label !== undefined ? (
        <div
          style={{
            color: theme.text.quaternary,
            fontSize: 10,
            marginTop: 2,
            textAlign: "center",
            maxWidth: 80,
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}

function OutcomeRow({
  name,
  when,
  result,
}: {
  name: string;
  when: string;
  result: string;
}) {
  const theme = useHostTheme();
  return (
    <Row style={{ gap: 10, alignItems: "baseline" }}>
      <div style={{ minWidth: 90 }}>
        <Pill size="sm">{name}</Pill>
      </div>
      <Text size="small" style={{ color: theme.text.secondary, flex: 1 }}>
        {when}
      </Text>
      <Text size="small" style={{ color: theme.text.primary, flex: 1 }}>
        {result}
      </Text>
    </Row>
  );
}

export default function CargoConductorExplainer() {
  const theme = useHostTheme();

  const ledgerRows = [
    ["cc-1", "cargo run", "cursor", "executed", "done", "1013 ms"],
    ["cc-2", "cargo check", "cursor", "executed", "done", "306 ms"],
    ["cc-3", "cargo check", "claude", "attached to cc-2 (identity)", "done", "305 ms, 0 waited"],
    ["cc-4", "cargo check -p does-not-exist", "codex", "executed", "failed", "31 ms"],
  ];

  return (
    <Stack style={{ gap: 24, maxWidth: 980, margin: "0 auto", padding: 24 }}>
      <Stack style={{ gap: 6 }}>
        <H1>cargo-conductor: what just got installed</H1>
        <Text style={{ color: theme.text.secondary }}>
          A broker that sits between your agents and cargo. Every cargo command an agent runs in
          Cursor is now silently routed through one daemon that deduplicates, schedules, and
          streams the result back — so twenty agents stop fighting over the same build locks.
        </Text>
      </Stack>

      <Stack style={{ gap: 8 }}>
        <H2>The problem it solves</H2>
        <Grid columns={4} style={{ gap: 12 }}>
          <Stat value="~73,000" label="cargo runs by agents" />
          <Stat value="~45,600" label="lock-wait events" tone="danger" />
          <Stat value="33" label="peak concurrent cargos" tone="warning" />
          <Stat value="96%" label="of re-runs were duplicates" tone="info" />
        </Grid>
        <Text size="small" style={{ color: theme.text.quaternary }}>
          Source: your Cursor, Codex, and Claude session archives for the tracedecay repo, Jun 6 -
          Aug 31 2026. Duplicate share: identical command + directory re-run within 15 minutes.
        </Text>
      </Stack>

      <Divider />

      <Stack style={{ gap: 10 }}>
        <H2>What happens when an agent runs cargo now</H2>
        <Row style={{ gap: 0, alignItems: "stretch" }}>
          <FlowBox
            title="Agent shell call"
            detail={'The agent types "cargo check -p foo" like always. Nothing changes for it.'}
          />
          <FlowArrow label="preToolUse hook" />
          <FlowBox
            title="Invisible rewrite"
            detail="The Cursor hook rewrites the command to go through the conductor client, tagging session + host."
          />
          <FlowArrow label="unix socket" />
          <FlowBox
            accent
            title="Broker daemon"
            detail="One lane per (workspace, target dir). Normalizes the command, checks what is already running, schedules."
          />
          <FlowArrow label="runs at most once" />
          <FlowBox
            title="Real cargo"
            detail="Spawned by the daemon with a fair CPU share. kache still caches rustc underneath, untouched."
          />
        </Row>
        <Text size="small" style={{ color: theme.text.quaternary }}>
          Output streams back through the client, so the agent's shell sees a normal cargo run —
          plus progress lines. If the daemon is ever down, the hook fails open and cargo runs
          directly.
        </Text>
      </Stack>

      <Card>
        <CardHeader>The daemon picks one of three paths for each request</CardHeader>
        <CardBody>
          <Stack style={{ gap: 10 }}>
            <OutcomeRow
              name="attach"
              when="An identical run is already in flight (the 96% case), or a broader compatible one covers this request."
              result="No new cargo process. The waiter replays the leader's output live and shares its result."
            />
            <OutcomeRow
              name="merge"
              when="Several scoped checks of the same shape are queued, e.g. -p a, -p b, -p c."
              result="One composite `cargo check -p a -p b -p c`; each requester is released as its own package finishes."
            />
            <OutcomeRow
              name="queue + run"
              when="Nothing in flight covers it."
              result="Scheduled by estimated cost: quick jobs first, recently-edited crates first, more waiters first; old jobs escape starvation."
            />
          </Stack>
        </CardBody>
      </Card>

      <Grid columns={2} style={{ gap: 16 }}>
        <Stack style={{ gap: 8 }}>
          <H3>What the agent sees</H3>
          <Code
            style={{ fontSize: 12 }}
          >{`$ cargo check -p tracedecay --lib
[cargo-conductor] ticket cc-7 attached to cc-5
  (covered by a larger run in flight)
    Checking tracedecay v0.1.0
[cargo-conductor] released early: requested
  packages compiled cleanly under cc-5
$ echo $?
0`}</Code>
          <Text size="small" style={{ color: theme.text.quaternary }}>
            Early release: a --lib check riding a broader build finishes the moment its own
            packages compile — even if the broader build later fails elsewhere.
          </Text>
        </Stack>
        <Stack style={{ gap: 8 }}>
          <H3>Long builds stop getting killed</H3>
          <Text size="small" style={{ color: theme.text.secondary }}>
            Your archives show 106 builds killed by the Claude 10-minute shell timeout — some
            while passing. Now, when the cost model predicts more than ~9 minutes, the run
            auto-backgrounds into a durable ticket:
          </Text>
          <Code style={{ fontSize: 12 }}>{`[cargo-conductor] ticket cc-12 backgrounded
  retrieve with conductor_result cc-12`}</Code>
          <Text size="small" style={{ color: theme.text.secondary }}>
            The agent is notified on its next tool call, can long-poll via the conductor_await MCP
            tool, and if it tries to stop while a ticket is pending, the stop hook holds it and
            re-delivers the result — so background builds are never forgotten.
          </Text>
        </Stack>
      </Grid>

      <Divider />

      <Stack style={{ gap: 8 }}>
        <H2>Proof from tonight's install</H2>
        <Text size="small" style={{ color: theme.text.secondary }}>
          Two parallel identical checks were submitted from different simulated hosts: cc-2
          executed once; cc-3 attached and mirrored the same result without spawning cargo. cc-4
          shows a failure ledgered normally.
        </Text>
        <Table
          headers={["ticket", "command", "host", "how it was served", "status", "duration"]}
          rows={ledgerRows}
          rowTone={[undefined, "success", "info", "danger"]}
        />
        <Text size="small" style={{ color: theme.text.quaternary }}>
          Source: /fast/cache/cargo-conductor/ledger.db via `conductor log`, Aug 31 2026.
        </Text>
      </Stack>

      <Callout tone="info" title="Where it lives, and how to turn it on">
        Installed as a symlink at ~/.cursor/plugins/local/cargo-conductor (rebuilds update it
        automatically). Reload Cursor once to activate the hooks and the conductor MCP tools.
        Inspect anytime with `conductor status` or the dashboard MCP app; uninstall by removing
        the symlink. Your kache compile cache keeps working underneath, untouched.
      </Callout>
    </Stack>
  );
}
