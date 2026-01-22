const spotSelect = document.querySelector("#spot");
const statusEl = document.querySelector("#status");
const windCard = document.querySelector("#wind-card .card-body");
const weatherCard = document.querySelector("#weather-card .card-body");
const marineCard = document.querySelector("#marine-card .card-body");
const tideCard = document.querySelector("#tide-card .card-body");
const forecastChartEl = document.querySelector("#forecast-chart");
const sourcesGrid = document.querySelector("#sources-grid");
const mapEl = document.querySelector("#map");
const windUnitLabel = document.querySelector("#wind-unit-label");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsPanel = document.querySelector("#settings-panel");
const windUnitSelect = document.querySelector("#wind-unit");
const tempUnitSelect = document.querySelector("#temp-unit");
const waveUnitSelect = document.querySelector("#wave-unit");
const directionChartEl = document.querySelector("#direction-chart");
let map;
let markers = {};
let lastConditions = null;
let lastMap = null;
let forecastChart = null;
let directionChart = null;
let flowLayer = null;
let flowData = null;
let flowGrid = null;
let flowGridController = null;
let lastFlowFrame = 0;

const defaultSettings = {
  windUnit: "kt",
  tempUnit: "f",
  waveUnit: "m"
};
let settings = loadSettings();

const cardinal = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW"
];

function degToCardinal(deg) {
  if (typeof deg !== "number") return "-";
  return cardinal[Math.round(deg / 22.5) % 16];
}

