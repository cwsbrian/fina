import { describe, expect, it } from "vitest";
import { CreateReceiptUploadIntentBody } from "@fina/shared";
import { CloudflareR2ReceiptInfrastructure } from "../src/receipts/storage.js";

describe("receipt presigned upload", () => {
  it("returns every signed request header and does not sign an empty CRC checksum", async () => {
    const infrastructure = new CloudflareR2ReceiptInfrastructure({
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "r2-access",
      R2_SECRET_ACCESS_KEY: "r2-secret",
      R2_RECEIPTS_CA_BUCKET: "private-bucket",
      R2_RECEIPTS_US_BUCKET: "us-private-bucket",
      RECEIPTS_CA_QUEUE_URL: "https://sqs.ca-central-1.amazonaws.com/1/receipts",
      RECEIPTS_US_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/receipts",
    } as never);
    const upload = await infrastructure.createUpload({
      workspaceId: "workspace", receiptId: "receipt", location: "enam", mimeType: "image/jpeg", byteSize: 123,
    });
    const url = new URL(upload.uploadUrl);
    expect(url.searchParams.get("x-amz-checksum-crc32")).toBeNull();
    expect(url.hostname).toBe("account.r2.cloudflarestorage.com");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(upload.headers).toMatchObject({
      "content-length": "123",
      "content-type": "image/jpeg",
    });
    const usUpload = await infrastructure.createUpload({
      workspaceId: "workspace", receiptId: "us-receipt", location: "us", mimeType: "image/png", byteSize: 456,
    });
    const usUrl = new URL(usUpload.uploadUrl);
    expect(usUrl.hostname).toBe("account.us.r2.cloudflarestorage.com");
    expect(usUrl.pathname).toContain("/us-private-bucket/workspaces/workspace/receipts/us-receipt/");
  });

  it("accepts up to 20 document pages", () => {
    const input = { originalName: "receipt.pdf", mimeType: "application/pdf", byteSize: 1, role: "itemized" };
    expect(CreateReceiptUploadIntentBody.safeParse({ ...input, pageCount: 20 }).success).toBe(true);
    expect(CreateReceiptUploadIntentBody.safeParse({ ...input, pageCount: 21 }).success).toBe(false);
  });
});
