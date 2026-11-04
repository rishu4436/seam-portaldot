import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
export function backupStorage(env = process.env) {
  const endpoint = new URL(env.SEAM_BACKUP_S3_ENDPOINT);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Use a trusted HTTPS backup bucket endpoint.");
  if (
    !env.SEAM_BACKUP_S3_BUCKET ||
    !env.SEAM_BACKUP_S3_ACCESS_KEY_ID ||
    !env.SEAM_BACKUP_S3_SECRET_ACCESS_KEY
  )
    throw new Error("Backup storage credentials are missing.");
  const client = new S3Client({
    endpoint: endpoint.origin,
    region: env.SEAM_BACKUP_S3_REGION ?? "auto",
    maxAttempts: 2,
    forcePathStyle: env.SEAM_BACKUP_S3_PATH_STYLE === "true",
    credentials: {
      accessKeyId: env.SEAM_BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: env.SEAM_BACKUP_S3_SECRET_ACCESS_KEY,
    },
  });
  const Bucket = env.SEAM_BACKUP_S3_BUCKET,
    Prefix = "seam-control-plane/v1/";
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(60000) });
  const key = (Key) => {
    if (!Key.startsWith(Prefix) || Key.includes(".."))
      throw new Error("Invalid backup object key.");
    return Key;
  };
  return {
    put: (Key, Body) =>
      send(
        new PutObjectCommand({
          Bucket,
          Key: key(Key),
          Body,
          ContentType: "application/octet-stream",
        }),
      ),
    async get(Key) {
      const result = await send(new GetObjectCommand({ Bucket, Key: key(Key) }));
      const maximum = 128 * 1024 * 1024;
      if (result.ContentLength > maximum || !result.Body)
        throw new Error("Invalid remote backup size.");
      const chunks = [];
      let length = 0;
      for await (const chunk of result.Body) {
        length += chunk.length;
        if (length > maximum) {
          result.Body.destroy();
          throw new Error("Remote backup is too large.");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    },
    async list() {
      const objects = [];
      let ContinuationToken;
      do {
        const value = await send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        objects.push(...(value.Contents ?? []).map((row) => row.Key));
        if (objects.length > 1000) throw new Error("Backup listing exceeds the safety budget.");
        ContinuationToken = value.IsTruncated ? value.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return objects;
    },
    remove: (Key) => send(new DeleteObjectCommand({ Bucket, Key: key(Key) })),
  };
}
