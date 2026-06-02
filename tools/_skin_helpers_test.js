const fs=require('fs'),path=require('path'),crypto=require('crypto');
function _bakTimestamp(d){const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];d=d||new Date();let h=d.getHours();const ampm=h>=12?'PM':'AM';h=h%12;if(h===0)h=12;const mm=String(d.getMinutes()).padStart(2,'0');return `${days[d.getDay()]}-${h}-${mm}-${ampm}`;}
function slugifySkinName(name){return String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');}
function setSkinNameInHtml(html,displayName){const safeName=String(displayName||'').replace(/\/g,'\\').replace(/"/g,'\\"');const decl=`--cbe-skin-name: "${safeName}";`;const rootIdx=html.indexOf(':root');if(rootIdx<0)return html;const open=html.indexOf('{',rootIdx);if(open<0)return html;let depth=0,close=-1;for(let i=open;i<html.length;i++){const c=html[i];if(c==='{')depth++;else if(c==='}'){depth--;if(depth===0){close=i;break;}}}if(close<0)return html;const body=html.slice(open+1,close);const re=/--cbe-skin-name\s*:\s*[^;]*;?/;let newBody;if(re.test(body))newBody=body.replace(re,decl);else newBody=`\n    ${decl}${body}`;return html.slice(0,open+1)+newBody+html.slice(close);}
console.log('ts:', _bakTimestamp(new Date(2026,4,31,15,13)));
console.log('slug1:', JSON.stringify(slugifySkinName('My Cool Skin!!')));
console.log('slug2:', JSON.stringify(slugifySkinName('  --Aqua  Dock-- ')));
console.log('slug3:', JSON.stringify(slugifySkinName('???')));
console.log('replace:', setSkinNameInHtml('<style>:root{--cbe-skin-name: "Old"; --x: 1;}</style>','New Name'));
console.log('insert:', setSkinNameInHtml('<style>:root{--x: 1;}</style>','Fresh'));
const md5=crypto.createHash('md5').update(fs.readFileSync('skins/aqua-dock.html')).digest('hex').slice(0,6);
console.log('aqua md5[:6]:', md5);
