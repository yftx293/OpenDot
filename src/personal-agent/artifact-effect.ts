import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../config.js';
import {
  beginApprovedArtifact,
  digestText,
  finishApprovedArtifact,
  getProductApproval,
} from './approval-store.js';

function artifactDirectory() {
  const directory = path.join(STORE_DIR, 'private-artifacts');
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function directory() {
  const value = path.join(STORE_DIR, 'private-artifacts');
  if (!fs.existsSync(value)) artifactDirectory();
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new Error('Private artifact storage is unsafe');
  return value;
}
function filename(id: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
  )
    throw new Error('Invalid artifact identity');
  return path.join(directory(), `${id}.txt`);
}
export function readApprovedArtifact(id: string, ownerId: string): string {
  const row = getProductApproval(id, ownerId);
  if (row.state !== 'completed') throw new Error('Artifact is not committed');
  return verify(filename(id), row.content_digest);
}
function verify(target: string, digest: string) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('Artifact storage is unsafe');
    const content = fs.readFileSync(descriptor, 'utf8');
    if (digestText(content) !== digest)
      throw new Error('Artifact content is uncertain');
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}
/** Exclusive creation makes retry safe; mismatched/partial effects are never overwritten. */
export function executeApprovedArtifact(
  id: string,
  ownerId: string,
  authorize: () => void,
  afterEffect?: () => void,
) {
  authorize();
  const row = beginApprovedArtifact(id, ownerId);
  const target = filename(id);
  try {
    authorize();
    if (row.state !== 'completed') {
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(target, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (descriptor !== undefined) {
        try {
          fs.writeFileSync(descriptor, row.content, 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        const parent = fs.openSync(directory(), 'r');
        try {
          fs.fsyncSync(parent);
        } finally {
          fs.closeSync(parent);
        }
      }
    }
    verify(target, row.content_digest);
  } catch {
    finishApprovedArtifact(id, ownerId, false);
    throw new Error(
      'Artifact effect is uncertain; manual reconciliation is required',
    );
  }
  // Fault seam is outside reconciliation: an actual executor may die here.
  afterEffect?.();
  authorize();
  return finishApprovedArtifact(id, ownerId, true);
}
