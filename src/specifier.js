import { isBuiltin, builtinModules } from 'node:module';
import { isAbsolute } from 'node:path';

const ASSET_EXT = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|txt|md|html|wasm|glsl|graphql|gql|yaml|yml|toml)(\?.*)?$/i;

/**
 * Classify an import specifier.
 * @returns {{kind:'builtin'|'relative'|'alias'|'package'|'other', spec:string, name?:string, subpath?:string, asset?:boolean}}
 */
export function classify(spec, aliasPatterns = []) {
  const asset = ASSET_EXT.test(spec);
  if (spec.startsWith('.') || spec.startsWith('/') || isAbsolute(spec)) return { kind: 'relative', spec, asset };
  if (spec.startsWith('node:')) return { kind: 'builtin', spec, name: spec.slice(5) };
  if (isBuiltin(spec)) return { kind: 'builtin', spec, name: spec };
  if (spec.startsWith('#') || aliasPatterns.some((p) => matchesPattern(p, spec))) return { kind: 'alias', spec, asset };
  // virtual:, data:, http:, bun:, etc.
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return { kind: 'other', spec };
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts[0] === '@' || parts.length < 2 || !parts[1]) return { kind: 'alias', spec, asset }; // "@/foo" style aliases
    return { kind: 'package', spec, name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join('/'), asset };
  }
  if (spec.startsWith('~')) return { kind: 'alias', spec, asset };
  return { kind: 'package', spec, name: parts[0], subpath: parts.slice(1).join('/'), asset };
}

function matchesPattern(pattern, spec) {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === spec;
  return spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
}

/** All built-in module names, without the node: prefix. */
export function builtinNames() {
  return builtinModules.map((m) => m.replace(/^node:/, ''));
}

/** Package name from any bare specifier, or null. */
export function packageNameOf(spec) {
  const c = classify(spec);
  return c.kind === 'package' ? c.name : null;
}
