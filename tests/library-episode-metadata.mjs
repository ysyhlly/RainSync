// Read actual REST projections from explicit provider metadata in an owned DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";
const quote=value=>`'${String(value).replaceAll("'","''")}'`;

await isolatedServer("library-episode-metadata",async f=>{
  const client=f.client();await client.login();
  const source=randomUUID(),episode=randomUUID(),movie=randomUUID();
  const metadata={Type:"Episode",IndexNumber:3,ParentIndexNumber:2,SeriesId:"series-one",SeasonId:"season-two",SeriesName:"源平台真实系列",SeasonName:"第二季",ImageTags:{Primary:"private-provider-image-tag"},Path:"/private/provider/path"};
  f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','owned Jellyfin episode metadata','jellyfin','owned-unused-config');
    INSERT INTO media_items(id,source_id,title,resource,metadata,browse_path,browse_labels) VALUES
    ('${episode}','${source}','第三集原始名称','episode-id',${quote(JSON.stringify(metadata))},ARRAY['series-one','season-two'],ARRAY['源平台真实系列','第二季']),
    ('${movie}','${source}','S02E99不是集数来源','movie-id','{"Type":"Movie","IndexNumber":99,"SeriesId":"series-one","SeasonId":"season-two","SeriesName":"源平台真实系列","SeasonName":"第二季"}',ARRAY['series-one','season-two'],ARRAY['源平台真实系列','第二季']);`);
  const expected={episode_number:3,season_number:2,series_title:"源平台真实系列"};
  const detail=await client.request(`/media/${episode}`);
  assert.deepEqual(detail.series,expected);
  assert.ok(!JSON.stringify(detail).includes("private-provider"));
  assert.equal((await client.request(`/media/${movie}`)).series,undefined);
  const flat=await client.request("/media");
  assert.deepEqual(flat.find(item=>item.id===episode).series,expected);
  let browse=await client.request("/media/browse");
  let node=browse.entries.find(entry=>entry.name==="owned Jellyfin episode metadata").id;
  for(let depth=0;depth<3;depth++){
    browse=await client.request(`/media/browse?node=${encodeURIComponent(node)}`);
    if(depth<2){assert.equal(browse.entries[0].media_count,1);node=browse.entries[0].id;}
  }
  assert.deepEqual(browse.entries.find(entry=>entry.type==="media"&&entry.media.id===episode).media.series,expected);
  assert.equal(browse.entries.some(entry=>entry.type==="media"&&entry.media.id===movie),false,"movie metadata never inserts it into the episode hierarchy");
  assert.ok(!JSON.stringify(browse).includes("private-provider"));
  console.log("PASS: detail, flat library and paginated hierarchy expose only real Jellyfin episode/season labels; movie names/order never become synthetic episode numbers");
});
