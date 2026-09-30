#!/usr/bin/env node
// Auditoria de secretos sobre lo que se va a commitear.
// Uso: node scripts/audit-secrets.mjs [directorio]   (default: el repo)
//
// Falla con exit 1 si encuentra algo que parezca una credencial. Pensado para
// correr en pre-commit y en CI.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, ".."));
const SKIP_DIRS = new Set([".git", "node_modules", "state", "runtime", "dist", ".venv"]);
const ALLOW_FILES = new Set([".env.example", "package-lock.json"]);

// Formatos de credencial que jamas deberian estar versionados.
const RULES = [
  { name: "openclaw/ark key", re: /\boc_sk_[A-Za-z0-9_]{16,}/g },
  { name: "ark api key", re: /\bark-[A-Za-z0-9]{20,}/g },
  { name: "aws access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws signature", re: /X-Tos-Signature=[0-9a-f]{40,}/g },
  { name: "credential query", re: /X-Tos-Credential=[^&\s"']{20,}/g },
  { name: "rfc4122 uuid en valor de secret", re: /R2_SECRET_ACCESS_KEY\s*[=:]\s*\S{20,}/g },
  { name: "bearer literal", re: /Bearer\s+[A-Za-z0-9._-]{24,}/g },
  { name: "private key", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

// Asignaciones a variables de entorno sensible con un valor no vacio.
const ENV_ASSIGN =
  /\b(SEEDANCE_API_KEY|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID|KLING_SK|KLING_AK|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*["']?([^\s"'#]{12,})/g;

const ENV_NAMES = new Set([
  "SEEDANCE_API_KEY",
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_ACCOUNT_ID",
  "KLING_SK",
  "KLING_AK",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
]);

const PLACEHOLDERS =
  /^(<|\$\{|\$\(|`|your|changeme|example|xxx|\.\.\.|placeholder|todo|null|none|securita)/i;

// Un valor que solo reenvia otra variable ("$FOO", "${FOO}") no es un secreto:
// es indireccion, y el valor real vive en el .env que no se versiona.
const INDIRECT = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile()) yield full;
  }
}

const findings = [];

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (ALLOW_FILES.has(rel)) continue;
  if (path.basename(file) === ".env") {
    findings.push({ rel, line: 0, rule: "archivo .env presente", snippet: "(archivo entero)" });
    continue;
  }
  // Solo texto plausible.
  const buf = readFileSync(file);
  if (buf.length > 2_000_000) continue;
  if (buf.includes(0)) continue;

  const text = buf.toString("utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    for (const { name, re } of RULES) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) findings.push({ rel, line: i + 1, rule: name, snippet: m[0].slice(0, 60) });
    }
    ENV_ASSIGN.lastIndex = 0;
    let m;
    while ((m = ENV_ASSIGN.exec(line))) {
      const [, name, value] = m;
      if (!ENV_NAMES.has(name)) continue;
      if (PLACEHOLDERS.test(value) || INDIRECT.test(value)) continue;
      findings.push({ rel, line: i + 1, rule: `valor asignado a ${name}`, snippet: value.slice(0, 24) });
    }
  });
}

console.log(`[audit] revisados ${ROOT}`);
if (findings.length === 0) {
  console.log("[audit] OK — ningun secreto detectado");
  process.exit(0);
}

console.error(`\n[audit] FALLO — ${findings.length} posible(s) secreto(s):\n`);
for (const f of findings) {
  console.error(`  ${f.rel}:${f.line}  [${f.rule}]  ${f.snippet}`);
}
console.error("\nRevisa .gitignore y usa .env.example como plantilla.");
process.exit(1);
