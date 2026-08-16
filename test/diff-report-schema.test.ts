import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { diff, type DiffReport } from "../src/index.js";
import { fixture, writeSkill } from "./helpers.js";

/**
 * Structural conformance between the published schema and a real report.
 *
 * The package ships exactly one runtime dependency, so this asserts the
 * schema's closed-object key sets against the keys the implementation
 * actually emits rather than pulling in a JSON-Schema validator.
 */

type SchemaNode = Record<string, unknown>;

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "diff-report.schema.json");

let schema: SchemaNode;
let report: DiffReport;

/** Resolves a local `#/$defs/<name>` reference against the loaded schema. */
function deref(node: SchemaNode): SchemaNode {
  const ref = node["$ref"];
  if (typeof ref !== "string") return node;
  const name = ref.replace("#/$defs/", "");
  const defs = schema["$defs"] as Record<string, SchemaNode>;
  const target = defs[name];
  if (target === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  return deref(target);
}

/** The sorted `properties` key set of a (possibly referencing) object node. */
function propertyKeys(node: SchemaNode): string[] {
  const resolved = deref(node);
  return Object.keys(resolved["properties"] as Record<string, unknown>).sort();
}

/** The sorted `required` key set of a (possibly referencing) object node. */
function requiredKeys(node: SchemaNode): string[] {
  const resolved = deref(node);
  return (resolved["required"] as string[]).slice().sort();
}

function itemsOf(node: SchemaNode): SchemaNode {
  return deref(deref(node)["items"] as SchemaNode);
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

function property(node: SchemaNode, name: string): SchemaNode {
  return (deref(node)["properties"] as Record<string, SchemaNode>)[name]!;
}

beforeAll(async () => {
  schema = JSON.parse(await readFile(schemaPath, "utf8")) as SchemaNode;

  const base = await fixture("base");
  const candidate = await fixture("candidate");
  await writeSkill(base.root, "name: demo\ndescription: fixture");
  await writeSkill(candidate.root, "name: demo\ndescription: fixture changed");
  // One path per report category, so every array is exercised.
  await writeFile(join(base.root, "gone.md"), "removed side\n");
  await writeFile(join(candidate.root, "new.py"), "print(1)\n");
  await writeFile(join(base.root, "notes.md"), "before\n");
  await writeFile(join(candidate.root, "notes.md"), "after\n");

  const result = await diff({ basePath: base.root, candidatePath: candidate.root });
  if (result.kind === "tool_error") throw new Error(result.message);
  report = result.report;
});

describe("published diff-report schema matches the emitted report", () => {
  it("states on its face that it is a structural subset, not the contract", () => {
    // The same honesty the approval-record schema carries: `maxLength` counts
    // code points where the specification counts UTF-8 bytes, and ordering and
    // category exclusivity are properties of the emitter, not of the shape.
    expect(typeof schema["description"]).toBe("string");
    expect(typeof schema["$comment"]).toBe("string");
    expect(schema["description"] as string).toMatch(/structural subset/i);
    expect(schema["$comment"] as string).toMatch(/UTF-8 BYTES/);
    expect(schema["$comment"] as string).toMatch(/unassigned in Unicode 15\.1/);
    expect(schema["$comment"] as string).toMatch(/order/i);
  });


  it("produces a fixture report that populates every category", () => {
    expect(report.added).toHaveLength(1);
    expect(report.removed).toHaveLength(1);
    expect(report.changed.map((entry) => entry.path)).toEqual(["SKILL.md", "notes.md"]);
    expect(report.base.skill.frontmatter_status).toBe("ok");
  });

  it("declares the top-level keys the report carries, all required", () => {
    expect(propertyKeys(schema)).toEqual(keysOf(report));
    expect(requiredKeys(schema)).toEqual(keysOf(report));
    expect((property(schema, "schema_version")["const"] as number)).toBe(report.schema_version);
  });

  it("declares the base and candidate side shapes", () => {
    for (const [name, side] of [
      ["base", report.base],
      ["candidate", report.candidate],
    ] as const) {
      const sideSchema = property(schema, name);
      expect(propertyKeys(sideSchema)).toEqual(keysOf(side));
      expect(requiredKeys(sideSchema)).toEqual(keysOf(side));

      const skillSchema = property(sideSchema, "skill");
      expect(propertyKeys(skillSchema)).toEqual(keysOf(side.skill));
      expect(requiredKeys(skillSchema)).toEqual(keysOf(side.skill));
    }
  });

  it("leaves skill.frontmatter open so captured frontmatter keys are unconstrained", () => {
    const frontmatter = property(property(property(schema, "base"), "skill"), "frontmatter");
    expect(frontmatter).not.toHaveProperty("additionalProperties");
    expect(frontmatter).not.toHaveProperty("properties");
    expect(Object.keys(report.base.skill.frontmatter ?? {})).toEqual(["description", "name"]);
  });

  it("declares the added and removed entry shape", () => {
    for (const [name, entry] of [
      ["added", report.added[0]!],
      ["removed", report.removed[0]!],
    ] as const) {
      const itemSchema = itemsOf(property(schema, name));
      expect(propertyKeys(itemSchema)).toEqual(keysOf(entry));
      expect(requiredKeys(itemSchema)).toEqual(keysOf(entry));
    }
  });

  it("declares the changed entry shape including both nested file states", () => {
    const entry = report.changed[0]!;
    const itemSchema = itemsOf(property(schema, "changed"));
    expect(propertyKeys(itemSchema)).toEqual(keysOf(entry));
    expect(requiredKeys(itemSchema)).toEqual(keysOf(entry));

    for (const side of ["base", "candidate"] as const) {
      const stateSchema = property(itemSchema, side);
      expect(propertyKeys(stateSchema)).toEqual(keysOf(entry[side]));
      expect(requiredKeys(stateSchema)).toEqual(keysOf(entry[side]));
    }
  });

  it("closes every object level the report contract closes", () => {
    const closed: SchemaNode[] = [
      schema,
      property(schema, "base"),
      property(property(schema, "base"), "skill"),
      itemsOf(property(schema, "added")),
      itemsOf(property(schema, "removed")),
      itemsOf(property(schema, "changed")),
      property(itemsOf(property(schema, "changed")), "base"),
    ];
    for (const node of closed) expect(deref(node)["additionalProperties"]).toBe(false);
  });
});
