// Resume a prepared managed app; does not initialize or reset its state.
import {startManagedApplication} from './application-operator.mjs';
const configFile=process.argv[2];if(!configFile)throw Error('CONFIG_REQUIRED');
const app=await startManagedApplication({configFile});
console.log(JSON.stringify({status:'app-serving',url:app.url,mode:app.mode}));
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{await app.close();process.exit(0);});
