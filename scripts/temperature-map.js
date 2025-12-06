/* --- START OF FILE temperature-map.js --- */

const MAP_WIDTH = 960;
const MAP_HEIGHT = 480;
const WORLD_TOPOJSON_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
const TEMPERATURE_DATA_URL = 'data/temperature_data.zip';

// --- D3 Configuration ---
const projection = d3
  .geoEquirectangular()
  .scale(153)
  .translate([MAP_WIDTH / 2, MAP_HEIGHT / 2]);

const geoPath = d3.geoPath(projection);
// Date parser for data format "YYYY-MM-DD HH:mm:ss"
const dateParser = d3.timeParse("%Y-%m-%d %H:%M:%S");

// --- State Variables ---
const revealedCountries = new Set();
let tooltip, overlayLayer, heatmapSvg;

// Data Storage
let allTemperatureData = null; // { "2015-01...": [240, ...], ... }
let screenCoords = [];         // [{x,y}, ...] Pre-calculated screen positions
let rawCoords = [];            // [[lon, lat], ...] Global raw coords for geo-calc
let timePoints = [];
let baselineData = {};         // { "01": [...], "02": [...] } 2015 baseline

// Interaction State
let isPlaying = false;
let animationInterval = null;
let isAnomalyMode = false;
let currentTransform = d3.zoomIdentity;
let zoomBehavior;

//Zoom
function zoomed({ transform }) {
  currentTransform = transform; 

  overlayLayer.attr("transform", transform);

  heatmapSvg.attr("transform", transform);
}

// Color Scales
// Absolute: 230K (-43C) to 310K (37C)
const absoluteColorScale = d3.scaleSequential(d3.interpolateInferno).domain([230, 310]);
// Anomaly: +5C (Red) to -5C (Blue). RdBu: 0=Red, 1=Blue. So domain is [5, -5]
const anomalyColorScale = d3.scaleSequential(d3.interpolateRdBu).domain([5, -5]);

let currentColorScale = absoluteColorScale;

// --- Initialization ---

async function init() {
  try {
    // 1. Setup UI
    const zoomListenerElement = setupLayers(); 
    setupTooltip();
    
    // 2. Load Geometry
    const worldTopo = await d3.json(WORLD_TOPOJSON_URL);
    const countries = topojson.feature(worldTopo, worldTopo.objects.countries);
    renderCountries(countries);
    
    // 3. Setup Legend
    setupLegend();

    // 4. Load Data
    await loadTemperatureData();
    
    // 5. Zoom
    setupZoom(zoomListenerElement); 

    //
    document.getElementById('zoom-in').addEventListener('click', () => {
      handleZoom('in');
    });

    document.getElementById('zoom-out').addEventListener('click', () => {
      handleZoom('out');
    });
    
    console.log('Map initialized successfully');
  } catch (err) {
    console.error('Failed to initialize map:', err);
    document.getElementById('map').innerHTML = 
      '<p style="color: red; padding: 2rem;">Failed to load map data.</p>';
  }

}

// --- Data Loading ---

async function loadTemperatureData() {
  try {
    const statusDisplay = document.getElementById('current-time-display');
    statusDisplay.textContent = 'Downloading data...';
    
    const response = await fetch(TEMPERATURE_DATA_URL);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const buffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    
    const jsonFile = zip.file("temperature_data.json") || zip.file("optimized_data.json");
    if (!jsonFile) throw new Error("JSON data not found in zip");
    
    statusDisplay.textContent = 'Processing...';
    const jsonString = await jsonFile.async("string");
    const parsedData = JSON.parse(jsonString);

    // 1. Process Coordinates
    // Store raw coords globally for "Point-in-Polygon" calc
    rawCoords = parsedData.coords; 
    // Pre-calculate screen coords for fast rendering
    screenCoords = rawCoords.map(d => {
      const p = projection(d);
      return p ? { x: p[0], y: p[1] } : null;
    });

    // 2. Process Temperatures
    allTemperatureData = parsedData.temperatures || parsedData.data;
    timePoints = Object.keys(allTemperatureData).sort();

    // 3. Extract Baseline Data (2015) for Anomaly Mode
    timePoints.forEach(dateStr => {
      if (dateStr.startsWith("2015")) {
        const parts = dateStr.split('-');
        if (parts.length > 1) {
          const month = parts[1];
          baselineData[month] = allTemperatureData[dateStr];
        }
      }
    });

    // 4. Setup Controls
    setupControls();
    
    // Initial Render
    renderHeatmap(0);
    
  } catch (error) {
    console.error("Error loading temperature data:", error);
    document.getElementById('current-time-display').textContent = 'Data Load Failed';
  }
}

