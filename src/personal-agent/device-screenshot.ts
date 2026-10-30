import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { PNG: Png } = createRequire(import.meta.url)('pngjs') as {
  PNG: {
    sync: {
      read(
        bytes: Buffer,
        options: { checkCRC: boolean },
      ): { width: number; height: number; data: Buffer };
      write(image: { width: number; height: number; data: Buffer }): Buffer;
    };
  };
};

const jpeg = createRequire(import.meta.url)('jpeg-js') as {
  decode(
    bytes: Buffer,
    options: {
      useTArray: false;
      formatAsRGBA: true;
      tolerantDecoding: false;
      maxResolutionInMP: number;
      maxMemoryUsageInMB: number;
    },
  ): { width: number; height: number; data: Buffer };
};

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 12_000_000;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function normalizeScreenshotPng(image: Buffer) {
  if (image.length < 33 || image.length > MAX_BYTES)
    throw new Error('Screenshot exceeds transport budget');
  if (
    !image.subarray(0, 8).equals(PNG) ||
    image.readUInt32BE(8) !== 13 ||
    image.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Screenshot must be a PNG');
  const width = image.readUInt32BE(16),
    height = image.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    throw new Error('Screenshot dimensions exceed budget');
  // pngjs 5's interlaced decoder does not bound decompression. Restrict
  // this path to ordinary 8-bit RGB/RGBA screenshots before decoding.
  if (
    image[24] !== 8 ||
    ![2, 6].includes(image[25]!) ||
    image[26] !== 0 ||
    image[27] !== 0 ||
    image[28] !== 0
  )
    throw new Error('Unsupported PNG screenshot format');
  // pngjs may accept a truncated stream with only IHDR. Require a complete
  // bounded chunk sequence with image data and a terminal IEND before decode.
  let offset = 8;
  let sawData = false;
  let sawEnd = false;
  let chunks = 0;
  while (offset < image.length) {
    if (++chunks > 10_000 || image.length - offset < 12)
      throw new Error('Screenshot PNG is truncated');
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > image.length) throw new Error('Screenshot PNG is truncated');
    const type = image.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || end !== image.length)
        throw new Error('Screenshot PNG has invalid end');
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawData || !sawEnd) throw new Error('Screenshot PNG is incomplete');
  let normalized: Buffer;
  try {
    const decoded = Png.sync.read(image, { checkCRC: true });
    if (
      decoded.width !== width ||
      decoded.height !== height ||
      decoded.data.length !== width * height * 4
    )
      throw new Error('PNG size mismatch');
    // Re-encode the pixels alone: metadata, embedded profiles and trailing
    // non-image bytes never enter the attachment transport.
    normalized = Png.sync.write({ width, height, data: decoded.data });
  } catch {
    throw new Error('Screenshot PNG cannot be decoded');
  }
  if (normalized.length > MAX_BYTES)
    throw new Error('Screenshot exceeds transport budget');
  return {
    bytes: normalized,
    mimeType: 'image/png' as const,
    width,
    height,
    sha256: createHash('sha256').update(normalized).digest('hex'),
  };
}

/** KimiCU may return JPEG. Decode under strict byte, pixel and allocation
 * limits, then re-encode pixels as PNG so metadata never crosses the device
 * boundary. The Authority still validates the resulting PNG independently. */
export function normalizeScreenshotImage(image: Buffer, mimeType: string) {
  if (mimeType === 'image/png') return normalizeScreenshotPng(image);
  if (mimeType !== 'image/jpeg') throw new Error('Unsupported screenshot MIME');
  if (image.length < 4 || image.length > MAX_BYTES)
    throw new Error('Screenshot exceeds transport budget');
  if (
    image[0] !== 0xff ||
    image[1] !== 0xd8 ||
    image[image.length - 2] !== 0xff ||
    image[image.length - 1] !== 0xd9
  )
    throw new Error('Screenshot must be a complete JPEG');
  let png: Buffer;
  try {
    const decoded = jpeg.decode(image, {
      useTArray: false,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: 12,
      maxMemoryUsageInMB: 128,
    });
    if (
      !Number.isInteger(decoded.width) ||
      !Number.isInteger(decoded.height) ||
      decoded.width < 1 ||
      decoded.height < 1 ||
      decoded.width > MAX_DIMENSION ||
      decoded.height > MAX_DIMENSION ||
      decoded.width * decoded.height > MAX_PIXELS ||
      decoded.data.length !== decoded.width * decoded.height * 4
    )
      throw new Error('JPEG dimensions invalid');
    png = Png.sync.write({
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    });
  } catch {
    throw new Error('Screenshot JPEG cannot be decoded');
  }
  return normalizeScreenshotPng(png);
}

