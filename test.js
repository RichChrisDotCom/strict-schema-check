#!/usr/bin/env node
/* Minimal test suite — no dependencies. Run: node test.js */
"use strict";

const assert = require("assert");
const { validateStrict, check } = require("./strict-schema-check.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const errs = (schema) => validateStrict(schema).issues.filter((i) => i.level === "error").length;

const OK = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

t("a valid strict schema has no errors", () => assert.strictEqual(errs(OK), 0));
t("missing additionalProperties is an error", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }), 1));
t("a property missing from required is an error", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false }), 1));
t("maxLength is stripped, not fatal (warn)", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", maxLength: 5 } }, required: ["a"], additionalProperties: false }), 0));
t("pattern is stripped, not fatal (warn)", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", pattern: "^x$" } }, required: ["a"], additionalProperties: false }), 0));
t("$ref is vendor-dependent (warn, not fatal)", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { $ref: "#/x" } }, required: ["a"], additionalProperties: false }), 0));
t("dropped keywords still produce a warning", () => {
  const r = validateStrict({ type: "object", properties: { a: { type: "string", maxLength: 5 } }, required: ["a"], additionalProperties: false });
  assert.ok(r.issues.some((i) => i.level === "warn" && /maxLength/.test(i.msg)));
});
t("a schema with ONLY dropped keywords passes the check", () => {
  const r = check({ type: "object", properties: { a: { type: "string", maxLength: 5 } }, required: ["a"], additionalProperties: false });
  assert.strictEqual(r.totalErr, 0);
});
t("oneOf is rejected", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { oneOf: [{ type: "string" }] } }, required: ["a"], additionalProperties: false }), 1));
t("anyOf at the root is rejected", () =>
  assert.strictEqual(errs({ anyOf: [OK] }), 1));
t("an unsupported format is stripped, not fatal (warn)", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", format: "phone" } }, required: ["a"], additionalProperties: false }), 0));
t("a supported format is accepted", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", format: "email" } }, required: ["a"], additionalProperties: false }), 0));
t("a nested object missing additionalProperties is an error", () =>
  assert.strictEqual(errs({ type: "object", properties: { o: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }, required: ["o"], additionalProperties: false }), 1));
t("union-with-null counts as an optional param", () => {
  const r = validateStrict({ type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"], additionalProperties: false });
  assert.strictEqual(r.optionalParams, 1);
  assert.strictEqual(r.unions, 1);
});
t("a tool definition is unwrapped", () => {
  const r = check({ name: "x", input_schema: OK });
  assert.strictEqual(r.totalErr, 0);
  assert.strictEqual(r.results[0].wrapped, "input_schema");
});
t("an array is checked as a toolset", () => {
  const r = check([{ name: "a", input_schema: OK }, { name: "b", input_schema: OK }]);
  assert.strictEqual(r.batch, true);
  assert.strictEqual(r.tools, 2);
  assert.strictEqual(r.totalErr, 0);
});
t("the tool cap fires past 20", () => {
  const many = Array.from({ length: 21 }, (_, i) => ({ name: "t" + i, input_schema: OK }));
  assert.strictEqual(check(many).capIssues.length, 1);
});
t("the union cap fires past 16", () => {
  const many = Array.from({ length: 17 }, (_, i) => ({
    name: "u" + i,
    input_schema: { type: "object", properties: { v: { type: ["string", "null"] } }, required: ["v"], additionalProperties: false },
  }));
  assert.ok(check(many).capIssues.some((c) => /union/.test(c)));
});

// ---- fixSchema ----
const { fixSchema } = require("./strict-schema-check.js");
const BROKEN = {
  type: "object",
  properties: {
    order_id: { type: "string", maxLength: 12 },
    note: { type: "string", format: "phone" },
    nested: { type: "object", properties: { x: { type: "string" } } },
  },
  required: ["order_id", "ghost"],
};

t("fix: adds additionalProperties to every object", () => {
  const { fixed } = fixSchema(BROKEN);
  assert.strictEqual(fixed.additionalProperties, false);
  assert.strictEqual(fixed.properties.nested.additionalProperties, false);
});
t("fix: adds every property to required", () => {
  const { fixed } = fixSchema(BROKEN);
  assert.deepStrictEqual(fixed.required.slice().sort(), ["nested", "note", "order_id"]);
});
t("fix: drops required entries that are not in properties", () => {
  const { fixed } = fixSchema(BROKEN);
  assert.ok(!fixed.required.includes("ghost"));
});
t("fix: strips rejected keywords and unsupported formats", () => {
  const { fixed } = fixSchema(BROKEN);
  assert.ok(!("maxLength" in fixed.properties.order_id));
  assert.ok(!("format" in fixed.properties.note));
});
t("fix: the repaired schema passes the check", () => {
  const { fixed } = fixSchema(BROKEN);
  assert.strictEqual(validateStrict(fixed).issues.filter((i) => i.level === "error").length, 0);
});
t("fix: does not mutate the input", () => {
  const before = JSON.stringify(BROKEN);
  fixSchema(BROKEN);
  assert.strictEqual(JSON.stringify(BROKEN), before);
});
t("fix: composition is reported as MANUAL, never silently rewritten", () => {
  const r = fixSchema({ type: "object", properties: { a: { oneOf: [{ type: "string" }] } }, required: ["a"], additionalProperties: false });
  assert.ok(r.manual.some((m) => /oneOf/.test(m)));
  assert.ok("oneOf" in r.fixed.properties.a, "oneOf must be left in place for the human to decide");
});
t("fix: root anyOf is reported as MANUAL", () => {
  const r = fixSchema({ anyOf: [{ type: "object", properties: {}, additionalProperties: false }] });
  assert.ok(r.manual.some((m) => /anyOf/.test(m)));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
