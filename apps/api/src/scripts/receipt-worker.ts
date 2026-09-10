import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { prisma } from "../db.js";
import { processReceiptOcr } from "../receipts/ocr.js";
import { CloudflareR2ReceiptInfrastructure, type ReceiptStorageLocation } from "../receipts/storage.js";

const queueUrl = process.env.RECEIPT_QUEUE_URL;
const queueRegion = process.env.AWS_REGION;
const storageLocation = process.env.RECEIPT_STORAGE_LOCATION;
if (!queueUrl || !queueRegion || !["enam", "us"].includes(storageLocation ?? "")) {
  throw new Error("RECEIPT_QUEUE_URL, AWS_REGION, and RECEIPT_STORAGE_LOCATION are required");
}
const location = storageLocation as ReceiptStorageLocation;
if (
  !process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY ||
  !process.env.OPENAI_API_KEY
) {
  throw new Error("R2 and OpenAI receipt OCR worker configuration are required");
}

const sqs = new SQSClient({ region: queueRegion });
const storage = new CloudflareR2ReceiptInfrastructure(process.env);
let stopping = false;
let lastCleanupAt = 0;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

while (!stopping) {
  if (Date.now() - lastCleanupAt > 60 * 60 * 1000) {
    lastCleanupAt = Date.now();
    const abandoned = await prisma.receiptDocument.findMany({
      where: { storageRegion: location, status: "uploading", createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      take: 100,
    });
    for (const receipt of abandoned) {
      const claimed = await prisma.receiptDocument.updateMany({
        where: { id: receipt.id, status: "uploading" },
        data: { status: "deleted", deletedAt: new Date(), ocrError: "upload_abandoned" },
      });
      if (claimed.count !== 1) continue;
      try {
        await storage.deleteObject({ location, bucket: receipt.storageBucket, key: receipt.storageKey });
      } catch (error) {
        await prisma.receiptDocument.updateMany({
          where: { id: receipt.id, status: "deleted", ocrError: "upload_abandoned" },
          data: { status: "uploading", deletedAt: null },
        });
        console.error("abandoned receipt cleanup failed", receipt.id, error instanceof Error ? error.message : "unknown_error");
      }
    }
  }
  const response = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20, VisibilityTimeout: 900,
  }));
  for (const message of response.Messages ?? []) {
    if (!message.Body || !message.ReceiptHandle) continue;
    try {
      const body = JSON.parse(message.Body) as { receiptId?: unknown };
      if (typeof body.receiptId !== "string") throw new Error("invalid_receipt_queue_message");
      await processReceiptOcr(process.env, body.receiptId);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      console.error("receipt worker message failed", error instanceof Error ? error.message : "unknown_error");
    }
  }
}

await prisma.$disconnect();
