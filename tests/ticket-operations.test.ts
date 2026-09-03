import { describe, expect, it, rs } from 'effect-rstest';
import * as rscPlugin from '@agent-bundle/runtime/plugin' with { rstest: 'importActual' };

rs.mock('@agent-bundle/runtime/plugin', () => ({
  ...rscPlugin,
  agent: rs.fn(),
}));

import { enrichTicketRequest } from '../src/lib/attribution.js';

const unavailable = {
  host: { reason: 'host-omitted', state: 'unavailable' },
  session: { reason: 'not-provided', state: 'unavailable' },
} as const;

describe('ticket request attribution', () => {
  it('preserves explicit host and session without mutating the input', () => {
    const input = {
      argv: ['cargo', 'check'],
      cwd: '/workspace',
      host: 'explicit-host',
      session: 'explicit-session',
    };
    const context = {
      host: { source: 'native', state: 'available', value: { name: 'context-host' } },
      invocation: { kind: 'tool' },
      session: {
        source: 'native',
        state: 'available',
        value: { sessionId: 'context-session' },
      },
    } as const;

    expect(enrichTicketRequest(input, context)).toEqual(input);
    expect(input).toEqual({
      argv: ['cargo', 'check'],
      cwd: '/workspace',
      host: 'explicit-host',
      session: 'explicit-session',
    });
  });

  it('fills omitted attribution from available request context', () => {
    const input = { argv: ['cargo', 'test'], cwd: '/workspace' };
    const context = {
      host: { source: 'native', state: 'available', value: { name: 'cursor' } },
      invocation: { kind: 'tool' },
      session: {
        source: 'native',
        state: 'available',
        value: { sessionId: 'native-session' },
      },
    } as const;

    expect(enrichTicketRequest(input, context)).toEqual({
      ...input,
      host: 'cursor',
      session: 'native-session',
    });
  });

  it('attributes CLI requests to the cli host when native host is unavailable', () => {
    const input = { argv: ['cargo', 'check'], cwd: '/workspace' };

    expect(enrichTicketRequest(input, { ...unavailable, invocation: { kind: 'cli' } })).toEqual({
      ...input,
      host: 'cli',
    });
  });

  it('attributes tool requests to the mcp host when native host is unavailable', () => {
    const input = { argv: ['cargo', 'check'], cwd: '/workspace' };

    expect(enrichTicketRequest(input, { ...unavailable, invocation: { kind: 'tool' } })).toEqual({
      ...input,
      host: 'mcp',
    });
  });

  it('uses a native session even when host attribution falls back to mcp', () => {
    const input = { argv: ['cargo', 'check'], cwd: '/workspace' };
    const context = {
      host: unavailable.host,
      invocation: { kind: 'script' },
      session: {
        source: 'native',
        state: 'available',
        value: { sessionId: 'native-session' },
      },
    } as const;

    expect(enrichTicketRequest(input, context)).toEqual({
      ...input,
      host: 'mcp',
      session: 'native-session',
    });
  });
});
