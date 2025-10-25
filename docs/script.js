const baseStyles = [
  {
    id: "openmaptiles",
    name: "OpenMapTiles Bright",
    url: "https://demotiles.maplibre.org/style.json",
  },
  {
    id: "carto-positron",
    name: "Carto Positron",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  },
  {
    id: "carto-dark",
    name: "Carto Dark Matter",
    url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  },
];

let map;
let mapReady = false;
let processedCollection = null;
let processedMetrics = [];

initialize();

function initialize() {
  setupMap();
  const fileInput = document.getElementById("fileInput");
  const downloadBtn = document.getElementById("downloadCsv");
  populateBasemapOptions();

  fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        handleGeoJson(data);
      } catch (error) {
        console.error(error);
        alert("Unable to parse the selected file as GeoJSON.");
      }
    };
    reader.onerror = () => {
      alert("Failed to read the selected file.");
    };
    reader.readAsText(file);
  });

  downloadBtn.addEventListener("click", () => {
    if (!processedMetrics.length) {
      return;
    }
    downloadCsv(processedCollection.features);
  });

  const basemapSelect = document.getElementById("basemapSelect");
  basemapSelect.addEventListener("change", (event) => {
    const selected = baseStyles.find((style) => style.id === event.target.value);
    if (selected && map) {
      map.setStyle(selected.url);
    }
  });
}

function setupMap() {
  map = new maplibregl.Map({
    container: "map",
    style: baseStyles[0].url,
    center: [0, 20],
    zoom: 1.5,
    pitch: 45,
    bearing: -17.6,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  map.on("load", () => {
    mapReady = true;
    addBuildingSourceAndLayers();
    attachBuildingPopup();
    if (processedCollection) {
      updateMapData(processedCollection);
    }
  });

  map.on("style.load", () => {
    addBuildingSourceAndLayers();
    attachBuildingPopup();
    if (processedCollection) {
      updateMapData(processedCollection);
    }
  });
}

function handleGeoJson(data) {
  if (!data || typeof data !== "object") {
    alert("The selected file does not contain valid GeoJSON data.");
    return;
  }

  const features = extractPolygonFeatures(data);
  if (!features.length) {
    alert("No polygon features were found in the GeoJSON file.");
    return;
  }

  const processedFeatures = features.map((feature, index) =>
    enrichFeatureWithMetrics(feature, index)
  );

  processedCollection = {
    type: "FeatureCollection",
    features: processedFeatures,
  };

  processedMetrics = processedFeatures.map((feature) => ({
    area_sqm: feature.properties.area_sqm,
    roundness: feature.properties.roundness,
    centroid_lat: feature.properties.centroid_lat,
    centroid_lon: feature.properties.centroid_lon,
    orientation_deg: feature.properties.orientation_deg,
  }));

  renderStats(processedMetrics);
  document.getElementById("downloadCsv").disabled = false;

  updateMapData(processedCollection);
}

function extractPolygonFeatures(geojson) {
  const featureCollection = normalizeToFeatureCollection(geojson);
  if (!featureCollection) {
    return [];
  }

  const polygonFeatures = [];
  featureCollection.features.forEach((feature) => {
    if (!feature || !feature.geometry) return;

    const geomType = feature.geometry.type;
    if (geomType === "Polygon") {
      polygonFeatures.push(feature);
    } else if (geomType === "MultiPolygon") {
      feature.geometry.coordinates.forEach((polygonCoords) => {
        polygonFeatures.push({
          type: "Feature",
          properties: { ...feature.properties },
          geometry: {
            type: "Polygon",
            coordinates: polygonCoords,
          },
        });
      });
    }
  });

  return polygonFeatures;
}

function normalizeToFeatureCollection(geojson) {
  if (geojson.type === "FeatureCollection") {
    return geojson;
  }
  if (geojson.type === "Feature") {
    return { type: "FeatureCollection", features: [geojson] };
  }
  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: geojson }],
    };
  }
  return null;
}