function formatValue(value, suffix) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value}${suffix}`;
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("knot_settings"));
    return { ...defaultSettings, ...stored };
  } catch (err) {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  localStorage.setItem("knot_settings", JSON.stringify(settings));
}

function knotsToMph(knots) {
  return knots * 1.15078;
}

function metersToFeet(meters) {
  return meters * 3.28084;
}

function formatWind(valueKnots) {
  if (valueKnots === null || valueKnots === undefined || Number.isNaN(valueKnots)) return "-";
  if (settings.windUnit === "mph") {
    return `${Math.round(knotsToMph(valueKnots))} mph`;
  }
  return `${Math.round(valueKnots)} kt`;
}

function formatTemp(valueF) {
  if (valueF === null || valueF === undefined || Number.isNaN(valueF)) return "-";
  if (settings.tempUnit === "c") {
    return `${Math.round(((valueF - 32) * 5) / 9)}°C`;
  }
  return `${Math.round(valueF)}°F`;
}

function formatWave(valueMeters) {
  if (valueMeters === null || valueMeters === undefined || Number.isNaN(valueMeters)) return "-";
  if (settings.waveUnit === "ft") {
    return `${metersToFeet(valueMeters).toFixed(1)} ft`;
  }
  return `${valueMeters.toFixed(1)} m`;
}

function weatherCodeText(code) {
  const map = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    56: "Freezing drizzle",
    57: "Heavy freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light showers",
    81: "Showers",
    82: "Heavy showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm w/ hail",
    99: "Thunderstorm w/ heavy hail"
  };
  if (code === null || code === undefined || Number.isNaN(code)) return "-";
  return map[code] ?? `Code ${code}`;
}

function cardinalFromDegrees(deg) {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return "-";
  const index = Math.round(deg / 45) % 8;
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[index];
}

function setCardContent(el, rows) {
  el.innerHTML = rows.map((row) => `<p><span>${row.label}</span>${row.value}</p>`).join("");
}

function formatTimeLabel(isoTime) {
  if (!isoTime) return "-";
  const date = new Date(isoTime);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const apiBase = (window.KNOT_API_BASE || "").replace(/\/$/, "");

function apiUrl(path) {
  if (!apiBase) return path;
  return `${apiBase}${path}`;
}

async function loadSpots() {
  const res = await fetch(apiUrl("/api/spots"));
  const data = await res.json();
  spotSelect.innerHTML = data.spots
    .map((spot) => `<option value="${spot.id}">${spot.name}</option>`)
    .join("");

  if (data.spots.length) {
    initMap(data.spots);
    spotSelect.value = data.spots[0].id;
    await loadConditions();
    loadMapWind().catch(() => {
      // ignore map wind errors
    });
  } else {
    statusEl.innerHTML = "<h2>Add a spot to data/spots.json to get started.</h2>";
  }
}

async function loadConditions() {
  const spotId = spotSelect.value;
  statusEl.classList.add("loading");
  statusEl.innerHTML = "<h2>Loading conditions...</h2><p>Checking the latest data.</p>";

  const res = await fetch(apiUrl(`/api/conditions?spot=${encodeURIComponent(spotId)}`));
  const data = await res.json();

  statusEl.classList.remove("loading");
  lastConditions = data;
  applyData(data);

  if (!data.sources?.open_meteo?.ok) {
    const fallback = await fetchOpenMeteoFallback(data.location.lat, data.location.lon);
    if (fallback) {
      data.current = fallback.current;
      data.hourly = fallback.hourly;
      data.sailability = getSailabilityClient(data.current, data.tides, data.thresholds);
      data.sources = data.sources || {};
      data.sources.open_meteo = { ok: true, url: fallback.url, note: "client fallback" };
      applyData(data);
    }
  }
}

function selectHourlyWindow(hourly, anchorTime, windowSize = 24) {
  if (!hourly?.time) return { start: 0, end: windowSize };
  const times = hourly.time.map((time) => new Date(time).getTime());
  let anchor = Date.now();
  if (anchorTime) {
    const parsed = new Date(anchorTime).getTime();
    if (!Number.isNaN(parsed)) {
      anchor = parsed;
    }
  }
  let anchorIndex = times.findIndex((time) => time >= anchor);
  if (anchorIndex === -1) anchorIndex = Math.max(0, times.length - 1);
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, anchorIndex - half);
  let end = Math.min(times.length, start + windowSize);
  if (end - start < windowSize) {
    start = Math.max(0, end - windowSize);
  }
  return { start, end };
}

function getNowIndex(hourly, window) {
  if (!hourly?.time) return null;
  const now = Date.now();
  const slice = hourly.time.slice(window.start, window.end);
  const idx = slice.findIndex((time) => new Date(time).getTime() >= now);
  if (idx === -1) return null;
  return idx;
}

const nowMarkerPlugin = {
  id: "nowMarker",
  afterDatasetsDraw(chart, _args, pluginOptions) {
    const index = pluginOptions?.index;
    if (index === null || index === undefined) return;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    if (!xScale || !yScale) return;
    const x = xScale.getPixelForValue(index);
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(29, 28, 26, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yScale.top);
    ctx.lineTo(x, yScale.bottom);
    ctx.stroke();
    ctx.fillStyle = "#1d1c1a";
    ctx.beginPath();
    ctx.arc(x, yScale.top + 6, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
};

if (typeof Chart !== "undefined") {
  Chart.register(nowMarkerPlugin);
}

function renderForecastChart(hourly) {
  if (!forecastChartEl) return;
  if (!hourly?.time) {
    if (forecastChart) {
      forecastChart.destroy();
      forecastChart = null;
    }
    return;
  }

  const window = selectHourlyWindow(hourly, lastConditions?.current?.time, 24);
  const labels = hourly.time.slice(window.start, window.end).map((time) => formatTimeLabel(time));
  const wind = hourly.windspeed_10m?.slice(window.start, window.end) ?? [];
  const gust = hourly.windgusts_10m?.slice(window.start, window.end) ?? [];
  const temp = hourly.temperature_2m?.slice(window.start, window.end) ?? [];
  const nowIndex = getNowIndex(hourly, window);

  const windData = wind.map((value) =>
    value == null ? null : settings.windUnit === "mph" ? knotsToMph(value) : value
  );
  const gustData = gust.map((value) =>
    value == null ? null : settings.windUnit === "mph" ? knotsToMph(value) : value
  );
  const tempData = temp.map((value) =>
    value == null ? null : settings.tempUnit === "c" ? ((value - 32) * 5) / 9 : value
  );

  const windUnitLabelText = settings.windUnit === "mph" ? "mph" : "kt";
  const tempUnitLabelText = settings.tempUnit === "c" ? "°C" : "°F";

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `Wind (${windUnitLabelText})`,
          data: windData,
          borderColor: "#0f6b6f",
          backgroundColor: "rgba(15, 107, 111, 0.15)",
          tension: 0.35,
          fill: true,
          pointRadius: 2
        },
        {
          label: `Gust (${windUnitLabelText})`,
          data: gustData,
          borderColor: "#cc5b2d",
          backgroundColor: "rgba(204, 91, 45, 0.12)",
          tension: 0.35,
          fill: false,
          pointRadius: 2
        },
        {
          label: `Temp (${tempUnitLabelText})`,
          data: tempData,
          borderColor: "#1d1c1a",
          backgroundColor: "rgba(29, 28, 26, 0.08)",
          tension: 0.35,
          yAxisID: "yTemp",
          fill: false,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        nowMarker: {
          index: nowIndex
        },
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 8
          }
        },
        tooltip: {
          intersect: false,
          mode: "index"
        }
      },
      scales: {
        y: {
          title: {
            display: true,
            text: `Wind (${windUnitLabelText})`
          },
          grid: {
            color: "rgba(29, 28, 26, 0.08)"
          }
        },
        yTemp: {
          position: "right",
          title: {
            display: true,
            text: `Temp (${tempUnitLabelText})`
          },
          grid: {
            drawOnChartArea: false
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  };

  if (forecastChart) {
    forecastChart.destroy();
  }
  forecastChart = new Chart(forecastChartEl, config);
}

function renderDirectionChart(hourly) {
  if (!directionChartEl) return;
  if (!hourly?.time) {
    if (directionChart) {
      directionChart.destroy();
      directionChart = null;
    }
    return;
  }

  const window = selectHourlyWindow(hourly, lastConditions?.current?.time, 24);
  const labels = hourly.time.slice(window.start, window.end).map((time) => formatTimeLabel(time));
  const direction = hourly.winddirection_10m?.slice(window.start, window.end) ?? [];
  const nowIndex = getNowIndex(hourly, window);

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Direction (°)",
          data: direction,
          borderColor: "#1d1c1a",
          backgroundColor: "rgba(29, 28, 26, 0.08)",
          tension: 0.2,
          fill: false,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        nowMarker: {
          index: nowIndex
        },
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 8
          }
        },
        tooltip: {
          callbacks: {
            label(context) {
              const value = context.parsed.y;
              if (value === null || value === undefined || Number.isNaN(value)) {
                return "Direction: -";
              }
              return `Direction: ${Math.round(value)}° (${cardinalFromDegrees(value)})`;
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 360,
          ticks: {
            stepSize: 90,
            callback(value) {
              return `${value}° ${cardinalFromDegrees(Number(value))}`;
            }
          },
          title: {
            display: true,
            text: "Direction (degrees)"
          },
          grid: {
            color: "rgba(29, 28, 26, 0.08)"
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  };

  if (directionChart) {
    directionChart.destroy();
  }
  directionChart = new Chart(directionChartEl, config);
}

function applyData(data) {
  const sail = data.sailability ?? { status: "unknown", reason: "-" };
  const windThreshold = data.thresholds?.wind_knots ?? 5;
  const tideThreshold = data.thresholds?.tide_ft ?? 1.5;
  statusEl.innerHTML = `
    <div>
      <p class="status-pill ${sail.status}">${sail.status}</p>
      <h2>${sail.reason}</h2>
      <p>Updated ${formatTimeLabel(data.updated_at)} for ${data.location.name ?? ""}</p>
      <p class="thresholds">Thresholds: wind ≥ ${formatWind(windThreshold)} · tide ≥ ${tideThreshold} ft</p>
    </div>
  `;

  const current = data.current ?? {};
  const gustLabel = current.wind_gust_source === "hourly" ? "Gust (hourly)" : "Gust";
  setCardContent(windCard, [
    { label: "Speed", value: formatWind(current.wind_speed_knots) },
    { label: gustLabel, value: formatWind(current.wind_gust_knots) },
    { label: "Direction", value: `${formatValue(current.wind_direction_deg, "°")} ${degToCardinal(current.wind_direction_deg)}` }
  ]);

  setCardContent(weatherCard, [
    { label: "Temp", value: formatTemp(current.temperature_f) },
    { label: "Weather", value: weatherCodeText(current.weather_code) },
    { label: "Time", value: formatTimeLabel(current.time) }
  ]);

  if (data.marine?.time) {
    setCardContent(marineCard, [
      { label: "Wave height", value: formatWave(data.marine.wave_height?.[0]) },
      { label: "Wave period", value: formatValue(data.marine.wave_period?.[0], " s") },
      { label: "Wave direction", value: `${formatValue(data.marine.wave_direction?.[0], "°")} ${degToCardinal(data.marine.wave_direction?.[0])}` }
    ]);
  } else {
    marineCard.innerHTML = "<p>No marine model data for this spot.</p>";
  }

  if (Array.isArray(data.tides)) {
    const next = data.tides.slice(0, 3).map((tide) => ({
      label: `${tide.type} ${formatTimeLabel(tide.t)}`,
      value: `${tide.v} ft`
    }));
    setCardContent(tideCard, next);
  } else {
    tideCard.innerHTML = "<p>Add a NOAA tide station for this spot.</p>";
  }

  renderForecastChart(data.hourly);
  renderDirectionChart(data.hourly);
  renderSources(data.sources);
}

async function fetchOpenMeteoFallback(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}` +
    `&longitude=${lon}` +
    "&hourly=temperature_2m,windspeed_10m,winddirection_10m,windgusts_10m,weathercode" +
    "&current_weather=true" +
    "&past_days=1" +
    "&windspeed_unit=kn" +
    "&temperature_unit=fahrenheit" +
    "&timezone=auto";
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const forecast = await res.json();
    const currentWeather = forecast.current_weather || {};
    const hourlyGusts = forecast.hourly?.windgusts_10m;
    const fallbackGust =
      Array.isArray(hourlyGusts) && hourlyGusts.length ? hourlyGusts[0] : null;
    return {
      url,
      current: {
        time: currentWeather.time,
        temperature_f: currentWeather.temperature,
        wind_speed_knots: currentWeather.windspeed,
        wind_direction_deg: currentWeather.winddirection,
        wind_gust_knots: currentWeather.windgusts ?? fallbackGust,
        wind_gust_source: currentWeather.windgusts != null ? "current" : "hourly",
        weather_code: currentWeather.weathercode
      },
      hourly: forecast.hourly ?? null
    };
  } catch (err) {
    return null;
  }
}

