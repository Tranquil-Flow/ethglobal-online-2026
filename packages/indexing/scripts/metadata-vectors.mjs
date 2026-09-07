import {writeFileSync} from 'node:fs';
import {validate,canonicalBytes,digestOf} from '../../contracts/index.mjs';
import {assessment} from '../test/fixtures.mjs';
const variants=[
 {name:'canonical',changes:{}},
 {name:'short offset',changes:{createdAt:'2026-01-01T00:00:00+00'}},
 {name:'compact offset',changes:{createdAt:'2026-01-01T00:00:00+0000'}},
 {name:'leap second',changes:{createdAt:'2026-01-01T23:59:60Z'}},
 {name:'unicode codepoints',changes:{verifierId:'😀'.repeat(256)}},
 {name:'escaped strings',changes:{method:'quote" slash\\ tab\t line\n control\u0001'}},
 {name:'invalid date',changes:{createdAt:'2026-02-30T00:00:00Z'}},
 {name:'private extra',changes:{prompt:'synthetic-private-canary'}},
 {name:'unsupported outcome',changes:{outcome:'trusted'}},
];
const rows=variants.map(({name,changes})=>{const a={...assessment,...changes};let valid=true;try{validate('Assessment',a);}catch{valid=false;}
 return {name,raw:canonicalBytes(a).toString(),object:'0x'+digestOf(a).slice(7),receipt:'0x'+a.receiptDigest.slice(7),verifier:'0x'+digestOf(a.verifierId).slice(7),method:'0x'+digestOf(a.method).slice(7),valid};});
writeFileSync(new URL('../subgraph/tests/metadata-vectors.json',import.meta.url),JSON.stringify(rows,null,2)+'\n');
console.log('Generated '+rows.length+' synthetic metadata cases using actual shared-schema validation and digestOf.');
