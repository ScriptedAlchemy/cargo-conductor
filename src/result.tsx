import { Mcp } from '@agent-bundle/rsc-runtime';

import type {
  AwaitResult,
  DaemonResult,
  LastResult,
  LogResult,
  RequestSubmitResult,
  ResultFetchResult,
  StatusResult,
} from './operations/schemas.js';

export type ConductorReceipt =
  | AwaitResult
  | DaemonResult
  | LastResult
  | LogResult
  | RequestSubmitResult
  | ResultFetchResult
  | StatusResult;

const summary = (receipt: ConductorReceipt): string => {
  switch (receipt.operation) {
    case 'daemon':
      return receipt.message;
    case 'await':
    case 'last':
    case 'log':
    case 'request':
    case 'result':
    case 'status':
      return receipt.summary;
    default: {
      const exhaustive: never = receipt;
      return exhaustive;
    }
  }
};

export const ConductorResult = ({ receipt }: { readonly receipt: ConductorReceipt }) => (
  <Mcp.Result structuredContent={receipt}>
    <Mcp.Text>{summary(receipt)}</Mcp.Text>
  </Mcp.Result>
);
