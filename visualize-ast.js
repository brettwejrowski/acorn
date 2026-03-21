#!/usr/bin/env node
/**
 * AST Visualizer - Parses a JavaScript file into an AST and renders it as a
 * colored tree. By default it reads and visualizes itself.
 *
 * Usage:
 *   node visualize-ast.js [file]       # visualize a file (default: this script)
 *   node visualize-ast.js --help       # show help
 *   node visualize-ast.js --no-color   # disable ANSI colors
 */

"use strict"

const fs   = require("fs")
const path = require("path")

// ---------------------------------------------------------------------------
// Locate acorn (works whether or not the local dist/ has been built)
// ---------------------------------------------------------------------------
function requireAcorn() {
  // 1. Prefer the project-local built copy
  const local = path.join(__dirname, "acorn", "dist", "acorn.js")
  if (fs.existsSync(local)) return require(local)

  // 2. Walk node_modules from cwd upward
  try { return require("acorn") } catch (_) {}

  // 3. Fall back to the copy bundled with globally-installed eslint / ts-node
  const candidates = [
    "/opt/node22/lib/node_modules/eslint/node_modules/acorn",
    "/opt/node22/lib/node_modules/ts-node/node_modules/acorn",
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c)
  }
  throw new Error(
    "Cannot find acorn. Run `npm install acorn` inside this repository."
  )
}

const acorn = requireAcorn()

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2)
const noColor = args.includes("--no-color")
const help    = args.includes("--help") || args.includes("-h")
const target  = args.find(a => !a.startsWith("--")) || __filename

