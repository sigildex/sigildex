import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lock, validateApprovalRecord } from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

/**
 * The published approval-record schema against the validator that actually
 * gates records.
 *
 * The schema is a structural subset of the specification, and this file exists
 * to keep that gap documented and bounded rather than discovered. It pins the
 * divergences that are known and intended — records the schema accepts and
 * `sigildex check` rejects — so a consumer reading the schema is never left
 * believing it is an acceptance test.
 *
 * The package ships one runtime dependency, so rather than pull in a
 * JSON-Schema validator this file evaluates the small keyword set this schema
 * uses. The evaluator throws on any keyword it does not implement, so a future
 * schema keyword fails loudly here instead of being silently skipped.
 */

type Node = Record<string, unknown>;
type Json = Record<string, unknown>;

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "approval-record.schema.json");

let schema: Node;
/** A real, freshly locked record — the ground truth both sides must accept. */
let valid: Json;

/** Keywords that carry no assertion. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$comment", "$defs"]);

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(name: string, value: unknown): boolean {
  switch (name) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "null": return value === null;
    default: throw new Error(`unsupported JSON Schema type: ${name}`);
  }
}

/** Returns one message per failed assertion; an empty array means the value validates. */
function validate(node: Node, value: unknown, path = ""): string[] {
  const errors: string[] = [];
  for (const [keyword, argument] of Object.entries(node)) {
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case "$ref": {
        const defs = schema["$defs"] as Record<string, Node>;
        const target = defs[(argument as string).replace("#/$defs/", "")];
        if (target === undefined) throw new Error(`unresolvable $ref: ${String(argument)}`);
        errors.push(...validate(target, value, path));
        break;
      }
      case "type": {
        const names = Array.isArray(argument) ? (argument as string[]) : [argument as string];
        if (!names.some((name) => typeMatches(name, value))) errors.push(`${path}: type`);
        break;
      }
      case "const":
        if (value !== argument) errors.push(`${path}: const`);
        break;
      case "enum":
        if (!(argument as unknown[]).includes(value)) errors.push(`${path}: enum`);
        break;
      case "pattern":
        if (typeof value === "string" && !new RegExp(argument as string).test(value)) errors.push(`${path}: pattern`);
        break;
      case "maxLength":
        // JSON Schema measures string length in CODE POINTS. The specification
        // measures every string limit in UTF-8 bytes. That is divergence 1.
        if (typeof value === "string" && [...value].length > (argument as number)) errors.push(`${path}: maxLength`);
        break;
      case "minimum":
        if (typeof value === "number" && value < (argument as number)) errors.push(`${path}: minimum`);
        break;
      case "required":
        if (isPlainObject(value)) {
          for (const key of argument as string[]) if (!(key in value)) errors.push(`${path}: missing ${key}`);
        }
        break;
      case "properties":
        if (isPlainObject(value)) {
          for (const [key, sub] of Object.entries(argument as Record<string, Node>)) {
            if (key in value) errors.push(...validate(sub, value[key], `${path}/${key}`));
          }
        }
        break;
      case "additionalProperties": {
        if (argument !== false) throw new Error("only additionalProperties: false is implemented");
        if (isPlainObject(value)) {
          const declared = new Set(Object.keys((node["properties"] ?? {}) as Json));
          for (const key of Object.keys(value)) if (!declared.has(key)) errors.push(`${path}: unknown key ${key}`);
        }
        break;
      }
      case "items":
        if (Array.isArray(value)) {
          value.forEach((entry, index) => errors.push(...validate(argument as Node, entry, `${path}/${index}`)));
        }
        break;
      case "anyOf":
        if (!(argument as Node[]).some((sub) => validate(sub, value, path).length === 0)) errors.push(`${path}: anyOf`);
        break;
      case "allOf":
        for (const sub of argument as Node[]) errors.push(...validate(sub, value, path));
        break;
      case "if": {
        const branch = validate(argument as Node, value, path).length === 0 ? node["then"] : node["else"];
        if (branch !== undefined) errors.push(...validate(branch as Node, value, path));
        break;
      }
      case "then":
      case "else":
        break; // Evaluated with the sibling `if`.
      default:
        throw new Error(`unsupported JSON Schema keyword: ${keyword}`);
    }
  }
  return errors;
}

/** Deep-clones the known-good record so each case mutates in isolation. */
function record(mutate: (draft: Json) => void): Json {
  const draft = JSON.parse(JSON.stringify(valid)) as Json;
  mutate(draft);
  return draft;
}

/** Asserts a document the published schema accepts and `sigildex check` refuses. */
function expectDivergence(document: Json, step: string): void {
  expect(validate(schema, document)).toEqual([]);
  const verdict = validateApprovalRecord(JSON.stringify(document));
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.step).toBe(step);
}

beforeAll(async () => {
  schema = JSON.parse(await readFile(schemaPath, "utf8")) as Node;
  const { root, lockPath } = await fixture("demo");
  await writeSkill(root, "name: demo\ndescription: fixture");
  const result = await lock({
    skillRoot: root,
    outputPath: join(dirname(lockPath), "demo.lock.json"),
    approvalId: "demo",
    artifactPath: "demo",
  });
  if (result.kind !== "locked") throw new Error(result.message);
  valid = JSON.parse(result.json) as Json;
});

