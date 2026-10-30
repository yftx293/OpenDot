/** Close a started candidate unless this exact instance was adopted by the
 * device-node connection registry. Registry membership, rather than a consent
 * id alone, matters when a replay encounters an already-running connection. */
export async function withDeviceMcpStartupCandidate<
  T extends { close(): Promise<void> },
  R,
>(
  candidate: T,
  isAdopted: () => boolean,
  operation: () => Promise<R>,
): Promise<R> {
  try {
    return await operation();
  } finally {
    if (!isAdopted()) await candidate.close();
  }
}
