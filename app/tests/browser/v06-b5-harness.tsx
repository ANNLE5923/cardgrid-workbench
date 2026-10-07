// Author walkthrough: fresh context + synthetic named IDB. Formal B5 UI only.
import {createRoot} from 'react-dom/client';
import {V06CardWorkbench} from '../../src/app/index.ts';
import {installB4} from './v06-b4-harness.ts';
const cg=installB4('cardgrid-b5-synthetic-only');
const snapshot=cg.ok(await cg.host.load());
if(snapshot.mode==='uninitialized'){
  await cg.setup();
  for(const d of [{id:'actions-one',name:'行动一',memberIds:['read','meal']},{id:'actions-two',name:'行动二',memberIds:['read','train']},{id:'actions-empty',name:'空行动',memberIds:[]}])
    await cg.submit('SaveDeck',{deck:{...d,version:1,deckKind:'action',parentDeckId:null,source:{kind:'manual'}},expectedVersion:null});
}
// Fault injection affects the real store transaction's reply, never an in-memory UI host.
Object.assign(window,{cg});
createRoot(document.getElementById('root')!).render(<V06CardWorkbench host={cg.host}/>);
