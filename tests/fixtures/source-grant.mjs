// Test-owned normal playback needs an actual media/source association. Missing
// association is reserved for explicit negative authorization tests.
import assert from 'node:assert/strict';
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto';
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
export function sourceMedia(f,resource){
 if(resource.kind==='agent'){
  const id=f.sql(`SELECT id FROM media_items WHERE source_id=${quote(resource.agent_id)} AND resource=${quote(resource.resource)}`);
  assert.match(id,/^[a-f\d-]{36}$/,'actual indexed Agent media required');return id;
 }
 assert.ok(['local','http','jellyfin','emby'].includes(resource.kind));
 const source=randomUUID(),media=randomUUID(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(f.env.SOURCE_ENCRYPTION_KEY,'base64'),nonce);
 const config={root:resource.root??'',url:resource.source_url??resource.upstream_base??resource.url??'',headers:resource.headers??{}};
 const encrypted=Buffer.concat([nonce,cipher.update(JSON.stringify(config)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${quote(source)},'owned delivery fixture',${quote(resource.kind)},${quote(encrypted)}); INSERT INTO media_items(id,source_id,title,resource) VALUES(${quote(media)},${quote(source)},'owned delivery fixture',${quote(resource.resource??resource.url??'owned')});`);
 return media;
}
