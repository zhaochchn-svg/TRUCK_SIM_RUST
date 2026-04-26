import { ref, shallowRef } from "vue";
import {
    convertAtsToGeo,
    convertEts2ToGeo,
} from "~/assets/utils/map/converters";
import { type WorkerCityArea } from "~/assets/utils/routing/algorithm";
import type { GameType } from "~/types";

// --- Types ---
export interface ScsCityArea {
    uid: string;
    type: number;
    x: number;
    y: number;
    width: number;
    height: number;
    hidden: boolean;
}

export interface ScsCity {
    token: string;
    name: string;
    countryToken: string;
    population: number;
    x: number;
    y: number;
    areas: ScsCityArea[];
}

interface GeoJsonProperties {
    name: string;
    poiName: string;
    poiType: string;
    countryToken?: string;
    scaleRank?: number;
    state?: string;
    [key: string]: any;
}

interface GeoJsonFeature {
    type: "Feature";
    geometry: {
        type: "Point";
        coordinates: [number, number];
    };
    properties: GeoJsonProperties;
}

interface GeoJsonCollection {
    type: "FeatureCollection";
    features: GeoJsonFeature[];
}

interface RealCompanyModFallback {
    [companyId: string]: {
        name: string;
        sort_name: string;
        trailer_look: string;
    };
}

const scsCitiesData = shallowRef<ScsCity[] | null>(null);
const villageData = shallowRef<GeoJsonCollection | null>(null);
const companiesData = shallowRef<GeoJsonCollection | null>(null);
const realCompanyModData = shallowRef<RealCompanyModFallback | null>(null);

const CITY_TRANSLATIONS: Record<string, string> = {
    // ATS
    "seattle": "西雅图", "portland": "波特兰", "los_angeles": "洛杉矶", "san_francisco": "旧金山",
    "las_vegas": "拉斯维加斯", "phoenix": "凤凰城", "denver": "丹佛", "salt_lake_city": "盐湖城",
    "boise": "博伊西", "helena": "海伦娜", "cheyenne": "夏延", "albuquerque": "阿尔伯克基",
    "austin": "奥斯汀", "houston": "休斯顿", "dallas": "达拉斯", "san_antonio": "圣安东尼奥",
    "sacramento": "萨克拉门托", "san_diego": "圣迭戈", "el_paso": "埃尔帕索", "raton": "拉顿",
    // ETS2
    "berlin": "柏林", "paris": "巴黎", "london": "伦敦", "rome": "罗马", "madrid": "马德里",
    "warsaw": "华沙", "prague": "布拉格", "vienna": "维也纳", "brussels": "布鲁塞尔",
    "amsterdam": "阿姆斯特丹", "zurich": "苏黎世", "milan": "米兰", "munich": "慕尼黑",
    "frankfurt": "法兰克福", "hamburg": "汉堡", "lyon": "里昂", "marseille": "马赛"
};

const COUNTRY_TRANSLATIONS: Record<string, string> = {
    "germany": "德国", "france": "法国", "uk": "英国", "italy": "意大利", "spain": "西班牙",
    "poland": "波兰", "austria": "奥地利", "belgium": "比利时", "netherlands": "荷兰",
    "switzerland": "瑞士", "czech": "捷克", "slovakia": "斯洛伐克", "hungary": "匈牙利",
    "washington": "华盛顿州", "oregon": "俄勒冈州", "california": "加利福尼亚州",
    "nevada": "内华达州", "arizona": "亚利桑那州", "utah": "犹他州", "idaho": "爱达荷州",
    "montana": "蒙大拿州", "wyoming": "怀俄明州", "colorado": "科罗拉多州",
    "new_mexico": "新墨西哥州", "texas": "德克萨斯州"
};

const isLoaded = ref(false);
const optimizedCityNodes = shallowRef<WorkerCityArea[]>([]);
const loadedGame = ref<GameType | null>(null);

