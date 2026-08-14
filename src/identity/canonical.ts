import { createHash } from "node:crypto";
import type { FileClass } from "./classify.js";

export const ROOT_DIGEST_DOMAIN = "sigildex-root-digest-v1\n";

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number | bigint;
  executable: boolean;
  class: FileClass;
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalManifestLine(file: ManifestEntry): string {
  return `${file.sha256} ${file.size} ${file.executable ? "x" : "-"} ${file.path}\n`;
}

export function canonicalManifest(manifest: readonly ManifestEntry[]): string {
  return manifest.map(canonicalManifestLine).join("");
}

export function computeRootDigest(manifest: readonly ManifestEntry[]): string {
  const hash = createHash("sha256");
  hash.update(ROOT_DIGEST_DOMAIN, "utf8");
  for (const file of manifest) hash.update(canonicalManifestLine(file), "utf8");
  return `sha256:${hash.digest("hex")}`;
}
