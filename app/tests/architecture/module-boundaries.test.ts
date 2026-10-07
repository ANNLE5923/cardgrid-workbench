import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../../',import.meta.url)),source=path.join(root,'src');
const walk=(directory:string):string[]=>fs.readdirSync(directory,{withFileTypes:true})
  .flatMap(e=>e.isDirectory()?walk(path.join(directory,e.name)):[path.join(directory,e.name)]);
const files=walk(source).filter(f=>/\.tsx?$/.test(f));
const relative=(file:string)=>path.relative(source,file).replaceAll('\\','/');
const owner=(file:string)=>relative(file).split('/')[0];
const publicEntries=new Set([
  'app/index.ts','workshop/index.ts','workshop/model.ts','drawing/index.ts','drawing/model.ts','drawing/selection.ts','decision/model.ts','decision/ui/index.ts',
  'daily/index.ts','daily/model.ts','daily/time.ts','daily/projection.ts',
  'journal/index.ts','journal/model.ts','maintenance/model.ts','text-output/model.ts','text-output/index.ts',
  'workspace/index.ts','workspace/codec.ts','workspace/v06.ts','workspace/contracts-v4.ts','workspace/legacy/index.ts','shared/ui/index.ts',
]);
const runtimeGraph=new Map<string,string[]>();
const violations:string[]=[];
for(const file of files){
  const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const runtime:string[]=[];
  for(const statement of ast.statements){
    if(!ts.isImportDeclaration(statement)&&!ts.isExportDeclaration(statement))continue;
    const spec=statement.moduleSpecifier;
    if(!spec||!ts.isStringLiteral(spec)||!spec.text.startsWith('.'))continue;
    const target=path.resolve(path.dirname(file),spec.text);
    if(target.endsWith('.css'))continue;
    if(!fs.existsSync(target)){violations.push(`${relative(file)}: unresolved ${spec.text}`);continue;}
    if(!target.startsWith(source+path.sep)){violations.push(`${relative(file)}: imports outside src`);continue;}
    if(owner(file)!==owner(target)&&!publicEntries.has(relative(target))){
      violations.push(`${relative(file)} bypasses public API: ${relative(target)}`);
    }
    const typeOnly=ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly || (!statement.importClause?.name
        &&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings)
        &&statement.importClause.namedBindings.elements.every(e=>e.isTypeOnly))
      : statement.isTypeOnly;
    if(!typeOnly)runtime.push(target);
  }
  runtimeGraph.set(file,runtime);
}
test('production imports use explicit module APIs and resolve inside src',()=>{
  assert.deepEqual(violations,[]);
});
test('runtime module dependencies have no circular imports',()=>{
  const active:string[]=[],visited=new Set<string>(),cycles:string[]=[];
  function visit(file:string){
    if(active.includes(file)){cycles.push([...active.slice(active.indexOf(file)),file].map(relative).join(' -> '));return;}
    if(visited.has(file))return;
    active.push(file);for(const next of runtimeGraph.get(file)??[])visit(next);active.pop();visited.add(file);
  }
  for(const file of files)visit(file);
  assert.deepEqual(cycles,[]);
});
test('shared UI has no dependency on product or workspace modules',()=>{
  const wrong=[...runtimeGraph].filter(([file])=>owner(file)==='shared')
    .flatMap(([file,targets])=>targets.filter(target=>owner(target)!=='shared').map(target=>`${relative(file)} -> ${relative(target)}`));
  assert.deepEqual(wrong,[]);
});
