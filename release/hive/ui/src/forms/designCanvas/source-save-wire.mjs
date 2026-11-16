// Host confirmation hashes the outer envelope; fractional geometry stays JSON text.
export function sourceSaveParams(source,reference,{limit=2*1024*1024}={}){
 const text=JSON.stringify(source);
 if(typeof text!=='string')throw Error('An editable source is required');
 const params={editable_source_json:text,source:reference};
 const bytes=new TextEncoder().encode(JSON.stringify({items:[],params,base_revision:null})).length;
 if(bytes>limit)throw Error('This source exceeds the Hive confirmation limit. Export a recovery snapshot and reduce embedded media before saving.');
 return params;
}