function renderSources(sources) {
  if (!sourcesGrid) return;
  if (!sources || Object.keys(sources).length === 0) {
    sourcesGrid.innerHTML = "<p>No source status available.</p>";
    return;
  }
  sourcesGrid.innerHTML = Object.entries(sources)
    .map(([key, info]) => {
      const ok = info?.ok;
      return `
        <div class="source-pill ${ok ? "ok" : "offline"}">
          <span>${key.replace(/_/g, " ")}</span>
          <strong>${ok ? "live" : "offline"}</strong>
        </div>
      `;
    })
    .join("");
}

function getSailabilityClient(current, tides, thresholds) {
  if (!current || typeof current.wind_speed_knots !== "number") {
    return { status: "unknown", reason: "No wind data available." };
  }

  const windThreshold = thresholds?.wind_knots ?? 5;
  const tideThreshold = thresholds?.tide_ft ?? 1.5;
  const tideValue = Array.isArray(tides) && tides.length ? Number(tides[0].v) : null;

  if (Number.isNaN(tideValue) || tideValue === null) {
    return { status: "unknown", reason: "No tide data available." };
  }

  if (current.wind_speed_knots >= windThreshold && tideValue >= tideThreshold) {
    return {
      status: "go",
      reason: `Wind at least ${windThreshold} kt and tide above ${tideThreshold} ft.`
    };
  }

  if (current.wind_speed_knots < windThreshold) {
    return { status: "no-go", reason: `Wind below ${windThreshold} kt.` };
  }

  return { status: "no-go", reason: `Tide below ${tideThreshold} ft.` };
}

