import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { PDFDocument } from "pdf-lib";

export type ReceiptStorageLocation = "enam" | "us";

export type ReceiptStorageEnv = {
  R2_ACCOUNT_ID?: string | undefined;
  R2_ACCESS_KEY_ID?: string | undefined;
  R2_SECRET_ACCESS_KEY?: string | undefined;
  R2_RECEIPTS_CA_BUCKET?: string | undefined;
  R2_RECEIPTS_US_BUCKET?: string | undefined;
  RECEIPTS_CA_QUEUE_URL?: string | undefined;
  RECEIPTS_US_QUEUE_URL?: string | undefined;
};

export class ReceiptInfrastructureError extends Error {
  constructor(readonly code: "receipt_storage_unavailable" | "receipt_file_mismatch" | "receipt_mime_mismatch" | "receipt_page_limit") {
    super(code);
  }
}

function tiffPageCount(bytes: Uint8Array): number {
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, littleEndian);
  const u32 = (offset: number) => view.getUint32(offset, littleEndian);
  let offset = u32(4);
  let pages = 0;
  const seen = new Set<number>();
  while (offset !== 0) {
    if (seen.has(offset) || offset + 2 > bytes.byteLength) throw new ReceiptInfrastructureError("receipt_file_mismatch");
    seen.add(offset);
    pages += 1;
    if (pages > 10) return pages;
    const entries = u16(offset);
    const nextOffsetPosition = offset + 2 + entries * 12;
    if (nextOffsetPosition + 4 > bytes.byteLength) throw new ReceiptInfrastructureError("receipt_file_mismatch");
    offset = u32(nextOffsetPosition);
  }
  return pages;
}

type LocationConfig = {
  location: ReceiptStorageLocation;
  endpoint: string;
  bucket: string;
  queueUrl: string;
  queueRegion: "ca-central-1" | "us-east-1";
  accessKeyId: string;
  secretAccessKey: string;
};

type R2Connection = Pick<LocationConfig, "location" | "endpoint" | "accessKeyId" | "secretAccessKey">;

function endpointFor(accountId: string, location: ReceiptStorageLocation): string {
  return location === "us"
    ? `https://${accountId}.us.r2.cloudflarestorage.com`
    : `https://${accountId}.r2.cloudflarestorage.com`;
}

function r2Connection(env: ReceiptStorageEnv, location: ReceiptStorageLocation): R2Connection {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new ReceiptInfrastructureError("receipt_storage_unavailable");
  }
  return {
    location,
    endpoint: endpointFor(env.R2_ACCOUNT_ID, location),
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

function configFor(env: ReceiptStorageEnv, location: ReceiptStorageLocation): LocationConfig {
  const isCa = location === "enam";
  const bucket = isCa ? env.R2_RECEIPTS_CA_BUCKET : env.R2_RECEIPTS_US_BUCKET;
  const queueUrl = isCa ? env.RECEIPTS_CA_QUEUE_URL : env.RECEIPTS_US_QUEUE_URL;
  if (!bucket || !queueUrl) {
    throw new ReceiptInfrastructureError("receipt_storage_unavailable");
  }
  const connection = r2Connection(env, location);
  return {
    ...connection,
    location,
    bucket,
    queueUrl,
    queueRegion: isCa ? "ca-central-1" : "us-east-1",
  };
}

function hasMimeMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
  if (mime === "application/pdf") return String.fromCharCode(...bytes.slice(0, 4)) === "%PDF";
  if (mime === "image/tiff") {
    return (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a);
  }
  return false;
}

export class CloudflareR2ReceiptInfrastructure {
  constructor(private readonly env: ReceiptStorageEnv) {}

  private client(location: ReceiptStorageLocation): S3Client {
    const config = r2Connection(this.env, location);
    return new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  async createUpload(input: { workspaceId: string; receiptId: string; location: ReceiptStorageLocation; mimeType: string; byteSize: number }): Promise<{
    bucket: string; key: string; uploadUrl: string; headers: Record<string, string>;
  }> {
    const config = configFor(this.env, input.location);
    const s3 = this.client(input.location);
    const key = `workspaces/${input.workspaceId}/receipts/${input.receiptId}/${randomUUID()}`;
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: input.mimeType,
      ContentLength: input.byteSize,
    });
    return {
      bucket: config.bucket,
      key,
      uploadUrl: await getSignedUrl(s3, command, { expiresIn: 300 }),
      headers: { "content-type": input.mimeType, "content-length": String(input.byteSize) },
    };
  }

  async read(input: { location: ReceiptStorageLocation; bucket: string; key: string }): Promise<Uint8Array> {
    const s3 = this.client(input.location);
    const object = await s3.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
    if (!object.Body) throw new ReceiptInfrastructureError("receipt_file_mismatch");
    return await object.Body.transformToByteArray();
  }

  async verify(input: { location: ReceiptStorageLocation; bucket: string; key: string; byteSize: number; mimeType: string; sha256: string }): Promise<{ pageCount: number }> {
    const s3 = this.client(input.location);
    const head = await s3.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }));
    if (head.ContentLength !== input.byteSize || head.ContentType !== input.mimeType) throw new ReceiptInfrastructureError("receipt_file_mismatch");
    const bytes = await this.read(input);
    if (!hasMimeMagic(bytes, input.mimeType)) throw new ReceiptInfrastructureError("receipt_mime_mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest.toLowerCase() !== input.sha256.toLowerCase()) throw new ReceiptInfrastructureError("receipt_file_mismatch");
    let pageCount = 1;
    if (input.mimeType === "application/pdf") {
      try { pageCount = (await PDFDocument.load(bytes)).getPageCount(); }
      catch { throw new ReceiptInfrastructureError("receipt_file_mismatch"); }
    } else if (input.mimeType === "image/tiff") {
      pageCount = tiffPageCount(bytes);
    }
    if (pageCount < 1 || pageCount > 20) throw new ReceiptInfrastructureError("receipt_page_limit");
    return { pageCount };
  }

  async downloadUrl(input: { location: ReceiptStorageLocation; bucket: string; key: string }): Promise<string> {
    const s3 = this.client(input.location);
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: input.bucket, Key: input.key }), { expiresIn: 300 });
  }

  async deleteObject(input: { location: ReceiptStorageLocation; bucket: string; key: string }): Promise<void> {
    const s3 = this.client(input.location);
    await s3.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  }

  async enqueue(input: { location: ReceiptStorageLocation; receiptId: string }): Promise<void> {
    const config = configFor(this.env, input.location);
    await new SQSClient({ region: config.queueRegion }).send(new SendMessageCommand({
      QueueUrl: config.queueUrl,
      MessageBody: JSON.stringify({ receiptId: input.receiptId, location: input.location }),
    }));
  }
}
