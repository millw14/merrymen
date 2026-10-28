/** Shared setup presentation. All links still pass the proposal renderer's exact issuer/id checks. */
export const CONFIG_CARD_CSS = String.raw`
.mm-brand{display:flex;align-items:center;gap:9px;margin-bottom:22px;font-size:16px;font-weight:750;letter-spacing:-.04em}.mm-brand small{margin-left:auto;color:var(--mm-fg2);font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.mm-mark{position:relative;display:block;flex:none;width:28px;height:28px;border-radius:9px;background:#b9f36e;overflow:hidden}.mm-mark:before{content:"";position:absolute;left:10px;top:3px;width:10px;height:22px;border-radius:80% 0 70% 30%;background:#17351e;transform:rotate(40deg)}.mm-mark:after{content:"";position:absolute;width:2px;height:21px;left:13px;top:6px;background:#b9f36e;transform:rotate(40deg)}
.mm-setup-card{max-width:720px;margin:auto;padding:12px 10px;color:var(--mm-fg);overflow-wrap:anywhere}.mm-setup-card h1{font-size:24px;line-height:1.2;letter-spacing:-.035em;margin:0 0 8px}.setup-intro{color:var(--mm-fg2);font-size:13px;max-width:62ch;margin:0 0 16px}.setup-kicker{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--mm-fg2);margin:0 0 8px}
.setup-progress{display:flex;list-style:none;padding:0;margin:0 0 20px;gap:8px;font-size:11px;color:var(--mm-fg2)}.setup-progress li{display:flex;align-items:center;gap:6px;flex:1;min-width:0}.setup-progress li:before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--mm-border)}.setup-progress li:not(:last-child):after{content:"";flex:1;height:1px;background:var(--mm-border);margin-left:2px}.setup-progress .done:before{background:var(--mm-ok)}.setup-progress .current{color:var(--mm-fg);font-weight:650}.setup-progress .current:before{background:var(--mm-ok);outline:3px solid var(--mm-ok-bg)}
.setup-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:14px 0;margin:0 0 14px;border-block:1px solid var(--mm-border);gap:16px}.setup-facts>div{min-width:0}.setup-facts dt{font-size:11px;color:var(--mm-fg2);margin-bottom:5px}.setup-facts dd{margin:0;font-size:13px;font-weight:600}.setup-facts .ut-inline:after{display:block;font-size:9px;font-weight:400;content:"Suggested name";margin-top:2px}.setup-facts .ut-inline{border:0}
.setup-action{display:flex;gap:12px;align-items:center;margin:16px 0 8px}.mm-setup-card a.cta{display:inline-flex;align-items:center;justify-content:center;gap:14px;min-height:42px;background:#b9f36e;color:#17351e;border:1px solid #b9f36e;border-radius:10px;font-size:13px;padding:10px 16px;text-decoration:none;font-weight:700}.mm-setup-card a.cta:after{content:"↗";font-size:16px}.setup-origin{font-size:11px;color:var(--mm-fg2);margin:0}.setup-expiry{font-size:11px;color:var(--mm-fg2);margin:8px 0 18px}.setup-expiry strong{font-weight:500;color:var(--mm-fg)}
.mm-setup-card details{border-top:1px solid var(--mm-border);margin:0;padding:0}.mm-setup-card summary{padding:13px 0;font-size:12px;font-weight:600;color:var(--mm-fg);cursor:pointer}.mm-setup-card details .grid{font-size:12px;grid-template-columns:minmax(100px,1fr) 1.5fr}.mm-setup-card details>p:last-child{margin-bottom:14px}.mm-setup-card details .card{border:0;padding:0;background:transparent}.mm-setup-card details h3{font-size:10px}.setup-reference .mono{font-size:10px}.setup-return{font-size:11px;color:var(--mm-fg2);margin:14px 0 0}.setup-result{font-size:12px;border-left:2px solid var(--mm-border);padding:0 0 0 12px;margin:14px 0}.mm-setup-card :is(a,summary):focus-visible{outline:2px solid var(--mm-ok);outline-offset:4px}.mm-setup-card a.cta:hover{filter:brightness(.95)}
@media(max-width:420px){.mm-setup-card{padding:8px 4px}.mm-setup-card h1{font-size:22px}.mm-brand{margin-bottom:18px}.setup-facts{gap:10px}.setup-action{align-items:flex-start;flex-direction:column;gap:8px}.mm-setup-card a.cta{width:100%}.setup-progress{gap:6px;font-size:10px}.setup-progress li{gap:5px}.setup-progress li:not(:last-child):after{display:none}.mm-setup-card details .grid{grid-template-columns:1fr;gap:2px}.mm-setup-card details dd{margin-bottom:8px}}
`;

