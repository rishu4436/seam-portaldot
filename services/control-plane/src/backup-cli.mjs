// Operator CLI. Credentials and encryption keys come from the environment, never arguments or output.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { backupStorage } from "./backup-storage.mjs";
import { restoreBackup } from "./backups.mjs";
const [command, ...args] = process.argv.slice(2);
if (command === "list") {
  console.log(JSON.stringify({ backups: await backupStorage().list() }));
} else if (["verify", "restore"].includes(command)) {
  const fileIndex = args.indexOf("--file"),
    objectIndex = args.indexOf("--object"),
    toIndex = args.indexOf("--to");
  if (fileIndex < 0 === objectIndex < 0) throw new Error("Specify exactly one --file or --object.");
  if (command === "restore" && (toIndex < 0 || !args[toIndex + 1]))
    throw new Error("Restore requires --to with a new database path.");
  const encrypted =
    fileIndex >= 0
      ? await readFile(resolve(args[fileIndex + 1]))
      : await backupStorage().get(args[objectIndex + 1]);
  const result = await restoreBackup(
    encrypted,
    process.env.SEAM_BACKUP_ENCRYPTION_KEY,
    command === "restore" ? args[toIndex + 1] : undefined,
  );
  console.log(JSON.stringify({ restored: command === "restore", ...result }));
} else if (command === "download") {
  const [object, target] = args;
  if (!object || !target) throw new Error("Download requires object key and new output path.");
  await writeFile(resolve(target), await backupStorage().get(object), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ downloaded: true }));
} else
  throw new Error(
    "Usage: backup-cli.mjs list | download <object> <new-file> | verify|restore --file <backup> | --object <key> [--to <new.sqlite>]",
  );
