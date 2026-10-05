import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {validateMaterials} from '../deploy/recovery-set.mjs';
const materials=()=>({schema_version:1,configuration:{RAINSYNC_CONTROL_CLUSTER:'0'},source_key_version:'owned-fixture',source_key:randomBytes(32).toString('base64'),original_media_policy:'Owned synthetic fixture only',agents:[]});
test('control peer token cannot enter ordinary recovery configuration',()=>{
 assert.doesNotThrow(()=>validateMaterials(materials()));
 for(const name of ['RAINSYNC_CONTROL_PEER_TOKEN','SOURCE_ENCRYPTION_KEY','AGENT_TOKEN','PAIR_CODE']){
  const data=materials();data.configuration[name]='synthetic-recovery-secret';
  assert.throws(()=>validateMaterials(data),/ordinary recovery configuration/);
 }
});
