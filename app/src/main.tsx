import {createRoot} from 'react-dom/client';
import {App} from './app/index.ts';

createRoot(document.getElementById('root')!).render(<App/>);
if('serviceWorker' in navigator&&!import.meta.url.includes('/src/')){
 window.addEventListener('load',()=>{navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js').catch(()=>{})});
}