function initMap(spots) {
  if (!mapEl || typeof L === "undefined") return;
  map = L.map(mapEl, { scrollWheelZoom: false }).setView([37.79, -122.3], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  initFlowLayer();
  queueGridFetch();
  map.on("moveend zoomend", () => {
    queueGridFetch();
  });

  markers = {};
  spots.forEach((spot) => {
    const marker = L.marker([spot.lat, spot.lon], {
      icon: buildWindIcon(null, null, null)
    }).addTo(map);
    marker.bindPopup(`<strong>${spot.name}</strong><br/>Click to load`);
    marker.on("click", () => {
      spotSelect.value = spot.id;
      loadConditions().catch(() => {
        statusEl.innerHTML = "<h2>Unable to load data right now.</h2>";
      });
    });
    markers[spot.id] = marker;
  });
}

async function loadMapWind() {
  const res = await fetch(apiUrl("/api/map"));
  const data = await res.json();
  lastMap = data;
  flowData = data;
  applyMapData(data);
}

function initFlowLayer() {
  if (!map) return;
  const canvas = document.createElement("canvas");
  canvas.className = "flow-canvas";
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.pointerEvents = "none";
  map.getPanes().overlayPane.appendChild(canvas);
  flowLayer = { canvas, ctx: canvas.getContext("2d"), phase: 0 };

  const resize = () => {
    const size = map.getSize();
    canvas.width = size.x * window.devicePixelRatio;
    canvas.height = size.y * window.devicePixelRatio;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    flowLayer.ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  };

  resize();
  map.on("resize zoom move", resize);
  map.on("move zoom", () => drawFlow());
  requestAnimationFrame(tickFlow);
}

function tickFlow() {
  const now = performance.now();
  if (now - lastFlowFrame > 80) {
    drawFlow();
    lastFlowFrame = now;
  }
  requestAnimationFrame(tickFlow);
}

function drawFlow() {
  if (!flowLayer || !flowData || !map) return;
  const { ctx, canvas } = flowLayer;
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);

  const zoom = map.getZoom();
  const spacing = Math.max(55, 110 - zoom * 4);
  const pixelBounds = map.getPixelBounds();
  const now = Date.now();
  const phase = now / 900;

  for (let x = pixelBounds.min.x; x <= pixelBounds.max.x; x += spacing) {
    for (let y = pixelBounds.min.y; y <= pixelBounds.max.y; y += spacing) {
      const latlng = map.unproject([x, y]);
      const point = map.layerPointToContainerPoint([x, y]);
      const wind = sampleWind(latlng);
      if (!wind) continue;
      drawFlowArrow(ctx, point.x, point.y, wind, phase, latlng.lat, latlng.lng);
    }
  }
}

