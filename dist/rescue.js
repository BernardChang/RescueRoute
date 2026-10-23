(() => {
  'use strict';
  const home = document.getElementById('rescue-home');
  if (!window.L) {
    document.getElementById('city-map').innerHTML = '<div class="map-offline">The live city map couldn’t load. Check your connection and refresh.</div>';
    return;
  }
  const map = L.map('city-map', { zoomControl: false, scrollWheelZoom: true }).setView([37.5665, 126.9780], 14);
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
    main:{name:'Main road',text:'Illustrative all-vehicle corridor. Verify current restrictions before travel.',points:[[37.5750,126.9540],[37.5724,126.9635],[37.5706,126.9732],[37.5681,126.9830],[37.5658,126.9922],[37.5645,127.0020]]},
    moto:{name:'Motorcycle road',text:'Illustrative motorcycle-and-pedestrian corridor. Verify local access rules.',points:[[37.5795,126.9675],[37.5745,126.9683],[37.5694,126.9694],[37.5642,126.9705],[37.5596,126.9720]]},
    foot:{name:'Footpath',text:'Illustrative pedestrian-only corridor. Vehicles are not permitted.',points:[[37.5747,126.9798],[37.5712,126.9818],[37.5682,126.9839],[37.5654,126.9860],[37.5619,126.9880]]}
  };
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
  }));
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