function enrichFeatureWithMetrics(feature, index) {
  const polygon = turf.cleanCoords(feature);
  const area = turf.area(polygon);
  const perimeter =
    turf.length(turf.polygonToLine(polygon), { units: "kilometers" }) * 1000;
  const centroidFeature = turf.centroid(polygon);
  const [centroidLon, centroidLat] = centroidFeature.geometry.coordinates;

  const roundness = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
  const orientation = computeMajorAxisOrientation(polygon, [centroidLon, centroidLat]);

  const extrudeHeight = computeExtrudeHeight(area);

  const properties = {
    ...(feature.properties || {}),
    feature_id: feature.id ?? index + 1,
    area_sqm: area,
    perimeter_m: perimeter,
    roundness,
    centroid_lat: centroidLat,
    centroid_lon: centroidLon,
    orientation_deg: orientation,
    extrude_height: extrudeHeight,
  };

  return {
    type: "Feature",
    geometry: feature.geometry,
    properties,
  };
}

function computeExtrudeHeight(area) {
  if (!isFinite(area) || area <= 0) {
    return 5;
  }
  const scaled = Math.sqrt(area);
  return Math.max(Math.min(scaled, 120), 8);
}

function computeMajorAxisOrientation(polygon, centroid) {
  try {
    const utmProj = buildUtmProjection(centroid[0], centroid[1]);
    const projectedPoints = [];
    polygon.geometry.coordinates.forEach((ring) => {
      ring.forEach((coord) => {
        const [x, y] = proj4(proj4.WGS84, utmProj, coord);
        projectedPoints.push([x, y]);
      });
    });

    if (projectedPoints.length < 2) {
      return 0;
    }

    let meanX = 0;
    let meanY = 0;
    projectedPoints.forEach(([x, y]) => {
      meanX += x;
      meanY += y;
    });
    meanX /= projectedPoints.length;
    meanY /= projectedPoints.length;

    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    projectedPoints.forEach(([x, y]) => {
      const dx = x - meanX;
      const dy = y - meanY;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    });

    const n = projectedPoints.length;
    if (n === 0) {
      return 0;
    }
    sxx /= n;
    syy /= n;
    sxy /= n;

    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const discriminant = Math.max(trace * trace * 0.25 - det, 0);
    const lambda1 = trace * 0.5 + Math.sqrt(discriminant);

    let vx;
    let vy;
    if (Math.abs(sxy) > 1e-9) {
      vx = lambda1 - syy;
      vy = sxy;
    } else {
      if (sxx >= syy) {
        vx = 1;
        vy = 0;
      } else {
        vx = 0;
        vy = 1;
      }
    }

    const length = Math.hypot(vx, vy);
    if (length === 0) {
      return 0;
    }

    vx /= length;
    vy /= length;

    let angle = (Math.atan2(vx, vy) * 180) / Math.PI;
    if (angle < 0) {
      angle += 360;
    }
    return angle;
  } catch (error) {
    console.warn("Orientation calculation failed", error);
    return 0;
  }
}

function buildUtmProjection(lon, lat) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const isNorthernHemisphere = lat >= 0;
  const base = `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
  return isNorthernHemisphere ? base : `${base} +south`;
}

function renderStats(metrics) {
  const container = document.getElementById("statsContainer");
  if (!metrics.length) {
    container.innerHTML = "<p>No data loaded yet.</p>";
    return;
  }

  const statsConfig = [
    { key: "area_sqm", label: "Area (m²)", digits: 2 },
    { key: "roundness", label: "Roundness", digits: 3 },
    { key: "centroid_lat", label: "Centroid Latitude", digits: 5 },
    { key: "centroid_lon", label: "Centroid Longitude", digits: 5 },
    { key: "orientation_deg", label: "Major Axis Orientation (°)", digits: 2 },
  ];

  const rows = statsConfig
    .map((config) => {
      const values = metrics.map((item) => item[config.key]).filter(isFinite);
      const stats = computeStats(values);
      return `
        <tr>
          <th scope="row">${config.label}</th>
          <td>${stats.count}</td>
          <td>${formatNumber(stats.sum, config.digits)}</td>
          <td>${formatNumber(stats.mean, config.digits)}</td>
          <td>${formatNumber(stats.stdDev, config.digits)}</td>
          <td>${formatNumber(stats.min, config.digits)}</td>
          <td>${formatNumber(stats.max, config.digits)}</td>
        </tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Feature</th>
          <th>Count</th>
          <th>Sum</th>
          <th>Mean</th>
          <th>Std Dev</th>
          <th>Min</th>
          <th>Max</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

