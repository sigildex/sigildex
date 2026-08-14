import type { DriftFile, DriftReport } from "../check.js";
import type { DiffChangedEntry, DiffPresentEntry, DiffReport } from "../diff/diff.js";
import { FILE_CLASSES, type FileClass } from "../identity/classify.js";
import type { JsonValue, SkillMetadata } from "../identity/frontmatter.js";
import type { ApprovalRecord } from "../schema/validate.js";
import { displayString } from "./sanitize.js";

const IDENTITY_NOTE =
  "This records byte identity only. It does not attest safety, provenance, or future content.";

function field(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(24)}${value}`;
}

function counted(count: number, label: string): string {
  return `${count} ${label}`;
}

function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return displayString(value);
  return displayString(JSON.stringify(value));
}

function sizeNote(entry: { size: number; executable: boolean }): string {
  return entry.executable ? `${entry.size} bytes, executable` : `${entry.size} bytes`;
}

/** Groups already-ordered entries by class, presenting classes in the §7.3 order. */
function groupByClass<Entry extends { class: FileClass }>(entries: readonly Entry[]): [FileClass, Entry[]][] {
  const groups: [FileClass, Entry[]][] = [];
  for (const fileClass of FILE_CLASSES) {
    const members = entries.filter((entry) => entry.class === fileClass);
    if (members.length > 0) groups.push([fileClass, members]);
  }
  return groups;
}

export function renderLockSummary(record: ApprovalRecord, outputPath: string): string {
  const lines = [
    `Locked ${displayString(record.artifact_path)}`,
    field("approval id", displayString(record.approval_id)),
    field("root digest", record.root_digest),
    field("files", String(record.files.length)),
    field("frontmatter", record.skill.frontmatter_status),
  ];
  const frontmatter = record.skill.frontmatter;
  if (frontmatter !== null) {
    for (const key of ["name", "description"]) {
      if (frontmatter[key] !== undefined) lines.push(field(`  ${key}`, formatValue(frontmatter[key])));
    }
  }
  lines.push(field("written to", outputPath), IDENTITY_NOTE);
  return `${lines.join("\n")}\n`;
}

export function renderMatch(record: ApprovalRecord): string {
  return [
    `Match: the artifact matches approval record ${displayString(record.approval_id)}.`,
    field("root digest", record.root_digest),
    field("files", String(record.files.length)),
    IDENTITY_NOTE,
    "",
  ].join("\n");
}

function driftLine(marker: string, file: DriftFile): string {
  const entry = file.actual ?? file.expected;
  return `  ${marker} ${displayString(file.path)} (${entry?.class ?? "other"})`;
}

export function renderDriftReport(report: DriftReport): string {
  const counts = [
    counted(report.added.length, "added"),
    counted(report.removed.length, "removed"),
    counted(report.modified.length, "modified"),
    counted(report.mode_changed.length, "mode-changed"),
  ].join(", ");
  const lines = [
    `Drift: the artifact no longer matches the approval record (${counts}).`,
    field("approved root digest", report.expected_root_digest),
    field("actual root digest", report.actual_root_digest),
    "",
  ];
  for (const file of report.added) lines.push(driftLine("+", file));
  for (const file of report.removed) lines.push(driftLine("-", file));
  for (const file of report.modified) lines.push(driftLine("~", file));
  for (const file of report.mode_changed) lines.push(driftLine("m", file));
  lines.push("", "Review the changes and re-lock only after approving them.", "");
  return lines.join("\n");
}

function changedNote(entry: DiffChangedEntry): string {
  const parts: string[] = [];
  if (entry.content_changed) parts.push("content");
  if (entry.mode_changed) parts.push("mode");
  return parts.join(", ");
}

function renderCategory(
  title: string,
  marker: string,
  entries: readonly (DiffPresentEntry | DiffChangedEntry)[],
): string[] {
  if (entries.length === 0) return [];
  const lines = [`${title} (${entries.length})`];
  for (const [fileClass, members] of groupByClass(entries)) {
    lines.push(`  ${fileClass}`);
    for (const entry of members) {
      const note = "content_changed" in entry ? changedNote(entry) : sizeNote(entry);
      lines.push(`    ${marker} ${displayString(entry.path)} (${note})`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * Non-normative presentation derived from the two `skill` objects. It is never
 * part of the report structure and carries no interoperability requirement.
 */
function renderFrontmatterComparison(base: SkillMetadata, candidate: SkillMetadata): string[] {
  const lines: string[] = [];
  if (base.frontmatter_status !== candidate.frontmatter_status) {
    lines.push(`  status: ${base.frontmatter_status} -> ${candidate.frontmatter_status}`);
  }
  const keys = [...new Set([...Object.keys(base.frontmatter ?? {}), ...Object.keys(candidate.frontmatter ?? {})])].sort();
  for (const key of keys) {
    const before = base.frontmatter?.[key];
    const after = candidate.frontmatter?.[key];
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    lines.push(`  ${displayString(key, 64)}: ${formatValue(before)} -> ${formatValue(after)}`);
  }
  if (lines.length === 0) return [];
  return ["frontmatter changes (informational only, never part of identity)", ...lines, ""];
}

export function renderDiffReport(report: DiffReport, identical: boolean): string {
  if (identical) {
    return [
      "Identical: both directories have the same artifact identity.",
      field("root digest", report.base.root_digest),
      IDENTITY_NOTE,
      "",
    ].join("\n");
  }
  const counts = [
    counted(report.added.length, "added"),
    counted(report.removed.length, "removed"),
    counted(report.changed.length, "changed"),
  ].join(", ");
  const lines = [
    `Different: the two directories have different artifact identities (${counts}).`,
    field("base root digest", report.base.root_digest),
    field("candidate root digest", report.candidate.root_digest),
    "",
    ...renderCategory("added", "+", report.added),
    ...renderCategory("removed", "-", report.removed),
    ...renderCategory("changed", "~", report.changed),
    ...renderFrontmatterComparison(report.base.skill, report.candidate.skill),
  ];
  return `${lines.join("\n")}\n`;
}
