import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareTextDocument,hashText,planTextReconciliation} from '../../../src/text-output/model.ts';
import type {LastTextSuccess,OutputKey,TextWriteIntent,TextSourceVersion} from '../../../src/workspace/v06.ts';
import {AT,TOKEN} from '../../support/v06/fixtures.ts';

const source=(revision=7,fingerprint='a'.repeat(64)):TextSourceVersion=>({kind:'journal',token:{...TOKEN,revision},inputFingerprint:fingerprint});
const key:OutputKey={bindingId:'directory',connectionVersion:1,epoch:TOKEN.epoch,kind:'journal',date:'2026-10-06',zone:'Asia/Shanghai'};
const bytes=(text:string)=>new TextEncoder().encode(text);
const steps=(result:{steps:readonly {kind:string}[]})=>result.steps.map(s=>s.kind);
async function setup(){
  const previous=await prepareTextDocument('旧输出\n',source()),latest=await prepareTextDocument('新输出\n',source(8,'b'.repeat(64)));
  const lastSuccess:LastTextSuccess={...previous,succeededAt:AT};
  return {key,currentKey:key,lastSuccess,intent:null,latest,diskBytes:bytes(previous.text)};
}
const rejected=(fn:()=>Promise<unknown>)=>assert.rejects(fn,(e:any)=>e.code==='INVALID_INPUT');

