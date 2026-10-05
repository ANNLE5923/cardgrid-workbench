import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const walk=directory=>fs.readdirSync(directory,{withFileTypes:true})
  .flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
const directories=process.argv.includes('--independent')?['tests/review']:['tests/modules','tests/architecture'];
const files=directories
  .filter(directory=>fs.existsSync(path.join(root,directory)))
  .flatMap(directory=>walk(path.join(root,directory)))
  .filter(file=>file.endsWith('.test.ts')).sort();
if(!files.length)throw new Error('No test files discovered');
const result=spawnSync(process.execPath,['--experimental-strip-types','--test',...files],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
