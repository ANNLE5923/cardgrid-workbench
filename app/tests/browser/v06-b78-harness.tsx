import {createRoot} from 'react-dom/client';
import {V06App} from '../../src/app/index.ts';
import {installB4} from './v06-b4-harness.ts';
const cg=installB4('cardgrid-b78-synthetic-only');
if(cg.ok(await cg.host.load()).mode==='uninitialized'){
  const old=await cg.setup();Object.assign(cg,{syntheticOld:old});const d=await cg.data();cg.ok(await cg.host.submit({commandId:crypto.randomUUID(),type:'SaveSettings',expected:await cg.token(),payload:{settings:{...d.settings,zone:'Asia/Shanghai'}}}));
  const s=await cg.synthesis();cg.ok(await cg.host.submit(s.command));await cg.answer();
}
Object.assign(window,{cg});
createRoot(document.getElementById('root')!).render(<V06App host={cg.host} initialDate='2026-10-06'/>);
