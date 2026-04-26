import type { Map as MapLibreGl, StyleSpecification } from "maplibre-gl";
import { blendWithBg, lightenColor } from "~/assets/utils/shared/colors";
import { BlobSource } from "~/assets/utils/shared/BlobSource";

export const MAP_PALETTES = {
    light: {
        background: "#f1f3f4",
        roads: "#ffffff",
        roadLines: "#e0e0e0",
        water: "#c2d1f0",
        waterOutline: "#a8c0e0",
        land: "#dae0e5",
        text: "#3c4043",
        textHalo: "#ffffff",
        borders: "#c1c4c5"
    },
    dark: {
        background: "#1a1c1e",
        roads: "#2d2f31",
        roadLines: "#3c4043",
        water: "#0e1621",
        waterOutline: "#1a2b3d",
        land: "#252729",
        text: "#e1e2e5",
        textHalo: "#1a1c1e",
        borders: "#44474a"
    }
};

export function updateMapTheme(map: MapLibreGl, theme: "light" | "dark") {
    if (!map) return;
    const p = MAP_PALETTES[theme];

    try {
        if (map.getLayer("background")) map.setPaintProperty("background", "background-color", p.background);
        if (map.getLayer("lines")) map.setPaintProperty("lines", "line-color", p.roadLines);
        if (map.getLayer("water")) map.setPaintProperty("water", "fill-color", p.water);
        if (map.getLayer("water-outline")) map.setPaintProperty("water-outline", "line-color", p.waterOutline);
        if (map.getLayer("roads")) map.setPaintProperty("roads", "line-color", p.roads);
        if (map.getLayer("maparea-zones")) map.setPaintProperty("maparea-zones", "fill-color", p.land);
        if (map.getLayer("country-borders")) map.setPaintProperty("country-borders", "line-color", p.borders);
        if (map.getLayer("state-borders")) map.setPaintProperty("state-borders", "line-color", p.borders);
        
        if (map.getLayer("city-labels")) {
            map.setPaintProperty("city-labels", "text-color", p.text);
            map.setPaintProperty("city-labels", "text-halo-color", p.textHalo);
        }
        if (map.getLayer("capital-major-labels")) {
            map.setPaintProperty("capital-major-labels", "text-color", p.text);
            map.setPaintProperty("capital-major-labels", "text-halo-color", p.textHalo);
        }
        if (map.getLayer("country-labels")) {
            map.setPaintProperty("country-labels", "text-color", p.text);
            map.setPaintProperty("country-labels", "text-halo-color", p.textHalo);
        }
        if (map.getLayer("village-labels")) {
            map.setPaintProperty("village-labels", "text-color", p.text);
        }
    } catch (e) {
        console.warn("Map theme update partially failed:", e);
    }
}

