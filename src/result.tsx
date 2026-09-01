import { Mcp } from '@agent-bundle/rsc-runtime';

import type { DaemonResult, LastResult, LogResult, StatusResult } from './operations/schemas.js';

export type ConductorReceipt = DaemonResult | LastResult | LogResult | StatusResult;

const summary = (receipt: ConductorReceipt): string => {
  switch (receipt.operation) {
    case 'daemon':
      return receipt.message;
    case 'last':
    case 'log':
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
