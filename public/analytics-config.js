// Parent-only opt-in collection. No identity/content/URL inferred from the DOM.
export const HOSTED_EVENTS = Object.freeze(['landing_viewed','page_performance','rage_click']);
const routes=['/','/home/','/signin/','/account/'];
export function safeProperties(input={}) {
 const out={schema_version:2};
 if(routes.includes(input.route))out.route=input.route;
 if(['signup','signin','checkout','account','navigation'].includes(input.control))out.control=input.control;
 for(const k of ['lcp_ms','inp_ms','cls'])if(Number.isFinite(input[k])&&input[k]>=0)out[k]=input[k];
 return out;
}
export function analyticsConfig({mode='self',key='',analyticsConsent=false,surface='parent',publicReader=false,budgetVerified=false,replayApproved=false,ownKey=false,route='/',deployment='test'}={}) {
 if(typeof key!=='string'||!['self','hosted'].includes(mode)||!key.startsWith('phc_')||!analyticsConsent||publicReader||surface!=='parent'||!routes.includes(route)||(mode==='self'&&!ownKey)||(mode==='hosted'&&!budgetVerified))return null;
 return {
  api_host:'https://us.i.posthog.com',ui_host:'https://us.posthog.com',
  persistence:'memory',cross_subdomain_cookie:false,person_profiles:'never',ip:false,
  autocapture:false,rageclick:false,capture_pageview:false,capture_pageleave:false,
  capture_exceptions:false,capture_performance:false,capture_dead_clicks:false,
  disable_surveys:true,disable_surveys_automatic_display:true,enable_heatmaps:false,
  enable_recording_console_log:false,disable_session_recording:!replayApproved,
  session_recording:{maskAllInputs:true,maskTextSelector:'*',maskTextFn:()=> '***',maskInputFn:()=> '***',maskAllElementAttributes:true,
   blockSelector:'form, input, textarea, select, .ph-no-capture, .code, dl, #writers, img, svg, canvas, video, audio, iframe',
   recordHeaders:false,recordBody:false,recordCrossOriginIframes:false,
   captureCanvas:{recordCanvas:false},captureJsonLd:false,collectFonts:false,inlineStylesheet:false,
   maskCapturedNetworkRequestFn:()=>null},
  before_send(event) {
   if(!HOSTED_EVENTS.includes(event.event)&&event.event!=='$snapshot')return null;
   const source=event.properties||{};
   if(event.event==='$snapshot') {
    // Recorder metadata must not inherit referrers, initial URLs, or automatic person properties.
    const props={$geoip_disable:true,$ip:'0.0.0.0',deployment:deployment==='production'?'production':'test',source:'client',...(source.internal===true?{internal:true}:{})};
    for(const k of ['token','distinct_id','$session_id','$window_id','$lib','$lib_version','$snapshot_bytes','$snapshot_data'])if(source[k]!==undefined)props[k]=source[k];
    return {...event,properties:props,$set:undefined,$set_once:undefined,$unset:undefined};
   }
   const props={...safeProperties(source),app_mode:mode,surface:'parent',source:'client',deployment:deployment==='production'?'production':'test',$geoip_disable:true,$ip:'0.0.0.0',...(source.internal===true?{internal:true}:{})};
   for(const k of ['token','distinct_id','$session_id','$window_id','$insert_id','$lib','$lib_version'])if(typeof source[k]==='string')props[k]=source[k];
   return {...event,properties:props,$set:undefined,$set_once:undefined,$unset:undefined};
  },
 };
}
export function captureSafe(ph,event,props={}) {if(HOSTED_EVENTS.includes(event))ph?.capture(event,safeProperties(props),{send_instantly:true,...(event==='page_performance'?{transport:'sendBeacon'}:{})});}
export function withdrawAnalytics(ph) {ph?.stopSessionRecording();ph?.opt_out_capturing({clear_persistence:true});ph?.reset();}
