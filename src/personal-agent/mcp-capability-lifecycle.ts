/** Lightweight participation in the existing capability mutation lifecycle.
 * No transport, configuration read or independent execution queue lives here. */
export type McpCapabilityImpact = {
  ownerUserId: string;
  scope: 'system' | 'user';
  ids?: string[];
};
type Handler = (impact: McpCapabilityImpact) => Promise<() => Promise<void>>;
let handler: Handler | undefined;
export function registerMcpCapabilityLifecycle(value: Handler) {
  handler = value;
  return () => {
    if (handler === value) handler = undefined;
  };
}
export async function quiesceProductMcpCapability(impact: McpCapabilityImpact) {
  return handler ? handler(impact) : async () => {};
}
