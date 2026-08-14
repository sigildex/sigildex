export {
  ROOT_DIGEST_DOMAIN,
  canonicalManifest,
  canonicalManifestLine,
  compareUtf8,
  computeRootDigest,
  type ManifestEntry,
} from "./identity/canonical.js";
export { classifyFile, FILE_CLASSES, type FileClass } from "./identity/classify.js";
export {
  MAX_FRONTMATTER_ALIASES,
  MAX_FRONTMATTER_BYTES,
  readSkillFrontmatter,
  type JsonValue,
  type SkillMetadata,
} from "./identity/frontmatter.js";
export {
  ASSIGNED_RANGES,
  SIMPLE_CASE_FOLDING,
  equivalenceKey,
  isAssignedUnicode15_1,
  simpleCaseFoldUnicode15_1,
} from "./identity/unicode-15-1.js";
export {
  WALK_LIMITS,
  validateRecordedPath,
  walkSkill,
  type WalkFailure,
  type WalkFailureRule,
  type WalkHooks,
  type WalkOptions,
  type WalkResult,
  type WalkSuccess,
} from "./identity/walk.js";
export {
  LIMITATIONS,
  validateApprovalRecord,
  type ApprovalRecord,
  type DeclaredSource,
  type ValidationResult,
  type ValidationStep,
} from "./schema/validate.js";
export { TOOL_VERSION, lock, serializeApprovalRecord, type LockOptions, type LockResult } from "./lock.js";
export {
  check,
  type CheckOptions,
  type CheckResult,
  type DriftFile,
  type DriftReport,
} from "./check.js";
export {
  diff,
  type DiffChangedEntry,
  type DiffFileState,
  type DiffOptions,
  type DiffPresentEntry,
  type DiffReport,
  type DiffResult,
  type DiffSide,
  type DiffTree,
} from "./diff/diff.js";