function sampleWind(latlng) {
  const source = flowGrid?.points?.length ? flowGrid.points : flowData?.spots;
  if (!source) return null;
  const samples = source
    .map((point) => {
      const speed = point.wind_speed_knots ?? point.wind?.mean_speed_knots;
      const direction = point.wind_direction_deg ?? point.wind?.mean_direction_deg;
      if (speed == null || direction == null) return null;
      const dx = latlng.lat - point.lat;
      const dy = latlng.lng - point.lon;
      const dist2 = dx * dx + dy * dy;
      const weight = dist2 === 0 ? 1 : 1 / dist2;
      return {
        weight,
        speed,
        direction
      };
    })
    .filter(Boolean);

  if (!samples.length) return null;
  let weightSum = 0;
  let speedSum = 0;
  let sinSum = 0;
  let cosSum = 0;
  samples.forEach((sample) => {
    weightSum += sample.weight;
    speedSum += sample.speed * sample.weight;
    const radians = (sample.direction * Math.PI) / 180;
    sinSum += Math.sin(radians) * sample.weight;
    cosSum += Math.cos(radians) * sample.weight;
  });
  const speed = speedSum / weightSum;
  const direction = (Math.atan2(sinSum / weightSum, cosSum / weightSum) * 180) / Math.PI;
  return {
    speed,
    direction: (direction + 360) % 360
  };
}

