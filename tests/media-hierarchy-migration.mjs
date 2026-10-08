// Upgrade + query checks on a fresh, process-owned PostgreSQL cluster only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedPostgres } from './fixtures/postgres.mjs';
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, 'Set an external artifact directory');
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, 'media-hierarchy', randomUUID());
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: 'media-hierarchy' });
const report = { result: 'running', checks: [] };
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const source = randomUUID(), media = randomUUID(), user = randomUUID(), owner = randomUUID(), privateLibrary = randomUUID(), privateSource = randomUUID();
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); report.checks.push(name); }
try {
  await db.start();
  const files = (await readdir('migrations')).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files.filter(file => Number(file.split('_')[0]) <= 82)) db.sql(`BEGIN; ${await readFile('migrations/' + file, 'utf8')}; COMMIT;`);
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES('${user}','viewer','test'),('${owner}','owner','test');
    INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','shared','local','not-a-secret');
    INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','Legacy episode','Documentary/Season 1/Episode 01.mkv');`);
  const generation = db.sql(`SELECT library_source_generation FROM media_items WHERE id='${media}'`);
  db.sql(`BEGIN; ${await readFile('migrations/0085_media_hierarchy.sql', 'utf8')}; COMMIT;`);
  check('legacy source-relative directories backfill without re-scan', JSON.parse(db.sql(`SELECT to_json(browse_path) FROM media_items WHERE id='${media}'`)), ['Documentary','Season 1']);
  check('backfill does not change playback authorization generation', db.sql(`SELECT library_source_generation FROM media_items WHERE id='${media}'`), generation);
  const parts = (kind, resource, metadata = {}) => JSON.parse(db.sql(`SELECT row_to_json(p) FROM media_browse_parts(${q(kind)},${q(resource)},${q(JSON.stringify(metadata))}::jsonb) p`));
  check('Windows-style relative NAS paths normalize', parts('agent', 'Shows\\Series\\ep.mkv').path, ['Shows','Series']);
  check('S3 object hierarchy is retained', parts('s3', 'prefix/folder/film.mp4').path, ['prefix','folder']);
  for (const resource of ['/srv/private/title.mp4','C:\\private\\title.mp4','//nas/secret/film.mp4','https://host/secret/film.mp4','safe/../secret/film.mp4','safe//film.mp4','safe/./film.mp4','safe\n/film.mp4']) check(`unsafe path stays flat: ${JSON.stringify(resource)}`, parts('local',resource).path, []);
  check('HTTP URL is never treated as a directory', parts('http','https://host/secret/film.mp4?token=secret').path, []);
  check('filename alone never guesses a television season', parts('local','TV.Show.S01E01.mkv').path, []);
  check('old upstream image metadata stays flat until new metadata is scanned', parts('jellyfin','opaque-item',{ImageTags:{Primary:'x'}}).path, []);
  const episode = {Type:'Episode',SeriesId:'series-id',SeriesName:'Actual Series',SeasonId:'season-id',SeasonName:'Season Two',ParentIndexNumber:2,Path:'/host/secret/film.mp4'};
  check('explicit upstream series and season form hierarchy', parts('jellyfin','opaque-item',episode), {path:['series:series-id','season:season-id'],labels:['Actual Series','Season Two']});
  check('missing upstream season remains at series level', parts('emby','opaque-item',{Type:'Episode',SeriesId:'series-id',SeriesName:'Actual Series'}).path,['series:series-id']);
  check('metadata season zero is preserved',parts('emby','opaque-item',{Type:'Episode',SeriesId:'series-id',ParentIndexNumber:0}).path,['series:series-id','number:0']);
  check('no hostile upstream identifier becomes a node',parts('emby','opaque-item',{Type:'Episode',SeriesId:'/host/path'}).path,[]);
  db.sql(`UPDATE media_items SET resource='Other/child/renamed.mkv' WHERE id='${media}'`);
  check('resource changes update hierarchy atomically',JSON.parse(db.sql(`SELECT to_json(browse_path) FROM media_items WHERE id='${media}'`)),['Other','child']);
  db.sql(`INSERT INTO media_items(id,source_id,title,resource) SELECT gen_random_uuid(),'${source}','Film '||i,'Many/folder-'||lpad(i::text,3,'0')||'/film.mkv' FROM generate_series(1,61) i;
    INSERT INTO media_items(id,source_id,title,resource) VALUES(gen_random_uuid(),'${source}','Direct film','Many/direct.mp4');
    INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES('${privateLibrary}','Secret library','${owner}','private');
    INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES('${privateSource}','Secret source','local','not-a-secret','${privateLibrary}');
    INSERT INTO media_items(id,source_id,title,resource) VALUES(gen_random_uuid(),'${privateSource}','Hidden','Many/secret/title.mp4');`);
  const visibility = `m.available AND library_media_allowed('${user}',m.id,'browse',NULL)`;
  check('private descendant counts are excluded before aggregation',db.sql(`SELECT count(*) FROM media_items m JOIN sources s ON s.id=m.source_id WHERE ${visibility}`),'63');
  const children = `WITH visible AS MATERIALIZED (SELECT m.id,m.browse_path,m.browse_labels FROM media_items m JOIN sources s ON s.id=m.source_id WHERE ${visibility} AND s.id='${source}' AND m.browse_path[1:1]=ARRAY['Many']), children AS (SELECT 'folder'::text AS type,'0:'||browse_path[2] AS key,min(browse_labels[2]) AS name,count(*) AS media_count FROM visible WHERE cardinality(browse_path)>1 GROUP BY browse_path[2] UNION ALL SELECT 'media','1:'||id::text,NULL,1 FROM visible WHERE cardinality(browse_path)=1)`;
  const page = after => JSON.parse(db.sql(`${children} SELECT COALESCE(json_agg(r),'[]') FROM (SELECT * FROM children WHERE key COLLATE "C">${q(after)} COLLATE "C" ORDER BY key COLLATE "C" LIMIT 24) r`));
  const first = page(''), second = page(first.at(-1).key), third = page(second.at(-1).key);
  check('full catalog creates 61 folders despite 24-entry page bound',[first.length,second.length,third.length],[24,24,14]);
  check('folders and direct media share one stable nonoverlapping cursor',new Set([...first,...second,...third].map(x=>x.key)).size,62);
  check('all media are below their real directory',db.sql(`SELECT count(*) FROM media_items WHERE source_id='${source}' AND browse_path[1:0]=ARRAY[]::text[]`),'63');
  check('direct children appear after folder groups',third.at(-1).type,'media');
  report.result='passed';
} catch(error) { report.result='failed'; report.failure=String(error.stack??error); process.exitCode=1; }
finally { await db.stop(); report.cleanup=await db.verifyStopped(); await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)); console.log(`${report.result}: ${report.checks.length} hierarchy SQL checks; ${root}/report.json`); if(report.failure) console.error(report.failure); }
