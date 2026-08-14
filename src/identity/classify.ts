export const FILE_CLASSES = [
  "instructions",
  "reference",
  "script",
  "config",
  "asset",
  "other",
] as const;

export type FileClass = (typeof FILE_CLASSES)[number];

const REFERENCE_EXTENSIONS = [".md", ".mdx", ".txt"];
const SCRIPT_EXTENSIONS = [
  ".sh", ".bash", ".zsh", ".py", ".rb", ".js", ".mjs", ".cjs",
  ".ts", ".mts", ".cts", ".pl", ".ps1",
];
const CONFIG_EXTENSIONS = [".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"];
const ASSET_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".pdf", ".woff", ".woff2",
];

export function classifyFile(recordedPath: string, executable: boolean): FileClass {
  const lowerPath = recordedPath.toLowerCase();
  const basename = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  if (lowerPath === "skill.md") return "instructions";
  if (REFERENCE_EXTENSIONS.some((extension) => basename.endsWith(extension))) return "reference";
  if (SCRIPT_EXTENSIONS.some((extension) => basename.endsWith(extension)) || executable) return "script";
  if (
    CONFIG_EXTENSIONS.some((extension) => basename.endsWith(extension)) ||
    basename === "makefile" || basename === "dockerfile"
  ) return "config";
  if (ASSET_EXTENSIONS.some((extension) => basename.endsWith(extension))) return "asset";
  return "other";
}
