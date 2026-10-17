#!/usr/bin/env node
/*
 * strict-schema-check — catch the tool-schema problems that cause 400s, before you ship.
 *
 * Strict mode (Anthropic "strict": true, OpenAI structured outputs) compiles your JSON
 * Schema into a grammar. Schemas that validate fine in your editor still fail there.
 * This checks the rules that actually bite.
 *
 * The rule set mirrors the in-browser version at
 * https://richchris.com/tools/strict-schema-validator and is documented at
 * https://richchris.com/blog/agent-tool-calling-json-schemas
 *
 * Usage:
 *   strict-schema-check tools.json
 *   cat tools.json | strict-schema-check -
 *   strict-schema-check tools.json --json      # machine-readable
 *   strict-schema-check tools.json --quiet     # exit code only
 *
 * Accepts: a single tool definition ({name, input_schema|parameters}), a bare JSON Schema,
 * or an array of tool definitions (checked as a request, so the per-request caps apply).
 *
 * Exit: 0 = no blocking problems, 1 = blocking problems found, 2 = bad usage / bad JSON.
 * No dependencies. Node 14+.
 */
"use strict";

const fs = require("fs");

const FORMATS = ["date-time", "date", "time", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"];
const BANNED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
                "minProperties", "maxProperties", "$ref", "definitions", "$defs"];
const SOFT = ["oneOf", "allOf"];
const CAPS = { tools: 20, optionalParams: 24, unions: 16 };

function isObj(n) { return n && typeof n === "object" && !Array.isArray(n); }

// Returns { issues: [{level,path,msg}], optionalParams, unions, objects }
function validateStrict(schema) {
  const issues = [];
  let optionalParams = 0, unions = 0, objects = 0;

  function walk(node, path) {
    if (!isObj(node)) return;

    for (const k of BANNED) {
      if (k in node) issues.push({ level: "error", path, msg: `'${k}' is rejected or ignored in strict mode` });
    }
    for (const k of SOFT) {
      if (k in node) issues.push({ level: "error", path, msg: `'${k}' is commonly rejected in strict mode` });
    }
    if ("anyOf" in node && path === "$") {
      issues.push({ level: "error", path, msg: "'anyOf' cannot sit at the root of a strict schema" });
    }
    if (node.format && FORMATS.indexOf(node.format) === -1) {
      issues.push({ level: "error", path, msg: `unsupported format '${node.format}' — it is dropped silently` });
    }
    if (Array.isArray(node.type) && node.type.length > 1) {
      unions++;
      if (node.type.indexOf("null") !== -1) optionalParams++;
    }

    const looksObject = node.type === "object" ||
      (Array.isArray(node.type) && node.type.indexOf("object") !== -1) || isObj(node.properties);
    if (looksObject) {
      objects++;
      if (node.additionalProperties !== false) {
        issues.push({ level: "error", path, msg: 'missing "additionalProperties": false — an open object has no closed grammar to compile' });
      }
      const props = isObj(node.properties) ? Object.keys(node.properties) : [];
      const req = Array.isArray(node.required) ? node.required : [];
      const missing = props.filter((k) => req.indexOf(k) === -1);
      if (missing.length) {
        issues.push({ level: "error", path, msg: `not listed in "required": ${missing.join(", ")} — optional fields must be a union with null` });
      }
      for (const k of req) {
        if (props.indexOf(k) === -1) {
          issues.push({ level: "warn", path, msg: `"${k}" is required but not defined in properties` });
        }
      }
      for (const k of props) walk(node.properties[k], `${path}.properties.${k}`);
    }

    if (isObj(node.items)) walk(node.items, `${path}.items`);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((s, i) => walk(s, `${path}.anyOf[${i}]`));
    if (isObj(node.additionalProperties)) walk(node.additionalProperties, `${path}.additionalProperties`);
  }

  if (!isObj(schema)) {
    return { issues: [{ level: "error", path: "$", msg: "not a JSON object" }], optionalParams: 0, unions: 0, objects: 0 };
  }
  walk(schema, "$");
  return { issues, optionalParams, unions, objects };
}