function drawFlowArrow(ctx, x, y, wind, phase, latSeed, lngSeed) {
  const length = Math.min(18, 6 + wind.speed);
  const angle = ((wind.direction - 90) * Math.PI) / 180;
  const drift = Math.sin(phase + latSeed + lngSeed) * 4;
  const dx = Math.cos(angle) * drift;
  const dy = Math.sin(angle) * drift;
  const alpha = Math.min(0.6, 0.2 + wind.speed / 30);

  ctx.save();
  ctx.translate(x + dx, y + dy);
  ctx.rotate(angle);
  ctx.strokeStyle = `rgba(15, 107, 111, ${alpha})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-length * 0.6, 0);
  ctx.lineTo(length * 0.5, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(length * 0.5, 0);
  ctx.lineTo(length * 0.5 - 5, -4);
  ctx.lineTo(length * 0.5 - 5, 4);
  ctx.closePath();
  ctx.fillStyle = `rgba(10, 80, 84, ${alpha})`;
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = `rgba(15, 107, 111, ${alpha * 0.4})`;
  ctx.arc(-length * 0.6, 0, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-length * 0.35, -3);
  ctx.lineTo(-length * 0.35 - 4, 0);
  ctx.lineTo(-length * 0.35, 3);
  ctx.closePath();
  ctx.fillStyle = `rgba(15, 107, 111, ${alpha * 0.5})`;
  ctx.fill();
  ctx.restore();
}

function queueGridFetch() {
  if (!map) return;
  if (flowGridController) {
    flowGridController.abort();
  }
  flowGridController = new AbortController();
  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth()
  ].join(",");
  fetchWindGrid(bbox, flowGridController.signal).catch(() => {
    // ignore grid fetch errors
  });
}

async function fetchWindGrid(bbox, signal) {
  const url = apiUrl(`/api/wind-grid?bbox=${encodeURIComponent(bbox)}&rows=7&cols=9`);
  const res = await fetch(url, { signal });
  if (res.ok) {
    const data = await res.json();
    if (data?.points?.length) {
      flowGrid = data;
      return;
    }
  }
  await fetchWindGridDirect(bbox, signal);
}

async function fetchWindGridDirect(bbox, signal) {
  const parts = bbox.split(",").map(Number);
  if (parts.length !== 4 || parts.some((num) => Number.isNaN(num))) return;
  const [west, south, east, north] = parts;
  const rows = 7;
  const cols = 9;
  const latitudes = [];
  const longitudes = [];
  for (let row = 0; row < rows; row += 1) {
    const lat = south + (north - south) * (row / (rows - 1));
    for (let col = 0; col < cols; col += 1) {
      const lon = west + (east - west) * (col / (cols - 1));
      latitudes.push(lat.toFixed(4));
      longitudes.push(lon.toFixed(4));
    }
  }
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${latitudes.join(",")}` +
    `&longitude=${longitudes.join(",")}` +
    "&current_weather=true" +
    "&windspeed_unit=kn" +
    "&timezone=auto";
  const res = await fetch(url, { signal });
  if (!res.ok) return;
  const data = await res.json();
  if (!Array.isArray(data)) return;
  const points = data.map((entry) => ({
    lat: entry.latitude,
    lon: entry.longitude,
    wind_speed_knots: entry.current_weather?.windspeed ?? null,
    wind_direction_deg: entry.current_weather?.winddirection ?? null
  }));
  flowGrid = {
    updated_at: new Date().toISOString(),
    rows,
    cols,
    points,
    source: { ok: true, url }
  };
}