export const CONFIG_CARD_JS = String.raw`
function merrymenBrand(parent,label){
 var brand=put(parent,"div","mm-brand");var mark=put(brand,"span","mm-mark");mark.setAttribute("aria-hidden","true");put(brand,"span",null,"merrymen");if(label)put(brand,"small",null,label);
}
function setupDisclosure(parent,label,cls){var d=put(parent,"details",cls);put(d,"summary",null,label);return d;}
function setupProgress(parent,labels,current){
 var list=put(parent,"ol","setup-progress");list.setAttribute("aria-label","Setup progress");
 labels.forEach(function(label,i){var item=put(list,"li",i<current?"done":i===current?"current":null,label);if(i===current)item.setAttribute("aria-current","step");});
}
function renderConfigurationProposal(d){
 var s=obj(d.summary)||{},res=obj(d.result),settings=obj(s.settings)||{};
 var creating=d.kind==="agent_draft"&&(s.purpose==="create"||(res&&res.setup_only===true));
 var status=str(d.status,40)||"",pending=status==="awaiting_approval",applied=status==="applied";
 var exp=Date.parse(typeof d.expires_at==="string"?d.expires_at:"");
 var expired=isFinite(exp)&&exp<=Date.now()&&(pending||(creating&&applied));
 var card=put(root,"article","mm-setup-card");
 // The home already carries a brand; standalone tool results carry their own.
 if(VIEW!=="home")merrymenBrand(card,"Owner review");
 put(card,"p","setup-kicker",creating?"New Merryman":"Settings proposal");
 var title=expired?"This setup has expired":pending?"Ready for your review":applied?(creating?"Setup approved":"Settings applied"):pick({cancelled:"Draft cancelled",rejected:"Proposal declined",expired:"This setup has expired",failed:"Setup needs attention",approved:"Approval recorded"},status,"Check proposal status");
 put(card,"h1",null,title);
 var explanation=expired?"Ask for a fresh proposal. This setup cannot be continued.":creating&&applied?"Owner wallet creation, permission signing and activation are still required; this does not confirm a running agent.":pending?(creating?"Review this setup in Merrymen, then sign your wallet's trading permission. Nothing changes until you approve.":"Review the exact changes in Merrymen. Approval can change your running agent immediately."):str(d.status_explained,400)||pick(STATUS_TEXT,status,"Check the latest status in chat.");
 put(card,"p","setup-intro",explanation);
 if(!expired&&(pending||applied))setupProgress(card,creating?["Draft ready","Owner approval","Activation"]:["Draft ready","Owner approval","Applied"],pending?1:creating?2:3);
 var facts=put(card,"dl","setup-facts");
 function fact(label,value){var item=put(facts,"div");put(item,"dt",null,label);cellInto(put(item,"dd"),value);}
 if(settings.agentName)fact("Name",utInline(settings.agentName,false));
 if(settings.strategy)fact("Strategy",human(settings.strategy));
 if(s.risk_level)fact("Risk level",human(s.risk_level));
 if(settings.basketSymbols&&facts.childNodes.length<3)fact("Basket",draftValue("basketSymbols",settings.basketSymbols));
 var rawDiff=Array.isArray(s.diff)?s.diff:d.diff,diff=arr(rawDiff,20).map(obj).filter(Boolean);
 if(!facts.childNodes.length){facts.remove();if(diff.length)put(card,"p","small muted",String(diff.length)+" proposed setting change"+(diff.length===1?"":"s")+" · review before approving");}
 var link=null;
 if(!expired&&(pending||(creating&&applied))){
  link=approvalLink(creating&&applied?ISSUER+"/connect/setup/"+d.proposal_id:d.approval_url,d.proposal_id,creating&&applied);
  if(link){
   var action=put(card,"div","setup-action");var a=put(action,"a","cta",creating&&applied?"Continue owner setup":creating?"Review & approve setup":"Review settings change");a.href=link.href;a.target="_blank";a.rel="noopener noreferrer";
   var note=put(action,"p","setup-origin","Opens "+link.host);a.addEventListener("click",function(e){if(openViaHost(link.href,note,reference))e.preventDefault();});
  }else put(card,"p","warn-text",typeof d.approval_url==="string"?"This approval address is not this Merrymen server's approval page, so it is not linked.":"No approval link in this result. Ask in chat for the latest proposal.");
 }
 if(pending||(creating&&applied)){var expiry=put(card,"p","setup-expiry");put(expiry,"strong",null,creating?"Setup expires: ":"Approval expires: ");put(expiry,"span",null,when(d.expires_at)||"Not known");if(creating&&!expired)put(expiry,"span",null," · Finish owner signing before expiry");}
 // Risk and service messages remain visible, even while full configuration is folded.
 var kept=arr(s.left_out,12).map(obj).filter(Boolean);kept.forEach(function(x){put(card,"p","small muted",str(x.why,300));});
 if(res&&Object.keys(res).length){var result=put(card,"div","setup-result");resultBlock(result,res);}
 var details=setupDisclosure(card,creating?"Review full configuration":"Review exact changes","setup-details");
 put(details,"p","small muted",creating?"This is a draft agent setup. Owner signing sets trading permission and limits; practice uses simulated funds.":"This is a change to the agent's settings. Signed limits and live activation stay under your control.");
 if(diff.length)table(details,[{label:"Setting"},{label:"Now"},{label:"Proposed"}],diff.map(function(x){return [str(x.label,80)||str(x.key,40),str(x.current,120),str(x.proposed,120)];}),(Array.isArray(rawDiff)?rawDiff.length:0)-diff.length);
 draftSettings(details,settings);generic(details,s,KNOWN_SUMMARY);
 var by=s.requested_by!==undefined?s.requested_by:d.requested_by;if(by!==undefined)row(grid(details),"Requested by",utInline(by,false));
 if(s.after_approval)put(details,"p","small muted",str(s.after_approval,400));
 if(s.assistant_note)untrustedBox(details,"The assistant's note",s.assistant_note,280);
 var reference=setupDisclosure(details,"Review reference","setup-reference");var g=grid(reference);
 row(g,"Proposal",mono(str(d.proposal_id,80)));if(d.binding_hash)row(g,"Binding",mono(str(d.binding_hash,80)));
 if(d.created_at)row(g,"Created",when(d.created_at));if(d.decided_at)row(g,"Decided",when(d.decided_at));
 if(!pending&&!(creating&&applied))row(g,"Approval window",when(d.expires_at));
 if(link)row(g,"Owner page",mono(link.href));
 else if(typeof d.approval_url==="string"&&!expired&&pending)untrustedBox(reference,"Address as received",d.approval_url,300);
 put(reference,"p","small muted","Approval applies only to this exact request.");
 if(pending||(creating&&applied))put(card,"p","setup-return",creating?"Return to chat after the secure review to check activation. A fresh worker report confirms readiness.":"Return to chat after the secure review to check the latest status.");
}
`;

/** Interactive home. Uses only the shared MCP Apps bridge; no direct network or wallet authority. */
export const HOME_CSS = String.raw`
.mm-home{max-width:760px;margin:auto;padding:22px;overflow-wrap:anywhere}.home-hero h1{font-size:25px;line-height:1.15;letter-spacing:-.035em;margin:6px 0 10px}.home-hero p{color:var(--mm-fg2);font-size:13px}.home-kicker{text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-weight:650;color:var(--mm-fg2)}
.home-tabs{display:flex;gap:4px;overflow:auto;border-bottom:1px solid var(--mm-border);margin:18px 0 16px;padding-bottom:5px}.mm-home button{font:inherit;cursor:pointer;border:1px solid var(--mm-border);border-radius:9px;background:var(--mm-bg);color:var(--mm-fg);padding:9px 12px;font-size:12px;font-weight:600}.mm-home button:hover{border-color:var(--mm-fg2)}.mm-home :is(button,input,select,summary,a):focus-visible{outline:2px solid var(--mm-ok);outline-offset:3px}.mm-home button:disabled{opacity:.5;cursor:default}.home-tabs button{border:0;background:transparent;white-space:nowrap}.home-tabs button[aria-selected=true]{color:var(--mm-fg);background:var(--mm-bg2)}.mm-home .primary{background:#b9f36e;color:#17351e;border-color:#b9f36e;min-height:42px;padding:10px 16px}
.home-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0;border-block:1px solid var(--mm-border);padding:14px 0}.home-metric strong{display:block;margin:5px 0;font-size:13px}.home-field{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;font-size:12px;font-weight:600}.mm-home input,.mm-home select{font:inherit;font-size:13px;color:var(--mm-fg);background:var(--mm-bg);border:1px solid var(--mm-border);padding:10px 12px;border-radius:9px;min-width:0;width:100%}.home-form{margin:16px 0}.home-fields{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.home-fields>.home-field:first-child,.home-fields>.home-strategy-note{grid-column:1/-1}.home-fields>.home-strategy-note{grid-row:3;margin:0 0 12px}.home-form h2{font-size:14px;margin:0 0 14px}.home-review{margin:14px 0 0}.home-review p{font-size:12px;color:var(--mm-fg2);max-width:62ch;margin:8px 0}.home-review .primary{margin:4px 0}
.home-step{display:flex;gap:12px;align-items:flex-start;padding:10px 0}.home-step p{font-size:12px;color:var(--mm-fg2)}.home-step strong{font-size:13px}.home-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}.home-footer{font-size:11px;color:var(--mm-fg2);margin:16px 0 0;padding-top:12px;border-top:1px solid var(--mm-border)}.home-activity{border-left:2px solid var(--mm-border);padding:0 0 16px 14px;margin-left:4px}.home-activity strong{font-size:13px}.home-activity p{font-size:12px;color:var(--mm-fg2)}.home-empty{padding:18px 8px;text-align:center;color:var(--mm-fg2)}.home-status{font-size:12px;min-height:18px}.home-status:empty{display:none}.home-strategy-note{color:var(--mm-fg2);font-size:12px}.mm-home a.cta{font-size:12px}.home-panel>.mm-setup-card{padding:0;max-width:none}
.mm-home details{margin:12px 0}.mm-home summary{cursor:pointer;font-size:12px;font-weight:600;padding:10px 0}.home-disclosure{border-top:1px solid var(--mm-border)}.home-disclosure p{font-size:12px;color:var(--mm-fg2)}.home-manage a.cta,.home-step a.cta{background:transparent;color:var(--mm-fg);padding:4px 0;text-decoration:underline;text-underline-offset:3px}.home-manage .home-actions{margin:0}.home-next{padding:12px 0;border-top:1px solid var(--mm-border)}.home-next h2{font-size:12px;color:var(--mm-fg2)}.home-flash{font-size:12px;color:var(--mm-fg2)}.home-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.home-proposal-options>.home-actions{margin:0}
@media(max-width:480px){.mm-home{padding:16px}.home-hero h1{font-size:23px}.home-metrics{gap:8px}.home-metric strong{font-size:12px}.home-tabs button{padding:8px 9px}.home-review .primary{width:100%}}
`;

