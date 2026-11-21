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
  const colors = {main:'#2563eb',moto:'#dc2626',foot:'#16a34a',unmarked:'#f59e0b'};
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
  const areaLayer=L.layerGroup().addTo(map);
  let areaPoints=[];
  let areaAnalysisBusy=false;
  const markersByNodeId=new Map();
  const routeLayer=L.layerGroup().addTo(map);
  const restoreEdgeGeometry=(edge)=>{
    if(edge?._rrPointEncoding!=='flat-latlng-v1'||!Array.isArray(edge.points))return edge;
    const points=[];
    for(let index=0;index+1<edge.points.length;index+=2)points.push([Number(edge.points[index]),Number(edge.points[index+1])]);
    const {_rrPointEncoding,...rest}=edge;
    return {...rest,points};
  };
  const normalizeGraph=(saved)=>{
    const originalNodes=Array.isArray(saved?.nodes)?saved.nodes:[];
    const originalEdges=Array.isArray(saved?.edges)?saved.edges:Array.isArray(saved?.connectors)?saved.connectors:[];
    const nodes=originalNodes;
    const nodeIds=new Set(nodes.map((node)=>node.id));
    const edges=originalEdges.filter((edge)=>nodeIds.has(edge?.from)&&nodeIds.has(edge?.to)).map(restoreEdgeGeometry);
    return {nodes,edges};
  };
  let graph={nodes:[],edges:[]};
  let editMode='';
  let edgeStart=null;
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
  const photoAccessMarkup=(item)=>{const access=item?.photoAccess;if(!access)return '';const hazards=access.hazards||{};const findings=[['Stairs',hazards.stairs],['Stalls',hazards.stalls],['Parked vehicles',hazards.parkedVehicles],['Low wires',hazards.lowHangingWires],['Dead end',hazards.deadEnd]].filter(([,visible])=>visible).map(([label])=>label);const width=Number.isFinite(access.estimatedClearWidthMeters)?`<small>Estimated clear width: ${access.estimatedClearWidthMeters.toFixed(1)} m (${safeText(access.widthEstimateConfidence||'unrated')} confidence)</small>`:'';return `<div class="photo-access-summary"><strong>Photo access: ${safeText(accessLevelLabel(access.accessLevel))}</strong><small>Car: ${access.canVehiclesPass?'yes':'no'} · Motorcycle: ${access.canMotorcyclesPass?'yes':'no'} · Foot: ${access.canPedestriansPass?'yes':'no'}</small>${width}${findings.length?`<small>Visible: ${safeText(findings.join(', '))}</small>`:''}${access.photoName?`<small>Evidence photo: ${safeText(access.photoName)}</small>`:''}</div>`;};
  const nodeRoadStatusMarkup=(node,weight=weightScore(node))=>{
    const access=node?.photoAccess;
    const score=normalizeWeight(weight);
    const modes=[['Car',access?.canVehiclesPass],['Motorcycle',access?.canMotorcyclesPass],['Foot',access?.canPedestriansPass]];
    const status=(canPass)=>canPass===false?['Blocked','is-blocked']:score>0?['Impeded','is-impeded']:canPass===true?['Clear','is-clear']:['Not assessed','is-unknown'];
    return `<div class="node-road-status" data-node-road-status role="list" aria-label="Travel access and impediment status">${modes.map(([mode,canPass])=>{const [label,className]=status(canPass);return `<span class="node-road-chip ${className}" role="listitem"><strong>${mode}</strong><span>${label}</span></span>`;}).join('')}</div>`;
  };
  const photoAccessAllows=(item)=>{const access=item?.photoAccess;if(!access)return true;if(selected==='car')return access.canVehiclesPass!==false;if(selected==='motorcycle')return access.canMotorcyclesPass!==false;return access.canPedestriansPass!==false;};
  const distanceMeters=(a,b)=>{const radius=6371000,toRadians=(value)=>value*Math.PI/180;const dLat=toRadians(b.lat-a.lat),dLng=toRadians(b.lng-a.lng);const s=Math.sin(dLat/2)**2+Math.cos(toRadians(a.lat))*Math.cos(toRadians(b.lat))*Math.sin(dLng/2)**2;return radius*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));};
  const edgePoints=(edge,from,to)=>{const points=Array.isArray(edge.points)&&edge.points.length>1?edge.points.map((point)=>[Number(point[0]),Number(point[1])]):[[from.lat,from.lng],[to.lat,to.lng]];if(edge.from!==from.id)points.reverse();points[0]=[from.lat,from.lng];points[points.length-1]=[to.lat,to.lng];return points;};
  const edgeLength=(edge,from,to)=>{const points=edgePoints(edge,from,to);let distance=0;for(let i=1;i<points.length;i++)distance+=distanceMeters({lat:points[i-1][0],lng:points[i-1][1]},{lat:points[i][0],lng:points[i][1]});return distance;};
  const formatDistance=(meters)=>meters<1000?`${Math.round(meters)} m`:`${(meters/1000).toFixed(2)} km`;
  const selectedRouteLabel=()=>{const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);return `Start: ${start?.name||'not set'} · End: ${end?.name||'not set'}`;};
  function updateRouteSelectionStatus(){document.getElementById('route-selection-status').textContent=`${selectedRouteLabel()}. Hover over a node for 2 seconds to set a route point or edit its weight.`;}
  function saveRouteSelection(){try{localStorage.setItem(routeStorageKey,JSON.stringify({startId:routeStartId,endId:routeEndId}));}catch{}}
  function updateRouteMarkerStyles(){for(const [id,marker] of markersByNodeId){const icon=marker.getElement()?.querySelector('.custom-node-icon');if(!icon)continue;const isStart=id===routeStartId;icon.classList.toggle('is-route-start',isStart);icon.classList.toggle('is-route-end',id===routeEndId&&!isStart);}}
  function setRouteEndpoint(role,node){
    if(role!=='start'&&role!=='end')return;
    if(!graph.nodes.some((item)=>item.id===node.id))return;
    if(role==='start')routeStartId=node.id;
    else routeEndId=node.id;
    saveRouteSelection();
    routeLayer.clearLayers();
    document.getElementById('route-result').hidden=true;
    map.closePopup();
    renderGraph();
    updateRouteSelectionStatus();
    editorStatus.textContent=`${role==='start'?'Start':'End'} node set to ${node.name||'Map node'}.`;
    refreshRouteIfReady();
  }
  async function deleteNode(nodeId){
    const node=graph.nodes.find((item)=>item.id===nodeId);
    if(!node)return;
    const previousGraph=graph;
    const previousStartId=routeStartId;
    const previousEndId=routeEndId;
    const previousEdgeStart=edgeStart;
    const signedIn=Boolean(cloudClient?.auth.currentUser);
    if(signedIn&&!cloudSyncReady){editorStatus.textContent='Wait for the shared Firebase map to finish loading, then delete the node again.';return;}
    const canSync=Boolean(cloudClient?.auth.currentUser&&cloudSyncReady);
    graph={
      nodes:graph.nodes.filter((item)=>item.id!==nodeId),
      edges:graph.edges.filter((item)=>item.from!==nodeId&&item.to!==nodeId)
    };
    if(routeStartId===nodeId)routeStartId=null;
    if(routeEndId===nodeId)routeEndId=null;
    if(edgeStart===nodeId)edgeStart=null;
    saveRouteSelection();
    routeLayer.clearLayers();
    document.getElementById('route-result').hidden=true;
    map.closePopup();
    renderGraph();
    updateRouteSelectionStatus();
    const saved=await persistGraph();
    if(saved||!canSync)refreshRouteIfReady();
    if(!saved&&canSync){
      graph=previousGraph;
      routeStartId=previousStartId;
      routeEndId=previousEndId;
      edgeStart=previousEdgeStart;
      saveRouteSelection();
      try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}
      renderGraph();
      updateRouteSelectionStatus();
      refreshRouteIfReady();
      const reason=editorStatus.textContent;
      editorStatus.textContent=reason&&reason.startsWith('Firebase save failed')
        ?`Node was kept because Firebase rejected the delete. ${reason}`
        :'Node was kept because the shared map could not be saved. Retry when Firebase is connected.';
    }
  }
  document.addEventListener('click',(event)=>{
    const target=event.target instanceof Element?event.target:null;
    const routeButton=target?.closest('[data-route-role][data-route-node-id]');
    if(routeButton){
      event.preventDefault();
      event.stopPropagation();
      const node=graph.nodes.find((item)=>item.id===routeButton.dataset.routeNodeId);
      if(node)setRouteEndpoint(routeButton.dataset.routeRole,node);
      return;
    }
    const deleteButton=target?.closest('[data-delete-node]');
    if(deleteButton){
      event.preventDefault();
      event.stopPropagation();
      deleteNode(deleteButton.dataset.deleteNode);
    }
  },true);
  function allowedEdgeTypes(){return selected==='car'?new Set(['main']):selected==='motorcycle'?new Set(['main','moto']):new Set(['main','moto','foot']);}
  function findShortestPath({useWeights=true,respectOneWay=true,ignorePhotoAccess=false}={}){
    const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);
    if(!start||!end)return {error:'Hover over a node and set both a start and an end point.'};
    if(start.id===end.id)return {nodes:[start],edges:[],distance:0};
    const nodeById=new Map(graph.nodes.map((node)=>[node.id,node]));const allowed=allowedEdgeTypes();const adjacency=new Map();let photoAccessExcluded=false;
    for(const edge of graph.edges){if(!allowed.has(edge.type||'main'))continue;const from=nodeById.get(edge.from),to=nodeById.get(edge.to);if(!from||!to)continue;const edgeBlocked=!photoAccessAllows(edge),fromBlocked=!photoAccessAllows(from),toBlocked=!photoAccessAllows(to);if(edgeBlocked||fromBlocked||toBlocked)photoAccessExcluded=true;if(!ignorePhotoAccess&&(edgeBlocked||fromBlocked||toBlocked))continue;const length=edgeLength(edge,from,to);const weightedLength=length*(1+weightScore(edge)+(weightScore(from)+weightScore(to))/2);for(const [nodeId,neighborId] of (edge.oneway&&respectOneWay?[[from.id,to.id]]:[[from.id,to.id],[to.id,from.id]])){if(!adjacency.has(nodeId))adjacency.set(nodeId,[]);adjacency.get(nodeId).push({edge,neighborId,cost:useWeights?weightedLength:length});}}
    const open=new Set([start.id]);const cameFrom=new Map();const gScore=new Map([[start.id,0]]);const fScore=new Map([[start.id,distanceMeters(start,end)]]);
    while(open.size){let current=null;for(const id of open)if(current===null||fScore.get(id)<fScore.get(current))current=id;if(current===end.id){const pathNodes=[end.id];const pathEdges=[];let cursor=end.id;while(cameFrom.has(cursor)){const previous=cameFrom.get(cursor);pathEdges.unshift(previous.edge);cursor=previous.nodeId;pathNodes.unshift(cursor);}const nodes=pathNodes.map((id)=>nodeById.get(id));let distance=0;let weightedCost=0;for(let i=0;i<pathEdges.length;i++){const edgeDistance=edgeLength(pathEdges[i],nodes[i],nodes[i+1]);distance+=edgeDistance;weightedCost+=edgeDistance*(1+weightScore(pathEdges[i])+(weightScore(nodes[i])+weightScore(nodes[i+1]))/2);}return {nodes,edges:pathEdges,distance,cost:weightedCost};}open.delete(current);for(const neighbor of adjacency.get(current)||[]){const tentative=gScore.get(current)+neighbor.cost;if(tentative<(gScore.get(neighbor.neighborId)??Infinity)){cameFrom.set(neighbor.neighborId,{nodeId:current,edge:neighbor.edge});gScore.set(neighbor.neighborId,tentative);fScore.set(neighbor.neighborId,tentative+distanceMeters(nodeById.get(neighbor.neighborId),end));open.add(neighbor.neighborId);}}}
    return {error:photoAccessExcluded&&!ignorePhotoAccess?`No connected ${selected} route was found because photo access restrictions block the available paths.`:'No connected path was found for this travel mode.'};
  }
  function drawRoute(path,style={}){const coordinates=[];for(let i=0;i<path.edges.length;i++){const segment=edgePoints(path.edges[i],path.nodes[i],path.nodes[i+1]);coordinates.push(...(coordinates.length?segment.slice(1):segment));}if(coordinates.length<2)return null;return L.polyline(coordinates,{color:style.color||'#2865d7',weight:style.weight||9,opacity:style.opacity??.92,dashArray:style.dashArray||null,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);}
  function findAccessBottleneck(){
    const start=graph.nodes.find((node)=>node.id===routeStartId);const end=graph.nodes.find((node)=>node.id===routeEndId);if(!start||!end)return [];
    const nodeById=new Map(graph.nodes.map((node)=>[node.id,node]));const allowed=allowedEdgeTypes();const network=new Map();const original=[];const infinity=1e6;const ensure=(id)=>{if(!network.has(id))network.set(id,[]);return network.get(id);};
    const addArc=(from,to,capacity,blocker=null)=>{const forward={to,rev:ensure(to).length,capacity,initial:capacity,blocker};const reverse={to:from,rev:ensure(from).length,capacity:0,initial:0,blocker:null};ensure(from).push(forward);ensure(to).push(reverse);original.push({from,to,arc:forward});};
    const inId=(id)=>`node:${id}:in`;const outId=(id)=>`node:${id}:out`;
    for(const node of graph.nodes){const blocked=!photoAccessAllows(node);addArc(inId(node.id),outId(node.id),blocked?1:infinity,blocked?{type:'node',item:node}:null);}
    addArc('source',inId(start.id),infinity);addArc(outId(end.id),'sink',infinity);
    for(const edge of graph.edges){if(!allowed.has(edge.type||'main'))continue;const from=nodeById.get(edge.from);const to=nodeById.get(edge.to);if(!from||!to)continue;const blocked=!photoAccessAllows(edge);const blocker=blocked?{type:'edge',item:edge}:null;addArc(outId(from.id),inId(to.id),blocked?1:infinity,blocker);if(!edge.oneway)addArc(outId(to.id),inId(from.id),blocked?1:infinity,blocker);}
    let flow=0;
    while(true){const parent=new Map([['source',null]]);const queue=['source'];for(let head=0;head<queue.length&&!parent.has('sink');head++){const from=queue[head];for(let index=0;index<ensure(from).length;index++){const arc=ensure(from)[index];if(arc.capacity<=0||parent.has(arc.to))continue;parent.set(arc.to,{from,index});queue.push(arc.to);if(arc.to==='sink')break;}}if(!parent.has('sink'))break;let amount=infinity;for(let cursor='sink';cursor!=='source';){const step=parent.get(cursor);amount=Math.min(amount,ensure(step.from)[step.index].capacity);cursor=step.from;}for(let cursor='sink';cursor!=='source';){const step=parent.get(cursor);const arc=ensure(step.from)[step.index];arc.capacity-=amount;ensure(cursor)[arc.rev].capacity+=amount;cursor=step.from;}flow+=amount;if(flow>=infinity)break;}
    if(flow>=infinity)return [];
    const reachable=new Set(['source']);const queue=['source'];for(let head=0;head<queue.length;head++){const from=queue[head];for(const arc of ensure(from)){if(arc.capacity>0&&!reachable.has(arc.to)){reachable.add(arc.to);queue.push(arc.to);}}}
    const blockers=[];const seen=new Set();for(const entry of original){if(entry.arc.initial!==1||!entry.arc.blocker||!reachable.has(entry.from)||reachable.has(entry.to))continue;const key=`${entry.arc.blocker.type}:${entry.arc.blocker.item.id}`;if(!seen.has(key)){seen.add(key);blockers.push(entry.arc.blocker);}}
    return blockers;
  }
  function highlightAccessBlockers(blockers){
    for(const blocker of blockers){if(blocker.type==='edge'){const edge=blocker.item;const from=graph.nodes.find((node)=>node.id===edge.from);const to=graph.nodes.find((node)=>node.id===edge.to);if(from&&to)L.polyline(edgePoints(edge,from,to),{color:'#c62828',weight:12,opacity:.9,dashArray:'7 5',lineCap:'round',lineJoin:'round'}).addTo(routeLayer);}else{const node=blocker.item;L.circleMarker([node.lat,node.lng],{radius:13,color:'#b42318',weight:4,fillColor:'#ffd8d5',fillOpacity:.95}).addTo(routeLayer);}}
    if(blockers.length){const layers=routeLayer.getLayers();if(layers.length)map.fitBounds(L.featureGroup(layers).getBounds(),{padding:[42,42],maxZoom:18});}
  }
  const accessBlockerLabel=(blocker)=>{if(blocker.type==='node')return `Node: ${blocker.item.name||'Map node'} (${blocker.item.lat.toFixed(5)}, ${blocker.item.lng.toFixed(5)})`;const edge=blocker.item;const from=graph.nodes.find((node)=>node.id===edge.from);const to=graph.nodes.find((node)=>node.id===edge.to);return `Edge: ${edge.name||'Unnamed edge'} (${from?.name||edge.from} → ${to?.name||edge.to})`;};
  const sameRoute=(a,b)=>a.nodes.length===b.nodes.length&&a.nodes.every((node,index)=>node.id===b.nodes[index].id)&&a.edges.every((edge,index)=>edge.id===b.edges[index].id);
  function updateRouteDisplay({fitBounds=true}={}){
    const result=document.getElementById('route-result');const path=findShortestPath();routeLayer.clearLayers();
    if(path.error){
      if(path.error.includes('photo access')){
        const unrestricted=findShortestPath({useWeights:false,ignorePhotoAccess:true});
        if(!unrestricted.error){const blockers=findAccessBottleneck();if(blockers.length){highlightAccessBlockers(blockers);result.textContent=`No connected ${selected} route. ${blockers.length===1?'This map item forms':'These map items form'} the photo access bottleneck: ${blockers.map(accessBlockerLabel).join('; ')}. Highlighted in red.`;}else result.textContent=`No connected ${selected} route. Photo access blocks the available paths, but no single bottleneck could be isolated.`;}
        else result.textContent=`No connected ${selected} route. The map has no path for this travel mode even when photo access restrictions are ignored.`;
      }else result.textContent=path.error;
      result.hidden=false;return false;
    }
    const distancePath=findShortestPath({useWeights:false});const openDirectionPath=findShortestPath({useWeights:false,respectOneWay:false});
    const routeLines=[];const routesAreSame=!distancePath.error&&sameRoute(path,distancePath);
    if(!distancePath.error&&!routesAreSame)routeLines.push(drawRoute(distancePath,{color:'#0b8f6a',weight:7,opacity:.96,dashArray:'10 7'}));
    if(path.edges.length)routeLines.push(drawRoute(path));
    const visibleLines=routeLines.filter(Boolean);if(fitBounds&&visibleLines.length)map.fitBounds(L.featureGroup(visibleLines).getBounds(),{padding:[42,42],maxZoom:17});
    if(!path.edges.length)result.textContent='Start and end are the same node. Route distance and adjusted cost: 0 m.';
    else if(routesAreSame)result.textContent=`The weight-aware route is also the shortest-distance route for ${selected}: ${formatDistance(path.distance)}. Its adjusted cost is ${formatDistance(path.cost)}.`;
    else result.textContent=`Primary blue line: lowest weight-adjusted cost (${formatDistance(path.distance)} physical distance; adjusted cost ${formatDistance(path.cost)}). Green dashed line: shortest physical distance allowed for ${selected} (${distancePath.error?'unavailable':formatDistance(distancePath.distance)}).`;
    if(!openDirectionPath.error&&!distancePath.error&&openDirectionPath.distance+1>distancePath.distance)result.textContent+=` One-way restrictions exclude a shorter ${formatDistance(openDirectionPath.distance)} path.`;
    else if(distancePath.error&&!openDirectionPath.error)result.textContent+=' A path exists only if one-way restrictions are ignored.';
    result.textContent+=' Both routes respect road type, one-way direction, and photo access; the blue route also accounts for impediment weights.';result.hidden=false;return true;
  }
  function refreshRouteIfReady(){if(routeStartId&&routeEndId)return updateRouteDisplay({fitBounds:true});return false;}
  const persistGraph=()=>{
    try{localStorage.setItem(storageKey,JSON.stringify(graph));}
    catch{editorStatus.textContent='Could not save this map in this browser.';return Promise.resolve(false);}
    if(!cloudClient?.auth.currentUser){editorStatus.textContent=`Saved on this device · ${graphSummary()}. Sign in to sync across devices.`;return Promise.resolve(false);}
    if(!cloudSyncReady){editorStatus.textContent='Connecting to Firebase…';return Promise.resolve(false);}
    const copy={nodes:graph.nodes,edges:graph.edges.map((edge)=>{
      if(!Array.isArray(edge.points)||!edge.points.some(Array.isArray))return edge;
      return {...edge,points:edge.points.flat(Infinity),_rrPointEncoding:'flat-latlng-v1'};
    })};
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
      editorStatus.textContent=`Synced to Firebase · ${graphSummary()}.`;
      // The root now points at the fully written generation. Old chunks are
      // unreachable, so a cleanup permission/network error must not undo a
      // successful map save or make the caller roll back its visible weight.
      try{
        const previousChunks=await cloudClient.getDocs(chunkCollection);const stale=[];previousChunks.forEach((chunkDoc)=>{if(chunkDoc.data().generation!==generation)stale.push(chunkDoc.ref);});
        for(let offset=0;offset<stale.length;offset+=450){const batch=cloudClient.writeBatch(cloudClient.db);stale.slice(offset,offset+450).forEach((reference)=>batch.delete(reference));await batch.commit();}
      }catch(cleanupError){console.warn('Map saved to Firebase, but old map chunks could not be cleaned up',cleanupError);}
      return true;
    }).catch((error)=>{console.error('Street map sync failed',error);const detail=[error?.code,error?.message].filter(Boolean).join(': ');editorStatus.textContent=`Firebase save failed${detail?` (${detail})`:''}.`;return false;});
    return cloudWriteQueue;
  };
  function startMapWeightPhotoFlow(input,item,itemType){
    const file=input.files?.[0];input.value='';if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)){window.alert('Choose a JPEG, PNG, or WebP road photo.');return;}
    if(file.size>10*1024*1024){window.alert('Choose a photo smaller than 10 MB.');return;}
    if(!cloudClient?.auth.currentUser){window.alert('Sign in before analyzing a photo and saving its weight.');return;}
    const request={id:crypto.randomUUID(),file,targetType:itemType,targetId:item.id,targetName:item.name||`${itemType==='node'?'Map node':'Street edge'}`,uploaderEmail:cloudClient.auth.currentUser.email||''};
    showPage('uploads',true);window.dispatchEvent(new CustomEvent('rescue:map-weight-photo',{detail:request}));
  }
  // Leaflet can recreate popup contents between opening and file selection.
  // Delegate the change event from the document so map photo inputs stay wired
  // even when a popup is reopened or its DOM is replaced.
  document.addEventListener('change',(event)=>{
    const input=event.target instanceof Element?event.target.closest('[data-weight-photo]'):null;
    if(!input)return;
    const targetType=input.dataset.weightPhotoTargetType;
    const items=targetType==='node'?graph.nodes:targetType==='edge'?graph.edges:null;
    const item=items?.find((entry)=>entry.id===input.dataset.weightPhotoTargetId);
    if(item)startMapWeightPhotoFlow(input,item,targetType);
    else input.value='';
  },true);
  window.rescueRouteApplyMapWeight=async({targetType,targetId,weight,photoAccess})=>{const item=(targetType==='node'?graph.nodes:graph.edges).find((entry)=>entry.id===targetId);if(!item)throw new Error('This map item no longer exists. Return to the map and select it again.');if(!cloudClient?.auth.currentUser)throw new Error('Sign in before saving a map weight.');if(!cloudSyncReady)throw new Error('The shared map is still loading. Wait a moment and retry.');const oldWeight=item.weight,oldPhotoAccess=item.photoAccess;item.weight=normalizeWeight(weight);item.photoAccess=photoAccess;routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();const saved=await persistGraph();if(!saved){const firebaseReason=editorStatus.textContent||'Firebase did not confirm the save.';item.weight=oldWeight;item.photoAccess=oldPhotoAccess;try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}renderGraph();throw new Error(`The suggested access and weight were not saved. ${firebaseReason}`);}refreshRouteIfReady();return item.weight;};
  const modeButtons=[['add-street-node','add'],['add-street-edge','edge'],['select-map-area','area']];
  const analyzeAreaButton=document.getElementById('analyze-map-area');
  const cancelAreaButton=document.getElementById('cancel-map-area');
  const readableApiError=(payload,fallback)=>{
    const error=payload?.error;
    if(typeof error==='string'&&error.trim())return error;
    if(error&&typeof error==='object'){
      const message=error.message||error.error?.message||error.detail||error.code;
      if(typeof message==='string'&&message.trim())return message;
    }
    if(typeof payload?.message==='string'&&payload.message.trim())return payload.message;
    return fallback;
  };
  function updateAreaSelection(){
    areaLayer.clearLayers();
    for(const point of areaPoints)L.circleMarker([point.lat,point.lng],{radius:6,color:'#fff',weight:2,fillColor:'#2865d7',fillOpacity:1,interactive:false}).addTo(areaLayer);
    if(areaPoints.length>1)L.polyline([...areaPoints.map((point)=>[point.lat,point.lng]),...(areaPoints.length>=3?[[areaPoints[0].lat,areaPoints[0].lng]]:[])],{color:'#2865d7',weight:3,dashArray:'8 7',interactive:false}).addTo(areaLayer);
    analyzeAreaButton.disabled=areaPoints.length<3||areaAnalysisBusy;
    cancelAreaButton.hidden=editMode!=='area';
  }
  function addAreaPoint(point){
    if(areaPoints.length>=20){editorStatus.textContent='Area outlines can have up to 20 corners.';return;}
    areaPoints.push({lat:point.lat,lng:point.lng});
    updateAreaSelection();
    editorStatus.textContent=areaPoints.length<3?`Area corner ${areaPoints.length} added. Add at least ${3-areaPoints.length} more.`:`Area selected with ${areaPoints.length} corners. Analyze to find its OSM intersections.`;
  }
  function clearAreaSelection(){areaPoints=[];areaLayer.clearLayers();areaAnalysisBusy=false;analyzeAreaButton.disabled=true;analyzeAreaButton.textContent='Analyze intersections with AI';cancelAreaButton.hidden=true;}
  function renderGraph(){
    Object.values(customLayers).forEach((layer)=>layer.clearLayers());
    customMarkers.clearLayers();
    markersByNodeId.clear();
    for(const edge of graph.edges){
      const from=graph.nodes.find((node)=>node.id===edge.from);
      const to=graph.nodes.find((node)=>node.id===edge.to);
      if(!from||!to)continue;
      const line=L.polyline(edgePoints(edge,from,to),{color:colors[edge.type]||colors.unmarked,weight:6,opacity:.95,lineCap:'round',lineJoin:'round'}).addTo(customLayers[edge.type]||customLayers.main);
      line.bindPopup(`<div class="street-popup"><strong>${safeText(edge.name||'Street edge')}</strong><br>${safeText(from.name||'Node')} ↔ ${safeText(to.name||'Node')}${photoAccessMarkup(edge)}<div class="weight-editor"><label>Impediment weight <span><output data-edge-weight-value>${weightScore(edge)}</output>/10</span><input type="range" data-edge-weight min="0" max="10" step="1" value="${weightScore(edge)}"></label><small>0 = clear · 10 = heavily impeded</small></div><div class="weight-photo-control"><label>📷 Upload road photo to assess access and weight<input type="file" data-weight-photo data-weight-photo-target-type="edge" data-weight-photo-target-id="${safeText(edge.id)}" accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label><small data-weight-photo-status>Review the AI result on Photo uploads, then apply it to this edge.</small></div><button type="button" data-delete-edge="${safeText(edge.id)}">Delete edge</button></div>`);
      line.on('popupopen',(event)=>{const popup=event.popup.getElement();const weightInput=popup.querySelector('[data-edge-weight]');weightInput.oninput=()=>{popup.querySelector('[data-edge-weight-value]').value=weightInput.value;popup.querySelector('[data-edge-weight-value]').textContent=weightInput.value;};weightInput.onchange=()=>{edge.weight=normalizeWeight(weightInput.value);persistGraph().then(refreshRouteIfReady);};const button=popup.querySelector('[data-delete-edge]');if(button)button.onclick=()=>{graph.edges=graph.edges.filter((item)=>item.id!==edge.id);routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();persistGraph().then(refreshRouteIfReady);map.closePopup();};});
    }
    for(const node of graph.nodes){
      const routeClass=routeStartId===node.id?' is-route-start':routeEndId===node.id?' is-route-end':'';
      const icon=L.divIcon({className:'',html:`<span class="custom-node-icon${edgeStart===node.id?' is-selected':''}${routeClass}" aria-hidden="true"></span>`,iconSize:[24,24],iconAnchor:[12,12]});
      const marker=L.marker([node.lat,node.lng],{icon,draggable:true,title:node.name||'Map node',alt:node.name||'Map node'}).addTo(customMarkers);
      markersByNodeId.set(node.id,marker);
      marker.on('dragend',()=>{const point=marker.getLatLng();node.lat=point.lat;node.lng=point.lng;routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();persistGraph().then(refreshRouteIfReady);});
      marker.bindPopup(`<div class="street-popup"><strong>${safeText(node.name||'Map node')}</strong><br>${node.lat.toFixed(5)}, ${node.lng.toFixed(5)}<div class="node-route-actions"><button type="button" data-route-role="start" data-route-node-id="${safeText(node.id)}">Set as start</button><button type="button" data-route-role="end" data-route-node-id="${safeText(node.id)}">Set as end</button></div><button type="button" data-delete-node="${safeText(node.id)}">Delete node</button>${photoAccessMarkup(node)}<div class="weight-editor"><label>Impediment weight <span><output data-node-weight-value>${weightScore(node)}</output>/10</span><input type="range" data-node-weight min="0" max="10" step="1" value="${weightScore(node)}"></label><small>0 = clear · 10 = heavily impeded</small></div>${nodeRoadStatusMarkup(node)}<div class="weight-photo-control"><label>📷 Upload road photo to assess access and weight<input type="file" data-weight-photo data-weight-photo-target-type="node" data-weight-photo-target-id="${safeText(node.id)}" accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label><small data-weight-photo-status>Review the AI result on Photo uploads, then apply it to this node.</small></div></div>`,{autoClose:true,closeOnClick:true,maxWidth:240,autoPan:true,autoPanPadding:[18,18]});
      let hoverTimer=null;const cancelHoverPopup=()=>{clearTimeout(hoverTimer);hoverTimer=null;};
      marker.on('mouseover',()=>{cancelHoverPopup();if(editMode==='edge'||editMode==='area')return;hoverTimer=setTimeout(()=>marker.openPopup(),2000);});
      marker.on('mouseout dragstart click',cancelHoverPopup);
      marker.on('popupopen',(event)=>{const popup=event.popup.getElement();const weightInput=popup.querySelector('[data-node-weight]');weightInput.oninput=()=>{popup.querySelector('[data-node-weight-value]').value=weightInput.value;popup.querySelector('[data-node-weight-value]').textContent=weightInput.value;const statusBadges=popup.querySelector('[data-node-road-status]');if(statusBadges)statusBadges.outerHTML=nodeRoadStatusMarkup(node,weightInput.value);};weightInput.onchange=()=>{node.weight=normalizeWeight(weightInput.value);persistGraph().then(refreshRouteIfReady);};});
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
          edgeStart=null;editMode='';routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph().then(refreshRouteIfReady);return;
        }
        marker.openPopup();
      });
    }
    for(const [type,layer] of Object.entries(customLayers)){const input=document.querySelector(`[data-layer="${type}"]`);if(input?.checked)layer.addTo(map);}
  }
  function updateModeButtons(){for(const [id,mode] of modeButtons)document.getElementById(id).classList.toggle('active',editMode===mode);document.getElementById('city-map').style.cursor=editMode==='add'||editMode==='area'?'crosshair':'';cancelAreaButton.hidden=editMode!=='area';}
  modeButtons.forEach(([id,mode])=>document.getElementById(id).addEventListener('click',()=>{if(editMode==='area')clearAreaSelection();editMode=editMode===mode?'':mode;edgeStart=null;if(editMode==='area'){map.doubleClickZoom.disable();updateAreaSelection();editorStatus.textContent='Click around the map to draw an area. Add at least three corners, then analyze.';}else{map.doubleClickZoom.enable();editorStatus.textContent=editMode==='add'?'Click the map to place an intersection node.':editMode==='edge'?'Select two nodes to create an edge between them.':'Editor ready. Add nodes and edges, or hover a node to set route endpoints.';}updateModeButtons();renderGraph();}));
  cancelAreaButton.addEventListener('click',()=>{clearAreaSelection();editMode='';map.doubleClickZoom.enable();updateModeButtons();editorStatus.textContent='Area selection canceled.';});
  analyzeAreaButton.addEventListener('click',async()=>{
    if(areaPoints.length<3||areaAnalysisBusy)return;
    const user=cloudClient?.auth.currentUser;
    if(!user){editorStatus.textContent='Sign in before analyzing and saving map intersections.';return;}
    if(!cloudSyncReady){editorStatus.textContent='Wait for the shared Firebase map to finish loading, then try again.';return;}
    areaAnalysisBusy=true;analyzeAreaButton.disabled=true;analyzeAreaButton.textContent='Analyzing…';editorStatus.textContent='Loading OpenStreetMap roads and asking OpenAI to verify intersections…';
    try{
      const token=await user.getIdToken();
      const response=await fetch('/api/map/analyze-area',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({polygon:areaPoints.map((point)=>[point.lat,point.lng])})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(readableApiError(result,`Area analysis failed (HTTP ${response.status}).`));
      if(!result.nodes?.length){editorStatus.textContent=result.summary||'No intersections were verified in this area.';clearAreaSelection();editMode='';map.doubleClickZoom.enable();updateModeButtons();return;}
      const previous=graph;
      const nodesById=new Map(graph.nodes.map((node)=>[node.id,node]));
      for(const node of result.nodes)nodesById.set(node.id,node);
      const edgesById=new Map(graph.edges.map((edge)=>[edge.id,edge]));
      for(const edge of result.edges||[])edgesById.set(edge.id,edge);
      graph={nodes:[...nodesById.values()],edges:[...edgesById.values()]};
      routeLayer.clearLayers();document.getElementById('route-result').hidden=true;renderGraph();
      const saved=await persistGraph();
      if(!saved){graph=previous;renderGraph();throw new Error('Intersections were found, but Firebase did not save them. Check your Firestore map write rules and retry.');}
      const intersections=result.intersections??result.nodes.filter((node)=>node.kind==='intersection').length;
      editorStatus.textContent=result.roadCoverageIncomplete?result.summary:`Added ${intersections} AI-verified intersection ${intersections===1?'node':'nodes'} and ${result.edges.length} OSM ${result.edges.length===1?'edge':'edges'} to Firebase.`;
      clearAreaSelection();editMode='';map.doubleClickZoom.enable();updateModeButtons();refreshRouteIfReady();
    }catch(error){areaAnalysisBusy=false;analyzeAreaButton.disabled=areaPoints.length<3;analyzeAreaButton.textContent='Analyze intersections with AI';editorStatus.textContent=error instanceof TypeError&&/fetch/i.test(error.message)?'The map-analysis connection ended before a result arrived. Retry; if it happens again, check the server deployment logs.':error?.message||'Area analysis failed. Try again.';}
  });
  document.getElementById('stop-street-edit').addEventListener('click',()=>{if(editMode==='area')clearAreaSelection();editMode='';edgeStart=null;map.doubleClickZoom.enable();updateModeButtons();editorStatus.textContent='Editor ready. Hover a node to set route endpoints.';renderGraph();});
  map.on('click',(event)=>{if(editMode==='area'){addAreaPoint(event.latlng);return;}if(editMode!=='add')return;graph.nodes.push({id:crypto.randomUUID(),name:nodeName.value.trim()||`Node ${graph.nodes.length+1}`,lat:event.latlng.lat,lng:event.latlng.lng,weight:0});editMode='';routeLayer.clearLayers();document.getElementById('route-result').hidden=true;updateModeButtons();renderGraph();persistGraph().then(refreshRouteIfReady);});
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
    if(!refreshRouteIfReady()){routeLayer.clearLayers();document.getElementById('route-result').hidden=true;}
  }));
  document.getElementById('show-route').addEventListener('click',()=>{
    updateRouteDisplay({fitBounds:true});
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
  import('./firebase-client.js').then((client)=>{cloudClient=client;client.onAuthStateChanged(client.auth,(user)=>{stopCloudSync?.();stopCloudSync=null;cloudSyncReady=false;editorStatus.textContent=user?'Loading the shared Manila street graph from Firebase…':'Loading the shared Manila street graph…';stopCloudSync=client.onSnapshot(client.doc(client.db,'cityMaps','manila'),async(snapshot)=>{const version=++mapSnapshotVersion;const remote=snapshot.exists()?snapshot.data():null;try{if(remote?.format==='chunked-v1'){cloudChunkCounts={nodes:Number(remote.nodeChunks)||0,edges:Number(remote.edgeChunks)||0};cloudChunkGeneration=remote.generation||null;const chunksSnapshot=await client.getDocs(client.collection(client.doc(client.db,'cityMaps','manila'),'chunks'));if(version!==mapSnapshotVersion)return;const pieces={nodes:[],edges:[]};chunksSnapshot.forEach((chunkDoc)=>{const chunk=chunkDoc.data();if(remote.generation&&chunk.generation!==remote.generation)return;if((chunk.kind==='nodes'||chunk.kind==='edges')&&Array.isArray(chunk.items))pieces[chunk.kind].push([Number.isInteger(chunk.index)?chunk.index:Number(chunkDoc.id.split('_').at(-1)),chunk.items]);});for(const kind of ['nodes','edges']){pieces[kind].sort((a,b)=>a[0]-b[0]);const expected=cloudChunkCounts[kind];if(pieces[kind].length!==expected)throw new Error(`Firebase map data is incomplete (${kind} chunks: ${pieces[kind].length}/${expected}).`);}graph=normalizeGraph({nodes:pieces.nodes.flatMap((chunk)=>chunk[1]),edges:pieces.edges.flatMap((chunk)=>chunk[1])});}else{const remoteEdges=Array.isArray(remote?.edges)?remote.edges:remote?.connectors;if(remote&&Array.isArray(remote.nodes)&&Array.isArray(remoteEdges)){graph=normalizeGraph({nodes:remote.nodes,edges:remoteEdges});cloudChunkCounts={nodes:0,edges:0};cloudChunkGeneration=null;}else{cloudSyncReady=true;cloudChunkGeneration=null;cloudChunkCounts={nodes:0,edges:0};if(graph.nodes.length||graph.edges.length){if(user)persistGraph();else editorStatus.textContent='No shared map exists yet. Sign in before saving the first shared nodes and edges.';}else editorStatus.textContent=user?'Connected to Firebase. Add nodes and edges to build the Manila street map.':'No shared map exists yet. Sign in to create the Manila street map.';return;}}if(version!==mapSnapshotVersion)return;routeLayer.clearLayers();try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}renderGraph();updateRouteSelectionStatus();cloudSyncReady=true;editorStatus.textContent=user?`Synced to Firebase · ${graphSummary()}.`:`Loaded shared map from Firebase · ${graphSummary()}. Sign in to save edits for everyone.`;refreshRouteIfReady();}catch(error){if(version!==mapSnapshotVersion)return;cloudSyncReady=false;console.error('Street map data could not be loaded',error);editorStatus.textContent=`Firebase map load failed (${error?.code||'data'}: ${error?.message||'could not read map chunks'}).`;}},(error)=>{cloudSyncReady=false;console.error('Street map sync could not start',error);editorStatus.textContent=`Firebase sync failed (${error?.code||'unknown'}: ${error?.message||'check Firestore access'}).`;});},(error)=>{console.error('Firebase authentication could not be checked for map sync',error);editorStatus.textContent='Could not check sign-in. Street changes are saved in this browser.';});}).catch((error)=>{console.error('Firebase map sync could not load',error);editorStatus.textContent=`Firebase map sync could not load (${error?.code||'unknown'}: ${error?.message||'check Firebase configuration'}).`;});
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
