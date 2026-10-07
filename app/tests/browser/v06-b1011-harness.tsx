import {createRoot} from 'react-dom/client';
import {V06App} from '../../src/app/index.ts';
import {createBrowserTextRuntime,outputPath,type DirectoryHandle} from '../../src/text-output/index.ts';
import {configurationExample} from '../../src/workspace/v5-config-example.ts';
import {decodeArchiveZip,encodeArchiveZip,archiveCapacity} from '../../src/workspace/archive-zip.ts';
import {installB4} from './v06-b4-harness.ts';
const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('b1011-output',{create:true}) as unknown as DirectoryHandle,native=createBrowserTextRuntime();
const cg=installB4('cardgrid-b1011-synthetic-only',{...native,pickDirectory:async()=>root});
let original:any=null;if(cg.ok(await cg.host.load()).mode==='uninitialized'){original=await cg.setup();cg.ok(await cg.host.submit({commandId:crypto.randomUUID(),type:'SaveSettings',expected:await cg.token(),payload:{settings:{...(await cg.data()).settings,zone:'Asia/Shanghai'}}}));await cg.submit('SaveJournalNote',{id:null,expectedVersion:null,date:'2026-10-06',zone:'Asia/Shanghai',text:'十月感想全文\r\n  保留空格'});}
cg.setNow('2026-11-01T02:00:00Z');
Object.assign(window,{cg,b1011:{configurationExample,decodeArchiveZip,encodeArchiveZip,archiveCapacity,original,
  async export(month='2026-10'){const p=cg.ok(await cg.host.archivePort.previewMonthlyArchive({token:await cg.token(),month,zone:'Asia/Shanghai'})),artifact=cg.ok(await cg.host.archivePort.exportMonthlyArchive({token:p.token,previewId:p.previewId}));return {p,artifact};},
  async verified(exportId:string){const v=cg.ok(await cg.host.archivePort.verifySavedArchive({token:await cg.token(),exportId})),clear=cg.ok(await cg.host.archivePort.previewArchiveClear({token:await cg.token(),previewId:v.previewId,verificationId:v.verificationId}));return {v,clear,command:{contractVersion:'v06-p0-1',commandId:crypto.randomUUID(),expected:clear.token,type:'CommitMonthlyArchive',payload:{previewId:v.previewId,verificationId:v.verificationId,clearPreviewId:clear.clearPreviewId,removalConfirmed:true}}};},
  async privateIndex(){return cg.host.archivePort.readArchiveIndex();},
  async removePrivate(){cg.host.invalidateCapabilities();const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('cardgrid-b1011-synthetic-only');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise<void>((resolve,reject)=>{const tx=db.transaction('monthly-archive','readwrite');tx.objectStore('monthly-archive').clear();tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();},
  async filesConnect(){const r=cg.ok(await cg.host.textFilePort.connectTextDirectory({epoch:(await cg.token()).epoch,suffix:'md'}));await cg.host.textFilePort.flush();return r;},
  async bytes(date='2026-10-06'){const c=cg.ok(await cg.host.textFilePort.readActiveTextConnection())!,states=cg.ok(await cg.host.textFilePort.readTextSyncState({bindingId:c.bindingId})),state=states.outputs.find(s=>s.key.kind==='journal'&&s.key.zone==='Asia/Shanghai'&&s.key.date===date)!;return {text:new TextDecoder().decode((await native.read(root,outputPath(state.key,c.suffix)))!),state};}
}});
createRoot(document.getElementById('root')!).render(<V06App host={cg.host} initialDate="2026-11-01"/>);