describe("the published schema states that it is not the contract", () => {
  it("carries a top-level description and $comment naming the gap", () => {
    const description = schema["description"];
    const comment = schema["$comment"];
    expect(typeof description).toBe("string");
    expect(typeof comment).toBe("string");
    expect(description as string).toMatch(/structural subset/i);
    // The three divergences the $comment must keep on the record.
    expect(comment as string).toMatch(/UTF-8 BYTES/);
    expect(comment as string).toMatch(/maxLength/);
    expect(comment as string).toMatch(/unassigned in Unicode 15\.1/);
    expect(comment as string).toMatch(/root_digest/);
    // And which side wins.
    expect(`${description as string} ${comment as string}`).toMatch(/sigildex check/);
  });

  it("declares maxLength as an upper bound, not the specification's limit", () => {
    const declaredSource = (schema["properties"] as Record<string, Node>)["declared_source"]!;
    const properties = declaredSource["properties"] as Record<string, Node>;
    // Nothing the validator accepts may be rejected here: 512 bytes is at most
    // 512 code points, so the code-point bound is never the stricter of the two.
    expect(properties["repository"]!["maxLength"]).toBe(512);
    expect(properties["tracking_policy"]!["maxLength"]).toBe(128);
    expect((schema["$defs"] as Record<string, Node>)["recordedPath"]!["maxLength"]).toBe(1024);
  });
});

describe("a freshly written record satisfies both the schema and the validator", () => {
  it("validates against the published schema", () => {
    expect(validate(schema, valid)).toEqual([]);
  });

  it("is accepted by sigildex check's validation algorithm", () => {
    expect(validateApprovalRecord(JSON.stringify(valid)).ok).toBe(true);
  });

  it("and the schema still rejects what it does constrain", () => {
    // Without this, an evaluator that returned no errors for everything would
    // make every divergence below look real.
    const rejected: Array<[string, (draft: Json) => void]> = [
      ["unknown top-level key", (draft) => { draft.extra = 1; }],
      ["missing required key", (draft) => { delete draft.created_at; }],
      ["altered limitations literal", (draft) => { draft.limitations = "anything else"; }],
      ["malformed root_digest", (draft) => { draft.root_digest = "sha256:nothex"; }],
      ["approval_id outside the grammar", (draft) => { draft.approval_id = "Not An Id"; }],
      ["control character in a path", (draft) => { (draft.files as Json[])[0]!.path = "a\u0001b.md"; }],
      ["absolute path", (draft) => { (draft.files as Json[])[0]!.path = "/etc/passwd"; }],
      ["traversal component", (draft) => { (draft.files as Json[])[0]!.path = "../escape.md"; }],
      ["unknown file class", (draft) => { (draft.files as Json[])[0]!.class = "executable"; }],
      ["negative size", (draft) => { (draft.files as Json[])[0]!.size = -1; }],
      ["frontmatter present while status is missing", (draft) => {
        draft.skill = { frontmatter_status: "missing", frontmatter: {} };
      }],
      ["unsupported schema_version", (draft) => { draft.schema_version = 2; }],
    ];
    for (const [label, mutate] of rejected) {
      expect(validate(schema, record(mutate)), label).not.toEqual([]);
    }
  });
});

describe("known divergences: the schema accepts what the validator refuses", () => {
  it("divergence 1 (byte length): 260 two-byte characters fit maxLength 512 and exceed 512 bytes", () => {
    const repository = "é".repeat(260);
    // The two units, side by side, on the same string.
    expect([...repository].length).toBe(260);
    expect(Buffer.byteLength(repository, "utf8")).toBe(520);
    expectDivergence(
      record((draft) => {
        draft.declared_source = { repository, verification: "user_supplied" };
      }),
      "shape",
    );
  });

  it("divergence 2 (Unicode assignment): a path holding a code point unassigned in 15.1 passes the pattern", () => {
    // U+0378 is unassigned in Unicode 15.1, so §4.2 rule 4 refuses it. The
    // schema's recordedPath pattern only bans control characters and bad form.
    expectDivergence(
      record((draft) => {
        const files = draft.files as Json[];
        files[0]!.path = "SKILL\u0378.md";
      }),
      "shape",
    );
  });

  it("divergence 3 (§9.5 step 5): a root_digest that contradicts its own manifest is well-shaped", () => {
    expectDivergence(
      record((draft) => {
        draft.root_digest = `sha256:${"a".repeat(64)}`;
      }),
      "internal_consistency",
    );
  });

  it("divergence 3 (§9.5 step 4): an out-of-order manifest is well-shaped", () => {
    const twoFiles = record((draft) => {
      const files = draft.files as Json[];
      files.push({ ...files[0]!, path: "aaa.md" });
    });
    // `aaa.md` sorts before `SKILL.md` is false byte-wise, so build the
    // violation explicitly: two entries in descending order.
    const files = twoFiles.files as Json[];
    files.sort((left, right) => (String(right.path) < String(left.path) ? -1 : 1));
    expect(files.map((entry) => String(entry.path))).toEqual(["aaa.md", "SKILL.md"]);
    expectDivergence(twoFiles, "manifest_integrity");
  });
});
