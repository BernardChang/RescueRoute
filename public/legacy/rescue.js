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
  const customMarkers=L.layerGroup().addTo(map);
  const routeLayer=L.layerGroup().addTo(map);
  const areaSelectionLayer=L.layerGroup().addTo(map);
  const normalizeGraph=(saved)=>({
    nodes:Array.isArray(saved?.nodes)?saved.nodes:[],
    edges:Array.isArray(saved?.edges)?saved.edges:Array.isArray(saved?.connectors)?saved.connectors:[]
  });
  let graph={nodes:[],edges:[]};
  let editMode='';
  let edgeStart=null;
  let areaPoints=[];
  let areaBusy=false;
  let routeStartId=null;
  let routeEndId=null;
  const routeStorageKey='rescueroute-route-selection-manila-v1';
  let cloudClient=null;
  let stopCloudSync=null;
  let cloudWriteQueue=Promise.resolve();
  let cloudSyncReady=false;
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved&&Array.isArray(saved.nodes))graph=normalizeGraph(saved);}catch{}
  try{const saved=JSON.parse(localStorage.getItem(routeStorageKey)||'null');routeStartId=saved?.startId||null;routeEndId=saved?.endId||null;}catch{}
  const safeText=(value)=>String(value).replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const graphSummary=()=>`${graph.nodes.length} nodes · ${graph.edges.length} ${graph.edges.length===1?'edge':'edges'}`;
  const distanceMeters=(a,b)=>{const radius=6371000,toRadians=(value)=>value*Math.PI/180;const dLat=toRadians(b.lat-a.lat),dLng=toRadians(b.lng-a.lng);const s=Math.sin(dLat/2)**2+Math.cos(toRadians(a.lat))*Math.cos(toRadians(b.lat))*Math.sin(dLng/2)**2;return radius*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));};
  const edgePoints=(edge,from,to)=>{const points=Array.isArray(edge.points)&&edge.points.length>1?edge.points.map((point)=>[Number(point[0]),Number(point[1])]):[[from.lat,from.lng],[to.lat,to.lng]];if(edge.from!==from.id)points.reverse();points[0]=[from.lat,from.lng];points[points.length-1]=[to.lat,to.lng];return points;};
  const edgeLength=(edge,from,to)=>{const points=edgePoints(edge,from,to);let distance=0;for(let i=1;i<points.length;i++)distance+=distanceMeters({lat:points[i-1][0],lng:points[i-1][1]},{lat:points[i][0],lng:points[i][1]});return distance;};
  const formatDistance=(meters)=>meters<1000?`${Math.round(meters)} m`:`${(meters/1000).toFixed(2)} km`;
  const selectedRouteLabel=()=>{const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);return `Start: ${start?.name||'not set'} · End: ${end?.name||'not set'}`;};
  function updateRouteSelectionStatus(){document.getElementById('route-selection-status').textContent=`${selectedRouteLabel()}. Hover a node to change either point.`;}
  function saveRouteSelection(){try{localStorage.setItem(routeStorageKey,JSON.stringify({startId:routeStartId,endId:routeEndId}));}catch{}}
  function setRouteEndpoint(role,node){if(role==='start')routeStartId=node.id;else routeEndId=node.id;saveRouteSelection();routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateRouteSelectionStatus();renderGraph();map.closePopup();}
  function allowedEdgeTypes(){return selected==='car'?new Set(['main']):selected==='motorcycle'?new Set(['main','moto']):new Set(['main','moto','foot']);}
  function findShortestPath(){
    const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);
    if(!start||!end)return {error:'Hover over a node and set both a start and an end point.'};
    if(start.id===end.id)return {nodes:[start],edges:[],distance:0};
    const nodeById=new Map(graph.nodes.map((node)=>[node.id,node]));const allowed=allowedEdgeTypes();const adjacency=new Map();
    for(const edge of graph.edges){if(!allowed.has(edge.type||'main'))continue;const from=nodeById.get(edge.from),to=nodeById.get(edge.to);if(!from||!to)continue;const length=edgeLength(edge,from,to);for(const [nodeId,neighborId] of (edge.oneway?[[from.id,to.id]]:[[from.id,to.id],[to.id,from.id]])){if(!adjacency.has(nodeId))adjacency.set(nodeId,[]);adjacency.get(nodeId).push({edge,neighborId,length});}}
    const open=new Set([start.id]);const cameFrom=new Map();const gScore=new Map([[start.id,0]]);const fScore=new Map([[start.id,distanceMeters(start,end)]]);
    while(open.size){let current=null;for(const id of open)if(current===null||fScore.get(id)<fScore.get(current))current=id;if(current===end.id){const pathNodes=[end.id];const pathEdges=[];let cursor=end.id;while(cameFrom.has(cursor)){const previous=cameFrom.get(cursor);pathEdges.unshift(previous.edge);cursor=previous.nodeId;pathNodes.unshift(cursor);}return {nodes:pathNodes.map((id)=>nodeById.get(id)),edges:pathEdges,distance:gScore.get(end.id)};}open.delete(current);for(const neighbor of adjacency.get(current)||[]){const tentative=gScore.get(current)+neighbor.length;if(tentative<(gScore.get(neighbor.neighborId)??Infinity)){cameFrom.set(neighbor.neighborId,{nodeId:current,edge:neighbor.edge});gScore.set(neighbor.neighborId,tentative);fScore.set(neighbor.neighborId,tentative+distanceMeters(nodeById.get(neighbor.neighborId),end));open.add(neighbor.neighborId);}}}
    return {error:'No connected path was found for this travel mode.'};
  }
  function drawRoute(path){routeLayer.clearLayers();const coordinates=[];for(let i=0;i<path.edges.length;i++){const segment=edgePoints(path.edges[i],path.nodes[i],path.nodes[i+1]);coordinates.push(...(coordinates.length?segment.slice(1):segment));}if(coordinates.length>1){const line=L.polyline(coordinates,{color:'#2865d7',weight:9,opacity:.92,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);line.bringToFront();map.fitBounds(line.getBounds(),{padding:[42,42],maxZoom:17});}}
  const persistGraph=()=>{
    try{localStorage.setItem(storageKey,JSON.stringify(graph));}
    catch{editorStatus.textContent='Could not save this map in this browser.';return;}
    if(!cloudClient?.auth.currentUser){editorStatus.textContent=`Saved on this device · ${graphSummary()}. Sign in to sync across devices.`;return;}
    if(!cloudSyncReady){editorStatus.textContent='Connecting to Firebase…';return;}
    const payload={nodes:graph.nodes,edges:graph.edges,updatedAt:Date.now()};
    cloudWriteQueue=cloudWriteQueue.then(()=>cloudClient.setDoc(cloudClient.doc(cloudClient.db,'cityMaps','manila'),payload)).then(()=>{editorStatus.textContent=`Synced to Firebase · ${graphSummary()}.`;}).catch((error)=>{console.error('Street map sync failed',error);editorStatus.textContent='Firebase save failed. Check Firestore setup and security rules.';});
  };
  const modeButtons=[['add-street-node','add'],['add-street-edge','edge'],['select-map-area','area']];
  function renderGraph(){
    Object.values(customLayers).forEach((layer)=>layer.clearLayers());
    customMarkers.clearLayers();
    for(const edge of graph.edges){
      const from=graph.nodes.find((node)=>node.id===edge.from);
      const to=graph.nodes.find((node)=>node.id===edge.to);
      if(!from||!to)continue;
      const line=L.polyline(edgePoints(edge,from,to),{color:colors[edge.type]||colors.main,weight:6,opacity:.95,lineCap:'round',lineJoin:'round'}).addTo(customLayers[edge.type]||customLayers.main);
      line.bindPopup(`<div class="street-popup"><strong>${safeText(edge.name||'Street edge')}</strong><br>${safeText(from.name||'Node')} ↔ ${safeText(to.name||'Node')}<br><button type="button" data-delete-edge="${safeText(edge.id)}">Delete edge</button></div>`);
      line.on('popupopen',(event)=>{const button=event.popup.getElement().querySelector('[data-delete-edge]');if(button)button.onclick=()=>{graph.edges=graph.edges.filter((item)=>item.id!==edge.id);routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();persistGraph();map.closePopup();};});
    }
    for(const node of graph.nodes){
      const routeClass=routeStartId===node.id?' is-route-start':routeEndId===node.id?' is-route-end':'';
      const icon=L.divIcon({className:'',html:`<span class="custom-node-icon${edgeStart===node.id?' is-selected':''}${routeClass}">${safeText(node.name?.slice(0,1)||'•')}</span>`,iconSize:[24,24],iconAnchor:[12,12]});
      const marker=L.marker([node.lat,node.lng],{icon,draggable:true}).addTo(customMarkers);
      marker.on('dragend',()=>{const point=marker.getLatLng();node.lat=point.lat;node.lng=point.lng;routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();persistGraph();});
      marker.bindPopup(`<div class="street-popup"><strong>${safeText(node.name||'Map node')}</strong><br>${node.lat.toFixed(5)}, ${node.lng.toFixed(5)}<div class="node-route-actions"><button type="button" data-route-role="start">Set as start</button><button type="button" data-route-role="end">Set as end</button></div><button type="button" data-delete-node="${safeText(node.id)}">Delete node</button></div>`,{autoClose:true,closeOnClick:true,maxWidth:230});
      marker.on('mouseover',()=>{if(editMode!=='edge'&&editMode!=='area')marker.openPopup();});
      marker.on('popupopen',(event)=>{const popup=event.popup.getElement();popup.querySelectorAll('[data-route-role]').forEach((button)=>{button.onclick=()=>setRouteEndpoint(button.dataset.routeRole,node);});const deleteButton=popup.querySelector('[data-delete-node]');if(deleteButton)deleteButton.onclick=()=>{graph.nodes=graph.nodes.filter((item)=>item.id!==node.id);graph.edges=graph.edges.filter((item)=>item.from!==node.id&&item.to!==node.id);if(routeStartId===node.id)routeStartId=null;if(routeEndId===node.id)routeEndId=null;saveRouteSelection();routeLayer.clearLayers();document.getElementById('route-result').hidden=true;edgeStart=null;renderGraph();persistGraph();updateRouteSelectionStatus();map.closePopup();};});
      marker.on('click',()=>{
        if(editMode==='area'){addAreaPoint(marker.getLatLng());return;}
        if(editMode==='edge'){
          if(!edgeStart){edgeStart=node.id;editorStatus.textContent=`Start node selected: ${node.name||'Node'}. Choose the other node.`;renderGraph();return;}
          if(edgeStart===node.id){edgeStart=null;editorStatus.textContent='Choose two different nodes for an edge.';renderGraph();return;}
          const start=graph.nodes.find((item)=>item.id===edgeStart);
          if(!start){edgeStart=null;editorStatus.textContent='Start node is unavailable. Select the first node again.';renderGraph();return;}
          const alreadyConnected=graph.edges.some((item)=>(item.from===start.id&&item.to===node.id)||(item.from===node.id&&item.to===start.id));
          if(alreadyConnected){edgeStart=null;editMode='';updateModeButtons();editorStatus.textContent='These nodes already have an edge.';renderGraph();return;}
          graph.edges.push({id:crypto.randomUUID(),from:start.id,to:node.id,name:nodeName.value.trim()||`${start.name||'Node'} – ${node.name||'Node'}`,type:nodeType.value});
          edgeStart=null;editMode='';routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph();return;
        }
        marker.openPopup();
      });
    }
    for(const [type,layer] of Object.entries(customLayers)){const input=document.querySelector(`[data-layer="${type}"]`);if(input?.checked)layer.addTo(map);}
  }
  function clearAreaSelection(){areaPoints=[];areaSelectionLayer.clearLayers();document.getElementById('analyze-map-area').disabled=true;document.getElementById('cancel-map-area').hidden=true;map.doubleClickZoom.enable();}
  function paintAreaSelection(){areaSelectionLayer.clearLayers();if(!areaPoints.length)return;if(areaPoints.length===1)L.circleMarker(areaPoints[0],{radius:6,color:'#2865d7',fillColor:'#fff',fillOpacity:1,weight:3}).addTo(areaSelectionLayer);else if(areaPoints.length===2)L.polyline(areaPoints,{color:'#2865d7',weight:3,dashArray:'7 5'}).addTo(areaSelectionLayer);else L.polygon(areaPoints,{color:'#2865d7',weight:3,dashArray:'7 5',fillColor:'#5890eb',fillOpacity:.12}).addTo(areaSelectionLayer);for(const point of areaPoints)L.circleMarker(point,{radius:4,color:'#2865d7',fillColor:'#fff',fillOpacity:1,weight:2}).addTo(areaSelectionLayer);}
  function addAreaPoint(point){if(areaPoints.length>=20){editorStatus.textContent='Area boundary reached its 20-corner limit. Analyze this area or cancel it.';return;}areaPoints.push(point);paintAreaSelection();updateModeButtons();editorStatus.textContent=`Area outline: ${areaPoints.length} ${areaPoints.length===1?'corner':'corners'}. Add corners, then analyze with AI.`;}
  function updateModeButtons(){for(const [id,mode] of modeButtons)document.getElementById(id).classList.toggle('active',editMode===mode);document.getElementById('city-map').style.cursor=['add','area'].includes(editMode)?'crosshair':'';document.getElementById('analyze-map-area').disabled=editMode!=='area'||areaPoints.length<3||areaBusy;document.getElementById('cancel-map-area').hidden=editMode!=='area';}
  modeButtons.forEach(([id,mode])=>document.getElementById(id).addEventListener('click',()=>{if(areaBusy)return;const wasSelectingArea=editMode==='area';editMode=editMode===mode?'':mode;edgeStart=null;if(mode==='area'&&editMode==='area'){areaPoints=[];areaSelectionLayer.clearLayers();map.doubleClickZoom.disable();editorStatus.textContent='Click at least three corners around a small street area, then choose Analyze area with AI.';}else if(wasSelectingArea){clearAreaSelection();editorStatus.textContent=mode==='area'?'Area selection cancelled.':editMode==='add'?'Click the map to place an intersection node.':editMode==='edge'?'Select two nodes to create an edge between them.':'Editor ready. Add nodes, edges, or select an area.';}else editorStatus.textContent=editMode==='add'?'Click the map to place an intersection node.':editMode==='edge'?'Select two nodes to create an edge between them.':'Editor ready. Add nodes, edges, or select an area.';updateModeButtons();renderGraph();}));
  document.getElementById('cancel-map-area').addEventListener('click',()=>{if(areaBusy)return;editMode='';clearAreaSelection();updateModeButtons();editorStatus.textContent='Area selection cancelled.';});
  document.getElementById('stop-street-edit').addEventListener('click',()=>{if(areaBusy)return;editMode='';edgeStart=null;clearAreaSelection();updateModeButtons();editorStatus.textContent='Editor ready. Hover a node to set route endpoints.';renderGraph();});
  map.on('click',(event)=>{if(areaBusy)return;if(editMode==='area'){addAreaPoint(event.latlng);return;}if(editMode!=='add')return;graph.nodes.push({id:crypto.randomUUID(),name:nodeName.value.trim()||`Node ${graph.nodes.length+1}`,lat:event.latlng.lat,lng:event.latlng.lng});editMode='';routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph();});
  document.getElementById('analyze-map-area').addEventListener('click',async()=>{if(areaBusy||areaPoints.length<3)return;const user=cloudClient?.auth.currentUser;if(!user){editorStatus.textContent='Sign in before asking AI to analyze a map area.';return;}areaBusy=true;updateModeButtons();editorStatus.textContent='Loading OpenStreetMap paths and asking AI to identify their intersections…';try{const token=await user.getIdToken();const response=await fetch('/api/map/analyze-area',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({polygon:areaPoints.map((point)=>[point.lat,point.lng])})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'AI map analysis could not complete.');const knownNodes=new Set(graph.nodes.map((node)=>node.id));const knownEdges=new Set(graph.edges.map((edge)=>edge.id));const newNodes=(result.nodes||[]).filter((node)=>!knownNodes.has(node.id));const newEdges=(result.edges||[]).filter((edge)=>!knownEdges.has(edge.id));if(graph.nodes.length+newNodes.length>2000||graph.edges.length+newEdges.length>4000)throw new Error('This graph is near its save limit. Select a smaller area or clear unused nodes and edges.');graph.nodes.push(...newNodes);graph.edges.push(...newEdges);editMode='';clearAreaSelection();routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph();editorStatus.textContent=`${result.summary||'AI street analysis complete.'} Added ${newNodes.length} new nodes and ${newEdges.length} new edges.`;}catch(error){editorStatus.textContent=error.message||'AI map analysis failed. Please retry.';}finally{areaBusy=false;updateModeButtons();}});
  document.getElementById('clear-street-map').addEventListener('click',()=>{if(!graph.nodes.length&&!graph.edges.length){editorStatus.textContent='There are no custom nodes or edges to clear.';return;}if(!window.confirm('Delete all nodes and edges saved in this browser?'))return;graph={nodes:[],edges:[]};routeStartId=null;routeEndId=null;saveRouteSelection();routeLayer.clearLayers();renderGraph();persistGraph();updateRouteSelectionStatus();});
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
  updateRouteSelectionStatus();
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
    routeLayer.clearLayers();document.getElementById('route-result').hidden=true;
  }));
  document.getElementById('show-route').addEventListener('click',()=>{
    const result=document.getElementById('route-result');
    const path=findShortestPath();
    if(path.error){routeLayer.clearLayers();result.textContent=path.error;result.hidden=false;return;}
    drawRoute(path);
    result.textContent=path.edges.length?`Shortest route: ${formatDistance(path.distance)} across ${path.edges.length} ${path.edges.length===1?'edge':'edges'} for ${selected}.`:'Start and end are the same node. Route distance: 0 m.';
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
  import('./firebase-client.js').then((client)=>{cloudClient=client;client.onAuthStateChanged(client.auth,(user)=>{stopCloudSync?.();stopCloudSync=null;cloudSyncReady=false;if(!user){editorStatus.textContent=`Saved on this device · ${graphSummary()}. Sign in to sync across devices.`;return;}editorStatus.textContent='Loading the shared Manila node-and-edge graph from Firebase…';stopCloudSync=client.onSnapshot(client.doc(client.db,'cityMaps','manila'),(snapshot)=>{const remote=snapshot.exists()?snapshot.data():null;const remoteEdges=Array.isArray(remote?.edges)?remote.edges:remote?.connectors;if(remote&&Array.isArray(remote.nodes)&&Array.isArray(remoteEdges)){graph={nodes:remote.nodes,edges:remoteEdges};routeLayer.clearLayers();try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}renderGraph();updateRouteSelectionStatus();editorStatus.textContent=`Synced to Firebase · ${graphSummary()}.`;}else if(graph.nodes.length||graph.edges.length){cloudSyncReady=true;persistGraph();}else{cloudSyncReady=true;editorStatus.textContent='Connected to Firebase. Add nodes and edges to build the Manila street map.';}cloudSyncReady=true;},(error)=>{console.error('Street map sync could not start',error);editorStatus.textContent='Firebase sync is unavailable. Check Firestore setup and security rules.';});},(error)=>{console.error('Firebase authentication could not be checked for map sync',error);editorStatus.textContent='Could not check sign-in. Street changes are saved in this browser.';});}).catch((error)=>{console.error('Firebase map sync could not load',error);editorStatus.textContent='Firebase sync could not load. Street changes are saved in this browser.';});
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
