import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { getPackage, pickVersion, typesPackageName } from './registry.js';
import { fetchPackageFiles } from './tarball.js';

export function hasDeclarations(dir) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile() && /\.d\.[cm]?ts$/.test(e.name)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Download a published package for inspection (never executed) plus the
 * matching-major @types package when it ships no declarations.
 * @returns {Promise<null | {root:string, version:string, typesFrom:string}>}
 */
export async function fetchForInspection(name, range) {
  const pkg = await getPackage(name);
  if (!pkg || !Object.keys(pkg.versions).length) return null;
  const version = pickVersion(pkg, range);
  const meta = pkg.versions[version];
  if (!meta?.tarball) return null;
  const root = await fetchPackageFiles(name, version, meta.tarball);
  let typesFrom = `${name}@${version}`;
  if (!name.startsWith('@types/') && !hasDeclarations(join(root, 'node_modules', ...name.split('/')))) {
    const tname = typesPackageName(name);
    const tpkg = await getPackage(tname).catch(() => null);
    if (tpkg && Object.keys(tpkg.versions).length) {
      const tv = pickVersion(tpkg, `^${version.split('.')[0]}`);
      if (tv && tpkg.versions[tv]) {
        await fetchPackageFiles(tname, tv, tpkg.versions[tv].tarball, root).catch(() => {});
        typesFrom = `${tname}@${tv}`;
      }
    }
  }
  return { root, version, typesFrom };
}