// Mechanically repair the problems that CAN be repaired without changing meaning.
// Composition (oneOf/allOf) and root-level anyOf are reported as manual, never silently rewritten.
function fixSchema(schema) {
  const changes = [], manual = [];
  const fixed = JSON.parse(JSON.stringify(schema));

  function walk(node, path) {
    if (!isObj(node)) return;

    for (const k of BANNED) {
      if (k in node) { delete node[k]; changes.push(`removed '${k}' at ${path}`); }
    }
    if (node.format && FORMATS.indexOf(node.format) === -1) {
      changes.push(`removed unsupported format '${node.format}' at ${path}`);
      delete node.format;
    }
    for (const k of SOFT) {
      if (k in node) manual.push(`'${k}' at ${path} — cannot be auto-fixed; rewrite it or make this tool non-strict`);
    }
    if ("anyOf" in node && path === "$") {
      manual.push(`'anyOf' at the root — restructure it (wrap the alternatives in an object)`);
    }

    const looksObject = node.type === "object" ||
      (Array.isArray(node.type) && node.type.indexOf("object") !== -1) || isObj(node.properties);
    if (looksObject) {
      if (node.additionalProperties !== false) {
        node.additionalProperties = false;
        changes.push(`set "additionalProperties": false at ${path}`);
      }
      const props = isObj(node.properties) ? Object.keys(node.properties) : [];

      if (Array.isArray(node.required)) {
        const orphans = node.required.filter((k) => props.indexOf(k) === -1);
        if (orphans.length) {
          node.required = node.required.filter((k) => props.indexOf(k) !== -1);
          changes.push(`removed from "required" (not defined in properties) at ${path}: ${orphans.join(", ")}`);
        }
      }
      if (props.length) {
        const req = Array.isArray(node.required) ? node.required.slice() : [];
        const added = props.filter((k) => req.indexOf(k) === -1);
        if (added.length) {
          node.required = req.concat(added);
          changes.push(`added to "required" at ${path}: ${added.join(", ")}`);
        }
      } else if ("required" in node) {
        delete node.required;
        changes.push(`removed empty "required" at ${path}`);
      }

      for (const k of props) walk(node.properties[k], `${path}.properties.${k}`);
    }

    if (isObj(node.items)) walk(node.items, `${path}.items`);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((s, i) => walk(s, `${path}.anyOf[${i}]`));
    if (isObj(node.additionalProperties)) walk(node.additionalProperties, `${path}.additionalProperties`);
  }

  walk(fixed, "$");
  return { fixed, changes, manual };
}

function extractSchema(parsed) {
  if (isObj(parsed) && isObj(parsed.input_schema)) return { schema: parsed.input_schema, label: "input_schema" };
  if (isObj(parsed) && isObj(parsed.parameters)) return { schema: parsed.parameters, label: "parameters" };
  return { schema: parsed, label: null };
}