// --- Rendering Core ---

function renderHeatmap(timeIndex) {
  if (!timePoints.length) return;

  const currentTime = timePoints[timeIndex];
  document.getElementById('current-time-display').textContent = currentTime;
  
  const currentTemps = allTemperatureData[currentTime];
  
  // Determine baseline for Anomaly Mode
  let baselineTemps = null;
  if (isAnomalyMode) {
    const month = currentTime.split('-')[1];
    baselineTemps = baselineData[month];
  }

  // Assemble Data
  const renderData = [];
  for (let i = 0; i < screenCoords.length; i++) {
    const coord = screenCoords[i];
    if (coord) {
      let val = currentTemps[i];
      
      // Calculate Anomaly if enabled
      if (isAnomalyMode && baselineTemps) {
        const baseVal = baselineTemps[i];
        if (baseVal !== undefined && baseVal !== null) {
          val = val - baseVal;
        } else {
          val = 0; 
        }
      }
      
      renderData.push({
        x: coord.x,
        y: coord.y,
        val: val
      });
    }
  }

  // D3 Update Pattern
  const circles = heatmapSvg.selectAll(".data-point")
    .data(renderData); 

  circles.exit().remove();

  const circlesEnter = circles.enter()
    .append("circle")
    .attr("class", "data-point")
    .attr("r", 3)
    .attr("stroke", "none");

  circlesEnter.merge(circles)
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .attr("fill", d => currentColorScale(d.val));
    
  // --- SYNC CHARTS ---
  // Update the dot position on all sidebar charts
  updateChartsSync(timeIndex);
}

// --- Interactions ---

function setupControls() {
  const slider = document.getElementById('time-slider');
  slider.max = timePoints.length - 1;
  slider.value = 0;
  slider.disabled = false;
  
  slider.addEventListener('input', function() {
    if (isPlaying) togglePlay(); 
    window.requestAnimationFrame(() => renderHeatmap(+this.value));
  });

  const playBtn = document.getElementById('play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', togglePlay);
  }

  const anomalyToggle = document.getElementById('anomaly-toggle');
  if (anomalyToggle) {
    anomalyToggle.addEventListener('change', function() {
      toggleAnomalyMode(this.checked);
    });
  }
}

function togglePlay() {
  const btn = document.getElementById('play-btn');
  const slider = document.getElementById('time-slider');
  const btnText = btn.querySelector('.text') || btn; // Compatible with icon structure

  if (isPlaying) {
    clearInterval(animationInterval);
    if (btnText) btnText.textContent = "Play";
    isPlaying = false;
  } else {
    if (btnText) btnText.textContent = "Pause";
    isPlaying = true;
    
    animationInterval = setInterval(() => {
      let nextVal = parseInt(slider.value) + 1;
      if (nextVal > parseInt(slider.max)) {
        nextVal = 0;
      }
      slider.value = nextVal;
      renderHeatmap(nextVal);
    }, 150); 
  }
}

function toggleAnomalyMode(enabled) {
  isAnomalyMode = enabled;
  currentColorScale = enabled ? anomalyColorScale : absoluteColorScale;
  
  updateLegend();
  
  // Refresh all existing charts in the sidebar to match new mode
  const listItems = document.querySelectorAll('.selection-list__item');
  listItems.forEach(item => {
    // If we stored the feature data, we can redraw
    if (item.featureData) {
      const container = item.querySelector('.chart-container');
      container.innerHTML = ''; // Clear old chart
      const trendData = calculateCountryTrend(item.featureData);
      drawDetailedChart(container, trendData, item.dataset.countryId);
    }
  });

  const slider = document.getElementById('time-slider');
  renderHeatmap(+slider.value);
}

// --- Layers & Geometry ---

