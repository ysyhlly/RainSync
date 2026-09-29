import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,"bookworm-preview");await mkdir(root,{recursive:true});
// Read-only existing image; every execution is a new disposable owned container.
const image=process.env.RAINSYNC_PREVIEW_FFMPEG_IMAGE??"rainsync-server:avatar-pipe-fix";
function docker(args){return execFileSync("docker",args,{windowsHide:true,timeout:60000,maxBuffer:4e6});}
const name=`rainsync-preview-codec-${randomUUID()}`;
try {
 const version=docker(["run","--rm","--name",name,image,"ffmpeg","-version"]).toString();assert.match(version,/ffmpeg version 5\.1/);
 await writeFile(resolve(root,"ffmpeg-version.txt"),version);
 for(const input of ["color=red:s=640x360:d=1","testsrc2=s=640x360:d=1"]){
  const bytes=docker(["run","--rm","--name",name,image,"ffmpeg","-v","error","-f","lavfi","-i",input,"-frames:v","1","-map_metadata","-1","-c:v","libwebp","-quality","75","-threads","1","-f","image2pipe","pipe:1"]);
  assert.equal(bytes.toString("ascii",0,4),"RIFF");assert.equal(bytes.readUInt32LE(4)+8,bytes.length);assert.ok(bytes.length<262144);
  await writeFile(resolve(root,input.startsWith("color")?"red.webp":"detail.webp"),bytes);
 }
 console.log("PASS: isolated Bookworm FFmpeg 5.1 libwebp/image2pipe produces complete bounded RIFF. This checks codec compatibility, not the new Linux Worker binary.");
} finally {try{docker(["rm","-f",name])}catch{}}