test('B3 text byte hash agrees with Node SHA-256 including multibyte characters and emoji',async()=>{
  const text='你好，世界🙂\n';assert.equal(await hashText(text),createHash('sha256').update(text,'utf8').digest('hex'));
});
test('B3 text builder is shared for journal/logs and rejects CRLF or invalid source metadata',async()=>{
  await rejected(()=>prepareTextDocument('bad\r\n',source()));
  await rejected(()=>prepareTextDocument('valid\n',source(-1)));
  await rejected(()=>prepareTextDocument('valid\n',source(1,'bad')));
});
test('B3 C25 old successful bytes with a newer pending render are normal update, not an external change',async()=>{
  const input=await setup(),result=await planTextReconciliation(input);
  assert.equal(result.kind,'update');assert.equal(result.externalChange,false);assert.deepEqual(steps(result),['write-latest']);
});
test('B3 C24 changed external bytes must be preserved before last-success restore and latest write',async()=>{
  const input=await setup(),disk=bytes('外部改动\r\n'),result=await planTextReconciliation({...input,diskBytes:disk});
  assert.equal(result.kind,'external-change');assert.deepEqual(steps(result),['preserve-external','restore-last-success','write-latest']);
  assert.equal(result.steps[0].kind,'preserve-external');if(result.steps[0].kind==='preserve-external')assert.deepEqual(result.steps[0].bytes,disk);
});
test('B3 external invalid UTF-8 is preserved as original bytes rather than decoded and re-encoded',async()=>{
  const input=await setup(),disk=new Uint8Array([0xff,0xfe,0x80]),result=await planTextReconciliation({...input,diskBytes:disk});
  assert.equal(result.steps[0].kind,'preserve-external');if(result.steps[0].kind==='preserve-external'){assert.deepEqual(result.steps[0].bytes,disk);result.steps[0].bytes[0]=0;assert.equal(disk[0],0xff);}
});
test('B3 missing file rebuilds last success before updating and never requests deleting workspace data',async()=>{
  const result=await planTextReconciliation({...await setup(),diskBytes:null});assert.equal(result.kind,'missing');assert.deepEqual(steps(result),['restore-last-success','write-latest']);
  assert.equal('workspaceRollback' in result,false);assert.equal('delete' in result,false);
});
test('B3 first connection with existing unknown bytes preserves them before initialization',async()=>{
  const result=await planTextReconciliation({...await setup(),lastSuccess:null,diskBytes:bytes('未知原文件')});
  assert.equal(result.kind,'initialize');assert.deepEqual(steps(result),['preserve-external','write-latest']);
  const empty=await planTextReconciliation({...await setup(),lastSuccess:null,diskBytes:null});assert.deepEqual(steps(empty),['write-latest']);
});
test('B3 C27 close/state gap reconciles a persisted intent and does not call it external editing or synced',async()=>{
  const input=await setup(),intent:TextWriteIntent={...input.latest,intentId:'intent-1',stage:'closed'};
  const result=await planTextReconciliation({...input,intent,diskBytes:bytes(intent.text)});
  assert.equal(result.kind,'reconcile');assert.equal(result.externalChange,false);assert.deepEqual(steps(result),['record-reconciled']);assert.equal('synced' in result,false);
});
test('B3 an older successful intent is recorded before writing the latest version',async()=>{
  const input=await setup(),written=await prepareTextDocument('中间版本\n',source(8,'b'.repeat(64))),latest=await prepareTextDocument('更新版本\n',source(9,'c'.repeat(64)));
  const result=await planTextReconciliation({...input,intent:{...written,intentId:'intent-old',stage:'prepared'},latest,diskBytes:bytes(written.text)});
  assert.deepEqual(steps(result),['record-reconciled','write-latest']);assert.equal(result.externalChange,false);
});
test('B3 same disk bytes with a new source revision require only verified metadata adoption',async()=>{
  const input=await setup(),latest=await prepareTextDocument(input.lastSuccess.text,source(8,'b'.repeat(64)));
  const result=await planTextReconciliation({...input,latest});assert.equal(result.kind,'current');assert.deepEqual(steps(result),['record-reconciled']);
});
test('B3 C26 replaced epoch or connection version yields no file steps',async()=>{
  const input=await setup();
  const epoch=await planTextReconciliation({...input,currentKey:{...key,epoch:'new-epoch'}});assert.equal(epoch.errorCode,'WORKSPACE_REPLACED');assert.deepEqual(epoch.steps,[]);
  const connection=await planTextReconciliation({...input,currentKey:{...key,connectionVersion:2}});assert.equal(connection.errorCode,'SOURCE_STALE');assert.deepEqual(connection.steps,[]);
});
test('B3 stale intent source cannot overwrite a newer source or use the same revision with another fingerprint',async()=>{
  const input=await setup(),intent:TextWriteIntent={...input.latest,source:source(9,'c'.repeat(64)),intentId:'future',stage:'verified'};
  assert.equal((await planTextReconciliation({...input,intent})).errorCode,'SOURCE_STALE');
  assert.equal((await planTextReconciliation({...input,intent:{...intent,source:source(8,'c'.repeat(64))}})).errorCode,'SOURCE_STALE');
});
test('B3 metadata corruption is refused rather than treated as an external-file change',async()=>{
  const input=await setup();await rejected(()=>planTextReconciliation({...input,lastSuccess:{...input.lastSuccess,sha256:'0'.repeat(64)}}));
});
test('B3 lastSuccess and source remain unchanged until the future writer verifies and persists success',async()=>{
  const input=await setup(),before=structuredClone(input);await planTextReconciliation({...input,diskBytes:bytes('外部修改')});assert.deepEqual(input,before);
});
test('B3 maintenance uses the same reconcile rules with its day revision and input fingerprint',async()=>{
  const previous=await prepareTextDocument('旧日志\n',{kind:'maintenance',epoch:TOKEN.epoch,dayRevision:1,inputFingerprint:'a'.repeat(64)});
  const latest=await prepareTextDocument('新日志\n',{kind:'maintenance',epoch:TOKEN.epoch,dayRevision:2,inputFingerprint:'b'.repeat(64)});
  const maintenanceKey={...key,kind:'maintenance' as const},input={key:maintenanceKey,currentKey:maintenanceKey,lastSuccess:{...previous,succeededAt:AT},intent:null,latest,diskBytes:bytes(previous.text)};
  assert.deepEqual(steps(await planTextReconciliation(input)),['write-latest']);
  const conflicting={...latest,source:{kind:'maintenance' as const,epoch:TOKEN.epoch,dayRevision:1,inputFingerprint:'c'.repeat(64)}};
  assert.equal((await planTextReconciliation({...input,latest:conflicting})).errorCode,'SOURCE_STALE');
});
