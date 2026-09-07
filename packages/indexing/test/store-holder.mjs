import {createPublicationStore} from '../src/store.mjs';
const timer=setInterval(()=>{},1000);
await createPublicationStore({directory:process.argv[2]}).transact(async(data,save)=>{await save();process.send({locked:true});await new Promise(()=>{});});
clearInterval(timer);