export function useCityData() {
    const { settings } = useSettings();

    function getBilingualName(name: string, token: string): { en: string; cn: string } {
        const cn = CITY_TRANSLATIONS[token.toLowerCase()];
        return { en: name, cn: cn || "" };
    }

    function getBilingualCountry(token: string): { en: string; cn: string } {
        const cn = COUNTRY_TRANSLATIONS[token.toLowerCase()];
        const en = token
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
        return { en, cn: cn || "" };
    }

    async function loadLocationData() {
        if (loadedGame.value === settings.value.selectedGame) return;

        scsCitiesData.value = null;
        villageData.value = null;
        companiesData.value = null;
        realCompanyModData.value = null;
        optimizedCityNodes.value = [];

        try {
            if (settings.value.selectedGame === "ets2") {
                const [
                    citiesRes,
                    villagesRes,
                    companiesRes,
                    realCompanyModRes,
                ] = await Promise.all([
                    fetch("/data/ets2/map-data/cities.json"),
                    fetch("/data/ets2/map-data/villages.geojson"),
                    fetch("/data/ets2/map-data/companies.geojson"),
                    fetch(
                        "/data/ets2/map-data/RealCompaniesModVanillaMapping.json",
                    ),
                ]);

                if (citiesRes.ok) scsCitiesData.value = await citiesRes.json();
                if (villagesRes.ok)
                    villageData.value = await villagesRes.json();
                if (companiesRes.ok)
                    companiesData.value = await companiesRes.json();
                if (realCompanyModRes.ok)
                    realCompanyModData.value = await realCompanyModRes.json();
            } else if (settings.value.selectedGame == "ats") {
                const [citiesRes, companiesRes, realCompanyModRes] =
                    await Promise.all([
                        fetch("/data/ats/map-data/cities.json"),
                        fetch("/data/ats/map-data/companies.geojson"),
                        fetch(
                            "/data/ats/map-data/RealCompaniesModVanillaMapping.json",
                        ),
                    ]);

                if (citiesRes.ok) scsCitiesData.value = await citiesRes.json();
                if (companiesRes.ok)
                    companiesData.value = await companiesRes.json();
                if (realCompanyModRes.ok)
                    realCompanyModData.value = await realCompanyModRes.json();
            }

            optimizedCityNodes.value = getWorkerCityData() || [];

            isLoaded.value = true;
            loadedGame.value = settings.value.selectedGame;
        } catch (e) {
            console.error("Failed to load map data:", e);
            loadedGame.value = null;
        }
    }

    function findDestinationCoords(
        targetCityId: string,
        targetCompanyId: string,
    ): [number, number] | null {
        if (!isLoaded.value || !companiesData.value) return null;

        let cityCoords = getCityGeoCoordinates(targetCityId);

        if (!cityCoords) {
            console.warn(`City Token not found in data: ${targetCityId}`);
            return null;
        }

        const safeCompanyName = targetCompanyId.toLowerCase().trim();
        let vanillaId: string | undefined = undefined;

        if (realCompanyModData.value) {
            vanillaId = Object.keys(realCompanyModData.value).find((key) => {
                const entry = realCompanyModData.value![key];
                return (
                    entry?.sort_name &&
                    safeCompanyName.includes(
                        entry.sort_name.toLowerCase().trim(),
                    )
                );
            });
        }

        const companyCandidates = companiesData.value.features.filter((f) => {
            const p = f.properties;

            return (
                p.poiType === "company" &&
                p.sprite &&
                (p.sprite.toLowerCase().trim() === safeCompanyName ||
                    (vanillaId && p["sprite"].includes(vanillaId)))
            );
        });

        if (companyCandidates.length === 0) {
            console.warn(`Company not found in data ${targetCompanyId}`);

            return [cityCoords[0], cityCoords[1]];
        }

        let bestCandidate: GeoJsonFeature | null = null;
        let minDistance = Infinity;

        const [cityLng, cityLat] = cityCoords;

        for (const candidate of companyCandidates) {
            const [companyLng, companyLat] = candidate.geometry.coordinates;

            const differenceX = companyLng - cityLng;
            const differenceY = companyLat - cityLat;
            const distance =
                differenceX * differenceX + differenceY * differenceY;

            if (distance < minDistance) {
                minDistance = distance;
                bestCandidate = candidate;
            }
        }

        if (bestCandidate) {
            const [finalLng, finalLat] = bestCandidate.geometry.coordinates;

            return [finalLng, finalLat];
        }

        return null;
    }

    function getCityGeoCoordinates(tokenId: string): [number, number] | null {
        if (!scsCitiesData.value) return null;
        const searchToken = tokenId.toLowerCase().trim();

        const city = scsCitiesData.value.find(
            (c) => c.token.toLowerCase() === searchToken,
        );

        if (city) {
            if (settings.value.selectedGame === "ets2") {
                return convertEts2ToGeo(city.x, city.y);
            } else {
                return convertAtsToGeo(city.x, city.y);
            }
        }

        return null;
    }

    function getWorkerCityData(): WorkerCityArea[] {
        const areasOut: WorkerCityArea[] = [];
        if (!scsCitiesData.value) return areasOut;

        for (const city of scsCitiesData.value) {
            if (city.areas && city.areas.length > 0) {
                for (const area of city.areas) {
                    areasOut.push({
                        minX: area.x - area.width / 2,
                        maxX: area.x + area.width / 2,
                        minZ: area.y - area.height / 2,
                        maxZ: area.y + area.height / 2,
                    });
                }
            }
        }
        return areasOut;
    }

    function getGameLocationName(targetLng: number, targetLat: number): string {
        if (!isLoaded.value) return "正在加载数据...";

        let bestName = "";
        let bestToken = "";
        let bestCountryToken = "";
        let minDistance = Infinity;

        if (scsCitiesData.value) {
            for (const city of scsCitiesData.value) {
                const [lng, lat] =
                    settings.value.selectedGame === "ets2"
                        ? convertEts2ToGeo(city.x, city.y)
                        : convertAtsToGeo(city.x, city.y);

                const dx = lng - targetLng;
                const dy = lat - targetLat;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < minDistance) {
                    minDistance = dist;
                    bestName = city.name;
                    bestToken = city.token;
                    bestCountryToken = city.countryToken;
                }
            }
        }

        if (villageData.value && villageData.value.features) {
            for (const feature of villageData.value.features) {
                const [lng, lat] = feature.geometry.coordinates;

                const dx = lng - targetLng;
                const dy = lat - targetLat;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < minDistance) {
                    minDistance = dist;
                    bestName = feature.properties.name;
                    bestToken = feature.properties.name;
                    bestCountryToken =
                        feature.properties.state ||
                        feature.properties.countryToken ||
                        "";
                }
            }
        }

        if (bestName) {
            const threshold = 0.3;

            const bilingualName = getBilingualName(bestName, bestToken);
            const bilingualCountry = getBilingualCountry(bestCountryToken);

            let enFullName = bilingualCountry.en
                ? `${bilingualName.en}, ${bilingualCountry.en}`
                : bilingualName.en;
            
            let cnFullName = bilingualCountry.cn
                ? `${bilingualCountry.cn}${bilingualName.cn}`
                : bilingualName.cn;

            if (minDistance >= threshold) {
                enFullName = `Near ${enFullName}`;
                cnFullName = `在${cnFullName}附近`;
            }

            return cnFullName ? `${enFullName}|${cnFullName}` : enFullName;
        }

        return "Open Road|荒郊野外";
    }

    return {
        scsCitiesData,
        loadLocationData,
        getGameLocationName,
        getWorkerCityData,
        findDestinationCoords,
    };
}
