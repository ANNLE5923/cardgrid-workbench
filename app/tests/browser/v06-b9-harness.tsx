import {createRoot} from 'react-dom/client';
import {V06App} from '../../src/app/index.ts';
import {createBrowserTextRuntime,outputPath,type DirectoryHandle,type TextRuntime} from '../../src/text-output/index.ts';
import {installB4} from './v06-b4-harness.ts';
// Only the chooser is substituted. Actual native OPFS handles are persisted in
// actual IDB; file streams and exclusive Web Locks use the production runtime.
// This does not claim external OS chooser or OS permission-revocation evidence.
const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('b9-output',{create:true}) as unknown as DirectoryHandle;
const native=createBrowserTextRuntime();let permissionDenied=false,copyFailed=false,streamFailed=false,picks=0,requests=0,supported=true;
const nativePicker=new URL(location.href).searchParams.has('nativePicker');
const runtime:TextRuntime=nativePicker?native:{...native,supported:()=>supported&&native.supported(),pickDirectory:async()=>{picks++;return root;},permission:async(h,request)=>{if(request){requests++;permissionDenied=false;}return permissionDenied?'denied':native.permission(h,request);},write:async(h,p,b,guard)=>{if(copyFailed&&p.includes('conflicts'))throw Error('synthetic conflict copy failure');if(streamFailed)throw Error('synthetic output stream failure');return native.write(h,p,b,guard);}};
const cg=installB4(nativePicker?'cardgrid-b9-manual-synthetic-only':'cardgrid-b9-synthetic-only',runtime);
if(cg.ok(await cg.host.load()).mode==='uninitialized'){await cg.setup();const d=await cg.data();cg.ok(await cg.host.submit({commandId:crypto.randomUUID(),type:'SaveSettings',expected:await cg.token(),payload:{settings:{...d.settings,zone:'Asia/Shanghai'}}}));}
const files=cg.host.textFilePort;
const connection=async()=>cg.ok(await files.readActiveTextConnection())!;
const state=async()=>cg.ok(await files.readTextSyncState({bindingId:(await connection()).bindingId}));
const row=async(kind='journal',date='2026-10-06',zone='Asia/Shanghai')=>(await state()).outputs.find(o=>o.key.kind===kind&&o.key.date===date&&o.key.zone===zone)!;
Object.assign(window,{cg,b9:{files,root,native,connection,state,row,
  denied:(v:boolean)=>{permissionDenied=v;},copyFailure:(v:boolean)=>{copyFailed=v;},streamFailure:(v:boolean)=>{streamFailed=v;},unsupported:()=>{supported=false;},counts:()=>({picks,requests}),
  async bytes(kind?:string,date?:string,zone?:string){const r=await row(kind,date,zone);return [...(await native.read(root,outputPath(r.key,(await connection()).suffix)))!];},
  async external(bytes:number[]){const r=await row();await native.write(root,outputPath(r.key,(await connection()).suffix),new Uint8Array(bytes),async()=>{});},
  async conflict(){const r=await row();return [...(await native.read(root,r.externalCopyPath!.split('/')))!];},
  async note(text:string,date='2026-10-06'){return cg.submit('SaveJournalNote',{id:null,expectedVersion:null,date,zone:'Asia/Shanghai',text});},
  metadataAbort(){const put=IDBObjectStore.prototype.put;let once=false;IDBObjectStore.prototype.put=function(value:any,...args:any[]){const r=put.call(this,value,...args as [IDBValidKey?]);if(!once&&this.name==='text-output'&&value.intent?.stage==='closed'){once=true;this.transaction.abort();}return r;};return()=>{IDBObjectStore.prototype.put=put;};}
}});
createRoot(document.getElementById('root')!).render(<V06App host={cg.host} initialDate='2026-10-06'/>);