if (help) {
  console.log(`
Usage: node visualize-ast.js [options] [file]

Options:
  --no-color   Disable ANSI color output
  --help, -h   Show this help message

Arguments:
  file         JavaScript file to visualize (default: this script)
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------
const C = noColor
  ? { reset: "", bold: "", dim: s => s, node: s => s, type: s => s,
      key: s => s, val: s => s, str: s => s, num: s => s,
      bool: s => s, nil: s => s, branch: s => s }
  : {
      reset:  "\x1b[0m",
      bold:   "\x1b[1m",
      dim:    s => `\x1b[2m${s}\x1b[0m`,
      node:   s => `\x1b[1;36m${s}\x1b[0m`,   // bold cyan  – node types
      type:   s => `\x1b[35m${s}\x1b[0m`,      // magenta    – value types
      key:    s => `\x1b[33m${s}\x1b[0m`,      // yellow     – property keys
      val:    s => `\x1b[32m${s}\x1b[0m`,      // green      – identifiers / names
      str:    s => `\x1b[31m${s}\x1b[0m`,      // red        – string literals
      num:    s => `\x1b[94m${s}\x1b[0m`,      // bright blue – numbers
      bool:   s => `\x1b[95m${s}\x1b[0m`,      // bright magenta – booleans
      nil:    s => `\x1b[90m${s}\x1b[0m`,      // dark gray  – null/undefined
      branch: s => `\x1b[90m${s}\x1b[0m`,      // dark gray  – tree branches
    }

// ---------------------------------------------------------------------------
// Properties we show inline (not recursed into) per node type
// ---------------------------------------------------------------------------
const INLINE_PROPS = {
  Identifier:              ["name"],
  Literal:                 ["value", "raw"],
  MemberExpression:        [],
  Property:                [],
  VariableDeclarator:      [],
  FunctionDeclaration:     ["id"],
  FunctionExpression:      ["id"],
  ArrowFunctionExpression: [],
  TemplateLiteral:         [],
  ImportDeclaration:       ["source"],
  ExportNamedDeclaration:  [],
  BreakStatement:          ["label"],
  ContinueStatement:       ["label"],
  LabeledStatement:        ["label"],
  ThisExpression:          [],
  Super:                   [],
  RestElement:             [],
  SpreadElement:           [],
  UnaryExpression:         ["operator", "prefix"],
  BinaryExpression:        ["operator"],
  LogicalExpression:       ["operator"],
  AssignmentExpression:    ["operator"],
  AssignmentPattern:       [],
  UpdateExpression:        ["operator", "prefix"],
  TemplateElement:         ["value"],
}

// Properties that contain child nodes we should recurse into
const CHILD_PROPS_SKIP = new Set([
  "start", "end", "loc", "raw", "regex", "bigint", "sourceType",
])

// ---------------------------------------------------------------------------
// Format a scalar value for inline display
// ---------------------------------------------------------------------------
function fmtScalar(v) {
  if (v === null)      return C.nil("null")
  if (v === undefined) return C.nil("undefined")
  switch (typeof v) {
    case "string":  return C.str(JSON.stringify(v.length > 60 ? v.slice(0, 57) + "…" : v))
    case "number":  return C.num(String(v))
    case "boolean": return C.bool(String(v))
    default:        return C.nil(String(v))
  }
}

// ---------------------------------------------------------------------------
// Collect the child entries of an AST node that we want to recurse into
// ---------------------------------------------------------------------------
function childEntries(node) {
  const entries = []
  const inlineSet = new Set(INLINE_PROPS[node.type] || [])

  for (const [k, v] of Object.entries(node)) {
    if (k === "type" || CHILD_PROPS_SKIP.has(k) || inlineSet.has(k)) continue
    if (v === null || v === undefined) continue
    if (typeof v === "object") entries.push([k, v])
  }
  return entries
}

// ---------------------------------------------------------------------------
// Collect inline property display strings for a node
// ---------------------------------------------------------------------------
function inlineProps(node) {
  const props = INLINE_PROPS[node.type]
  if (!props || props.length === 0) return ""

  const parts = props
    .filter(k => node[k] !== undefined && node[k] !== null)
    .map(k => {
      const v = node[k]
      if (k === "name")  return C.val(v)
      if (k === "value" && typeof v === "object" && v !== null) {
        // TemplateElement value object
        return `{ ${C.key("cooked")}: ${fmtScalar(v.cooked)} }`
      }
      return `${C.key(k)}: ${fmtScalar(v)}`
    })
  return parts.length ? ` ${C.dim("(")}${parts.join(C.dim(", "))}${C.dim(")")}` : ""
}

// ---------------------------------------------------------------------------
// Recursive tree printer
// ---------------------------------------------------------------------------
const VERT  = "│  "
const TEE   = "├─ "
const LAST  = "└─ "
const BLANK = "   "

function printNode(node, prefix, isLast) {
  const connector = isLast ? LAST : TEE
  const childPfx  = prefix + (isLast ? BLANK : VERT)

  if (Array.isArray(node)) {
    // Render array elements
    node.forEach((item, i) => {
      const last = i === node.length - 1
      if (item && typeof item === "object" && item.type) {
        printNode(item, prefix, last)
      } else {
        const conn = last ? LAST : TEE
        console.log(prefix + C.branch(conn) + fmtScalar(item))
      }
    })
    return
  }

  if (!node || typeof node !== "object") {
    console.log(prefix + C.branch(connector) + fmtScalar(node))
    return
  }

  // Print this node's header
  const header = C.node(node.type) + inlineProps(node)
  const loc    = node.loc
    ? C.dim(` [${node.loc.start.line}:${node.loc.start.column}–${node.loc.end.line}:${node.loc.end.column}]`)
    : ""
  console.log(prefix + C.branch(connector) + header + loc)

  // Recurse into child properties
  const children = childEntries(node)
  children.forEach(([k, v], i) => {
    const lastProp = i === children.length - 1
    const propPfx  = childPfx + (lastProp ? BLANK : VERT)

    if (Array.isArray(v)) {
      if (v.length === 0) return
      console.log(childPfx + C.branch(lastProp ? LAST : TEE) + C.key(k) + C.dim(` [${v.length}]`))
      v.forEach((item, j) => {
        const lastItem = j === v.length - 1
        if (item && typeof item === "object" && item.type) {
          printNode(item, propPfx, lastItem)
        } else {
          const conn2 = lastItem ? LAST : TEE
          console.log(propPfx + C.branch(conn2) + fmtScalar(item))
        }
      })
    } else if (v && typeof v === "object" && v.type) {
      console.log(childPfx + C.branch(lastProp ? LAST : TEE) + C.key(k))
      printNode(v, propPfx, true)
    } else if (v && typeof v === "object") {
      // Plain object (e.g. TemplateElement.value)
      console.log(childPfx + C.branch(lastProp ? LAST : TEE) + C.key(k) + ": " + fmtScalar(JSON.stringify(v)))
    } else {
      console.log(childPfx + C.branch(lastProp ? LAST : TEE) + C.key(k) + ": " + fmtScalar(v))
    }
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const filePath = path.resolve(target)
const src      = fs.readFileSync(filePath, "utf8")

// Strip shebang so acorn doesn't choke on it
const parseSrc = src.startsWith("#!") ? src.replace(/^#!.*/, "") : src

let ast
try {
  ast = acorn.parse(parseSrc, {
    ecmaVersion: 2022,
    sourceType:  "script",
    locations:   true,
  })
} catch (err) {
  // Try again as a module if script mode fails
  ast = acorn.parse(parseSrc, {
    ecmaVersion: 2022,
    sourceType:  "module",
    locations:   true,
  })
}

const lines = src.split("\n").length
console.log()
console.log(
  `\x1b[1mAST Visualization\x1b[0m  ${C.dim("─".repeat(40))}`,
)
console.log(
  `${C.key("File")}     : ${C.val(filePath)}`,
)
console.log(
  `${C.key("Parser")}  : acorn ${C.val(acorn.version)}`,
)
console.log(
  `${C.key("Lines")}   : ${C.num(lines)}  ${C.key("Nodes")} : ${C.num(countNodes(ast))}`,
)
console.log(C.dim("─".repeat(52)))
console.log()

// Print the root without a connector prefix
console.log(C.node(ast.type))
const topChildren = childEntries(ast)
topChildren.forEach(([k, v], i) => {
  const last   = i === topChildren.length - 1
  const propPfx = last ? BLANK : VERT

  if (Array.isArray(v)) {
    if (v.length === 0) return
    console.log(C.branch(last ? LAST : TEE) + C.key(k) + C.dim(` [${v.length}]`))
    v.forEach((item, j) => {
      const lastItem = j === v.length - 1
      printNode(item, propPfx, lastItem)
    })
  } else if (v && typeof v === "object" && v.type) {
    console.log(C.branch(last ? LAST : TEE) + C.key(k))
    printNode(v, propPfx, true)
  }
})

console.log()

// ---------------------------------------------------------------------------
// Count total AST nodes
// ---------------------------------------------------------------------------
function countNodes(node) {
  if (!node || typeof node !== "object") return 0
  if (Array.isArray(node)) return node.reduce((n, c) => n + countNodes(c), 0)
  let count = node.type ? 1 : 0
  for (const v of Object.values(node)) {
    if (v && typeof v === "object" && !CHILD_PROPS_SKIP.has(v)) {
      count += countNodes(v)
    }
  }
  return count
}
