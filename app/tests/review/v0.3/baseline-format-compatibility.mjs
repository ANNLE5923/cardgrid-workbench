import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {emptyWorkspaceData, emptyActionData, exportWorkspace} from '../../../src/workspace/format.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url)), base='ef71af30a9c9f7bfa8cca671ea87b160c6094c82';
const original=execFileSync('git',['show',`${base}:src/workspace/format.ts`],{cwd:root,encoding:'utf8'});
// Only relocation of imports changes. All previous-version checks stay byte-for-byte.
const relocated=original.replace(/from\s*(['"])(\.[^'"]+)\1/g,(_,quote,relative)=>`from ${quote}${pathToFileURL(path.resolve(root,'src/workspace',relative)).href}${quote}`);
const out=fileURLToPath(new URL('./baseline-format-relocated.ts',import.meta.url)); await fs.writeFile(out,relocated);
const previous=await import(pathToFileURL(out));
const envelope=data=>({schemaVersion:4,epoch:'independent-version-proof',revision:1,mode:'current',dataFormat:data.version===3?'action-v3':'action-v2',data,lifecycleReceipt:null});
const old=envelope(emptyActionData()), current=envelope(emptyWorkspaceData());
assert.equal(previous.inspectEnvelope(old).kind,'current');
assert.throws(()=>previous.inspectEnvelope(current),/不支持|版本|未知|action-v2|允许|格式/);
assert.throws(()=>previous.inspectImport(exportWorkspace(current)));
const result={role:'independent read-only compatibility check',baseline:base,baselineFile:'src/workspace/format.ts',
  baselineSha256:createHash('sha256').update(original).digest('hex'),importsRelocatedOnly:true,
  checks:[{name:'previous format still accepts v2',status:'pass'},{name:'previous cached format refuses v3 envelope before writes',status:'pass'},
    {name:'previous cached format refuses v3 backup',status:'pass'}],
  limitation:'Executes the original parser relocated to current unchanged shared helpers; it does not boot the entire historical browser bundle.'};
await fs.writeFile(fileURLToPath(new URL('./baseline-compatibility.json',import.meta.url)),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
