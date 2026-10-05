import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ok} from '../../modules/workspace/v3-fixtures.ts';
import {validateActionData,parseRestore} from '../../../src/workspace/format.ts';
const payload={date:'2026-10-04',zone:'UTC',text:'independent diary'};
const evidence=async(h:any)=>{const p=ok(await h.client.prepareBackup()) as any;return {token:p.token,dataFingerprint:p.dataFingerprint,fileSavedConfirmed:true as const};};
test('R-D01 v3 reads and refused diary save never implicitly upgrade or write',async()=>{
  const h=harness();await h.setup();const before=h.evidence();
  ok(await h.client.readJournal({date:payload.date,zone:payload.zone}));
  const refused=await h.submit('SaveJournalEntry',payload);assert.equal(refused.ok,false);assert.deepEqual(h.evidence(),before);
});
test('R-D02 backed-up explicit v3 upgrade preserves every previous field',async()=>{
  const h=harness();await h.setup();await h.generate();await h.accept();
  const before=ok(await h.client.load()).data!;
  const preview=ok(await h.client.previewMigration({token:await h.token(),choices:{zone:null}}));
  ok(await h.submit('CommitMigration',{previewId:preview.previewId,backup:await evidence(h),discardDraftsConfirmed:true}));
  const after=ok(await h.client.load()).data! as any;assert.equal(after.version,4);
  const {journalEntries,version,...rest}=after;assert.deepEqual(journalEntries,[]);assert.deepEqual(rest,Object.fromEntries(Object.entries(before).filter(([key])=>key!=='version')));
});
test('R-D03 v4 full backup restores exactly with journal and history',async()=>{
  const h=harness({version:4});ok(await h.submit('SaveJournalEntry',payload));
  const before=ok(await h.client.load()).data!,p=ok(await h.client.prepareBackup());
  const parsed=parseRestore(p.text);assert.deepEqual(parsed.data,before);
  const r=ok(await h.client.previewRestore({token:await h.token(),text:p.text}));
  ok(await h.submit('RestoreWorkspace',{previewId:r.previewId,backup:await evidence(h),discardDraftsConfirmed:true}));
  assert.deepEqual(ok(await h.client.load()).data,before);
});
test('R-D04 v3 workshop adapter and v2 planner commands preserve journal',async()=>{
  const h=harness({version:4});ok(await h.submit('SaveJournalEntry',payload));
  const journal=(ok(await h.client.load()).data as any).journalEntries;
  await h.setup();ok(await h.submit('CreateCapture',{text:'independent capture',source:'review'}));
  const after=ok(await h.client.load()).data as any;assert.equal(after.version,4);assert.deepEqual(after.journalEntries,journal);
});
test('R-D05 v3 config imports preserve v4 journal',async()=>{
  const h=harness({version:4});await h.setup();ok(await h.submit('SaveJournalEntry',payload));
  const journal=(ok(await h.client.load()).data as any).journalEntries;
  const pack=ok(await h.client.exportDefinitions());assert.equal(pack.version,3);
  const preview=ok(await h.client.previewDefinitions({token:await h.token(),text:JSON.stringify(pack),mode:'merge'}));
  ok(await h.submit('ImportDefinitions',{previewId:preview.previewId,mode:'merge',backup:await evidence(h)}));
  assert.deepEqual((ok(await h.client.load()).data as any).journalEntries,journal);
});
test('R-D06 strict v4 validation rejects duplicate keys and malformed journal fields',async()=>{
  const h=harness({version:4});ok(await h.submit('SaveJournalEntry',payload));
  const before=ok(await h.client.load()).data as any;
  const duplicate=structuredClone(before);duplicate.journalEntries.push({...duplicate.journalEntries[0],id:'another'});
  assert.throws(()=>validateActionData(duplicate));
  for(const patch of [{date:'bad-date'},{zone:'bad/zone'},{text:2},{version:0},{unexpected:true}]){const bad=structuredClone(before);Object.assign(bad.journalEntries[0],patch);assert.throws(()=>validateActionData(bad));}
});
test('R-D07 future protection follows current workspace timezone',async()=>{
  const h=harness({version:4});h.setNow('2026-10-05T01:00:00Z');
  const settings={...(ok(await h.client.load()).data!.settings),zone:'America/New_York'};
  ok(await h.submit('SaveSettings',{settings}));
  const before=h.evidence();
  const result=await h.submit('SaveJournalEntry',{date:'2026-10-05',zone:'Asia/Tokyo',text:'future in workspace'});
  assert.equal(result.ok,false,'date 5 is future in workspace settings.zone; a different payload zone cannot bypass protection');
  assert.deepEqual(h.evidence(),before);
});