function computeStats(values) {
  const count = values.length;
  if (!count) {
    return {
      count: 0,
      sum: 0,
      mean: 0,
      stdDev: 0,
      min: 0,
      max: 0,
    };
  }

  const sum = values.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const variance =
    values.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) / count;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...values);
  const max = Math.max(...values);

  return { count, sum, mean, stdDev, min, max };
}

function formatNumber(value, digits) {
  if (typeof value !== "number" || !isFinite(value)) {
    return "-";
  }
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function updateMapData(collection) {
  if (!collection || !collection.features.length || !mapReady) {
    if (collection && collection.features.length) {
      processedCollection = collection;
    }
    return;
  }

  const source = map.getSource("buildings");
  if (source) {
    source.setData(collection);
  }

  const bounds = turf.bbox(collection);
  if (bounds && isFinite(bounds[0])) {
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, maxZoom: 17 }
    );
  }
}

function downloadCsv(features) {
  const originalKeys = new Set();
  features.forEach((feature) => {
    Object.keys(feature.properties || {}).forEach((key) => {
      if (
        !key.startsWith("__") &&
        ![
          "area_sqm",
          "perimeter_m",
          "roundness",
          "centroid_lat",
          "centroid_lon",
          "orientation_deg",
          "extrude_height",
        ].includes(key)
      ) {
        originalKeys.add(key);
      }
    });
  });

  const computedKeys = [
    "area_sqm",
    "perimeter_m",
    "roundness",
    "centroid_lat",
    "centroid_lon",
    "orientation_deg",
    "extrude_height",
  ];

  const headers = [...originalKeys, ...computedKeys];
  const csvRows = [headers.join(",")];

  features.forEach((feature) => {
    const props = feature.properties || {};
    const row = headers
      .map((key) => escapeCsvValue(props[key]))
      .join(",");
    csvRows.push(row);
  });

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "building_shape_metrics.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const stringValue = String(value);
  if (stringValue.includes(",") || stringValue.includes("\"") || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function populateBasemapOptions() {
  const basemapSelect = document.getElementById("basemapSelect");
  if (!basemapSelect) return;
  basemapSelect.innerHTML = baseStyles
    .map(
      (style, index) =>
        `<option value="${style.id}"${index === 0 ? " selected" : ""}>${style.name}</option>`
    )
    .join("");
}

function addBuildingSourceAndLayers() {
  if (!map) return;

  if (!map.getSource("buildings")) {
    map.addSource("buildings", {
      type: "geojson",
      data: processedCollection || { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer("buildings-fill")) {
    map.addLayer({
      id: "buildings-fill",
      type: "fill",
      source: "buildings",
      paint: {
        "fill-color": [
          "interpolate",
          ["linear"],
          ["get", "roundness"],
          0,
          "#be123c",
          0.5,
          "#f97316",
          1,
          "#22c55e",
        ],
        "fill-opacity": 0.4,
      },
    });
  }

  if (!map.getLayer("buildings-extrusion")) {
    map.addLayer({
      id: "buildings-extrusion",
      type: "fill-extrusion",
      source: "buildings",
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["get", "roundness"],
          0,
          "#831843",
          0.5,
          "#f59e0b",
          1,
          "#16a34a",
        ],
        "fill-extrusion-height": ["get", "extrude_height"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.75,
      },
    });
  }

  if (!map.getLayer("buildings-outline")) {
    map.addLayer({
      id: "buildings-outline",
      type: "line",
      source: "buildings",
      paint: {
        "line-width": 1,
        "line-color": "#1f2937",
      },
    });
  }
}

function attachBuildingPopup() {
  if (!map) return;
  if (map._buildingClickHandlerAttached) {
    return;
  }
  const handler = (e) => {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const props = feature.properties || {};
    const description = `
      <div class="popup">
        <strong>${props.name || "Building"}</strong><br />
        Area: ${formatNumber(props.area_sqm, 2)} m²<br />
        Roundness: ${formatNumber(props.roundness, 3)}<br />
        Centroid: ${formatNumber(props.centroid_lat, 6)}, ${formatNumber(
          props.centroid_lon,
          6
        )}<br />
        Orientation: ${formatNumber(props.orientation_deg, 1)}°
      </div>`;

    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(description).addTo(map);
  };
  map.on("click", "buildings-fill", handler);
  map.on("click", "buildings-extrusion", handler);
  map._buildingClickHandlerAttached = true;
}
