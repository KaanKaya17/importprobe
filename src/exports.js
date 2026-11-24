import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { classify } from './specifier.js';
import { findInstalled } from './project.js';
import { fetchForInspection } from './inspect.js';
import { MINI_OPTIONS, virtualHost, exportEqualsTarget, specifierOf } from './tsutil.js';
import { suggest } from './suggest.js';

const MAX_ITEMS = 400;
const short = (s, n = 240) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * The real API of a module: what an agent should look at instead of guessing.
 * @param {{module:string, version?:string, projectDir?:string, exportName?:string}} q
 */
export async function describeModule({ module: spec, version, projectDir, exportName }) {
  const c = classify(spec);
  if (c.kind === 'builtin') return describeBuiltin(spec, c.name, exportName);
  if (c.kind !== 'package') throw new Error(`"${spec}" is not a package or Node.js built-in.`);

  let root;
  let source;
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  const installed = !version && findInstalled(c.name, dir);
  if (installed) {
    root = dir; // TypeScript resolves node_modules upward from here, like the project does
    const v = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
    source = `${c.name}@${v} (installed)`;
  } else {
    const got = await fetchForInspection(c.name, version);
    if (!got) throw new Error(`"${c.name}" does not exist on npm.`);
    root = got.root;
    source = `${c.name}@${got.version} (from npm, types: ${got.typesFrom})`;
  }

  const file = join(root, '__importprobe_describe__.ts');
  const host = virtualHost(MINI_OPTIONS, new Map([[file, `import * as __m from ${JSON.stringify(spec)};\n`]]));
  const program = ts.createProgram({ rootNames: [file], options: { ...MINI_OPTIONS, noLib: false }, host });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  const specNode = specifierOf(sf.statements[0]);
  const modSym = checker.getSymbolAtLocation(specNode);
  if (!modSym) return { module: spec, source, note: 'No type information available for this module.', values: [], types: [] };

  // Every export, with export= members folded in (CommonJS-style packages like lodash/express).
  const entries = new Map();
  for (const s of checker.getExportsOfModule(modSym)) entries.set(s.name, s);
  const target = exportEqualsTarget(checker, modSym);
  if (target) {
    for (const p of checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(target, specNode))) if (!entries.has(p.name)) entries.set(p.name, p);
    entries.set('default', target);
  }

  const resolveSym = (s) => {
    if (!(s.flags & ts.SymbolFlags.Alias)) return s;
    try { return checker.getAliasedSymbol(s); } catch { return s; }
  };

  if (exportName) {
    const s = entries.get(exportName);
    if (!s) {
      return { module: spec, source, error: `No export named "${exportName}".`, didYouMean: suggest(exportName, [...entries.keys()]) };
    }
    return { module: spec, source, export: exportName, ...describeSymbol(checker, resolveSym(s), specNode) };
  }

  const values = [];
  const types = [];
  for (const [name, s] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (name.startsWith('__')) continue;
    const r = resolveSym(s);
    if (r.flags & ts.SymbolFlags.Value) {
      const t = checker.getTypeOfSymbolAtLocation(r, specNode);
      values.push({ name, type: short(checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation)) });
    } else types.push(name);
  }
  return {
    module: spec,
    source,
    values: values.slice(0, MAX_ITEMS),
    types: types.slice(0, MAX_ITEMS),
    truncated: values.length > MAX_ITEMS || types.length > MAX_ITEMS,
  };
}

/** Members of one export: properties, call signatures, constructor + instance members. */
function describeSymbol(checker, sym, at) {
  const t = checker.getTypeOfSymbolAtLocation(sym, at);
  const members = (type) => checker.getPropertiesOfType(checker.getApparentType(type))
    .filter((p) => !p.name.startsWith('_'))
    .slice(0, MAX_ITEMS)
    .map((p) => ({ name: p.name, type: short(checker.typeToString(checker.getTypeOfSymbolAtLocation(p, at), undefined, ts.TypeFormatFlags.NoTruncation)) }));
  const out = { type: short(checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation), 400) };
  const calls = t.getCallSignatures();
  if (calls.length) {
    out.signatures = calls.slice(0, 8).map((s) => short(checker.signatureToString(s), 400));
    out.returns = members(calls[0].getReturnType()).slice(0, 150);
  }
  const ctors = t.getConstructSignatures();
  if (ctors.length) out.instanceMembers = members(ctors[0].getReturnType());
  const props = members(t);
  if (props.length && !(calls.length && props.every((p) => ['apply', 'call', 'bind', 'toString', 'length', 'arguments', 'caller', 'name', 'prototype'].includes(p.name)))) {
    out.properties = props;
  }
  return out;
}

async function describeBuiltin(spec, name, exportName) {
  if (!isBuiltin(spec)) throw new Error(`"${spec}" is not a Node.js built-in module.`);
  const mod = await import(`node:${name}`);
  if (exportName) {
    if (!(exportName in mod)) return { module: spec, source: `node ${process.version}`, error: `No export named "${exportName}".`, didYouMean: suggest(exportName, Object.keys(mod)) };
    const v = mod[exportName];
    const keys = v && (typeof v === 'object' || typeof v === 'function') ? Object.getOwnPropertyNames(v).filter((k) => !['length', 'name', 'prototype', 'caller', 'arguments'].includes(k)) : [];
    const proto = typeof v === 'function' && v.prototype ? Object.getOwnPropertyNames(v.prototype).filter((k) => k !== 'constructor') : [];
    return { module: spec, source: `node ${process.version}`, export: exportName, type: typeof v, properties: keys.map((k) => ({ name: k })), instanceMembers: proto.map((k) => ({ name: k })) };
  }
  return {
    module: spec,
    source: `node ${process.version}`,
    values: Object.keys(mod).filter((k) => k !== 'default').sort().map((k) => ({ name: k, type: typeof mod[k] })),
    types: [],
  };
}
