(() => {
  'use strict';
  const home = document.getElementById('rescue-home');
  if (!window.L) {
    document.getElementById('city-map').innerHTML = '<div class="map-offline">The live city map couldn’t load. Check your connection and refresh.</div>';
    return;
  }
  const map = L.map('city-map', { zoomControl: false, scrollWheelZoom: true }).setView([14.5995, 120.9842], 13);
  const tileUrl = document.querySelector('meta[name="rescue-map-tile-url"]')?.content;
  if (!tileUrl) {
    document.getElementById('city-map').innerHTML = '<div class="map-offline">The map tile source is not configured. Check the site setup and refresh.</div>';
    return;
  }
  L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    referrerPolicy: 'strict-origin-when-cross-origin',
    updateWhenIdle: true,
    keepBuffer: 1
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const colors = {main:'#dc8047',moto:'#8764bb',foot:'#398eae'};
  const layers = {main:L.layerGroup().addTo(map),moto:L.layerGroup().addTo(map),foot:L.layerGroup().addTo(map)};
  const samples = {
    main:{name:'Main road',text:'Illustrative all-vehicle corridor. Verify current restrictions before travel.',points:[[14.6092,120.9732],[14.6054,120.9792],[14.6018,120.9852],[14.5975,120.9921],[14.5928,120.9984],[14.5859,121.0045]]},
    moto:{name:'Motorcycle road',text:'Illustrative motorcycle-and-pedestrian corridor. Verify local access rules.',points:[[14.6115,120.9842],[14.6068,120.9831],[14.6019,120.9824],[14.5963,120.9811],[14.5908,120.9798]]},
    foot:{name:'Footpath',text:'Illustrative pedestrian-only corridor. Vehicles are not permitted.',points:[[14.6051,120.9913],[14.6010,120.9898],[14.5972,120.9879],[14.5934,120.9853],[14.5897,120.9831]]}
  };
  const storageKey='rescueroute-street-graph-manila-v1';
  const editorStatus=document.getElementById('street-editor-status');
  const nodeName=document.getElementById('street-name');
  const nodeType=document.getElementById('street-type');
  const customLayers={main:L.layerGroup().addTo(map),moto:L.layerGroup().addTo(map),foot:L.layerGroup().addTo(map)};
  let graph={nodes:[],connectors:[]};let editMode='';let connectStart=null;let cloudClient=null;let stopCloudSync=null;let cloudWriteQueue=Promise.resolve();let cloudSyncReady=false;
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved&&Array.isArray(saved.nodes)&&Array.isArray(saved.connectors))graph=saved;}catch{}
  const safeText=(value)=>String(value).replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const persistGraph=()=>{try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{editorStatus.textContent='Could not save this map in this browser.';return;}if(!cloudClient?.auth.currentUser){editorStatus.textContent=`Saved on this device · ${graph.nodes.length} nodes · ${graph.connectors.length} streets. Sign in to sync across devices.`;return;}if(!cloudSyncReady){editorStatus.textContent='Connecting to Firebase…';return;}const payload={nodes:graph.nodes,connectors:graph.connectors,updatedAt:Date.now()};cloudWriteQueue=cloudWriteQueue.then(()=>cloudClient.setDoc(cloudClient.doc(cloudClient.db,'cityMaps','manila'),payload)).then(()=>{editorStatus.textContent=`Synced to Firebase · ${graph.nodes.length} nodes · ${graph.connectors.length} streets.`;}).catch((error)=>{console.error('Street map sync failed',error);editorStatus.textContent='Firebase save failed. Check Firestore setup and security rules.';});};
  const modeButtons=[['add-street-node','add'],['connect-streets','connect']];
  function renderGraph(){Object.values(customLayers).forEach((layer)=>layer.clearLayers());for(const road of graph.connectors){const from=graph.nodes.find((node)=>node.id===road.from),to=graph.nodes.find((node)=>node.id===road.to);if(!from||!to)continue;const line=L.polyline([[from.lat,from.lng],[to.lat,to.lng]],{color:colors[road.type]||colors.main,weight:6,opacity:.95,lineCap:'round'}).addTo(customLayers[road.type]||customLayers.main);line.bindPopup(`<div class="street-popup"><strong>${safeText(road.name||'Street connector')}</strong><br>${safeText(from.name||'Node')} ↔ ${safeText(to.name||'Node')}<br><button type="button" data-delete-connector="${safeText(road.id)}">Delete street</button></div>`);line.on('popupopen',(event)=>event.popup.getElement().querySelector('[data-delete-connector]')?.addEventListener('click',()=>{graph.connectors=graph.connectors.filter((item)=>item.id!==road.id);renderGraph();persistGraph();map.closePopup();}));}
    for(const node of graph.nodes){const icon=L.divIcon({className:'',html:`<span class="custom-node-icon${connectStart===node.id?' is-selected':''}">${safeText(node.name?.slice(0,1)||'•')}</span>`,iconSize:[24,24],iconAnchor:[12,12]});const marker=L.marker([node.lat,node.lng],{icon,draggable:true}).addTo(map);marker.on('dragend',()=>{const point=marker.getLatLng();node.lat=point.lat;node.lng=point.lng;renderGraph();persistGraph();});marker.on('click',()=>{if(editMode==='connect'){if(!connectStart){connectStart=node.id;editorStatus.textContent=`Start selected: ${node.name||'Node'}. Choose the next node.`;renderGraph();return;}if(connectStart===node.id){connectStart=null;editorStatus.textContent='Choose two different nodes to connect.';renderGraph();return;}const start=graph.nodes.find((item)=>item.id===connectStart);graph.connectors.push({id:crypto.randomUUID(),from:start.id,to:node.id,name:nodeName.value.trim()||`${start.name||'Street'} – ${node.name||'Street'}`,type:nodeType.value});connectStart=null;editMode='';updateModeButtons();renderGraph();persistGraph();return;}marker.bindPopup(`<div class="street-popup"><strong>${safeText(node.name||'Map node')}</strong><br>${node.lat.toFixed(5)}, ${node.lng.toFixed(5)}<br><button type="button" data-delete-node="${safeText(node.id)}">Delete node</button></div>`).openPopup();setTimeout(()=>document.querySelector('[data-delete-node]')?.addEventListener('click',()=>{graph.nodes=graph.nodes.filter((item)=>item.id!==node.id);graph.connectors=graph.connectors.filter((item)=>item.from!==node.id&&item.to!==node.id);renderGraph();persistGraph();map.closePopup();},{once:true}),0);});}
    for(const [type,layer] of Object.entries(customLayers)){const input=document.querySelector(`[data-layer="${type}"]`);if(input?.checked)layer.addTo(map);}}
  function updateModeButtons(){for(const [id,mode] of modeButtons)document.getElementById(id).classList.toggle('active',editMode===mode);document.getElementById('city-map').style.cursor=editMode==='add'?'crosshair':'';}
  modeButtons.forEach(([id,mode])=>document.getElementById(id).addEventListener('click',()=>{editMode=editMode===mode?'':mode;connectStart=null;updateModeButtons();editorStatus.textContent=editMode==='add'?'Click the map to place an intersection node.':editMode==='connect'?'Choose two nodes to draw a street between them.':'Editor ready. Add nodes by clicking the map.';renderGraph();}));
  document.getElementById('stop-street-edit').addEventListener('click',()=>{editMode='';connectStart=null;updateModeButtons();editorStatus.textContent='Editor ready. Drag nodes to adjust their positions.';renderGraph();});
  map.on('click',(event)=>{if(editMode!=='add')return;graph.nodes.push({id:crypto.randomUUID(),name:nodeName.value.trim()||`Node ${graph.nodes.length+1}`,lat:event.latlng.lat,lng:event.latlng.lng});editMode='';updateModeButtons();renderGraph();persistGraph();});
  document.getElementById('clear-street-map').addEventListener('click',()=>{if(!graph.nodes.length&&!graph.connectors.length){editorStatus.textContent='There are no custom nodes or streets to clear.';return;}if(!window.confirm('Delete all nodes and custom streets saved in this browser?'))return;graph={nodes:[],connectors:[]};renderGraph();persistGraph();});
  for (const [key,road] of Object.entries(samples)) {
    const style={color:colors[key],weight:key==='main'?6:5,opacity:.94,lineCap:'round',lineJoin:'round',dashArray:key==='moto'?'10 8':key==='foot'?'2 9':null};
    const line=L.polyline(road.points,style).addTo(layers[key]);
    L.polyline(road.points,{color:'#fff',weight:1,opacity:.52,interactive:false}).addTo(layers[key]);
    line.bindPopup(`<div class="road-popup"><strong>${road.name}</strong><br>${road.text}</div>`);
    line.on('mouseover',()=>line.setStyle({weight:key==='main'?9:8}));
    line.on('mouseout',()=>line.setStyle(style));
  }
  const checkboxes=[...document.querySelectorAll('[data-layer]')];
  checkboxes.forEach((input)=>input.addEventListener('change',()=>{
    const layer=layers[input.dataset.layer];
    if(input.checked)layer.addTo(map);else map.removeLayer(layer);
    if(customLayers[input.dataset.layer]){if(input.checked)customLayers[input.dataset.layer].addTo(map);else map.removeLayer(customLayers[input.dataset.layer]);}
  }));
  renderGraph();
  document.getElementById('toggle-all').addEventListener('click',(event)=>{
    const show=checkboxes.some((item)=>!item.checked);
    checkboxes.forEach((item)=>{item.checked=show;item.dispatchEvent(new Event('change'));});
    event.currentTarget.textContent=show?'Hide all':'Show all';
  });
  const modes=[...document.querySelectorAll('[data-mode]')];let selected='car';
  modes.forEach((button)=>button.addEventListener('click',()=>{
    selected=button.dataset.mode;
    modes.forEach((item)=>{const active=item===button;item.classList.toggle('selected',active);item.setAttribute('aria-pressed',String(active));});
    const allowed=selected==='car'?['main']:selected==='motorcycle'?['main','moto']:['main','moto','foot'];
    checkboxes.forEach((input)=>{const on=allowed.includes(input.dataset.layer);input.checked=on;input.dispatchEvent(new Event('change'));});
    document.getElementById('toggle-all').textContent=allowed.length===3?'Hide all':'Show all';
    document.getElementById('route-result').hidden=true;
  }));
  document.getElementById('show-route').addEventListener('click',()=>{
    const names={car:'Main roads',motorcycle:'Main roads and motorcycle roads',foot:'Main roads, motorcycle roads, and footpaths'};
    const result=document.getElementById('route-result');
    result.textContent=`${names[selected]} are shown on this sample map. The colored corridors are illustrative and aren’t a verified turn-by-turn route.`;
    result.hidden=false;
  });
  const search=async()=>{
    const input=document.getElementById('city-search');const status=document.getElementById('search-status');
    const query=input.value.trim();if(!query)return;
    status.textContent='Searching for the place…';
    try{
      const url=new URL('https://nominatim.openstreetmap.org/search');url.searchParams.set('format','jsonv2');url.searchParams.set('limit','1');url.searchParams.set('q',query);
      const response=await fetch(url,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error('search unavailable');
      const results=await response.json();if(!results.length){status.textContent='No place found. Try a city name.';return;}
      const place=results[0];const bounds=L.latLngBounds([[Number(place.boundingbox[0]),Number(place.boundingbox[2])],[Number(place.boundingbox[1]),Number(place.boundingbox[3])]]);
      map.fitBounds(bounds,{padding:[30,30],maxZoom:14});document.getElementById('map-location-label').textContent=place.display_name.split(',').slice(0,2).join(' · ').toUpperCase();status.textContent='Map centred on '+place.display_name.split(',').slice(0,2).join(', ')+'. Sample overlays remain illustrative.';
    }catch{status.textContent='Place search is unavailable. The map still works in central Seoul.';}
  };
  document.getElementById('search-city').addEventListener('click',search);
  document.getElementById('city-search').addEventListener('keydown',(event)=>{if(event.key==='Enter')search();});
  document.getElementById('locate-me').addEventListener('click',()=>{
    const status=document.getElementById('search-status');
    if(!navigator.geolocation){status.textContent='Location isn’t available in this browser.';return;}
    status.textContent='Finding your location…';
    navigator.geolocation.getCurrentPosition((position)=>{map.setView([position.coords.latitude,position.coords.longitude],15);document.getElementById('map-location-label').textContent='YOUR LOCATION';status.textContent='Map centred on your location. The sample overlays aren’t verified nearby roads.';},()=>{status.textContent='Location access was unavailable. Search for a city instead.';},{timeout:10000,maximumAge:60000});
  });
  import('./firebase-client.js').then((client)=>{cloudClient=client;client.onAuthStateChanged(client.auth,(user)=>{stopCloudSync?.();stopCloudSync=null;cloudSyncReady=false;if(!user){editorStatus.textContent=`Saved on this device · ${graph.nodes.length} nodes · ${graph.connectors.length} streets. Sign in to sync across devices.`;return;}editorStatus.textContent='Loading the shared Manila street map from Firebase…';stopCloudSync=client.onSnapshot(client.doc(client.db,'cityMaps','manila'),(snapshot)=>{const remote=snapshot.exists()?snapshot.data():null;if(remote&&Array.isArray(remote.nodes)&&Array.isArray(remote.connectors)){graph={nodes:remote.nodes,connectors:remote.connectors};try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}renderGraph();editorStatus.textContent=`Synced to Firebase · ${graph.nodes.length} nodes · ${graph.connectors.length} streets.`;}else if(graph.nodes.length||graph.connectors.length){cloudSyncReady=true;persistGraph();}else{cloudSyncReady=true;editorStatus.textContent='Connected to Firebase. Add nodes to build the Manila street map.';}cloudSyncReady=true;},(error)=>{console.error('Street map sync could not start',error);editorStatus.textContent='Firebase sync is unavailable. Check Firestore setup and security rules.';});},(error)=>{console.error('Firebase authentication could not be checked for map sync',error);editorStatus.textContent='Could not check sign-in. Street changes are saved in this browser.';});}).catch((error)=>{console.error('Firebase map sync could not load',error);editorStatus.textContent='Firebase sync could not load. Street changes are saved in this browser.';});
  function resizeMap(){if(!home.hidden)requestAnimationFrame(()=>map.invalidateSize());}
  const uploads=document.getElementById('uploads-page');
  function showPage(page,updateHash=false){
    if(page==='uploads'){
      home.hidden=true;uploads.hidden=false;document.querySelector('.auth-shell').style.display='none';document.body.classList.remove('account-open');
      document.querySelectorAll('[data-page-link]').forEach((link)=>link.classList.toggle('nav-active',link.dataset.pageLink==='uploads'));
      if(updateHash&&location.hash!=='#uploads')history.pushState(null,'','#uploads');
      window.dispatchEvent(new Event('rescue:uploads'));return;
    }
    uploads.hidden=true;home.hidden=false;document.querySelectorAll('[data-page-link]').forEach((link)=>link.classList.toggle('nav-active',link.dataset.pageLink==='map'));
    if(updateHash&&location.hash!=='#map')history.pushState(null,'','#map');resizeMap();
  }
  document.querySelectorAll('[data-account-link]').forEach((button)=>button.addEventListener('click',()=>{window.dispatchEvent(new Event('rescue:account'));}));
  document.querySelectorAll('[data-page-link="map"]').forEach((link)=>link.addEventListener('click',(event)=>{event.preventDefault();showPage('map',true);if(link.getAttribute('href')==='#road-guide')document.getElementById('road-guide').scrollIntoView({behavior:'smooth'});}));
  document.querySelectorAll('[data-page-link="uploads"]').forEach((link)=>link.addEventListener('click',(event)=>{event.preventDefault();showPage('uploads',true);}));
  function syncPage(){if(location.hash==='#uploads')showPage('uploads');else if(location.hash==='#map'||!location.hash)showPage('map');}
  window.addEventListener('hashchange',syncPage);window.addEventListener('popstate',syncPage);
  if(['#login','#signup'].includes(location.hash))window.dispatchEvent(new Event('rescue:account'));else syncPage();
  map.whenReady(resizeMap);
})();
