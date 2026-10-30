import type { CallToolResult } from '@earendil-works/pi-mcp';

export class McpDeliveryError extends Error {
  readonly result?: CallToolResult;
  constructor(
    readonly delivery: 'not_sent' | 'uncertain',
    options?: ErrorOptions & { result?: CallToolResult },
  ) {
    super(
      delivery === 'not_sent'
        ? 'MCP request not sent'
        : 'MCP outcome uncertain; do not retry automatically',
      options,
    );
    this.result = options?.result;
  }
}