function setupLayers() {

  const heatmapContainer = d3.select('#map').append('svg')
    .attr('id', 'heatmap-container')
    .attr('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`)
    .style('position', 'absolute')
    .style('top', 0).style('left', 0);
  
  heatmapSvg = heatmapContainer.append('g').attr('id', 'heatmap-content-group'); 
    
  const overlayContainer = d3.select('#map').append('svg')
    .attr('id', 'overlay-container')
    .attr('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`)
    .style('position', 'absolute')
    .style('top', 0).style('left', 0);

  overlayLayer = overlayContainer.append('g').attr('id', 'overlay-content-group');
  
  return overlayContainer;

}

function renderCountries(countries) {
  const defs = overlayLayer.append('defs');
  
  const mask = defs.append('mask').attr('id', 'ocean-mask');
  mask.append('path').datum({ type: 'Sphere' })
    .attr('d', geoPath).attr('fill', 'white');
  
  mask.selectAll('path.country-mask')
    .data(countries.features).join('path')
    .attr('class', 'country-mask')
    .attr('d', geoPath).attr('fill', 'black');
  
  overlayLayer.append('path')
    .datum({ type: 'Sphere' })
    .attr('class', 'ocean-background')
    .attr('d', geoPath)
    .attr('mask', 'url(#ocean-mask)')
    .style('fill', '#a8d8ea')
    .style('pointer-events', 'none');
  
  const countryMasks = overlayLayer.append('g').attr('class', 'country-masks');
  countryMasks.selectAll('path.country')
    .data(countries.features).join('path')
    .attr('class', 'country')
    .attr('d', geoPath)
    .on('mouseenter', handleMouseEnter)
    .on('mouseleave', handleMouseLeave)
    .on('click', handleClick);
  
  overlayLayer.append('g').attr('class', 'country-borders')
    .selectAll('path.country-border')
    .data(countries.features).join('path')
    .attr('class', 'country-border')
    .attr('d', geoPath)
    .style('fill', 'none')
    .style('stroke', '#94a3b8')
    .style('stroke-width', '0.5px')
    .style('pointer-events', 'none');
}

// --- Legend ---

function setupLegend() {
  const mapWrapper = document.querySelector('.map-wrapper');
  if (document.getElementById('main-legend')) return;

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.id = 'main-legend';
  
  const canvas = document.createElement('canvas');
  canvas.id = 'legend-canvas';
  canvas.width = 200;
  canvas.height = 20;
  
  const labelDiv = document.createElement('div');
  labelDiv.id = 'legend-labels';
  labelDiv.style.display = 'flex';
  labelDiv.style.justifyContent = 'space-between';
  labelDiv.style.width = '200px';
  labelDiv.style.fontSize = '0.75rem';
  labelDiv.style.color = '#475569';
  labelDiv.style.marginTop = '4px';
  
  const container = document.createElement('div');
  container.appendChild(canvas);
  container.appendChild(labelDiv);
  legend.appendChild(container);
  
  mapWrapper.appendChild(legend);
  updateLegend();
}

//Zoom
function setupZoom(container) {
  zoomBehavior = d3.zoom() 
    .scaleExtent([1, 8])
    .on("zoom", zoomed);

  container.call(zoomBehavior);
}

function handleZoom(direction) {
  const container = d3.select('#overlay-container'); 
  
  if (direction === 'in') {
    container.transition().duration(250).call(zoomBehavior.scaleBy, 1.2);
  } else if (direction === 'out') {
    container.transition().duration(250).call(zoomBehavior.scaleBy, 1 / 1.2);
  }
}

//
function updateLegend() {
  const canvas = document.getElementById('legend-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const labelDiv = document.getElementById('legend-labels');
  
  ctx.clearRect(0, 0, 200, 20);
  const gradient = ctx.createLinearGradient(0, 0, 200, 0);
  
  if (isAnomalyMode) {
    const stops = 10;
    for (let i = 0; i <= stops; i++) {
        const t = i / stops;
        gradient.addColorStop(t, d3.interpolateRdBu(1 - t)); 
    }
    labelDiv.innerHTML = '<span>-5°C (Cooler)</span><span>+5°C (Warmer)</span>';
  } else {
    const infernoColors = [
      { stop: 0, color: '#000004' },
      { stop: 0.25, color: '#57106e' },
      { stop: 0.5, color: '#bc3754' },
      { stop: 0.75, color: '#f98e09' },
      { stop: 1, color: '#fcffa4' }
    ];
    infernoColors.forEach(c => gradient.addColorStop(c.stop, c.color));
    labelDiv.innerHTML = '<span>230K (-43°C)</span><span>310K (37°C)</span>';
  }
  
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 200, 20);
  ctx.strokeStyle = '#cbd5e1';
  ctx.strokeRect(0, 0, 200, 20);
}

// --- Mouse Handlers ---

function handleMouseEnter(event, feature) {
  const countryId = getCountryId(feature);
  const countryName = getCountryName(feature);
  
  let content = `<strong>${countryName}</strong><br/>`;
  content += "Click to reveal trends";

  tooltip.style('opacity', 1).html(content);

  if (!revealedCountries.has(countryId)) {
    d3.select(event.target).classed('country--hover', true);
  }
}

function handleMouseLeave(event, feature) {
  const countryId = getCountryId(feature);
  tooltip.style('opacity', 0);
  if (!revealedCountries.has(countryId)) {
    d3.select(event.target).classed('country--hover', false);
  }
}

function handleClick(event, feature) {
  const countryId = getCountryId(feature);
  const countryName = getCountryName(feature);
  const element = d3.select(event.target);

  if (revealedCountries.has(countryId)) {
    revealedCountries.delete(countryId);
    element.classed('country--revealed', false);
    removeFromSelectionList(countryId);
  } else {
    revealedCountries.add(countryId);
    element.classed('country--revealed', true);
    addToSelectionList(countryId, countryName, feature);
  }
  
  updateBorderStyle(countryId, revealedCountries.has(countryId));
}

// --- Sidebar & Chart Logic ---

function addToSelectionList(id, name, feature) {
  const list = document.getElementById('selection-list');
  const item = document.createElement('li');
  item.className = 'selection-list__item';
  item.dataset.countryId = id;
  // Store feature data on the DOM element for mode switching
  item.featureData = feature; 
  
  item.style.flexDirection = "column";
  item.style.alignItems = "stretch";
  
  // Header
  const header = document.createElement('div');
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.innerHTML = `
    <span style="font-weight:600; font-size:0.9rem;">${name}</span>
    <button onclick="removeCountry('${id}')" style="background:none;border:none;cursor:pointer;color:#ef4444;">✕</button>
  `;
  item.appendChild(header);

  // Chart Container
  const chartContainer = document.createElement('div');
  chartContainer.className = 'chart-container'; 
  chartContainer.style.height = "100px"; 
  chartContainer.style.width = "100%";
  chartContainer.style.marginTop = "5px";
  chartContainer.innerHTML = '<span style="font-size:0.7rem;color:#999;">Calculating...</span>';
  item.appendChild(chartContainer);
  
  list.appendChild(item);

  // Calculate & Draw
  setTimeout(() => {
    const trendData = calculateCountryTrend(feature);
    if (trendData && trendData.length > 0) {
        chartContainer.innerHTML = ''; 
        drawDetailedChart(chartContainer, trendData, id);
        
        // Sync immediately
        const slider = document.getElementById('time-slider');
        updateChartsSync(+slider.value); 
    } else {
        chartContainer.innerHTML = '<span style="font-size:0.7rem;color:#ef4444;">No data</span>';
    }
  }, 50);
}

// 1. Calculate Trend (Point-in-Polygon)
function calculateCountryTrend(feature) {
  if (!rawCoords || rawCoords.length === 0) return null;

  const indicesInCountry = [];
  for (let i = 0; i < rawCoords.length; i++) {
    const coord = rawCoords[i];
    if (d3.geoContains(feature, coord)) {
      indicesInCountry.push(i);
    }
  }

  if (indicesInCountry.length === 0) return null;

  return timePoints.map(dateStr => {
    const temps = allTemperatureData[dateStr];
    
    // Anomaly calc
    let baselineTemps = null;
    if (isAnomalyMode) {
        const month = dateStr.split('-')[1];
        baselineTemps = baselineData[month];
    }

    let sum = 0;
    let count = 0;

    indicesInCountry.forEach(idx => {
      let val = temps[idx];
      if (isAnomalyMode && baselineTemps) {
         val = val - baselineTemps[idx];
      }
      sum += val;
      count++;
    });

    return {
      date: dateParser(dateStr), 
      val: count > 0 ? sum / count : 0,
      rawDate: dateStr
    };
  });
}

// 2. Draw D3 Chart with Axes & Sync Marker
function drawDetailedChart(container, data, countryId) {
  const width = container.clientWidth || 250;
  const height = 100;
  const margin = {top: 10, right: 10, bottom: 20, left: 35};

  const svg = d3.select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  // Scales
  const x = d3.scaleTime()
    .domain(d3.extent(data, d => d.date))
    .range([margin.left, width - margin.right]);

  const y = d3.scaleLinear()
    .domain(d3.extent(data, d => d.val))
    .range([height - margin.bottom, margin.top]);

  // Axes
  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0))
    .attr("color", "#64748b")
    .style("font-size", "9px");

  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4))
    .attr("color", "#64748b")
    .style("font-size", "9px");
    
  svg.append("text")
    .attr("x", 2)
    .attr("y", 10)
    .style("font-size", "9px")
    .style("fill", "#64748b")
    .text(isAnomalyMode ? "°C" : "K");

  // Line
  const line = d3.line()
    .x(d => x(d.date))
    .y(d => y(d.val))
    .curve(d3.curveMonotoneX);

  svg.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", isAnomalyMode ? "#ef4444" : "#3b82f6")
    .attr("stroke-width", 1.5)
    .attr("d", line);

  // Sync Marker Group (Hidden initially)
  const markerGroup = svg.append("g")
    .attr("class", "sync-marker-group")
    .attr("id", `marker-${countryId}`)
    .style("display", "none");

  // Halo
  markerGroup.append("circle")
    .attr("r", 6)
    .attr("fill", isAnomalyMode ? "rgba(239, 68, 68, 0.3)" : "rgba(59, 130, 246, 0.3)");

  // Dot
  markerGroup.append("circle")
    .attr("r", 3.5)
    .attr("fill", isAnomalyMode ? "#ef4444" : "#3b82f6")
    .attr("stroke", "white")
    .attr("stroke-width", 1.5);
    

  //tamperture text
  markerGroup.append("text")
    .attr("class", "sync-temp-label")
    .attr("y", 15)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("font-weight", "600")
    .style("fill", "#1e3a8a");

  // Attach metadata to DOM for sync function
  container.chartMeta = { x, y, data};
}

