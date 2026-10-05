import {readFileSync} from "node:fs";
import {parse,compileScript} from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import {createPinia,setActivePinia} from "pinia";
import {afterEach,expect,it,vi} from "vitest";
import {useSession} from "../apps/web/src/features/auth/session.store";
import {platformOAuthApi,oauthPrerequisiteLabels,type OAuthLogin} from "../apps/web/src/features/account/platform-oauth.api";
import {createOAuthFlow,validateOAuthStatus} from "../apps/web/src/features/account/platform-oauth-flow";
const id="00000000-0000-0000-0000-000000000001",state="a".repeat(64);
const status={provider:"douyin",id:null,revision:null,state:"revoked",available:true,missing_prerequisites:[],authorization_kind:"official_oauth",playback_session:false,authorization_mode:"web",scopes:[],access_expires_at:null,refresh_expires_at:null,auto_renew:false,renewal_state:"disabled",next_refresh_at:null};
function login(extra:Partial<OAuthLogin>={}):OAuthLogin {return {id,provider:"douyin",status:"pending",mode:"web",stage:null,authorization_url:`https://open.douyin.com/platform/oauth/connect/?state=${state}`,qr_payload:null,expires_at:181000,next_poll_at:4000,server_time:1000,...extra};}
async function settle(){for(let i=0;i<16;i++)await Promise.resolve();}
/** Run the real SFC setup/lifecycle with Vue's in-memory renderer. No browser,
 * DOM package, listener or real account endpoint is used. */
function mountPanel(api:any){
 setActivePinia(createPinia());const session=useSession();session.accept({id,username:"fixture",admin:false,csrf:"fixture-csrf"});session.api=api;
 vi.stubGlobal("location",{origin:"https://fixture.example"});vi.stubGlobal("crypto",{randomUUID:()=>id});
 const source=readFileSync(new URL("../apps/web/src/features/account/OfficialPlatformAccountPanel.vue",import.meta.url),"utf8");
 const descriptor=parse(source).descriptor;const script=compileScript(descriptor,{id:"fixture-account-panel"}).content;
 let js=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 js=js.replace(/import[\s\S]*?from\s+["'][^"']+["'];?\s*/g,"").replace("export default","return");
 const names=["_defineComponent","computed","ref","watch","onMounted","onBeforeUnmount","QRCode","useSession","platformOAuthApi","oauthPrerequisiteLabels","createOAuthFlow","validateOAuthStatus","AppDialog","Notice"];
 const component=new Function(...names,js)(Vue.defineComponent,Vue.computed,Vue.ref,Vue.watch,Vue.onMounted,Vue.onBeforeUnmount,{toDataURL:async()=>"fixture:image"},useSession,platformOAuthApi,oauthPrerequisiteLabels,createOAuthFlow,validateOAuthStatus,{},{});
 let controls:any;const setup=component.setup;component.setup=(props:any,context:any)=>{controls=setup(props,context);return()=>null;};
 const renderer=Vue.createRenderer<any,any>({patchProp(){},insert(node,parent){node.parent=parent;},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:node=>node.parent,nextSibling:()=>null});
 const app=renderer.createApp(component,{provider:"douyin"});app.mount({});return {controls,unmount:()=>app.unmount()};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("component Cancel during start captures cancellation before hiding the dialog",async()=>{
 let resolve!:(v:OAuthLogin)=>void;const start=new Promise<OAuthLogin>(r=>{resolve=r});const api=vi.fn(async(path:string,method:string)=>path.endsWith("/oauth")?status:method==="DELETE"?login({status:"failed",authorization_url:null}):start);
 const panel=mountPanel(api);await settle();await panel.controls.show();panel.controls.consent.value=true;const beginning=panel.controls.begin();await settle();expect(panel.controls.state.value.phase).toBe("starting");await panel.controls.close();
 expect(api.mock.calls.some(([path,method])=>path.endsWith(`/login/${id}`)&&method==="DELETE")).toBe(true);expect(panel.controls.open.value).toBe(false);
 resolve(login({status:"confirmed",authorization_url:null}));await beginning;expect(panel.controls.state.value.phase).toBe("idle");panel.unmount();
});
it("component Close while pending cancels exact request and stops future polls",async()=>{
 vi.useFakeTimers();const api=vi.fn(async(path:string,method:string)=>path.endsWith("/oauth")?status:method==="DELETE"?login({status:"failed",authorization_url:null}):login());const panel=mountPanel(api);await settle();await panel.controls.show();panel.controls.consent.value=true;await panel.controls.begin();expect(panel.controls.state.value.phase).toBe("pending");await panel.controls.close();
 expect(api.mock.calls.filter(([path,method])=>path.endsWith(`/login/${id}`)&&method==="DELETE")).toHaveLength(1);const count=api.mock.calls.length;await vi.advanceTimersByTimeAsync(10000);expect(api.mock.calls).toHaveLength(count);panel.unmount();
});