export async function initializeMap(
    container: HTMLElement,
): Promise<MapLibreGl> {
    const { settings, activeSettings } = useSettings();
    const currentTheme = activeSettings.value.mapTheme || "light";
    const p = MAP_PALETTES[currentTheme as "light" | "dark"];
    const game = settings.value.selectedGame;

    const baseUrl = window.location.origin;

    const maplibregl = (await import("maplibre-gl")).default;
    const { Protocol, PMTiles } = await import("pmtiles");

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    async function loadPmtiles(fileName: string, key: string) {
        const url = `${window.location.origin}/data/${game}/map-data/tiles/${fileName}.mp3`;

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to load ${fileName}`);

            const blob = await response.blob();
            const pmtilesInstance = new PMTiles(new BlobSource(blob, key));
            protocol.add(pmtilesInstance);
        } catch (error) {
            console.error("Error loading PMTiles blob:", error);
        }
    }

    await Promise.all([
        loadPmtiles("roads", "roads"),
        loadPmtiles("map-data-combined", "all-data"),
    ]);

    const style: StyleSpecification = {
        version: 8,
        name: "PMTiles (local)",
        sources: {
            [`${game}`]: {
                type: "vector",
                url: `pmtiles://roads`,
            },
        },
        sprite: `${baseUrl}/sprites/${game}/sprites`,
        glyphs: `${baseUrl}/glyphs/{fontstack}/{range}.pbf`,
        layers: [
            {
                id: "background",
                type: "background",
                paint: { "background-color": p.background },
            },
            {
                id: "lines",
                type: "line",
                source: `${game}`,
                "source-layer": `${game}`,
                paint: {
                    "line-color": p.roadLines,
                    "line-width": 1,
                },
            },
        ],
    };

    const mapOptions = {
        container,
        style,
        center: game === "ets2" ? [10, 50] : [-115, 40],
        zoom: 6,
        minZoom: 5,
        maxZoom: 13,
        maxPitch: 60,
        fadeDuration: 0,
        attributionControl: false,
        collectResourceTiming: false,
        doubleClickZoom: true, // Re-enable default zoom
        maxBounds: game === "ets2" 
            ? [[-28, 25], [50, 74]]
            : [[-130, 23], [-60, 55]],
    };

    const map = new maplibregl.Map(mapOptions as maplibregl.MapOptions);

    map.on("load", async () => {
        map.addSource("all-data", {
            type: "vector",
            url: "pmtiles://all-data",
        });

        // WATER
        map.addLayer({
            id: "water",
            type: "fill",
            source: "all-data",
            "source-layer": "water",
            paint: { "fill-color": p.water, "fill-opacity": 1.0 },
        });

        map.addLayer({
            id: "water-outline",
            type: "line",
            source: "all-data",
            "source-layer": "water",
            paint: {
                "line-color": p.waterOutline,
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 7, 10, 4],
                "line-opacity": 0.6,
            },
        });

        // THICK ROADS
        map.addLayer({
            id: "roads",
            type: "line",
            source: `${game}`,
            "source-layer": `${game}`,
            layout: {
                "line-join": ["step", ["zoom"], "miter", 8, "round"],
                "line-cap": ["step", ["zoom"], "butt", 8, "round"],
            },
            paint: {
                "line-color": p.roads,
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 9, 2, 10, 6, 11, 9],
            },
        });

        // POLYGONS FOR PARKING ETC
        map.addLayer({
            id: "maparea-zones",
            type: "fill",
            source: "all-data",
            "source-layer": "mapareas",
            paint: {
                "fill-color": p.land,
                "fill-opacity": 0.5,
            },
        }, "lines");

        // PREFABS
        map.addLayer({
            id: "prefab-zones",
            type: "fill",
            source: "all-data",
            "source-layer": "prefabs",
            paint: {
                "fill-color": [
                    "match", ["get", "color"],
                    0, activeSettings.value.themeColor,
                    p.land
                ],
                "fill-opacity": 0.6
            },
            minzoom: 5,
        }, "lines");

        // VILLAGE NAMES (Dynamic source layer for ATS/ETS2)
        map.addLayer({
            id: "village-labels",
            type: "symbol",
            source: "all-data",
            "source-layer": game === "ets2" ? "ets2villages" : "atsvillages",
            layout: {
                "text-field": ["get", "name"],
                "text-font": [activeSettings.value.fontFamily],
                "text-size": 13,
                "text-allow-overlap": true,
            },
            paint: { "text-color": p.text },
            minzoom: 8.2,
        });

        // BORDERS
        const borderLayerNames = ["countries", "states"];
        borderLayerNames.forEach(layer => {
            map.addLayer({
                id: `${layer}-borders`,
                type: "line",
                source: "all-data",
                "source-layer": layer,
                paint: { "line-color": p.borders, "line-width": 2, "line-opacity": 0.4 },
            }, "lines");
        });

        // SPRITES
        map.addLayer({
            id: "all-sprites",
            type: "symbol",
            source: "all-data",
            "source-layer": "spritelocations",
            filter: ["!=", ["get", "poiType"], "road"],
            minzoom: 8,
            layout: {
                "icon-image": ["get", "sprite"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.7, 10, 1.5],
                "icon-allow-overlap": false,
            },
        });

        // CITY LABELS
        map.addLayer({
            id: "city-labels",
            type: "symbol",
            source: "all-data",
            "source-layer": "cities",
            layout: {
                "text-field": ["get", "name"],
                "text-font": [activeSettings.value.fontFamily],
                "text-size": 15,
                "text-offset": [0, -0.3],
                "text-allow-overlap": true,
            },
            paint: {
                "text-color": p.text,
                "text-halo-color": p.textHalo,
                "text-halo-width": 1.5,
            },
            minzoom: 6,
        });
    });

    return map;
}
