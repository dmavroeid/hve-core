import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const PYTHON = process.env.CATALOG_PYTHON ?? "python";
const DISCLAIMER = "> [!CAUTION]\n> **Disclaimer:** This agent is an assistive data-science and data-engineering coaching tool only. It does not validate customer data, execute production pipelines, establish model fitness, or replace data owners, privacy and Responsible AI reviewers, engineering review, or business decision authority. Catalogs, feasibility findings, analyses, experiments, tests, and operational recommendations generated with this tool may be incomplete or inaccurate and must be independently reviewed against approved data sources, stakeholder evidence, and organizational controls before use. Outputs from this tool do not constitute data approval, feasibility sign-off, model approval, privacy or Responsible AI approval, or production readiness.";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function checkerError(message) {
  console.error(message);
  process.exit(2);
}

function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) fail("catalog must begin with closed YAML frontmatter");
  return match[1];
}

function normalizeJoinKeys(joinKeys) {
  const from = [].concat(joinKeys.from_field);
  const to = [].concat(joinKeys.to_field);
  return JSON.stringify(from.map((field, index) => [field, to[index]]).sort());
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

function main() {
  const catalogPath = process.argv[2];
  if (!catalogPath) checkerError("usage: node task-fixture/check.mjs deliverable/northlake-ds-catalog.md");
  const catalogAbsolutePath = path.resolve(process.cwd(), catalogPath);
  if (!existsSync(catalogAbsolutePath)) fail("missing candidate catalog");

  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const contractRoot = path.join(fixtureRoot, "contract");
  const inventoryPath = path.join(fixtureRoot, "inventory.json");
  const validatorPath = path.join(contractRoot, "scripts", "validate_catalog.py");

  try {
    readFileSync(inventoryPath, "utf8");
    readFileSync(validatorPath, "utf8");
  } catch (error) {
    checkerError(`checker setup error: ${error.message}`);
  }

  const validation = spawnSync(PYTHON, [validatorPath, catalogAbsolutePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120000,
  });
  if (validation.error) checkerError(`validator invocation failed: ${validation.error.message}`);
  if (validation.status === 2) checkerError((validation.stderr || validation.stdout).trim() || "validator reported an operational error");
  if (validation.status !== 0) fail((validation.stdout || validation.stderr).trim() || "catalog failed the DS_CATALOG_V1 validator");

  const expected = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const markdown = readFileSync(catalogAbsolutePath, "utf8");
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const normalizedBody = body.replace(/\r\n/g, "\n");
  let actual;
  try {
    actual = parse(extractFrontmatter(markdown));
  } catch (error) {
    checkerError(`frontmatter parse error: ${error.message}`);
  }

  if (actual.catalog_version !== "DS_CATALOG_V1") fail(`expected catalog_version DS_CATALOG_V1, found ${actual.catalog_version}`);
  if (actual.engagement !== "northlake-equipment-rentals") fail(`expected engagement northlake-equipment-rentals, found ${actual.engagement}`);

  const expectedEntities = new Map(expected.entities.map(entity => [entity.id, entity]));
  const actualEntities = new Map(actual.entities.map(entity => [entity.id, entity]));
  if (actual.entities.length !== expected.entities.length) fail(`expected ${expected.entities.length} entities, found ${actual.entities.length}`);
  for (const [id, entity] of expectedEntities) {
    const candidate = actualEntities.get(id);
    if (!candidate) fail(`missing entity ${id}`);
    for (const field of ["tier", "profile_ref"]) {
      if (candidate[field] !== entity[field]) fail(`entity ${id} ${field} mismatch`);
    }
    if (!sameJson(candidate.source, entity.source)) fail(`entity ${id} source mismatch`);
    if (!sameJson(candidate.volume, entity.volume)) fail(`entity ${id} volume mismatch`);
    if (!sameJson(candidate.classification, entity.classification)) fail(`entity ${id} classification mismatch`);
    if (!sameJson(candidate.lineage, entity.lineage)) fail(`entity ${id} lineage mismatch`);
  }

  const expectedRelationships = new Map(expected.relationships.map(relationship => [relationship.id, relationship]));
  const actualRelationships = new Map(actual.relationships.map(relationship => [relationship.id, relationship]));
  if (actual.relationships.length !== expected.relationships.length) fail(`expected ${expected.relationships.length} relationships, found ${actual.relationships.length}`);
  for (const [id, relationship] of expectedRelationships) {
    const candidate = actualRelationships.get(id);
    if (!candidate) fail(`missing relationship ${id}`);
    for (const field of ["from", "to", "cardinality", "from_minimum", "to_minimum", "confidence"]) {
      if (candidate[field] !== relationship[field]) fail(`relationship ${id} ${field} mismatch`);
    }
    if (normalizeJoinKeys(candidate.join_keys) !== normalizeJoinKeys(relationship.join_keys)) {
      fail(`relationship ${id} join_keys mismatch`);
    }
  }

  if (!sameJson(actual.coverage, {
    entities_catalogued: expected.entities.length,
    entities_access_confirmed: expected.entities.filter(entity => entity.source.access_confirmed).length,
    entities_classified: expected.entities.filter(entity =>
      entity.classification.sensitivity !== "none"
      || ["gdpr_article", "ccpa_section", "nist_pf_category", "nistir8062_objective", "owasp_privacy_id"]
        .some(field => entity.classification[field] !== null),
    ).length,
    relationships_confirmed: expected.relationships.filter(relationship => relationship.confidence === "confirmed").length,
    relationships_inferred: expected.relationships.filter(relationship => relationship.confidence === "inferred").length,
  })) {
    fail("coverage counts do not reconcile with the authoritative inventory");
  }

  if (!normalizedBody.trimEnd().endsWith(DISCLAIMER)) fail("missing canonical Data Science and Engineering Coaching disclaimer footer");
  console.log("Catalog passed contract and machine-fact checks. Narrative fidelity, grain, basis, open questions, table coverage and usefulness require source-grounded review.");
}

try {
  main();
} catch (error) {
  checkerError(error instanceof Error ? error.message : String(error));
}