function applyMapData(data) {
  data.spots.forEach((spot) => {
    const marker = markers[spot.id];
    if (!marker) return;
    const wind = spot.wind;
    marker.setIcon(
      buildWindIcon(
        wind?.mean_speed_knots ?? null,
        wind?.mean_direction_deg ?? null,
        wind?.std_dev_knots ?? null
      )
    );
    const stdText =
      wind?.std_dev_knots != null
        ? settings.windUnit === "mph"
          ? `±${Math.round(knotsToMph(wind.std_dev_knots))} mph`
          : `±${wind.std_dev_knots} kt`
        : "-";
    const speedLabel = wind?.mean_speed_knots != null ? formatWind(wind.mean_speed_knots) : "-";
    const srcCount = wind?.sources ? wind.sources.length : 0;
    const dirValue = wind?.mean_direction_deg;
    const dirLabel = dirValue != null ? `${dirValue}° (${cardinalFromDegrees(dirValue)})` : "-";
    marker.setPopupContent(
      `<strong>${spot.name}</strong><br/>Wind: ${speedLabel}<br/>Dir: ${dirLabel}<br/>Std dev: ${stdText}<br/>Sources: ${srcCount}`
    );
  });
}

function buildWindIcon(speed, direction, stdDev) {
  const label = speed == null ? "--" : Math.round(settings.windUnit === "mph" ? knotsToMph(speed) : speed);
  const rotation = direction == null ? 0 : direction;
  const uncertainty = stdDev != null && stdDev > 2 ? "wind-uncertain" : "";
  return L.divIcon({
    className: "wind-icon",
    html: `
      <div class="wind-marker ${uncertainty}">
        <div class="wind-arrow" style="transform: rotate(${rotation}deg)">
          <span class="arrow-shaft"></span>
          <span class="arrow-head"></span>
        </div>
        <div class="wind-speed">${label}</div>
      </div>
    `,
    iconSize: [50, 50],
    iconAnchor: [25, 25]
  });
}

setInterval(() => {
  if (map) {
    loadMapWind().catch(() => {
      // ignore map refresh errors
    });
  }
}, 10 * 60 * 1000);

function applySettingsToUI() {
  windUnitSelect.value = settings.windUnit;
  tempUnitSelect.value = settings.tempUnit;
  waveUnitSelect.value = settings.waveUnit;
  if (windUnitLabel) {
    windUnitLabel.textContent = `Wind in ${settings.windUnit === "mph" ? "mph" : "kt"}`;
  }
}

function refreshFromSettings() {
  if (lastConditions) {
    applyData(lastConditions);
  }
  if (lastMap) {
    applyMapData(lastMap);
  }
}

settingsToggle.addEventListener("click", () => {
  const isOpen = settingsPanel.classList.toggle("open");
  settingsPanel.setAttribute("aria-hidden", String(!isOpen));
});

document.addEventListener("click", (event) => {
  if (!settingsPanel.classList.contains("open")) return;
  const target = event.target;
  if (settingsPanel.contains(target) || settingsToggle.contains(target)) {
    return;
  }
  settingsPanel.classList.remove("open");
  settingsPanel.setAttribute("aria-hidden", "true");
});

[windUnitSelect, tempUnitSelect, waveUnitSelect].forEach((select) => {
  select.addEventListener("change", () => {
    settings = {
      windUnit: windUnitSelect.value,
      tempUnit: tempUnitSelect.value,
      waveUnit: waveUnitSelect.value
    };
    saveSettings();
    applySettingsToUI();
    refreshFromSettings();
  });
});

applySettingsToUI();

spotSelect.addEventListener("change", () => {
  loadConditions().catch(() => {
    statusEl.innerHTML = "<h2>Unable to load data right now.</h2>";
  });
});

loadSpots().catch(() => {
  statusEl.innerHTML = "<h2>Unable to load spots.</h2>";
});
