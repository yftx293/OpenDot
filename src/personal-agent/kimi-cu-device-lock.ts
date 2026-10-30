import os from 'node:os';
import path from 'node:path';

/** All KimiCU MCP processes for this macOS account share one desktop input
 * resource. Resolve the account home through the OS, not caller-supplied HOME
 * or target-specific configuration, so another Dot cannot bypass the lock. */
export function kimiCuDeviceLock() {
  return {
    resourceId: 'opendot:kimicu:desktop-input',
    lockDirectory: path.join(os.userInfo().homedir, '.opendot', 'device-locks'),
  };
}
