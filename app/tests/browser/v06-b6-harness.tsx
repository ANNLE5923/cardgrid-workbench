// Author UI evidence, synthetic named IDB only. Today callback is an explicit B7 seam.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {V06HandDock} from '../../src/daily/index.ts';
import {installB4} from './v06-b4-harness.ts';
import '../../src/app/style.css';
const cg=installB4('cardgrid-b6-synthetic-only');
if(cg.ok(await cg.host.load()).mode==='uninitialized'){
  await cg.setup();await cg.submit('TakeActionMaterial',{action:cg.ref(cg.catalog.actionCards[0])});
  await cg.submit('TakeActionMaterial',{action:cg.ref(cg.catalog.actionCards[0])});
  await cg.answer();await cg.submit('TakeEntryMaterial',{entry:cg.ref(cg.catalog.catalogEntries[3])});
  const s=await cg.synthesis();cg.ok(await cg.host.submit(s.command));
}
Object.assign(window,{cg,handIntents:[]});
function Harness(){
  const [page,setPage]=useState('工坊'),[selected,setSelected]=useState('');
  return <div className="app paper comfortable"><main><h1>统一手牌作者走查</h1><nav aria-label="走查页面">{['工坊','决策','日记','Today'].map(p=><button key={p} onClick={()=>setPage(p)}>{p}</button>)}</nav><p>当前页面：{page}</p><p>Today 选择回调检查；新格式排期由 B7 接入，本页不保存安排。</p><p role="status">{selected}</p></main>
    <V06HandDock host={cg.host} isToday={page==='Today'} onPlay={request=>{(window as unknown as {handIntents:unknown[]}).handIntents.push(request);setSelected(`已选择本次 ID ${request.item.id}，尚未保存安排`);}}/></div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
