import {json,JSONValueKind,Bytes,TypedMap,JSONValue} from '@graphprotocol/graph-ts';
import {sha256} from './sha256';
export function quoted(s:string):string{
 let out='"';
 for(let i=0;i<s.length;i++){
  let n=s.charCodeAt(i),c=s.charAt(i);
  if(n==34)out+='\\"';else if(n==92)out+='\\\\';
  else if(n==8)out+='\\b';else if(n==9)out+='\\t';else if(n==10)out+='\\n';else if(n==12)out+='\\f';else if(n==13)out+='\\r';
  else if(n<32){let hex=n.toString(16);out+='\\u'+'0000'.slice(hex.length)+hex;}
  else out+=c;
 }
 return out+'"';
}
function isDigest(s:string):bool{
 if(s.length!=71||!s.startsWith('sha256:'))return false;
 for(let i=7;i<s.length;i++){let n=s.charCodeAt(i);if(!((n>=48&&n<=57)||(n>=97&&n<=102)))return false;}return true;
}
function digits(s:string):bool{if(!s.length)return false;for(let i=0;i<s.length;i++){let n=s.charCodeAt(i);if(n<48||n>57)return false;}return true;}
function dateTime(s:string):bool{
 if(s.length<20||s.charAt(4)!='-'||s.charAt(7)!='-'||(s.charAt(10)!='T'&&s.charAt(10)!='t'&&s.charAt(10)!=' ')||s.charAt(13)!=':'||s.charAt(16)!=':')return false;
 let ys=s.slice(0,4),ms=s.slice(5,7),ds=s.slice(8,10),hs=s.slice(11,13),ns=s.slice(14,16),ss=s.slice(17,19);
 if(!digits(ys)||!digits(ms)||!digits(ds)||!digits(hs)||!digits(ns)||!digits(ss))return false;
 let y=I32.parseInt(ys),m=I32.parseInt(ms),d=I32.parseInt(ds),h=I32.parseInt(hs),n=I32.parseInt(ns),sec=I32.parseInt(ss);
 let days=[31,28,31,30,31,30,31,31,30,31,30,31];if(y%4==0&&(y%100!=0||y%400==0))days[1]=29;
 if(m<1||m>12||d<1||d>days[m-1]||h>23||n>59||sec>59)return false;
 let rest=s.slice(19);if(rest.startsWith('.')){let end=1;while(end<rest.length&&digits(rest.charAt(end)))end++;if(end==1)return false;rest=rest.slice(end);}
 if(rest=='Z'||rest=='z')return true;
 if(rest.length!=6||(rest.charAt(0)!='+'&&rest.charAt(0)!='-')||rest.charAt(3)!=':'||!digits(rest.slice(1,3))||!digits(rest.slice(4,6)))return false;
 return I32.parseInt(rest.slice(1,3))<=23&&I32.parseInt(rest.slice(4,6))<=59;
}
export function validMetadata(raw:string,object:string,receipt:string,verifier:string,method:string,outcome:i32,mode:i32):bool{
 if(Bytes.fromUTF8(raw).length>8192)return false;
 let parsed=json.try_fromString(raw);if(parsed.isError||parsed.value.kind!=JSONValueKind.OBJECT)return false;
 let map=parsed.value.toObject();
 let required=['assessmentId','createdAt','method','mode','outcome','profileId','receiptDigest','verifierId','version'];
 let allowed=['assessmentId','createdAt','evidenceDigest','method','mode','outcome','profileId','reasonCode','receiptDigest','verifierId','version'];
 for(let i=0;i<required.length;i++)if(!map.isSet(required[i]))return false;
 let keys=map.entries.map<string>(entry=>entry.key);keys.sort();let parts=new Array<string>();
 for(let i=0;i<keys.length;i++){
  let key=keys[i],v=map.get(key);if(allowed.indexOf(key)<0||v===null)return false;
  if(v.kind!=JSONValueKind.STRING)return false;let s=v.toString();
  if(!s.length||s.length>256)return false;
  if((key=='profileId'||key=='receiptDigest'||key=='evidenceDigest')&&!isDigest(s))return false;
  parts.push(quoted(key)+':'+quoted(s));
 }
 let canonical='{'+parts.join(',')+'}';
 // Publisher must send canonical bytes: catches duplicate JSON keys and noncanonical payloads.
 if(raw!=canonical||sha256(canonical)!=object.slice(2))return false;
 if(map.get('version')!.toString()!='1'||!dateTime(map.get('createdAt')!.toString()))return false;
 let modes=['development','live'],outcomes=['pending','passed','mismatch','inconclusive','unavailable'];
 if(mode<0||mode>1||outcome<0||outcome>4)return false;
 return map.get('receiptDigest')!.toString()=='sha256:'+receipt.slice(2)
  &&sha256(quoted(map.get('verifierId')!.toString()))==verifier.slice(2)
  &&sha256(quoted(map.get('method')!.toString()))==method.slice(2)
  &&map.get('mode')!.toString()==modes[mode]&&map.get('outcome')!.toString()==outcomes[outcome];
}