/** A trusted, private output directory chosen by the local device owner. The
 * caller supplies the generated path to the screenshot producer; a returned
 * path is never used as an arbitrary file-read request. */
export class DeviceScreenshotOutput {
  private readonly directory: string;
  private readonly rootStat: fs.Stats;
  private readonly issued = new Set<string>();
  constructor(directory: string) {
    if (!['darwin', 'linux'].includes(process.platform))
      throw new Error('Screenshot output requires a private POSIX directory');
    this.directory = path.resolve(directory);
    this.rootStat = fs.lstatSync(this.directory);
    if (
      !this.rootStat.isDirectory() ||
      this.rootStat.isSymbolicLink() ||
      this.rootStat.uid !== process.getuid?.() ||
      (this.rootStat.mode & 0o077) !== 0 ||
      fs.realpathSync(this.directory) !== this.directory
    )
      throw new Error('Screenshot output directory is not private');
  }
  private verifyRoot() {
    const current = fs.lstatSync(this.directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== this.rootStat.dev ||
      current.ino !== this.rootStat.ino ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o077) !== 0 ||
      fs.realpathSync(this.directory) !== this.directory
    )
      throw new Error('Screenshot output directory changed');
  }
  allocate() {
    this.verifyRoot();
    if (this.issued.size >= 32)
      throw new Error('Screenshot output budget exhausted');
    const target = path.join(this.directory, `${randomUUID()}.png`);
    this.issued.add(target);
    return target;
  }
  /** Remove only the generated regular file in the still-original private root.
   * Never follow a link or remove a replacement for an already-open file. */
  private removeIssuedFile(target: string, opened?: fs.Stats) {
    this.verifyRoot();
    try {
      const current = fs.lstatSync(target);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.uid !== process.getuid?.() ||
        (opened && (current.dev !== opened.dev || current.ino !== opened.ino))
      )
        return;
      fs.unlinkSync(target);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  abandon(expectedPath: string) {
    if (this.issued.delete(expectedPath)) this.removeIssuedFile(expectedPath);
  }
  read(expectedPath: string, returnedPath: string, authorize: () => void) {
    if (!this.issued.delete(expectedPath))
      throw new Error('Screenshot output identity changed');
    let fd: number | undefined;
    let opened: fs.Stats | undefined;
    try {
      authorize();
      this.verifyRoot();
      if (
        expectedPath !== returnedPath ||
        path.dirname(expectedPath) !== this.directory ||
        !/^[0-9a-f-]{36}\.png$/.test(path.basename(expectedPath))
      )
        throw new Error('Screenshot output identity changed');
      fd = fs.openSync(
        expectedPath,
        fs.constants.O_RDONLY |
          (fs.constants.O_NOFOLLOW ?? 0) |
          (fs.constants.O_NONBLOCK ?? 0),
      );
      const stat = fs.fstatSync(fd);
      opened = stat;
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        stat.size < 33 ||
        stat.size > MAX_BYTES
      )
        throw new Error('Screenshot file is invalid');
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!n) break;
        length += n;
      }
      const after = fs.fstatSync(fd);
      this.verifyRoot();
      authorize();
      if (
        length !== stat.size ||
        after.size !== stat.size ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error('Screenshot changed during reading');
      const image = bytes.subarray(0, length);
      const normalized = normalizeScreenshotPng(image);
      this.verifyRoot();
      authorize();
      return normalized;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      this.removeIssuedFile(expectedPath, opened);
    }
  }
}