function check(parsed) {
  const batch = Array.isArray(parsed);
  const items = batch ? parsed : [parsed];
  const results = [];
  let totalOpt = 0, totalUnions = 0, totalErr = 0;

  items.forEach((item, i) => {
    const ex = extractSchema(item);
    const r = validateStrict(ex.schema);
    const errs = r.issues.filter((x) => x.level === "error").length;
    totalOpt += r.optionalParams;
    totalUnions += r.unions;
    totalErr += errs;
    results.push({
      name: (isObj(item) && typeof item.name === "string" && item.name) || `tool ${i + 1}`,
      issues: r.issues, errors: errs, wrapped: ex.label,
    });
  });

  const capIssues = [];
  if (batch) {
    if (items.length > CAPS.tools) capIssues.push(`this request has ${items.length} strict tools — the cap is ${CAPS.tools}`);
    if (totalOpt > CAPS.optionalParams) capIssues.push(`optional parameters total ${totalOpt} — the cap is ${CAPS.optionalParams} per request`);
    if (totalUnions > CAPS.unions) capIssues.push(`union-typed parameters total ${totalUnions} — the cap is ${CAPS.unions} per request`);
  }

  return { batch, results, totalErr, totalOpt, totalUnions, capIssues, tools: items.length };
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const args = argv.filter((a) => !a.startsWith("--"));
  const target = args[0];

  if (!target) {
    console.error("usage: strict-schema-check <file.json> | -    [--json] [--quiet]");
    return 2;
  }

  let raw;
  try {
    raw = target === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(target, "utf8");
  } catch (e) {
    console.error(`strict-schema-check: cannot read ${target}: ${e.message}`);
    return 2;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.error(`strict-schema-check: not valid JSON: ${e.message}`);
    return 2;
  }

  // --fix: repair what can be repaired mechanically, print the fixed JSON to stdout and the
  // changelog to stderr, so `strict-schema-check bad.json --fix > fixed.json` just works.
  if (flags.has("--fix")) {
    const isBatch = Array.isArray(parsed);
    const items = isBatch ? parsed : [parsed];
    const out = [];
    let changes = 0, manualCount = 0;

    items.forEach((item, i) => {
      const ex = extractSchema(item);
      const r = fixSchema(ex.schema);
      changes += r.changes.length;
      manualCount += r.manual.length;

      if (ex.label) {
        const clone = JSON.parse(JSON.stringify(item));
        clone[ex.label] = r.fixed;
        out.push(clone);
      } else {
        out.push(r.fixed);
      }
      const name = isObj(item) && typeof item.name === "string" ? ` (${item.name})` : "";
      console.error(`tool ${i + 1}${name}: ${r.changes.length} change(s), ${r.manual.length} needing a decision`);
      for (const c of r.changes) console.error(`  fixed:  ${c}`);
      for (const m of r.manual) console.error(`  MANUAL: ${m}`);
    });

    const result = isBatch ? out : out[0];
    console.log(JSON.stringify(result, null, 2));

    const after = check(result);
    const stillBad = after.totalErr > 0 || after.capIssues.length > 0;
    console.error("");
    console.error(`${changes} change(s) applied` + (manualCount ? `, ${manualCount} item(s) need a human decision` : ""));
    console.error(stillBad
      ? "NOTE: the fixed schema still has blocking problems — see the MANUAL items above."
      : "The fixed schema passes the check.");
    return (manualCount || stillBad) ? 1 : 0;
  }

  const r = check(parsed);
  const failed = r.totalErr > 0 || r.capIssues.length > 0;

  if (flags.has("--json")) {
    console.log(JSON.stringify({
      ok: !failed, tools: r.tools, errors: r.totalErr,
      optionalParams: r.totalOpt, unions: r.totalUnions,
      capViolations: r.capIssues,
      results: r.results.map((x) => ({ tool: x.name, errors: x.errors, issues: x.issues })),
    }, null, 2));
    return failed ? 1 : 0;
  }

  if (flags.has("--quiet")) return failed ? 1 : 0;

  const head = r.batch ? `${r.tools} tool${r.tools === 1 ? "" : "s"} checked` : "schema checked";
  console.log(`${head} — ${r.totalErr === 0 ? "no blocking problems" : r.totalErr + " blocking problem" + (r.totalErr === 1 ? "" : "s")}`);
  if (!r.batch && r.results[0].wrapped) console.log(`  (checked the "${r.results[0].wrapped}" block of the tool definition)`);
  console.log("");

  for (const res of r.results) {
    if (r.batch) console.log(`${res.errors ? "x" : "ok"} ${res.name}${res.errors ? ` (${res.errors})` : ""}`);
    for (const i of res.issues) {
      const tag = i.level === "error" ? "ERROR" : i.level === "warn" ? "WARN " : "INFO ";
      console.log(`  ${tag} ${i.path} — ${i.msg}`);
    }
  }
  for (const c of r.capIssues) console.log(`  ERROR per-request cap — ${c}`);
  if (r.capIssues.length) console.log("");
  console.log(`  optional params: ${r.totalOpt}/${CAPS.optionalParams}   union-typed: ${r.totalUnions}/${CAPS.unions}   tools: ${r.tools}/${CAPS.tools}`);
  console.log("");

  if (failed) {
    console.log("FAIL — fix the errors above before sending this schema to the API.");
    if (!r.batch) console.log("       (paste the whole toolset as an array to check the per-request caps)");
  } else {
    console.log("PASS — no blocking problems found.");
  }
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { validateStrict, check, fixSchema, FORMATS, BANNED, CAPS };
