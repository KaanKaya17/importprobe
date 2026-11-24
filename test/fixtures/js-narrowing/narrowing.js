// Plain JS reads subtype properties through base types all the time; that is not an invention.
import ts from 'typescript';

const sf = ts.createSourceFile('x.ts', 'import a from "b";', ts.ScriptTarget.Latest);
export const spec = sf.statements[0].moduleSpecifier; // Statement has no moduleSpecifier, ImportDeclaration does
