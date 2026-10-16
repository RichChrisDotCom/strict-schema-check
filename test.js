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
t("maxLength is rejected", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", maxLength: 5 } }, required: ["a"], additionalProperties: false }), 1));
t("pattern is rejected", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", pattern: "^x$" } }, required: ["a"], additionalProperties: false }), 1));
t("$ref is rejected", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { $ref: "#/x" } }, required: ["a"], additionalProperties: false }), 1));
t("oneOf is rejected", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { oneOf: [{ type: "string" }] } }, required: ["a"], additionalProperties: false }), 1));
t("anyOf at the root is rejected", () =>
  assert.strictEqual(errs({ anyOf: [OK] }), 1));
t("an unsupported format is rejected", () =>
  assert.strictEqual(errs({ type: "object", properties: { a: { type: "string", format: "phone" } }, required: ["a"], additionalProperties: false }), 1));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
