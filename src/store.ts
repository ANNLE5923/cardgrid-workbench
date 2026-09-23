import {emptyData,readEnvelope,migrateV1,validateData,type Data,type Envelope} from './domain.ts';
const DB='cardgrid-workspace';
export type Recovery={createdAt:string;reason:string;raw:unknown};
let connection:IDBDatabase|null=null;
export async function openDatabase():Promise<IDBDatabase>{if(connection)return connection;return new Promise((resolve,reject)=>{
 const r=indexedDB.open(DB,3);
 r.onupgradeneeded=()=>{const db=r.result,tx=r.transaction!;if(!db.objectStoreNames.contains('workspace'))db.createObjectStore('workspace');if(!db.objectStoreNames.contains('recovery'))db.createObjectStore('recovery');const s=tx.objectStore('workspace'),get=s.get('current');get.onsuccess=()=>{if(get.result){try{const next=get.result.schemaVersion===1?migrateV1(get.result):readEnvelope(get.result);tx.objectStore('recovery').put({createdAt:new Date().toISOString(),reason:'P1A升级前原文',raw:get.result},'pre-p1a');tx.objectStore('recovery').put({createdAt:new Date().toISOString(),reason:'结构升级前备份',raw:get.result},'previous');s.put(next,'current')}catch{tx.abort()}}}};
 r.onerror=()=>reject(new Error('无法打开本地数据；未覆盖原记录。'+(r.error?.message||'')));
 r.onblocked=()=>reject(new Error('其他窗口仍在使用旧数据，请关闭其他CardGrid窗口后重试。'));
 r.onsuccess=()=>{connection=r.result;connection.onversionchange=()=>{connection?.close();connection=null};resolve(connection)};
})}
async function get(store:string,key:string):Promise<unknown>{const db=await openDatabase();return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
export async function load():Promise<Envelope>{const raw=await get('workspace','current');return raw===undefined?{schemaVersion:3,revision:0,data:emptyData()}:readEnvelope(raw)}
export async function rawData(){return get('workspace','current')}
export async function recovery():Promise<Recovery|undefined>{return await get('recovery','previous') as Recovery|undefined}
export async function migrationBackup(){return get('recovery','pre-p1a')}
export async function commit(data:Data,expected:number,reason:string,reset=false):Promise<Envelope>{const nextData=validateData(data),db=await openDatabase();return new Promise((resolve,reject)=>{
 const tx=db.transaction(['workspace','recovery'],'readwrite'),store=tx.objectStore('workspace');let result:Envelope;let error:Error|undefined;
 const r=store.get('current');r.onsuccess=()=>{try{const raw=r.result;const old=raw===undefined?{schemaVersion:3 as const,revision:0,data:emptyData()}:readEnvelope(raw);if(old.revision!==expected)throw Error('另一窗口已更新数据。请重新载入后再修改，本次没有覆盖。');if(reset)tx.objectStore('recovery').clear();else tx.objectStore('recovery').put({createdAt:new Date().toISOString(),reason,raw:old},'previous');result={schemaVersion:3,revision:old.revision+1,data:nextData};store.put(result,'current')}catch(e){error=e as Error;tx.abort()}};
 tx.oncomplete=()=>{notify();resolve(result!)};tx.onabort=()=>reject(error||new Error('保存失败，原数据已保留。'+(tx.error?.message||'')));tx.onerror=()=>{};
})}
const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('cardgrid-changes');
function notify(){channel?.postMessage('changed')}
export function onExternalChange(fn:()=>void){if(!channel)return ()=>{};channel.addEventListener('message',fn);return ()=>channel.removeEventListener('message',fn)}
export async function exportRecovery():Promise<Data>{const r=await recovery();if(!r)throw Error('还没有本机恢复点');const raw=r.raw as {schemaVersion?:number};return (raw.schemaVersion===1?migrateV1(raw):readEnvelope(raw)).data}
