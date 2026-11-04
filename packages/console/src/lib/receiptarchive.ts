import {
  inspectEvidenceBundle,
  prepareEvidenceBundle,
  type EvidenceBundle,
} from "@seam/sdk/browser";

export const RECEIPT_DB = "seam.receipts.v1";
export const RECEIPT_ARCHIVE_EVENT = "seam:receipts-changed";
const MAXIMUM_RECORDS = 100,
  MAXIMUM_BYTES = 32 * 1024 * 1024;
export interface ArchivedReceipt {
  id: string;
  savedAt: string;
  bundle: EvidenceBundle;
}
export interface ReceiptArchiveExport {
  archiveVersion: 1;
  exportedAt: string;
  receipts: ArchivedReceipt[];
}
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function archiveEntry(input: unknown, savedAt = new Date().toISOString()): ArchivedReceipt {
  const bundle = prepareEvidenceBundle(input);
  if (inspectEvidenceBundle(bundle).status === "failed")
    throw new Error("Receipt integrity failed. The local archive was not changed.");
  const receipt = bundle.receipt as unknown as {
    approvalHash?: string;
    integrityHash?: string;
    receiptHash?: string;
  };
  const id = `${bundle.plan.planDigest}:${receipt.approvalHash ?? receipt.integrityHash ?? receipt.receiptHash ?? bundle.createdAt}`;
  return { id, savedAt, bundle };
}
export function validateArchive(input: unknown): ArchivedReceipt[] {
  const value = input as ReceiptArchiveExport;
  if (
    !value ||
    value.archiveVersion !== 1 ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > MAXIMUM_RECORDS ||
    size(value) > MAXIMUM_BYTES
  )
    throw new Error("Choose a version 1 receipt archive with at most 100 receipts and 32 MiB.");
  return value.receipts.map((row) => {
    if (!row || typeof row.savedAt !== "string" || !Number.isFinite(Date.parse(row.savedAt)))
      throw new Error("Invalid archive timestamp.");
    return archiveEntry(row.bundle, row.savedAt);
  });
}
function open(factory?: IDBFactory): Promise<IDBDatabase> {
  const source = factory ?? globalThis.indexedDB;
  if (!source)
    return Promise.reject(
      new Error("Local receipt storage is unavailable. Download your receipt before leaving."),
    );
  return new Promise((resolve, reject) => {
    const request = source.open(RECEIPT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("receipts", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error("Local receipt storage is unavailable. Download your receipt before leaving."),
      );
    request.onblocked = () =>
      reject(new Error("Another tab is blocking the receipt archive. Close it and retry."));
  });
}
function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(RECEIPT_ARCHIVE_EVENT));
}
export async function listLocalReceipts(factory?: IDBFactory): Promise<ArchivedReceipt[]> {
  const db = await open(factory);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("receipts", "readonly"),
        request = transaction.objectStore("receipts").getAll();
      transaction.oncomplete = () => {
        try {
          const rows = request.result as ArchivedReceipt[];
          const valid = validateArchive({ archiveVersion: 1, receipts: rows });
          resolve(valid.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () => reject(new Error("The local receipt archive could not be read."));
    });
  } finally {
    db.close();
  }
}
export async function importLocalReceipts(input: unknown, factory?: IDBFactory): Promise<number> {
  const entries = validateArchive(input); // Validate every receipt before opening a write transaction.
  const db = await open(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("receipts", "readwrite", { durability: "strict" }),
        store = transaction.objectStore("receipts");
      const current = store.getAll();
      let problem: unknown;
      current.onsuccess = () => {
        try {
          const merged = new Map((current.result as ArchivedReceipt[]).map((row) => [row.id, row]));
          for (const row of entries) {
            const previous = merged.get(row.id);
            if (!previous || previous.savedAt <= row.savedAt) merged.set(row.id, row);
          }
          if (merged.size > MAXIMUM_RECORDS || size([...merged.values()]) > MAXIMUM_BYTES)
            throw new Error(
              "The receipt archive is full. Export your receipts before adding more.",
            );
          for (const row of merged.values()) store.put(row);
        } catch (error) {
          problem = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(
          problem ?? new Error("Receipt storage failed. Download your receipt before leaving."),
        );
    });
    notify();
    return entries.length;
  } finally {
    db.close();
  }
}
export async function saveLocalReceipt(input: unknown, factory?: IDBFactory): Promise<void> {
  const entry = archiveEntry(input);
  await importLocalReceipts({ archiveVersion: 1, receipts: [entry] }, factory);
}
export async function exportLocalReceipts(): Promise<ReceiptArchiveExport> {
  return {
    archiveVersion: 1,
    exportedAt: new Date().toISOString(),
    receipts: await listLocalReceipts(),
  };
}
export async function removeLocalReceipt(id: string, factory?: IDBFactory): Promise<void> {
  const db = await open(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("receipts", "readwrite", { durability: "strict" });
      transaction.objectStore("receipts").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("The local receipt could not be removed."));
    });
    notify();
  } finally {
    db.close();
  }
}
