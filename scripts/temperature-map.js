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

// --- State Variables ---
const revealedCountries = new Set();
let tooltip, overlayLayer, heatmapSvg;

// Data Storage
let allTemperatureData = null; // { "2015-01...": [240, ...], ... }
let screenCoords = [];         // [{x,y}, ...] Pre-calculated screen positions
let timePoints = [];
let baselineData = {};         // { "01": [...], "02": [...] } 2015 baseline

// Interaction State
let isPlaying = false;
let animationInterval = null;
let isAnomalyMode = false;

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
    setupLayers();
    setupTooltip();
    
    // 2. Load Geometry
    const worldTopo = await d3.json(WORLD_TOPOJSON_URL);
    const countries = topojson.feature(worldTopo, worldTopo.objects.countries);
    renderCountries(countries);
    
    // 3. Setup Legend (needs to happen before data load for updates)
    setupLegend();

    // 4. Load Data
    await loadTemperatureData();
    
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
    
    // Try to find the file (compatible with both names)
    const jsonFile = zip.file("temperature_data.json") || zip.file("optimized_data.json");
    if (!jsonFile) throw new Error("JSON data not found in zip");
    
    statusDisplay.textContent = 'Processing...';
    const jsonString = await jsonFile.async("string");
    const parsedData = JSON.parse(jsonString);

    // 1. Process Coordinates (Pre-calculate Projection)
    // This optimization is crucial for performance
    const rawCoords = parsedData.coords; 
    screenCoords = rawCoords.map(d => {
      const p = projection(d);
      return p ? { x: p[0], y: p[1] } : null;
    });

    // 2. Process Temperatures
    allTemperatureData = parsedData.temperatures || parsedData.data;
    timePoints = Object.keys(allTemperatureData).sort();

    // 3. Extract Baseline Data (2015) for Anomaly Mode
    timePoints.forEach(dateStr => {
      // Assuming format "YYYY-MM-DD..."
      if (dateStr.startsWith("2015")) {
        // Extract month "01", "02", etc.
        const parts = dateStr.split('-');
        if (parts.length > 1) {
          const month = parts[1];
          // Store the array for this month
          baselineData[month] = allTemperatureData[dateStr];
        }
      }
    });
    console.log(`Baseline data extracted for ${Object.keys(baselineData).length} months.`);

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
          val = 0; // Default if no baseline
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
    .data(renderData); // No key needed, index order is stable

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
}

// --- Interactions ---

function setupControls() {
  // 1. Slider
  const slider = document.getElementById('time-slider');
  slider.max = timePoints.length - 1;
  slider.value = 0;
  slider.disabled = false;
  
  slider.addEventListener('input', function() {
    if (isPlaying) togglePlay(); // Pause if user drags
    // Use requestAnimationFrame for smoother dragging
    window.requestAnimationFrame(() => renderHeatmap(+this.value));
  });

  // 2. Play Button
  const playBtn = document.getElementById('play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', togglePlay);
  }

  // 3. Anomaly Toggle
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
  
  if (isPlaying) {
    clearInterval(animationInterval);
    if (btn) btn.textContent = "▶ Play";
    isPlaying = false;
  } else {
    if (btn) btn.textContent = "⏸ Pause";
    isPlaying = true;
    
    animationInterval = setInterval(() => {
      let nextVal = parseInt(slider.value) + 1;
      if (nextVal > parseInt(slider.max)) {
        nextVal = 0;
      }
      slider.value = nextVal;
      renderHeatmap(nextVal);
    }, 150); // 150ms per frame
  }
}

function toggleAnomalyMode(enabled) {
  isAnomalyMode = enabled;
  currentColorScale = enabled ? anomalyColorScale : absoluteColorScale;
  
  updateLegend();
  
  // Re-render current frame
  const slider = document.getElementById('time-slider');
  renderHeatmap(+slider.value);
}

// --- Layers & Geometry ---

function setupLayers() {
  heatmapSvg = d3.select('#map').append('svg')
    .attr('id', 'heatmap-svg')
    .attr('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`)
    .style('position', 'absolute')
    .style('top', 0).style('left', 0);

  overlayLayer = d3.select('#map').append('svg')
    .attr('id', 'overlay-layer')
    .attr('viewBox', `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`)
    .style('position', 'absolute')
    .style('top', 0).style('left', 0);
}

function renderCountries(countries) {
  const defs = overlayLayer.append('defs');
  
  // Mask logic
  const mask = defs.append('mask').attr('id', 'ocean-mask');
  mask.append('path').datum({ type: 'Sphere' })
    .attr('d', geoPath).attr('fill', 'white');
  
  mask.selectAll('path.country-mask')
    .data(countries.features).join('path')
    .attr('class', 'country-mask')
    .attr('d', geoPath).attr('fill', 'black');
  
  // Ocean Background
  overlayLayer.append('path')
    .datum({ type: 'Sphere' })
    .attr('class', 'ocean-background')
    .attr('d', geoPath)
    .attr('mask', 'url(#ocean-mask)')
    .style('fill', '#a8d8ea')
    .style('pointer-events', 'none');
  
  // Interactive Country Layer
  const countryMasks = overlayLayer.append('g').attr('class', 'country-masks');
  countryMasks.selectAll('path.country')
    .data(countries.features).join('path')
    .attr('class', 'country')
    .attr('d', geoPath)
    .on('mouseenter', handleMouseEnter)
    .on('mouseleave', handleMouseLeave)
    .on('click', handleClick);
  
  // Borders
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

function updateLegend() {
  const canvas = document.getElementById('legend-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const labelDiv = document.getElementById('legend-labels');
  
  ctx.clearRect(0, 0, 200, 20);
  const gradient = ctx.createLinearGradient(0, 0, 200, 0);
  
  if (isAnomalyMode) {
    // Anomaly: Blue (-5) -> White (0) -> Red (+5)
    const stops = 10;
    for (let i = 0; i <= stops; i++) {
        const t = i / stops;
        // RdBu: 1=Blue, 0=Red. We want Left=Blue, Right=Red.
        // So at t=0 (Left), we want color RdBu(1).
        gradient.addColorStop(t, d3.interpolateRdBu(1 - t)); 
    }
    labelDiv.innerHTML = '<span>-5°C (Cooler)</span><span>+5°C (Warmer)</span>';
  } else {
    // Absolute: Inferno
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
  content += isAnomalyMode ? "Click to toggle mask" : "Click to toggle mask";

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
    addToSelectionList(countryId, countryName);
  }
  
  updateBorderStyle(countryId, revealedCountries.has(countryId));
}

// --- Sidebar Helpers ---

function addToSelectionList(id, name) {
  const list = document.getElementById('selection-list');
  const item = document.createElement('li');
  item.className = 'selection-list__item';
  item.dataset.countryId = id;
  item.innerHTML = `
    <span>${name}</span>
    <button onclick="removeCountry('${id}')" style="background:none;border:none;cursor:pointer;color:#ef4444;">✕</button>
  `;
  list.appendChild(item);
}

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

// --- Utilities ---

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