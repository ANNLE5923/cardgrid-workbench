// Human-only external directory chooser/OS permission acceptance, synthetic data.
// Does not open an app or migrate the production cardgrid-workspace database.
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:4199,strictPort:true},optimizeDeps:{noDiscovery:true,entries:[],include:['react','react-dom/client','react/jsx-dev-runtime','@js-temporal/polyfill','jsbi']},plugins:[{name:'b9-native-directory',configureServer(v){v.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/__v06b9')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/browser/v06-b9-harness.tsx"></script>');}else next();});}}]});
await server.listen();console.log('B9 原生系统目录验收入口：http://127.0.0.1:4199/__v06b9?nativePicker=1');console.log('仅 cardgrid-b9-manual-synthetic-only 合成数据库；选择空临时目录。按 Ctrl+C 停止。');
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await server.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
