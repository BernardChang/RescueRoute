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
  const tileLayer = L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    crossOrigin: 'anonymous',
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
  const markersByNodeId=new Map();
  const routeLayer=L.layerGroup().addTo(map);
  const areaSelectionLayer=L.layerGroup().addTo(map);
  let legacyImageGraphRemoved=false;
  const normalizeGraph=(saved)=>{
    const originalNodes=Array.isArray(saved?.nodes)?saved.nodes:[];
    const originalEdges=Array.isArray(saved?.edges)?saved.edges:Array.isArray(saved?.connectors)?saved.connectors:[];
    const nodes=originalNodes.filter((node)=>node?.source!=='map-image-ai'&&!String(node?.id||'').startsWith('image-node-'));
    const nodeIds=new Set(nodes.map((node)=>node.id));
    const edges=originalEdges.filter((edge)=>edge?.source!=='map-image-ai'&&!String(edge?.id||'').startsWith('image-edge-')&&nodeIds.has(edge?.from)&&nodeIds.has(edge?.to));
    if(nodes.length!==originalNodes.length||edges.length!==originalEdges.length)legacyImageGraphRemoved=true;
    return {nodes,edges};
  };
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
  let cloudChunkCounts={nodes:0,edges:0};
  let cloudChunkGeneration=null;
  let mapSnapshotVersion=0;
  let cloudSyncReady=false;
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved&&Array.isArray(saved.nodes))graph=normalizeGraph(saved);}catch{}
  try{const saved=JSON.parse(localStorage.getItem(routeStorageKey)||'null');routeStartId=saved?.startId||null;routeEndId=saved?.endId||null;}catch{}
  const safeText=(value)=>String(value).replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const graphSummary=()=>`${graph.nodes.length} nodes · ${graph.edges.length} ${graph.edges.length===1?'edge':'edges'}`;
  const normalizeWeight=(value)=>Math.max(0,Math.min(10,Math.round(Number(value)||0)));
  const weightScore=(item)=>normalizeWeight(item?.weight);
  const accessLevelLabel=(level)=>({vehicle_accessible:'Vehicle accessible',motorcycle_only:'Motorcycle access only',pedestrian_only:'Foot access only',blocked:'Blocked to vehicles and pedestrians',uncertain:'Access uncertain'})[level]||'Not photo assessed';
  const photoAccessMarkup=(item)=>{const access=item?.photoAccess;if(!access)return '';const hazards=access.hazards||{};const findings=[['Stairs',hazards.stairs],['Stalls',hazards.stalls],['Parked vehicles',hazards.parkedVehicles],['Low wires',hazards.lowHangingWires],['Dead end',hazards.deadEnd]].filter(([,visible])=>visible).map(([label])=>label);return `<div class="photo-access-summary"><strong>Photo access: ${safeText(accessLevelLabel(access.accessLevel))}</strong><small>Car: ${access.canVehiclesPass?'yes':'no'} · Motorcycle: ${access.canMotorcyclesPass?'yes':'no'} · Foot: ${access.canPedestriansPass?'yes':'no'}</small>${findings.length?`<small>Visible: ${safeText(findings.join(', '))}</small>`:''}</div>`;};
  const photoAccessAllows=(item)=>{const access=item?.photoAccess;if(!access)return true;if(selected==='car')return access.canVehiclesPass!==false;if(selected==='motorcycle')return access.canMotorcyclesPass!==false;return access.canPedestriansPass!==false;};
  const distanceMeters=(a,b)=>{const radius=6371000,toRadians=(value)=>value*Math.PI/180;const dLat=toRadians(b.lat-a.lat),dLng=toRadians(b.lng-a.lng);const s=Math.sin(dLat/2)**2+Math.cos(toRadians(a.lat))*Math.cos(toRadians(b.lat))*Math.sin(dLng/2)**2;return radius*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));};
  const edgePoints=(edge,from,to)=>{const points=Array.isArray(edge.points)&&edge.points.length>1?edge.points.map((point)=>[Number(point[0]),Number(point[1])]):[[from.lat,from.lng],[to.lat,to.lng]];if(edge.from!==from.id)points.reverse();points[0]=[from.lat,from.lng];points[points.length-1]=[to.lat,to.lng];return points;};
  const edgeLength=(edge,from,to)=>{const points=edgePoints(edge,from,to);let distance=0;for(let i=1;i<points.length;i++)distance+=distanceMeters({lat:points[i-1][0],lng:points[i-1][1]},{lat:points[i][0],lng:points[i][1]});return distance;};
  const formatDistance=(meters)=>meters<1000?`${Math.round(meters)} m`:`${(meters/1000).toFixed(2)} km`;
  const selectedRouteLabel=()=>{const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);return `Start: ${start?.name||'not set'} · End: ${end?.name||'not set'}`;};
  function updateRouteSelectionStatus(){document.getElementById('route-selection-status').textContent=`${selectedRouteLabel()}. Hover over a node for 2 seconds to set a route point or edit its weight.`;}
  function saveRouteSelection(){try{localStorage.setItem(routeStorageKey,JSON.stringify({startId:routeStartId,endId:routeEndId}));}catch{}}
  function updateRouteMarkerStyles(){for(const [id,marker] of markersByNodeId){const icon=marker.getElement()?.querySelector('.custom-node-icon');if(!icon)continue;const isStart=id===routeStartId;icon.classList.toggle('is-route-start',isStart);icon.classList.toggle('is-route-end',id===routeEndId&&!isStart);}}
  function setRouteEndpoint(role,node){if(role==='start')routeStartId=node.id;else routeEndId=node.id;saveRouteSelection();routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateRouteSelectionStatus();updateRouteMarkerStyles();map.closePopup();}
  function allowedEdgeTypes(){return selected==='car'?new Set(['main']):selected==='motorcycle'?new Set(['main','moto']):new Set(['main','moto','foot']);}
  function findShortestPath({useWeights=true,respectOneWay=true}={}){
    const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);
    if(!start||!end)return {error:'Hover over a node and set both a start and an end point.'};
    if(start.id===end.id)return {nodes:[start],edges:[],distance:0};
    const nodeById=new Map(graph.nodes.map((node)=>[node.id,node]));const allowed=allowedEdgeTypes();const adjacency=new Map();let photoAccessExcluded=false;
    for(const edge of graph.edges){if(!allowed.has(edge.type||'main'))continue;const from=nodeById.get(edge.from),to=nodeById.get(edge.to);if(!from||!to)continue;if(!photoAccessAllows(edge)||!photoAccessAllows(from)||!photoAccessAllows(to)){photoAccessExcluded=true;continue;}const length=edgeLength(edge,from,to);const weightedLength=length*(1+weightScore(edge)+(weightScore(from)+weightScore(to))/2);for(const [nodeId,neighborId] of (edge.oneway&&respectOneWay?[[from.id,to.id]]:[[from.id,to.id],[to.id,from.id]])){if(!adjacency.has(nodeId))adjacency.set(nodeId,[]);adjacency.get(nodeId).push({edge,neighborId,cost:useWeights?weightedLength:length});}}
    const open=new Set([start.id]);const cameFrom=new Map();const gScore=new Map([[start.id,0]]);const fScore=new Map([[start.id,distanceMeters(start,end)]]);
    while(open.size){let current=null;for(const id of open)if(current===null||fScore.get(id)<fScore.get(current))current=id;if(current===end.id){const pathNodes=[end.id];const pathEdges=[];let cursor=end.id;while(cameFrom.has(cursor)){const previous=cameFrom.get(cursor);pathEdges.unshift(previous.edge);cursor=previous.nodeId;pathNodes.unshift(cursor);}const nodes=pathNodes.map((id)=>nodeById.get(id));let distance=0;let weightedCost=0;for(let i=0;i<pathEdges.length;i++){const edgeDistance=edgeLength(pathEdges[i],nodes[i],nodes[i+1]);distance+=edgeDistance;weightedCost+=edgeDistance*(1+weightScore(pathEdges[i])+(weightScore(nodes[i])+weightScore(nodes[i+1]))/2);}return {nodes,edges:pathEdges,distance,cost:weightedCost};}open.delete(current);for(const neighbor of adjacency.get(current)||[]){const tentative=gScore.get(current)+neighbor.cost;if(tentative<(gScore.get(neighbor.neighborId)??Infinity)){cameFrom.set(neighbor.neighborId,{nodeId:current,edge:neighbor.edge});gScore.set(neighbor.neighborId,tentative);fScore.set(neighbor.neighborId,tentative+distanceMeters(nodeById.get(neighbor.neighborId),end));open.add(neighbor.neighborId);}}}
    return {error:photoAccessExcluded?`No connected ${selected} route was found. Photo assessments exclude one or more roads that this travel mode cannot use.`:'No connected path was found for this travel mode.'};
  }
  function drawRoute(path,style={}){const coordinates=[];for(let i=0;i<path.edges.length;i++){const segment=edgePoints(path.edges[i],path.nodes[i],path.nodes[i+1]);coordinates.push(...(coordinates.length?segment.slice(1):segment));}if(coordinates.length<2)return null;return L.polyline(coordinates,{color:style.color||'#2865d7',weight:style.weight||9,opacity:style.opacity??.92,dashArray:style.dashArray||null,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);}
  const sameRoute=(a,b)=>a.nodes.length===b.nodes.length&&a.nodes.every((node,index)=>node.id===b.nodes[index].id)&&a.edges.every((edge,index)=>edge.id===b.edges[index].id);
  const persistGraph=()=>{
    try{localStorage.setItem(storageKey,JSON.stringify(graph));}
    catch{editorStatus.textContent='Could not save this map in this browser.';return Promise.resolve(false);}
    if(!cloudClient?.auth.currentUser){editorStatus.textContent=`Saved on this device · ${graphSummary()}. Sign in to sync across devices.`;return Promise.resolve(false);}
    if(!cloudSyncReady){editorStatus.textContent='Connecting to Firebase…';return Promise.resolve(false);}
    const copy={nodes:graph.nodes,edges:graph.edges};
    cloudWriteQueue=cloudWriteQueue.catch(()=>{}).then(async()=>{
      const itemChunks=(items)=>{const chunks=[];let current=[];let bytes=2;for(const item of items){const itemBytes=new TextEncoder().encode(JSON.stringify(item)).length+1;if(itemBytes>300000)throw new Error('A single map item is too large to save.');if(current.length&&bytes+itemBytes>300000){chunks.push(current);current=[];bytes=2;}current.push(item);bytes+=itemBytes;}if(current.length)chunks.push(current);return chunks;};
      const nodeChunks=itemChunks(copy.nodes),edgeChunks=itemChunks(copy.edges);const generation=crypto.randomUUID();
      const root=cloudClient.doc(cloudClient.db,'cityMaps','manila');const chunkCollection=cloudClient.collection(root,'chunks');
      const chunkWrites=[];
      nodeChunks.forEach((items,index)=>chunkWrites.push([cloudClient.doc(chunkCollection,`nodes_${generation}_${index}`),{kind:'nodes',generation,index,items}]));
      edgeChunks.forEach((items,index)=>chunkWrites.push([cloudClient.doc(chunkCollection,`edges_${generation}_${index}`),{kind:'edges',generation,index,items}]));
      for(let offset=0;offset<chunkWrites.length;offset+=450){const batch=cloudClient.writeBatch(cloudClient.db);for(const [reference,data] of chunkWrites.slice(offset,offset+450))batch.set(reference,data);await batch.commit();}
      const rootBatch=cloudClient.writeBatch(cloudClient.db);rootBatch.set(root,{format:'chunked-v1',generation,nodeChunks:nodeChunks.length,edgeChunks:edgeChunks.length,updatedAt:Date.now()});await rootBatch.commit();
      cloudChunkGeneration=generation;cloudChunkCounts={nodes:nodeChunks.length,edges:edgeChunks.length};
      const previousChunks=await cloudClient.getDocs(chunkCollection);const stale=[];previousChunks.forEach((chunkDoc)=>{if(chunkDoc.data().generation!==generation)stale.push(chunkDoc.ref);});
      for(let offset=0;offset<stale.length;offset+=450){const batch=cloudClient.writeBatch(cloudClient.db);stale.slice(offset,offset+450).forEach((reference)=>batch.delete(reference));await batch.commit();}
      editorStatus.textContent=`Synced to Firebase · ${graphSummary()}.`;return true;
    }).catch((error)=>{console.error('Street map sync failed',error);const detail=[error?.code,error?.message].filter(Boolean).join(': ');editorStatus.textContent=`Firebase save failed${detail?` (${detail})`:''}.`;return false;});
    return cloudWriteQueue;
  };
  function startMapWeightPhotoFlow(input,item,itemType){
    const file=input.files?.[0];input.value='';if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)){window.alert('Choose a JPEG, PNG, or WebP road photo.');return;}
    if(file.size>10*1024*1024){window.alert('Choose a photo smaller than 10 MB.');return;}
    if(!cloudClient?.auth.currentUser){window.alert('Sign in before analyzing a photo and saving its weight.');return;}
    const request={file,targetType:itemType,targetId:item.id,targetName:item.name||`${itemType==='node'?'Map node':'Street edge'}`};
    showPage('uploads',true);window.dispatchEvent(new CustomEvent('rescue:map-weight-photo',{detail:request}));
  }
  window.rescueRouteApplyMapWeight=async({targetType,targetId,weight,photoAccess})=>{const item=(targetType==='node'?graph.nodes:graph.edges).find((entry)=>entry.id===targetId);if(!item)throw new Error('This map item no longer exists. Return to the map and select it again.');if(!cloudClient?.auth.currentUser)throw new Error('Sign in before saving a map weight.');if(!cloudSyncReady)throw new Error('The shared map is still loading. Wait a moment and retry.');const oldWeight=item.weight,oldPhotoAccess=item.photoAccess;item.weight=normalizeWeight(weight);item.photoAccess=photoAccess;routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();const saved=await persistGraph();if(!saved){item.weight=oldWeight;item.photoAccess=oldPhotoAccess;try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}renderGraph();throw new Error('The suggested access and weight could not be saved to Firebase. Check the map status on the map page and retry.');}return item.weight;};
  const modeButtons=[['add-street-node','add'],['add-street-edge','edge'],['select-map-area','area']];
  function renderGraph(){
    Object.values(customLayers).forEach((layer)=>layer.clearLayers());
    customMarkers.clearLayers();
    markersByNodeId.clear();
    for(const edge of graph.edges){
      const from=graph.nodes.find((node)=>node.id===edge.from);
      const to=graph.nodes.find((node)=>node.id===edge.to);
      if(!from||!to)continue;
      const line=L.polyline(edgePoints(edge,from,to),{color:colors[edge.type]||colors.main,weight:6,opacity:.95,lineCap:'round',lineJoin:'round'}).addTo(customLayers[edge.type]||customLayers.main);
      line.bindPopup(`<div class="street-popup"><strong>${safeText(edge.name||'Street edge')}</strong><br>${safeText(from.name||'Node')} ↔ ${safeText(to.name||'Node')}${photoAccessMarkup(edge)}<div class="weight-editor"><label>Impediment weight <span><output data-edge-weight-value>${weightScore(edge)}</output>/10</span><input type="range" data-edge-weight min="0" max="10" step="1" value="${weightScore(edge)}"></label><small>0 = clear · 10 = heavily impeded</small></div><div class="weight-photo-control"><label>📷 Upload road photo to assess access and weight<input type="file" data-weight-photo accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label><small data-weight-photo-status>Review the AI result on Photo uploads, then apply it to this edge.</small></div><button type="button" data-delete-edge="${safeText(edge.id)}">Delete edge</button></div>`);
      line.on('popupopen',(event)=>{const popup=event.popup.getElement();const weightInput=popup.querySelector('[data-edge-weight]');weightInput.oninput=()=>{popup.querySelector('[data-edge-weight-value]').value=weightInput.value;popup.querySelector('[data-edge-weight-value]').textContent=weightInput.value;};weightInput.onchange=()=>{edge.weight=normalizeWeight(weightInput.value);routeLayer.clearLayers();document.getElementById('route-result').hidden=true;persistGraph();};popup.querySelector('[data-weight-photo]').onchange=(change)=>startMapWeightPhotoFlow(change.currentTarget,edge,'edge');const button=popup.querySelector('[data-delete-edge]');if(button)button.onclick=()=>{graph.edges=graph.edges.filter((item)=>item.id!==edge.id);routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();persistGraph();map.closePopup();};});
    }
    for(const node of graph.nodes){
      const routeClass=routeStartId===node.id?' is-route-start':routeEndId===node.id?' is-route-end':'';
      const markerLabel=node.kind==='intersection'?'×':safeText(node.name?.slice(0,1)||'•');
      const icon=L.divIcon({className:'',html:`<span class="custom-node-icon${edgeStart===node.id?' is-selected':''}${routeClass}">${markerLabel}</span>`,iconSize:[24,24],iconAnchor:[12,12]});
      const marker=L.marker([node.lat,node.lng],{icon,draggable:true}).addTo(customMarkers);
      markersByNodeId.set(node.id,marker);
      marker.on('dragend',()=>{const point=marker.getLatLng();node.lat=point.lat;node.lng=point.lng;routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();persistGraph();});
      marker.bindPopup(`<div class="street-popup"><strong>${safeText(node.name||'Map node')}</strong><br>${node.lat.toFixed(5)}, ${node.lng.toFixed(5)}${photoAccessMarkup(node)}<div class="weight-editor"><label>Impediment weight <span><output data-node-weight-value>${weightScore(node)}</output>/10</span><input type="range" data-node-weight min="0" max="10" step="1" value="${weightScore(node)}"></label><small>0 = clear · 10 = heavily impeded</small></div><div class="weight-photo-control"><label>📷 Upload road photo to assess access and weight<input type="file" data-weight-photo accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label><small data-weight-photo-status>Review the AI result on Photo uploads, then apply it to this node.</small></div><div class="node-route-actions"><button type="button" data-route-role="start">Set as start</button><button type="button" data-route-role="end">Set as end</button></div><button type="button" data-delete-node="${safeText(node.id)}">Delete node</button></div>`,{autoClose:true,closeOnClick:true,maxWidth:240});
      let hoverTimer=null;const cancelHoverPopup=()=>{clearTimeout(hoverTimer);hoverTimer=null;};
      marker.on('mouseover',()=>{cancelHoverPopup();if(editMode==='edge'||editMode==='area')return;hoverTimer=setTimeout(()=>marker.openPopup(),2000);});
      marker.on('mouseout dragstart click',cancelHoverPopup);
      marker.on('popupopen',(event)=>{const popup=event.popup.getElement();const weightInput=popup.querySelector('[data-node-weight]');weightInput.oninput=()=>{popup.querySelector('[data-node-weight-value]').value=weightInput.value;popup.querySelector('[data-node-weight-value]').textContent=weightInput.value;};weightInput.onchange=()=>{node.weight=normalizeWeight(weightInput.value);routeLayer.clearLayers();document.getElementById('route-result').hidden=true;persistGraph();};popup.querySelector('[data-weight-photo]').onchange=(change)=>startMapWeightPhotoFlow(change.currentTarget,node,'node');popup.querySelectorAll('[data-route-role]').forEach((button)=>{button.onclick=()=>setRouteEndpoint(button.dataset.routeRole,node);});const deleteButton=popup.querySelector('[data-delete-node]');if(deleteButton)deleteButton.onclick=()=>{graph.nodes=graph.nodes.filter((item)=>item.id!==node.id);graph.edges=graph.edges.filter((item)=>item.from!==node.id&&item.to!==node.id);if(routeStartId===node.id)routeStartId=null;if(routeEndId===node.id)routeEndId=null;saveRouteSelection();routeLayer.clearLayers();document.getElementById('route-result').hidden=true;edgeStart=null;renderGraph();persistGraph();updateRouteSelectionStatus();map.closePopup();};});
      marker.on('click',()=>{
        if(editMode==='area'){addAreaPoint(marker.getLatLng());return;}
        if(editMode==='edge'){
          if(!edgeStart){edgeStart=node.id;editorStatus.textContent=`Start node selected: ${node.name||'Node'}. Choose the other node.`;renderGraph();return;}
          if(edgeStart===node.id){edgeStart=null;editorStatus.textContent='Choose two different nodes for an edge.';renderGraph();return;}
          const start=graph.nodes.find((item)=>item.id===edgeStart);
          if(!start){edgeStart=null;editorStatus.textContent='Start node is unavailable. Select the first node again.';renderGraph();return;}
          const alreadyConnected=graph.edges.some((item)=>(item.from===start.id&&item.to===node.id)||(item.from===node.id&&item.to===start.id));
          if(alreadyConnected){edgeStart=null;editMode='';updateModeButtons();editorStatus.textContent='These nodes already have an edge.';renderGraph();return;}
          graph.edges.push({id:crypto.randomUUID(),from:start.id,to:node.id,name:nodeName.value.trim()||`${start.name||'Node'} – ${node.name||'Node'}`,type:nodeType.value,weight:0});
          edgeStart=null;editMode='';routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph();return;
        }
        marker.openPopup();
      });
    }
    for(const [type,layer] of Object.entries(customLayers)){const input=document.querySelector(`[data-layer="${type}"]`);if(input?.checked)layer.addTo(map);}
  }
  function clearAreaSelection(){areaPoints=[];areaSelectionLayer.clearLayers();document.getElementById('analyze-map-area').disabled=true;document.getElementById('cancel-map-area').hidden=true;map.doubleClickZoom.enable();}
  function paintAreaSelection(){areaSelectionLayer.clearLayers();if(!areaPoints.length)return;if(areaPoints.length===1)L.circleMarker(areaPoints[0],{radius:6,color:'#2865d7',fillColor:'#fff',fillOpacity:1,weight:3}).addTo(areaSelectionLayer);else if(areaPoints.length===2)L.polyline(areaPoints,{color:'#2865d7',weight:3,dashArray:'7 5'}).addTo(areaSelectionLayer);else L.polygon(areaPoints,{color:'#2865d7',weight:3,dashArray:'7 5',fillColor:'#5890eb',fillOpacity:.12}).addTo(areaSelectionLayer);for(const point of areaPoints)L.circleMarker(point,{radius:4,color:'#2865d7',fillColor:'#fff',fillOpacity:1,weight:2}).addTo(areaSelectionLayer);}
  function addAreaPoint(point){if(areaPoints.length>=20){editorStatus.textContent='Area boundary reached its 20-corner limit. Analyze this area or cancel it.';return;}areaPoints.push(point);paintAreaSelection();updateModeButtons();editorStatus.textContent=`Area outline: ${areaPoints.length} ${areaPoints.length===1?'corner':'corners'}. Add corners, then find OpenStreetMap crossings.`;}
  function updateModeButtons(){for(const [id,mode] of modeButtons)document.getElementById(id).classList.toggle('active',editMode===mode);document.getElementById('city-map').style.cursor=['add','area'].includes(editMode)?'crosshair':'';document.getElementById('analyze-map-area').disabled=editMode!=='area'||areaPoints.length<3||areaBusy;document.getElementById('cancel-map-area').hidden=editMode!=='area';}
  modeButtons.forEach(([id,mode])=>document.getElementById(id).addEventListener('click',()=>{if(areaBusy)return;const wasSelectingArea=editMode==='area';editMode=editMode===mode?'':mode;edgeStart=null;if(mode==='area'&&editMode==='area'){areaPoints=[];areaSelectionLayer.clearLayers();map.doubleClickZoom.disable();editorStatus.textContent='Click at least three corners around the street area, then find OSM crossings.';}else if(wasSelectingArea){clearAreaSelection();editorStatus.textContent=mode==='area'?'Area selection cancelled.':editMode==='add'?'Click the map to place an intersection node.':editMode==='edge'?'Select two nodes to create an edge between them.':'Editor ready. Add nodes, edges, or select an area.';}else editorStatus.textContent=editMode==='add'?'Click the map to place an intersection node.':editMode==='edge'?'Select two nodes to create an edge between them.':'Editor ready. Add nodes, edges, or select an area.';updateModeButtons();renderGraph();}));
  document.getElementById('cancel-map-area').addEventListener('click',()=>{if(areaBusy)return;editMode='';clearAreaSelection();updateModeButtons();editorStatus.textContent='Area selection cancelled.';});
  document.getElementById('stop-street-edit').addEventListener('click',()=>{if(areaBusy)return;editMode='';edgeStart=null;clearAreaSelection();updateModeButtons();editorStatus.textContent='Editor ready. Hover a node to set route endpoints.';renderGraph();});
  map.on('click',(event)=>{if(areaBusy)return;if(editMode==='area'){addAreaPoint(event.latlng);return;}if(editMode!=='add')return;graph.nodes.push({id:crypto.randomUUID(),name:nodeName.value.trim()||`Node ${graph.nodes.length+1}`,lat:event.latlng.lat,lng:event.latlng.lng,weight:0});editMode='';routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph();});
  document.getElementById('analyze-map-area').addEventListener('click',async()=>{
    if(areaBusy||areaPoints.length<3)return;
    const user=cloudClient?.auth.currentUser;
    if(!user){editorStatus.textContent='Sign in before asking AI to analyze a map area.';return;}
    areaBusy=true;updateModeButtons();editorStatus.textContent='Loading OpenStreetMap roads and finding actual crossings…';
    try{
      const token=await user.getIdToken();
      const response=await fetch('/api/map/analyze-area',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({polygon:areaPoints.map((point)=>[point.lat,point.lng])})});
      const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'OpenStreetMap graph creation could not complete.');
      const knownNodes=new Set(graph.nodes.map((node)=>node.id));const knownEdges=new Set(graph.edges.map((edge)=>edge.id));
      const newNodes=(result.nodes||[]).filter((node)=>!knownNodes.has(node.id));const newEdges=(result.edges||[]).filter((edge)=>!knownEdges.has(edge.id));
      graph.nodes.push(...newNodes);graph.edges.push(...newEdges);editMode='';clearAreaSelection();routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph();
      editorStatus.textContent=`${result.summary||'OpenStreetMap street analysis complete.'} Added ${newNodes.length} new nodes and ${newEdges.length} new edges.`;
    }catch(error){editorStatus.textContent=error.message||'OpenStreetMap graph creation failed. Please retry.';}
    finally{areaBusy=false;updateModeButtons();}
  });
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
    const distancePath=findShortestPath({useWeights:false});
    const openDirectionPath=findShortestPath({useWeights:false,respectOneWay:false});
    routeLayer.clearLayers();
    if(path.error){result.textContent=path.error;result.hidden=false;return;}
    const routeLines=[];
    const routesAreSame=!distancePath.error&&sameRoute(path,distancePath);
    if(!distancePath.error&&!routesAreSame)routeLines.push(drawRoute(distancePath,{color:'#7b8995',weight:7,opacity:.72,dashArray:'8 7'}));
    routeLines.push(drawRoute(path));
    const visibleLines=routeLines.filter(Boolean);
    if(visibleLines.length)map.fitBounds(L.featureGroup(visibleLines).getBounds(),{padding:[42,42],maxZoom:17});
    if(!path.edges.length)result.textContent='Start and end are the same node. Route distance and adjusted cost: 0 m.';
    else if(routesAreSame)result.textContent=`A* kept the same route as distance-only shortest: ${formatDistance(path.distance)}; weight-adjusted cost ${formatDistance(path.cost)}. No lower-cost route is connected for ${selected} under the current one-way rules.`;
    else result.textContent=`Weight-aware A*: ${formatDistance(path.distance)} physical, cost ${formatDistance(path.cost)}. Gray dashed line: distance-only shortest is ${distancePath.error?'unavailable':`${formatDistance(distancePath.distance)} physical (cost ${formatDistance(distancePath.cost)})`}.`;
    if(!openDirectionPath.error&&!distancePath.error&&openDirectionPath.distance+1>distancePath.distance)result.textContent+=` One-way restrictions exclude a shorter ${formatDistance(openDirectionPath.distance)} path.`;
    else if(distancePath.error&&!openDirectionPath.error)result.textContent+=' A path exists only if one-way restrictions are ignored.';
    result.textContent+=' Photo access checks are applied for this travel mode; roads marked inaccessible are excluded.';
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
  import('./firebase-client.js').then((client)=>{cloudClient=client;client.onAuthStateChanged(client.auth,(user)=>{stopCloudSync?.();stopCloudSync=null;cloudSyncReady=false;editorStatus.textContent=user?'Loading the shared Manila street graph from Firebase…':'Loading the shared Manila street graph…';stopCloudSync=client.onSnapshot(client.doc(client.db,'cityMaps','manila'),async(snapshot)=>{const version=++mapSnapshotVersion;const remote=snapshot.exists()?snapshot.data():null;try{if(remote?.format==='chunked-v1'){cloudChunkCounts={nodes:Number(remote.nodeChunks)||0,edges:Number(remote.edgeChunks)||0};cloudChunkGeneration=remote.generation||null;const chunksSnapshot=await client.getDocs(client.collection(client.doc(client.db,'cityMaps','manila'),'chunks'));if(version!==mapSnapshotVersion)return;const pieces={nodes:[],edges:[]};chunksSnapshot.forEach((chunkDoc)=>{const chunk=chunkDoc.data();if(remote.generation&&chunk.generation!==remote.generation)return;if((chunk.kind==='nodes'||chunk.kind==='edges')&&Array.isArray(chunk.items))pieces[chunk.kind].push([Number.isInteger(chunk.index)?chunk.index:Number(chunkDoc.id.split('_').at(-1)),chunk.items]);});for(const kind of ['nodes','edges']){pieces[kind].sort((a,b)=>a[0]-b[0]);const expected=cloudChunkCounts[kind];if(pieces[kind].length!==expected)throw new Error(`Firebase map data is incomplete (${kind} chunks: ${pieces[kind].length}/${expected}).`);}graph=normalizeGraph({nodes:pieces.nodes.flatMap((chunk)=>chunk[1]),edges:pieces.edges.flatMap((chunk)=>chunk[1])});}else{const remoteEdges=Array.isArray(remote?.edges)?remote.edges:remote?.connectors;if(remote&&Array.isArray(remote.nodes)&&Array.isArray(remoteEdges)){graph=normalizeGraph({nodes:remote.nodes,edges:remoteEdges});cloudChunkCounts={nodes:0,edges:0};cloudChunkGeneration=null;}else{cloudSyncReady=true;cloudChunkGeneration=null;cloudChunkCounts={nodes:0,edges:0};if(graph.nodes.length||graph.edges.length){if(user)persistGraph();else editorStatus.textContent='No shared map exists yet. Sign in before saving the first shared nodes and edges.';}else editorStatus.textContent=user?'Connected to Firebase. Add nodes and edges to build the Manila street map.':'No shared map exists yet. Sign in to create the Manila street map.';return;}}if(version!==mapSnapshotVersion)return;routeLayer.clearLayers();try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}renderGraph();updateRouteSelectionStatus();cloudSyncReady=true;editorStatus.textContent=user?`Synced to Firebase · ${graphSummary()}.`:`Loaded shared map from Firebase · ${graphSummary()}. Sign in to save edits for everyone.`;if(user&&legacyImageGraphRemoved){legacyImageGraphRemoved=false;persistGraph();editorStatus.textContent='Removed the old screenshot-guessed graph. New auto-created roads now come directly from OpenStreetMap crossings.';}}catch(error){if(version!==mapSnapshotVersion)return;cloudSyncReady=false;console.error('Street map data could not be loaded',error);editorStatus.textContent=`Firebase map load failed (${error?.code||'data'}: ${error?.message||'could not read map chunks'}).`;}},(error)=>{cloudSyncReady=false;console.error('Street map sync could not start',error);editorStatus.textContent=`Firebase sync failed (${error?.code||'unknown'}: ${error?.message||'check Firestore access'}).`;});},(error)=>{console.error('Firebase authentication could not be checked for map sync',error);editorStatus.textContent='Could not check sign-in. Street changes are saved in this browser.';});}).catch((error)=>{console.error('Firebase map sync could not load',error);editorStatus.textContent=`Firebase map sync could not load (${error?.code||'unknown'}: ${error?.message||'check Firebase configuration'}).`;});
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
