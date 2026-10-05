import {sameValue} from '../daily/model.ts';
const clone=<T,>(v:T):T=>structuredClone(v);
const MISSING=Symbol('missing');
function isPlainObject(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object'&&!Array.isArray(v);}
// Three-way merge: base = editing baseline, local = this draft, remote = authoritative latest.
// Unchanged-on-this-side takes remote; only-local keeps local; both-changed-different becomes a conflict.
export function merge3(base:unknown,local:unknown,remote:unknown,path:string[]=[]):{value:unknown}|{conflicts:{path:string;base:unknown;local:unknown;remote:unknown}[]}{
 if(sameValue(local,base))return{value:remote};
 if(sameValue(remote,base))return{value:local};
 if(sameValue(local,remote))return{value:local};
 if(isPlainObject(base)||isPlainObject(local)||isPlainObject(remote)){
  const keys=[...new Set([...Object.keys(base??{}),...Object.keys(local??{}),...Object.keys(remote??{})])];
  const out:Record<string,unknown>={};const conflicts:any[]=[];
  for(const k of keys){
   const r=merge3(isPlainObject(base)?base[k]:MISSING,isPlainObject(local)?local[k]:MISSING,isPlainObject(remote)?remote[k]:MISSING,[...path,k]);
   if('conflicts'in r)conflicts.push(...r.conflicts);else out[k]=r.value;
  }
  return conflicts.length?{conflicts}:{value:out};
 }
 return{conflicts:[{path:path.join('.')||'(value)',base,local,remote}]};
}