// 3. Sync Logic (Called by renderHeatmap)
function updateChartsSync(timeIndex) {
  const containers = document.querySelectorAll('.chart-container');
  
  containers.forEach(container => {
    const meta = container.chartMeta;
    if (!meta) return;

    const { x, y, data } = meta;
    const currentPoint = data[timeIndex];

    if (currentPoint) {
      const svg = d3.select(container).select('svg');
      const marker = svg.select('.sync-marker-group');

      marker
        .style("display", "block")
        .attr("transform", `translate(${x(currentPoint.date)}, ${y(currentPoint.val)})`);

      const tempValue = currentPoint.val.toFixed(2);
      const unit = isAnomalyMode ? "°C" : "K";
      const dateStr = d3.timeFormat("%b %Y")(currentPoint.date);

      //update tamperture
      marker.select(".sync-temp-label")
        .text(`${tempValue} ${unit}`);
    }
  });
}

// --- Helpers ---

function removeFromSelectionList(id) {
  const item = document.querySelector(`li[data-country-id="${id}"]`);
  if (item) {
    item.remove();
  }
}

function updateBorderStyle(countryId, isRevealed) {
  overlayLayer
    .select('.country-borders')
    .selectAll('path.country-border')
    .filter(d => getCountryId(d) === countryId)
    .style('stroke', isRevealed ? '#3b82f6' : '#94a3b8')
    .style('stroke-width', isRevealed ? '1.2px' : '0.5px');
}

window.removeCountry = function(id) {
  revealedCountries.delete(id);

  overlayLayer
    .select('.country-masks')
    .selectAll('path.country')
    .filter(d => getCountryId(d) === id)
    .classed('country--revealed', false)
    .classed('country--hover', false); 

  updateBorderStyle(id, false);
  removeFromSelectionList(id);
};

function setupTooltip() {
  tooltip = d3.select('body').append('div')
    .attr('class', 'tooltip')
    .style('position', 'absolute')
    .style('opacity', 0);

  overlayLayer.on('mousemove', event => {
    tooltip
      .style('left', `${event.pageX + 12}px`)
      .style('top', `${event.pageY - 8}px`);
  });
}

function getCountryId(feature) {
  return (
    feature.properties?.iso_a3 ||
    feature.properties?.adm0_a3 ||
    feature.id ||
    String(feature.properties?.name || 'unknown')
  );
}

function getCountryName(feature) {
  return feature.properties?.name || 'Unknown';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}