export const HOME_JS = String.raw`
var setup = null;
var homeTab = "Overview";
var homeBusy = false;
var homeGeneration = 0;
var homePendingCall = null;
var homeDraft = null;
var homeForms = {};
var homeData = {};
var homeProposal = null;
var homeSettingDraft = null;
var homeAlertDraft = {kind:"trade_confirmed"};
var homeConfirm = null;
var homeFlash = "";
var homeMessage = "";
var homePanel = null;
var HOME_CALLS = {get_merryman_setup:1,list_agents:1,get_portfolio:1,get_trades:1,list_decisions:1,get_agent_controls:1,get_agent_settings:1,create_merryman:1,create_agent_draft:1,propose_settings_change:1,get_proposal:1,list_proposals:1,cancel_proposal:1,list_notification_channels:1,list_subscriptions:1,subscribe:1,unsubscribe:1};
var STRATEGIES = [
 ["trencher","Trencher","Find verified memecoin pools, with Brain reviews and automatic exits."],
 ["steady-basket","Steady Basket","Buy a little of your selected stocks on a schedule."],
 ["weekend-gap","Weekend Gap","Buy selected tokenised stocks while the underlying market is closed, then sell when it reopens."],
 ["llm-strategist","AI Strategist","An AI-guided strategy that evaluates market conditions."],
 ["even-keel","Even Keel · holders","Keep the stocks in your basket evenly weighted. Runs only while you hold $MERRYMEN; opens nothing new until then."],
 ["dip-hunter","Dip Hunter · holders","Look for pullbacks in the stocks you follow. Runs only while you hold $MERRYMEN; opens nothing new until then."]
];
function canHome(name) {
 var c = setup && obj(setup.connection);
 return !!(has(HOME_CALLS,name) && c && arr(c.available_tools,30).indexOf(name)>=0);
}
function homeArgs() { return setup && obj(setup.agent) ? {agent:setup.agent.id} : {}; }
function homeButton(parent,label,fn,primary) {
 var b = put(parent,"button",primary ? "primary" : null,label); b.type="button"; b.disabled=homeBusy;
 b.addEventListener("click",fn); return b;
}
function homeToolButton(parent,label,name,args,done,primary) {
 var b=homeButton(parent,label,function(){ homeCall(name,typeof args==="function"?args():args,done); },primary);
 b.disabled=homeBusy || !initialized || !obj(hostCaps.serverTools) || !canHome(name); return b;
}
function homeErrorMessage(protocolError,result){
 var meta=obj(result&&result._meta);var body=result&&(obj(result.structuredContent)||parseText(result.content));var data=obj(protocolError&&protocolError.data);
 var error=(meta&&obj(meta["dev.merrymen/error"]))||(body&&obj(body.error))||(data&&(obj(data.error)||data));
 var raw=(error&&error.message)||(protocolError&&protocolError.message)||(result&&textOf(result.content));
 // The envelope and trace stay available to the host; the view shows only human copy.
 var message=typeof raw==="string"?raw.split(/\r?\n/)[0].split("{")[0].trim():"";
 for(var i=0;i<3;i++)message=message.replace(/^(?:MCP\s+)?(?:Error\s+)?(?:-?\d+|[a-z][a-z0-9]*_[a-z0-9_]+)\s*:\s*/i,"").replace(/^Error:\s*/i,"");
 message=clean(message.replace(/\s+(?:trace[_ ]?id|request[_ ]?id)\s*[:=].*$/i,""),400)||"This action could not be completed. Try again or ask in chat.";
 var retry=error&&num(error.retry_after_s);if(retry!==null&&retry!==undefined&&retry>=0&&!/\bretry (?:after|in)\b/i.test(message))message+=" Retry after "+Math.ceil(retry)+" seconds.";
 return message;
}
function homeCall(name,args,done) {
 if(homeBusy || !initialized || !obj(hostCaps.serverTools) || !canHome(name)) return;
 homeDiscardPendingCall();
 homeBusy=true; homeMessage="Working…"; var generation=homeGeneration;
 var call={id:null,timer:null};homePendingCall=call;
 var buttons=Array.from(root.querySelectorAll("button")).map(function(b){var was=b.disabled;b.disabled=true;return {button:b,disabled:was};});
 var status=root.querySelector(".home-status"); if(status) status.textContent=homeMessage;
 call.id=request("tools/call",{name:name,arguments:args},function(err,r){
  clearTimeout(call.timer); if(homePendingCall!==call || generation!==homeGeneration)return; homePendingCall=null;homeBusy=false;
  var d=r && (obj(r.structuredContent)||parseText(r.content));
  if(err || !r || r.isError || !d){
   homeMessage=homeErrorMessage(err,r);
   homeDraw(); return;
  }
  homeMessage="";if(status)status.textContent="";buttons.forEach(function(b){b.button.disabled=b.disabled;});done(d);queueSize();
 });
 call.timer=setTimeout(function(){
  if(homePendingCall!==call || generation!==homeGeneration)return; homeBusy=false;
  // A host can wait for the user's approval longer than 30 seconds. Keep its
  // response active until a retry or refreshed context supersedes this call.
  homeMessage="Still waiting for your app. Finish any approval in chat; the result will appear here when it arrives. You can also retry with the same details.";
  homeDraw(); queueSize();
 },30000);
}
function homeDiscardPendingCall(){
 if(!homePendingCall)return;clearTimeout(homePendingCall.timer);delete pending[String(homePendingCall.id)];homePendingCall=null;
}
function ownerLink(parent,label,raw) {
 if(!ISSUER || typeof raw!=="string")return;
 var u;try{u=new URL(raw);}catch(e){return;}
 if(u.origin!==ISSUER || u.username || u.password || u.hash || u.search || ["/create","/grant","/settings","/deposit","/agent","/connect/apps"].indexOf(u.pathname)<0)return;
 var a=put(parent,"a","cta",label);a.href=u.href;a.target="_blank";a.rel="noopener noreferrer";
 a.addEventListener("click",function(e){if(openViaHost(u.href,a))e.preventDefault();});
}
function inHomePanel(fn){ var old=root;root=homePanel;try{fn();}finally{root=old;} }
function homeContext(d){return JSON.stringify([obj(d.connection)&&d.connection.id,d.agent&&d.agent.id,d.agent&&d.agent.account,arr(obj(d.connection)&&d.connection.available_tools,40).slice().sort()]);}
function homeAcceptSetup(d){
 if(!setup||homeContext(setup)!==homeContext(d)){homeDraft=null;homeForms={};homeSettingDraft=null;homeAlertDraft={kind:"trade_confirmed"};homeProposal=null;homeFlash="";homeTab="Overview";}
 homeData={};homeConfirm=null;setup=d;
}
function homeRefresh(){homeCall("get_merryman_setup",homeArgs(),function(d){homeAcceptSetup(d);homeDraw();if(homeTab!=="Overview")homeLoadTab();});}
function onHostReady(){if(setup)homeDraw();}
function render(d){
 if(!obj(d.connection) || !Array.isArray(d.next_steps) || !obj(d.runtime))return false;
 homeDiscardPendingCall();homeAcceptSetup(d);homeGeneration++;homeBusy=false;homeMessage="";homeDraw();return true;
}
function homeDraw(){
 clear(root);root.className="mm-home";
 merrymenBrand(root,"Hosted");
 var hasAccount=!!(setup.agent&&setup.agent.account);
 if(!(homeTab==="Approvals"&&homeProposal)){
  var hero=put(root,"header","home-hero");put(hero,"div","home-kicker",hasAccount?"YOUR MERRYMAN":"MAKE IT YOURS");
  put(hero,"h1",null,hasAccount?clean(setup.agent.name,40)||"Your Merryman":"Meet your next Merryman.");
  if(hasAccount)hero.appendChild(chip(human(setup.phase),setup.phase==="live"?"live":setup.phase==="paper"?"paper":"info"));
  put(hero,"p",null,setup.phase==="no_shared_agent"&&canHome("create_merryman")?"Choose a direction. Review your setup and sign securely in Merrymen.":clean(setup.summary,600));
  if(!obj(hostCaps.serverTools))put(hero,"p","small","Your host can display this home. Ask in chat to use its tools, or continue through the owner links.");
 }
 var nav=put(root,"nav","home-tabs");nav.setAttribute("aria-label","Merryman sections");nav.setAttribute("role","tablist");
 var tabs=["Overview"];
 if(hasAccount&&canHome("get_portfolio"))tabs.push("Portfolio");
 if(hasAccount&&(canHome("get_trades")||canHome("list_decisions")))tabs.push("Activity");
 if(hasAccount)tabs.push("Settings");
 if(canHome("list_proposals")||homeProposal)tabs.push("Approvals");
 if(hasAccount&&canHome("list_subscriptions"))tabs.push("Alerts");
 if(tabs.indexOf(homeTab)<0)homeTab="Overview";
 tabs.forEach(function(label){var b=homeButton(nav,label,function(){homeTab=label;homeMessage="";homeConfirm=null;homeDraw();homeLoadTab();});b.setAttribute("role","tab");b.setAttribute("aria-selected",String(label===homeTab));});
 var status=put(root,"p","home-status",homeMessage);status.setAttribute("role","status");
 if(homeFlash){var flash=put(root,"p",homeProposal&&homeProposal.status==="awaiting_approval"?"home-flash home-announcement":"home-flash",homeFlash);flash.setAttribute("role","status");}
 homePanel=put(root,"div","home-panel");homePanel.setAttribute("role","tabpanel");homePanel.setAttribute("aria-label",homeTab);
 if(homeTab==="Overview")homeOverview();
 else if(homeTab==="Settings")homeSettings();
 else if(homeTab==="Alerts"){homeAlerts();if(homeData.subscriptions)homeSubscriptions(homeData.subscriptions);}
 else if(homeTab==="Approvals")homeApprovals();
 else if(homeTab==="Portfolio"&&homeData.portfolio)inHomePanel(function(){renderPortfolioResult(homeData.portfolio);});
 else if(homeTab==="Activity"&&homeData.activity)homeActivity(homeData.activity.data,homeData.activity.tool);
 else put(homePanel,"p","home-empty","Use Refresh to load the latest "+homeTab.toLowerCase()+".");
 if(!(homeTab==="Approvals"&&homeProposal)){
  var actions=put(root,"div","home-actions");
  homeButton(actions,"Refresh",function(){if(homeTab==="Overview")homeRefresh();else homeLoadTab();}).disabled=homeBusy||!initialized||!obj(hostCaps.serverTools);
 }
 var manage=setupDisclosure(root,"Wallet & connected apps","home-disclosure home-manage"),links=obj(setup.links)||{};
 var linksRow=put(manage,"div","home-actions");ownerLink(linksRow,"Wallet & permissions ↗",links.wallet);ownerLink(linksRow,"Connected apps ↗",links.connected_apps);
 put(manage,"p","small",clean(setup.runtime.explanation,650));queueSize();
}
function homeOverview(){
 var a=obj(setup.agent),links=obj(setup.links)||{},creating=canHome("create_merryman");
 if(a&&a.account){
  var metrics=put(homePanel,"div","home-metrics");
  [["LAST REPORTED MODE",a.mode==="live"?"Live · real funds":a.mode==="paper"?"Paper · simulated":human(a.mode)||"Not reporting"],["WORKER",a.worker_fresh===true?"Fresh report":a.worker_fresh===false?"Awaiting fresh report":"Not known"],["STRATEGY",human(a.strategy)||"Not selected"]].forEach(function(v){var m=put(metrics,"div","home-metric");put(m,"span","home-kicker",v[0]);put(m,"strong",null,v[1]);});
  var wallet=setupDisclosure(homePanel,"Wallet & permission details","home-disclosure");var g=grid(wallet);row(g,"Smart account",shortAddr(a.account));row(g,"Permission expires",when(a.permission_expires_at));row(g,"Worker reported",when(a.heartbeat_at));
 }
 if(creating){setupProgress(homePanel,["Prepare setup","Owner approval","Activation"],0);homeConfig(homePanel,true);}
 var steps=arr(setup.next_steps,12).filter(function(s){return obj(s)&&s.action!=="propose_settings"&&(!creating||s.action!=="draft_setup");});
 function step(parent,x){var r=put(parent,"div","home-step"),text=put(r,"div");put(text,"strong",null,clean(x.label,100));put(text,"p",null,clean(x.detail,500));if(x.url)ownerLink(text,x.owner_action_required?"Continue in Merrymen ↗":"Open Merrymen ↗",x.url);}
 if(steps.length){
  if(creating){var options=setupDisclosure(homePanel,"Already have a Merryman?","home-disclosure home-manage");if(setup.phase==="no_shared_agent")put(options,"p",null,clean(setup.summary,600));steps.forEach(function(x){step(options,x);});}
  else {var next=put(homePanel,"section","home-next");put(next,"h2",null,"Next step");step(next,steps[0]);if(steps.length>1){var more=setupDisclosure(homePanel,"More options","home-disclosure");steps.slice(1).forEach(function(x){step(more,x);});}}
 }
 if(setup.phase==="select_agent"&&canHome("list_agents"))homeToolButton(homePanel,"Choose a shared Merryman","list_agents",{},homeAgentList,true);
 if(!a&&!creating)ownerLink(homePanel,"Connect or share a Merryman ↗",links.connected_apps);
}
function homeAgentList(d){
 clear(homePanel);put(homePanel,"h2",null,"Choose your Merryman");
 arr(d.agents,30).forEach(function(a){if(!obj(a))return;homeToolButton(homePanel,clean(a.name,40)||clean(a.agent,40)||"Merryman","get_merryman_setup",{agent:a.agent},function(s){homeAcceptSetup(s);homeDraw();});});
}
function homeField(parent,label,tag,choices){
 var wrap=put(parent,"label","home-field",label);var input=put(wrap,tag||"input");input.setAttribute("aria-label",label);
 if(choices)choices.forEach(function(v){var o=put(input,"option",null,v[1]);o.value=v[0];});return input;
}
function homeRemember(input,state,key){input.addEventListener("input",function(){state[key]=input.value;});input.addEventListener("change",function(){state[key]=input.value;});}
function homeSubmit(parent,label,tool){var b=put(parent,"button","primary",label);b.type="submit";b.disabled=homeBusy||!initialized||!obj(hostCaps.serverTools)||!canHome(tool);return b;}
function homeSetProposal(d){homeProposal=d;if(homeDraft&&homeDraft.proposal_id===d.proposal_id&&(d.terminal===true||["cancelled","expired","applied","rejected","failed","refused","confirmed","paper_filled"].indexOf(d.status)>=0))homeDraft=null;}
function homePropose(tool,payload,context){
 if(homeBusy)return;
 var fingerprint=context+":"+JSON.stringify(payload);
 if(!homeDraft||homeDraft.fingerprint!==fingerprint)homeDraft={context:context,fingerprint:fingerprint,idempotency_key:"home_"+crypto.randomUUID()};
 homeCall(tool,Object.assign({},payload,{idempotency_key:homeDraft.idempotency_key}),function(d){homeDraft.proposal_id=d.proposal_id;delete homeForms[context];homeSettingDraft=null;homeSetProposal(d);homeTab="Approvals";homeFlash=d.status==="awaiting_approval"?"Draft prepared. Review the exact change before approving it.":"This request already has an outcome. Check its status below; you can prepare a new draft from Settings.";homeDraw();});
}
function homeConfig(parent,creating){
 var context=(creating?"create_merryman":"create_agent_draft")+":"+(setup.agent?setup.agent.id:"new");
 var saved=homeData.settings;var fieldsByKey={};arr(saved&&saved.settings,40).forEach(function(s){if(obj(s))fieldsByKey[s.key]=s;});
 var asset=fieldsByKey.assetMode;var basketSpec=fieldsByKey.basketSymbols;
 var defaults={name:creating?"My Merryman":saved.configured_name||"",strategy:creating?"trencher":saved.strategy||"",risk_level:creating?"careful":"",asset_mode:asset&&asset.valid_for_proposal===true?asset.value:"",basket:basketSpec&&basketSpec.valid_for_proposal===true?arr(basketSpec.value,10).join(", "):""};
 var state=homeForms[context]||(homeForms[context]={});var shown=Object.assign({},defaults,state);
 var form=put(parent,"form","home-form");if(!creating)put(form,"h2",null,"Name, strategy & basket");
 var fields=put(form,"div","home-fields");
 var name=homeField(fields,"Name");name.name="name";name.maxLength=24;name.required=creating;name.value=shown.name;name.autocomplete="off";
 var strategy=homeField(fields,"Strategy","select",(creating?[]:[["","Keep current strategy"]]).concat(STRATEGIES));strategy.name="strategy";strategy.value=shown.strategy;
 var note=put(fields,"p","home-strategy-note");function strategyNote(){var s=STRATEGIES.find(function(v){return v[0]===strategy.value;});note.textContent=s?s[2]:"";}strategyNote();strategy.addEventListener("change",strategyNote);
 var risk=homeField(fields,"Risk settings","select",(creating?[]:[["","Keep current risk settings"]]).concat([["careful","Careful"],["balanced","Balanced"],["bold","Bold"]]));risk.name="risk_level";risk.value=shown.risk_level;
 var advanced=setupDisclosure(form,"Assets & basket · optional","home-disclosure");advanced.open=!!(state.asset_mode||state.basket);
 var mode=homeField(advanced,"Assets to consider","select",[["",creating?"Choose later":"Keep current assets"],["all","Stocks and crypto"],["stocks","Stocks only"],["crypto","Crypto only"]]);mode.value=shown.asset_mode;
 var basket=homeField(advanced,"Basket symbols");basket.value=shown.basket;basket.placeholder="e.g. NVDA, AAPL";basket.maxLength=170;
 put(advanced,"p","small muted",creating?"Optional basket: up to 10 supported stock symbols. Your owner review shows the exact configuration.":"Comma-separated symbols. Leave blank to keep the current basket. Available: "+arr(saved.available_basket_symbols,50).join(", "));
 var configFields=[[name,"name"],[strategy,"strategy"],[risk,"risk_level"],[mode,"asset_mode"],[basket,"basket"]];
 function rememberConfig(v){if(v[0].value===defaults[v[1]])delete state[v[1]];else state[v[1]]=v[0].value;}
 configFields.forEach(function(v){v[0].addEventListener("input",function(){rememberConfig(v);});v[0].addEventListener("change",function(){rememberConfig(v);});});
 var why=put(form,"div","home-review");
 put(why,"p",null,creating?"Only you can approve the setup and sign the wallet's trading permission.":"Review the exact before-and-after settings in Merrymen. Approval can change your running agent immediately.");
 homeSubmit(why,creating?"Prepare my Merryman →":"Review settings change →",creating?"create_merryman":"create_agent_draft");
 put(why,"p","small muted","Practice uses simulated funds. Live mode, funding and signed trading limits stay under your control.");
 if(!creating)put(why,"p","small muted","These are your saved settings. The worker's last reported strategy can differ until it picks up a change.");
 form.addEventListener("submit",function(e){e.preventDefault();configFields.forEach(rememberConfig);
  basket.setCustomValidity("");var symbols=basket.value.trim()?basket.value.split(",").map(function(v){return v.trim();}):[];
  if(symbols.length>10||symbols.some(function(v){return !/^[A-Za-z0-9][A-Za-z0-9._$-]{0,15}$/.test(v);}))basket.setCustomValidity("Enter up to 10 symbols separated by commas.");
  if(!form.reportValidity())return;var payload={};
  if(name.value.trim()&&(creating||name.value.trim()!==defaults.name))payload.name=name.value.trim();
  if(strategy.value&&(creating||strategy.value!==defaults.strategy))payload.strategy=strategy.value;
  if(risk.value)payload.risk_level=risk.value;
  if(mode.value&&(creating||mode.value!==defaults.asset_mode))payload.asset_mode=mode.value;
  if(symbols.length&&(creating||JSON.stringify(symbols)!==JSON.stringify(arr(basketSpec&&basketSpec.value,10))))payload.basket=symbols;
  if(!Object.keys(payload).length){homeMessage="Change a field before preparing a proposal.";homeDraw();return;}
  homePropose(creating?"create_merryman":"create_agent_draft",payload,context);
 });
}
function homeSettings(){
 if(homeData.settings){
  if(canHome("create_agent_draft"))homeConfig(homePanel,false);
  homeSettingEditor(homeData.settings);
 }else{var pendingSettings=section(homePanel,"Saved configuration");put(pendingSettings,"p","small",canHome("get_agent_settings")?"Load saved settings before editing. Worker reports may still show an earlier configuration.":"This connection cannot read saved settings. Update connected-app access or use the owner settings page.");put(pendingSettings,"p","small muted","Approval can change your running agent immediately.");if(canHome("get_agent_settings"))homeToolButton(pendingSettings,"Load saved settings","get_agent_settings",homeArgs(),function(d){homeData.settings=d;homeDraw();});}
 var s=section(homePanel,"Running controls");
 arr(setup.controls,12).forEach(function(c){if(!obj(c))return;var r=put(s,"details","home-disclosure");put(r,"summary",null,human(c.control));put(r,"p",null,clean(c.effect,500));put(r,"p","small muted",clean(c.where,200));});
 var links=obj(setup.links)||{};ownerLink(s,"Open settings ↗",links.settings);ownerLink(s,"Review funding ↗",links.funding);
 if(canHome("get_agent_controls"))homeToolButton(s,"View signed limits & risk","get_agent_controls",homeArgs(),function(d){homeData.controls=d;homeDraw();});
 if(homeData.controls)homeControls(homeData.controls);
}
function homeSettingEditor(d){
 var s=section(homePanel,"Trading preferences");put(s,"p","small muted",clean(d.note,1000));
 var settings=arr(d.settings,40).filter(function(v){return obj(v)&&typeof v.key==="string";});
 function allSaved(){var details=put(s,"details");put(details,"summary",null,"All saved preferences");var g=grid(details);settings.forEach(function(v){row(g,clean(v.label,100),clean(v.display_value,300));});}
 if(!canHome("propose_settings_change")||!settings.length){allSaved();return;}
 var state=homeSettingDraft||(homeSettingDraft={key:settings[0].key,value:null});
 var form=put(s,"form","home-form");var select=homeField(form,"Preference to change","select",settings.map(function(v){return [v.key,clean(v.label,100)];}));select.value=state.key;
 var spec=settings.find(function(v){return v.key===select.value;})||settings[0];state.key=spec.key;
 select.addEventListener("change",function(){homeSettingDraft={key:select.value,value:null};homeDraw();});
 put(form,"p","small",clean(spec.help,500));put(form,"p","small muted","Currently: "+clean(spec.display_value,300));
 var factor=spec.kind==="pct"?100:spec.kind==="hoursAsSec"?3600:1;
 var label="New value ("+(spec.kind==="pct"?"%":spec.kind==="hoursAsSec"?"hours":human(spec.unit))+")";var choices=spec.kind==="bool"?[["","Choose a value"],["true","On"],["false","Off"]]:Array.isArray(spec.options)?[["","Choose a value"]].concat(spec.options.map(function(v){return [v,human(v)];})):null;
 var input=homeField(form,label,choices?"select":"input",choices);input.required=true;
 var current=spec.value_state==="stored"&&spec.valid_for_proposal===true?spec.value:null;
 input.value=state.value!==null?state.value:current===null?"":Array.isArray(current)?current.join(", "):typeof current==="number"?String(current/factor):String(current);
 if(!choices&&spec.kind!=="symbols"){input.type="number";input.step=spec.kind==="hoursAsSec"?"any":spec.kind==="usd"||spec.kind==="pct"?"0.01":"1";if(typeof spec.min==="number")input.min=String(spec.min/factor);if(typeof spec.max==="number")input.max=String(spec.max/factor);}
 if(spec.kind==="pct")put(form,"p","small muted","Enter a percentage, for example 0.5 for 0.5%.");
 if(spec.kind==="hoursAsSec")put(form,"p","small muted","Enter hours, for example 0.5 for 30 minutes. The duration must be a whole number of seconds.");
 if(spec.zero_meaning)put(form,"p","small muted","Zero means: "+clean(spec.zero_meaning,200));
 if(spec.kind==="symbols")put(form,"p","small muted","Up to 10 symbols, separated by commas. Available: "+arr(d.available_basket_symbols,50).join(", "));
 homeRemember(input,state,"value");homeSubmit(form,"Review this preference →","propose_settings_change");
 form.addEventListener("submit",function(e){e.preventDefault();state.value=input.value;input.setCustomValidity("");var value;
  if(spec.kind==="bool")value=input.value==="true";
  else if(spec.kind==="symbols"){value=input.value.split(",").map(function(v){return v.trim();});if(value.length>10||value.some(function(v){return !/^[A-Za-z0-9][A-Za-z0-9._$-]{0,15}$/.test(v);}))input.setCustomValidity("Enter up to 10 symbols separated by commas.");}
  else if(choices)value=input.value;else {value=Number(input.value)*factor;if(factor!==1){if(Math.abs(value-Math.round(value))>0.000001)input.setCustomValidity(spec.kind==="pct"?"Use increments of 0.01%.":"Choose a duration that is a whole number of seconds.");else value=Math.round(value);}}
  if(!form.reportValidity())return;
  if(JSON.stringify(value)===JSON.stringify(spec.value)){homeMessage="Choose a different value before preparing a proposal.";homeDraw();return;}
  var changes={};changes[spec.key]=value;homePropose("propose_settings_change",Object.assign({},homeArgs(),{changes:changes}),"preference:"+setup.agent.id);
 });
 allSaved();
}
function homeControls(d){
 var s=section(homePanel,"Signed limits");var g=grid(s);var l=obj(d.signed_limits)||{};
 row(g,"Per trade",money(l.per_trade_usdg));row(g,"Per day",money(l.per_day_usdg));row(g,"Operations per day",num(l.max_ops_per_day)===null?null:fmt(l.max_ops_per_day,0));row(g,"Drawdown",num(l.max_drawdown_pct)===null?null:fmt(l.max_drawdown_pct,2)+"%");row(g,"Expiry",when(l.expires_at));put(s,"p","small muted",clean(l.enforced_where,500));
 var b=obj(d.budget_24h)||{};var budget=section(homePanel,"Last 24 hours · "+human(b.book));budget.appendChild(chip(b.book==="paper"?"Paper · simulated":b.book==="live"?"Live · real funds":human(b.book),b.book));var bg=grid(budget);row(bg,"Spent",money(b.spent_usdg));row(bg,"Remaining",money(b.remaining_usdg));row(bg,"Operations",num(b.ops)===null?null:fmt(b.ops,0));row(bg,"Operations remaining",num(b.ops_remaining)===null?null:fmt(b.ops_remaining,0));put(budget,"p","small muted",clean(b.note,700));
 var risk=obj(d.risk_settings)||{};var r=section(homePanel,"Current risk settings");var rg=grid(r);row(rg,"Slippage",bps(risk.slippage_bps));row(rg,"Price impact cap",bps(risk.max_impact_bps));row(rg,"Stop loss",bps(risk.stop_loss_bps));row(rg,"Take profit",bps(risk.take_profit_bps));row(rg,"Max chat action",money(risk.chat_action_ceiling_usdg));row(rg,"Cycle seconds",num(risk.tick_seconds)===null?null:fmt(risk.tick_seconds,0));put(r,"p","small muted","Signed limits and live activation are reviewed in Merrymen. The remaining budget can change as the worker runs.");
}
function homeLoadTab(){
 if(homeTab==="Portfolio")homeCall("get_portfolio",homeArgs(),function(d){homeData.portfolio=d;homeDraw();});
 else if(homeTab==="Activity"){
  var tool=homeData.activity?homeData.activity.tool:canHome("get_trades")?"get_trades":"list_decisions";
  homeCall(tool,Object.assign({},homeArgs(),{limit:20}),function(d){homeData.activity={data:d,tool:tool};homeDraw();});
 }else if(homeTab==="Settings"&&canHome("get_agent_settings"))homeCall("get_agent_settings",homeArgs(),function(d){homeData.settings=d;homeDraw();});
 else if(homeTab==="Alerts")homeCall("list_subscriptions",{},function(d){homeData.subscriptions=d;homeDraw();});
 else if(homeTab==="Approvals"){if(homeProposal&&canHome("get_proposal"))homeCall("get_proposal",{proposal_id:homeProposal.proposal_id},function(d){homeSetProposal(d);homeDraw();});else homeCall("list_proposals",{status:"open",limit:20},function(d){homeData.proposals=d;homeDraw();});}
}
function homeApprovals(){
 if(homeProposal){
  inHomePanel(function(){renderProposalResult(homeProposal);});
  var follow=put(homePanel,"div","home-actions");
  var creating=homeProposal.kind==="agent_draft"&&((obj(homeProposal.summary)||{}).purpose==="create"||(obj(homeProposal.result)||{}).setup_only===true);
  if(canHome("get_proposal")&&!(creating&&homeProposal.status==="applied"))homeToolButton(follow,"Check approval status","get_proposal",{proposal_id:homeProposal.proposal_id},function(d){homeSetProposal(d);homeDraw();});
  else homeToolButton(follow,"Check activation","get_merryman_setup",homeArgs(),function(d){homeAcceptSetup(d);homeTab="Overview";homeDraw();});
  var options=setupDisclosure(homePanel,"Manage this proposal","home-disclosure home-proposal-options");var actions=put(options,"div","home-actions");
  if(canHome("list_proposals"))homeToolButton(actions,"Back to approvals","list_proposals",{status:"open",limit:20},function(d){homeProposal=null;homeData.proposals=d;homeConfirm=null;homeDraw();});
  var cancellable=homeProposal.status==="awaiting_approval"&&["agent_draft","settings"].indexOf(homeProposal.kind)>=0;
  if(cancellable&&canHome("cancel_proposal")){
   if(homeConfirm===homeProposal.proposal_id){options.open=true;put(options,"p","small","Cancel this unapproved configuration draft? Your saved settings will stay unchanged.");homeToolButton(actions,"Confirm cancel draft","cancel_proposal",{proposal_id:homeProposal.proposal_id},function(d){homeSetProposal(d);homeConfirm=null;homeFlash=d.status==="cancelled"?"Draft cancelled. Your saved settings are unchanged.":"The proposal changed before it could be cancelled. Check its current status.";homeDraw();});homeButton(actions,"Keep draft",function(){homeConfirm=null;homeDraw();});}
   else homeButton(actions,"Cancel draft",function(){homeConfirm=homeProposal.proposal_id;homeDraw();});
  }
  if(!actions.childNodes.length)options.remove();
  return;
 }
 if(canHome("list_proposals"))homeToolButton(homePanel,"Load pending approvals","list_proposals",{status:"open",limit:20},function(d){homeProposal=null;homeData.proposals=d;homeConfirm=null;homeDraw();});
 var list=homeData.proposals;var items=arr(list&&list.proposals,50);
 put(homePanel,"p","small muted","Proposals visible to this connection. A pending draft has no effect until you approve it in Merrymen.");
 if(!items.length)put(homePanel,"p","home-empty",list?"No pending approvals. Prepare a settings change or ask your assistant for a proposal.":"Load pending approvals to see what still needs your review.");
 items.forEach(function(p){if(!obj(p))return;var s=section(homePanel,clean(obj(p.summary)&&p.summary.action,100)||human(p.kind));s.appendChild(chip(human(p.status),p.status==="awaiting_approval"?"warn":"info"));put(s,"p","small muted","Created "+when(p.created_at)+" · Expires "+when(p.expires_at));
  if(canHome("get_proposal"))homeToolButton(s,"Review proposal","get_proposal",{proposal_id:p.proposal_id},function(d){homeSetProposal(d);homeConfirm=null;homeDraw();});
 });
}
function homeActivity(d,tool){
 var actions=put(homePanel,"div","home-actions");
 [["Trades","get_trades"],["Decisions","list_decisions"]].forEach(function(v){if(canHome(v[1]))homeToolButton(actions,v[0],v[1],Object.assign({},homeArgs(),{limit:20}),function(r){homeData.activity={data:r,tool:v[1]};homeDraw();});});
 var items=arr(tool==="get_trades"?d.trades:d.decisions,20);
 if(!items.length)put(homePanel,"p","home-empty","No recent "+(tool==="get_trades"?"trades":"decisions")+" in this result.");
 items.forEach(function(t){if(!obj(t))return;var r=put(homePanel,"article","home-activity");put(r,"strong",null,[human(t.side||t.action),human(t.status||(obj(t.outcome)&&t.outcome.category)),].filter(Boolean).join(" · ")||"Recorded activity");if(t.symbol||t.token)r.appendChild(utInline(t.symbol||t.token,false));if(t.book)r.appendChild(chip(t.book==="paper"?"Paper · simulated":t.book==="live"?"Live · real funds":human(t.book),t.book));put(r,"p",null,when(t.time||t.at||t.created_at));if(t.stored_explanation)untrustedBox(r,"Stored explanation",t.stored_explanation);});
 put(homePanel,"p","small muted",clean(d.note||d.figures_note,700));if(d.next_cursor)put(homePanel,"p","small muted","Showing the most recent 20. Ask in chat for more history or a filtered view.");
}
function homeAlerts(){
 var s=section(homePanel,"Telegram alerts");put(s,"p","small muted","Alerts go to your linked Telegram bot. Delivery follows your notification settings.");
 if(canHome("list_notification_channels"))homeToolButton(s,"Check alert channel","list_notification_channels",{},function(d){homeData.channels=d;homeDraw();});
 if(homeData.channels){var d=homeData.channels;var c=arr(d.channels,3)[0];if(obj(c)){var r=section(s,"Channel status");r.appendChild(chip(c.ready===true?"Ready":c.ready===false?"Needs attention":"Readiness unknown",c.ready===true?"ok":"warn"));put(r,"p",null,clean(c.how_to_fix,500)||(c.ready===true?"Telegram is linked and alerts are enabled.":"Alert readiness is unknown. Check your Telegram settings before relying on delivery."));warnings(r,d.warnings);}}
 if(homeData.alertWarnings)warnings(s,homeData.alertWarnings);
 if(canHome("subscribe")){
  var state=homeAlertDraft;var form=put(s,"form","home-form");var select=homeField(form,"Add an alert","select",[["trade_confirmed","Live trades confirmed"],["risk_halt","Risk halt"],["provider_failure","Provider failure"],["stale_data","Worker stops reporting"],["inactivity","No recent activity"],["summary","Daily or weekly summary"],["watchlist_price","Stock token price threshold"]]);select.value=state.kind;
  select.addEventListener("change",function(){state.kind=select.value;homeDraw();});var inputs={};
  function alertField(key,label,tag,choices,fallback){var input=homeField(form,label,tag,choices);input.value=has(state,key)?state[key]:fallback;inputs[key]=input;homeRemember(input,state,key);return input;}
  if(state.kind==="inactivity"){var hours=alertField("hours","Hours without activity",null,null,"24");hours.type="number";hours.min="6";hours.max="168";hours.step="1";hours.required=true;}
  if(state.kind==="summary"){alertField("period","Summary frequency","select",[["day","Daily"],["week","Weekly · Mondays"]],"day");var hour=alertField("hour_utc","Delivery hour (UTC)",null,null,"9");hour.type="number";hour.min="0";hour.max="23";hour.step="1";hour.required=true;put(form,"p","small muted","The selected hour uses UTC. Weekly summaries arrive on Mondays.");}
  if(state.kind==="watchlist_price"){
   var token=alertField("token","Stock token address",null,null,"");token.required=true;token.pattern="0x[0-9a-fA-F]{40}";token.maxLength=42;
   ["above","below"].forEach(function(k){var input=alertField(k,k==="above"?"Price above (USD)":"Price below (USD)",null,null,"");input.type="number";input.min="0.000000001";input.max="1000000000";input.step="any";});
   put(form,"p","small muted","Choose a registered stock token with a supported price feed. Set at least one threshold; this alert never buys or sells.");
  }
  homeSubmit(form,"Add Telegram alert","subscribe");
  form.addEventListener("submit",function(e){e.preventDefault();Object.keys(inputs).forEach(function(k){state[k]=inputs[k].value;inputs[k].setCustomValidity("");});var params={};
   if(state.kind==="inactivity")params.hours=Number(inputs.hours.value);
   if(state.kind==="summary"){params.period=inputs.period.value;params.hour_utc=Number(inputs.hour_utc.value);}
   if(state.kind==="watchlist_price"){params.token=inputs.token.value.trim();["above","below"].forEach(function(k){if(inputs[k].value!=="")params[k]=Number(inputs[k].value);});if(!has(params,"above")&&!has(params,"below"))inputs.above.setCustomValidity("Set an upper or lower price threshold.");if(has(params,"above")&&has(params,"below")&&params.below>=params.above)inputs.below.setCustomValidity("The lower threshold must be below the upper threshold.");}
   if(!form.reportValidity())return;
   homeCall("subscribe",Object.assign({},state.kind==="watchlist_price"?{}:homeArgs(),{kind:state.kind,params:params}),function(d){homeFlash=d.created?"Alert added.":"This alert is already active.";homeData.alertWarnings=d.warnings;homeData.channels={channels:[d.channel],warnings:d.warnings};homeDraw();homeLoadTab();});
  });
 }
 ownerLink(s,"Telegram settings ↗",(obj(setup.links)||{}).settings);
}
function homeSubscriptions(d){
 var s=section(homePanel,"Active alerts");var items=arr(d.subscriptions,60);
 put(s,"p","small muted",String(d.active_subscriptions)+" active · maximum "+String(d.max_active_subscriptions));
 if(!items.length)put(s,"p","muted","No active alerts are shared with this connection.");
 items.forEach(function(v){if(!obj(v))return;var r=put(s,"div","home-step");var t=put(r,"div");put(t,"strong",null,clean(v.description,300));put(t,"p","small muted",v.agent===null?"Token price alert":v.agent===setup.agent.id?"For this Merryman":"For shared Merryman "+clean(v.agent,64));put(t,"p",null,v.last_delivery?"Latest delivery: "+human(v.last_delivery.status):"No delivery yet");
  if(canHome("unsubscribe")){
   if(homeConfirm===v.subscription_id){put(t,"p","small","Remove this alert and drop its pending notifications?");homeToolButton(t,"Confirm remove alert","unsubscribe",{subscription_id:v.subscription_id},function(){homeFlash="Alert removed.";homeConfirm=null;homeData.subscriptions=null;homeDraw();homeLoadTab();});homeButton(t,"Keep alert",function(){homeConfirm=null;homeDraw();});}
   else homeButton(t,"Remove alert",function(){homeConfirm=v.subscription_id;homeDraw();});
  }
 });
 if(d.not_shown)put(s,"p","small muted","Some alerts belong to agents not shared with this connection.");
}
`;
