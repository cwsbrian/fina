import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { sha256 } from "js-sha256";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";

export type ReceiptSource = "camera" | "library" | "files";
export type ReceiptRole = "payment_proof" | "itemized" | "combined";

type PickedReceipt = { uri: string; name: string; mimeType: string };

async function normalizeImage(asset: ImagePicker.ImagePickerAsset): Promise<PickedReceipt> {
  const type = asset.mimeType?.toLowerCase();
  const needsJpeg = type === "image/heic" || type === "image/heif" || !["image/jpeg", "image/png"].includes(type ?? "");
  if (needsJpeg) {
    const converted = await ImageManipulator.manipulateAsync(asset.uri, [], {
      compress: 0.94,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return { uri: converted.uri, name: `${(asset.fileName ?? "receipt").replace(/\.[^.]+$/, "")}.jpg`, mimeType: "image/jpeg" };
  }
  return { uri: asset.uri, name: asset.fileName ?? `receipt-${Date.now()}.${type === "image/png" ? "png" : "jpg"}`, mimeType: type! };
}

async function pick(source: ReceiptSource): Promise<PickedReceipt | null> {
  if (source === "files") {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["image/jpeg", "image/png", "application/pdf", "image/tiff"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return null;
    const asset = result.assets[0]!;
    return { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? "application/octet-stream" };
  }
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("camera_permission_required");
  }
  const result = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  if (result.canceled) return null;
  return await normalizeImage(result.assets[0]!);
}

export async function pickAndUploadReceipt(input: {
  source: ReceiptSource;
  role: ReceiptRole;
  transactionId?: string;
}): Promise<string | null> {
  const selected = await pick(input.source);
  if (!selected) return null;
  const response = await fetch(selected.uri);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);
  const workspaceId = await bootstrapActiveWorkspace();
  if (!workspaceId) throw new Error("no_workspace");
  const intent = await apiFetch<{
    receiptId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  }>(`/workspaces/${workspaceId}/receipts/upload-intents`, {
    method: "POST",
    body: JSON.stringify({
      originalName: selected.name,
      mimeType: selected.mimeType,
      byteSize: bytes.byteLength,
      role: input.role,
      transactionId: input.transactionId,
      sha256: digest,
    }),
  });
  const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: bytes });
  if (!upload.ok) throw new Error("receipt_upload_failed");
  await apiFetch(`/workspaces/${workspaceId}/receipts/${intent.receiptId}/complete`, {
    method: "POST",
    body: JSON.stringify({ sha256: digest, byteSize: bytes.byteLength }),
  });
  return intent.receiptId;
}
