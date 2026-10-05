// Sequential: every script owns an isolated server and fresh browser contexts.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const scripts=[
  'today-entry','v03-closure','workspace-v3','action-storage','sphere-a3','workshop-hierarchy',
  'action-3g-gate-main','action-3g-gate-supplement','action-3g-gate-additional',
  'action-3g-final-extra','action-3g-hook-faults','action-3g-readonly-edges',
  'action-2g','action-2g-closure','action-2g-save-failures','action-2g-annotation',
];
const env={...process.env,CARDGRID_PLAYWRIGHT_MODULE:process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright',
  CARDGRID_V3_OUTPUT:process.env.CARDGRID_V3_OUTPUT||path.join(root,'test-results/v03-core'),
  CARDGRID_A3_OUTPUT:process.env.CARDGRID_A3_OUTPUT||path.join(root,'test-results/v03-sphere'),
  CARDGRID_ACTION_OUTPUT:process.env.CARDGRID_ACTION_OUTPUT||path.join(root,'test-results/v03-storage'),
  CARDGRID_WS_OUTPUT:process.env.CARDGRID_WS_OUTPUT||path.join(root,'test-results/v03-hierarchy')};
const failed=[];
for(const script of scripts){
  console.log(`Browser gate: ${script}`);
  const scriptEnv={...env,CARDGRID_2G_OUTPUT:process.env.CARDGRID_2G_OUTPUT||path.join(root,'test-results',script)};
  const status=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[`tests/browser/${script}.mjs`],{cwd:root,env:scriptEnv,stdio:'inherit'});
    child.on('error',reject);child.on('exit',code=>resolve(code??1));});
  if(status!==0)failed.push(script);
}
if(failed.length){console.error('Failed browser scripts:',failed.join(', '));process.exitCode=1;}
