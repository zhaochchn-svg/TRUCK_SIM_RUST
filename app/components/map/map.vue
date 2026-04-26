<script lang="ts" setup>
/**
 * 地图主组件
 * 负责地图初始化、遥感数据订阅、UI 图层叠加以及自动寻路逻辑
 */
import { ref, onMounted, shallowRef, Transition } from "vue";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { usePlatform } from "~/composables/Platform";
import { blendWithBg, lightenColor } from "~/assets/utils/shared/colors";
import { generateTruckIcon } from "~/assets/utils/map/markers";

defineProps<{ goHome: () => void }>();

// 交互反馈触发器
const clickingNotificationTrigger = ref(0);

// ======> COMPOSABLES <======

// 配置管理
const { activeSettings, settings, updateGlobal } = useSettings();

// 地图实例与状态
const mapEl = shallowRef<HTMLElement | null>(null);
const map = shallowRef<maplibregl.Map | null>(null);
const isSettingsPanelOpened = ref(false);

// 点击设置目的地使能状态
const isClickingEnabled = ref(settings.value.isClickingEnabled);

const disableClicking = () => {
    if (isClickingEnabled.value) {
        isClickingEnabled.value = false;
    } else if (settings.value.isClickingEnabled) {
        updateGlobal("isClickingEnabled", false);
    }
};

watch(isClickingEnabled, (val) => {
    if (settings.value.isClickingEnabled !== val) {
        updateGlobal("isClickingEnabled", val);
    }
});

watch(() => settings.value.isClickingEnabled, (val) => {
    isClickingEnabled.value = val;
});

// UI 面板状态
const isSheetHidden = ref(false);

// 任务同步 Key (用于判断任务是否发生变更)
const currentJobKey = ref<string>("");

// 订阅遥感数据
const {
    startTelemetry,
    stopTelemetry,
    gameTime,
    gameConnected,
    truckCoords,
    truckSpeed,
    speedLimit,
    truckHeading,
    fuel,
    restStoptime,
    restStopMinutes,
    hasInGameMarker,
    hasActiveJob,
    destinationCity,
    scale,
    averageSpeed,
    destinationCompany,
} = useEtsTelemetry();

// 城市与位置数据加载器
const { loadLocationData, findDestinationCoords } = useCityData();

// 平台检查
const { isElectron, isMobile, isWeb } = usePlatform();
const { announceOverSpeed } = useVoiceNavigation();

// 路网系统
const { loading, progress, adjacency, nodeCoords, initializeGraphData } =
    useGraphSystem();

// 地图相机与标记管理
const {
    isCameraLocked,
    isAutoFollowEnabled,
    isNavigating,
    initCameraListeners,
    followTruck,
    startNavigationMode,
    stopNavigationMode,
    initMarker,
    updateMarkerSize,
    updateMarkerImage,
    toggleAutoFollow,
} = useMapCamera(map);

// 路由逻辑控制
const {
    setupRouteLayer,
    handleRouteClick,
    updateRouteProgress,
    clearRouteState,
    destinationName,
    routeDistance,
    routeEta,
    isCalculating: isCalculatingRoute,
    isWorkerReady,
    initWorkerData,
    destroyWorker,
    isRouteActive,
    routeFound,
    fullRouteDirections,
    nextTurnDistance,
} = useRouteController(map, adjacency, nodeCoords, stopNavigationMode);

let uiTimer: ReturnType<typeof setTimeout> | null = null;
let routeTimer: ReturnType<typeof setTimeout> | null = null;
const mockTruckCoords = ref<[number, number] | null>(null);
const mockTruckHeading = ref(0);

// 在挂载前强制显示加载页，防止闪烁
loading.value = true;
progress.value = 0;

// 判断卡车是否已在地图上生成 (非 0,0 坐标)
const isTruckSpawned = computed(() => {
    return (
        truckCoords.value &&
        (truckCoords.value[0] !== 0 || truckCoords.value[1] !== 0)
    );
});

const activeTruckCoords = computed<[number, number] | null>(() => {
    if (gameConnected.value) {
        return isTruckSpawned.value ? truckCoords.value : null;
    }

    return mockTruckCoords.value;
});

const activeTruckHeading = computed(() =>
    gameConnected.value ? truckHeading.value : mockTruckHeading.value,
);

const activeRouteScale = computed(() =>
    scale.value > 0 ? scale.value : settings.value.selectedGame === "ats" ? 20 : 19,
);

const activeAverageSpeed = computed(() =>
    gameConnected.value ? averageSpeed.value : 80,
);
const isOverSpeed = computed(
    () => speedLimit.value > 0 && truckSpeed.value > speedLimit.value + 2,
);
const showOverSpeedWarning = computed(
    () => gameConnected.value && isOverSpeed.value,
);
let overSpeedSince = 0;
let lastOverSpeedVoiceAt = 0;

function syncMockTruckFromMap(force: boolean = false) {
    if (gameConnected.value || !map.value) return;
    if (isRouteActive.value && !force) return;

    const center = map.value.getCenter();
    const nextCoords: [number, number] = [center.lng, center.lat];
    const nextHeading = ((map.value.getBearing() % 360) + 360) % 360;

    mockTruckCoords.value = nextCoords;
    mockTruckHeading.value = nextHeading;
    followTruck(nextCoords, nextHeading);
}

watch(
    [gameConnected, loading],
    ([isConnected, isLoading]) => {
        if (isConnected) {
            mockTruckCoords.value = null;
            mockTruckHeading.value = 0;
            return;
        }

        if (!isLoading && map.value) {
            syncMockTruckFromMap(true);
        }
    },
    { immediate: true },
);

/**
 * 监听游戏任务变化: 自动同步游戏内的导航路线
 */
watch(
    [
        hasActiveJob,
        destinationCity,
        destinationCompany,
        gameConnected,
        loading,
        isWorkerReady,
        isTruckSpawned,
    ],
    async ([
        hasJob,
        city,
        company,
        isConnected,
        isLoading,
        isReady,
        truckReady,
    ]) => {
        if (!truckCoords.value) return;
        // 必须等待后端连接和路网数据加载完成
        if (isLoading || !isReady || !isConnected || !truckReady) {
            currentJobKey.value = "";
            return;
        }

        const newJobKey = hasJob ? `${city}|${company}` : "";
        if (hasJob && newJobKey === currentJobKey.value) return;

        if (routeTimer) clearTimeout(routeTimer);

        if (hasJob && newJobKey !== currentJobKey.value) {
            const destCoords = findDestinationCoords(city, company);
            if (destCoords) {
                currentJobKey.value = newJobKey;
                clearRouteState();
                disableClicking();

                await handleRouteClick(
                    destCoords,
                    truckCoords.value,
                    truckHeading.value,
                    activeRouteScale.value,
                    false,
                    activeAverageSpeed.value,
                );
            }
        } else if (!hasJob && currentJobKey.value !== "") {
            // 任务结束，清理路径
            clearRouteState();
            stopNavigationMode();
            currentJobKey.value = "";
        }
    },
);

// 标记是否已经执行过刷新后的自动恢复
const hasAutoRecovered = ref(false);

/**
 * 监听路由计算结果，延迟自动重置状态以隐藏 UI 图标
 */
watch(routeFound, (newVal) => {
    if (newVal !== null) {
        if (uiTimer) clearTimeout(uiTimer);
        uiTimer = setTimeout(() => {
            routeFound.value = null;
        }, 2000); // 2秒后重置
    }
});

/**
 * 监听手动设置的目的地: 实现刷新页面后的导航自动恢复
 */
watch(
    [gameConnected, loading, isWorkerReady, isTruckSpawned, truckCoords],
    ([isGameConnected, isLoading, isReady, truckReady, currentCoords]) => {
        // 如果已经恢复过，或者条件不满足，则跳过
        if (hasAutoRecovered.value || isLoading || !isReady || !isGameConnected || !truckReady || !currentCoords) return;

        const destination = activeSettings.value.lastDestination;
        if (destination && !isRouteActive.value && !isCalculatingRoute.value) {
            console.log("[Map] 正在自动恢复上次的导航路线...");
            hasAutoRecovered.value = true; // 确保只触发一次
            disableClicking();
            handleRouteClick(
                destination,
                currentCoords,
                truckHeading.value,
                activeRouteScale.value,
                true,
                activeAverageSpeed.value,
            );
        }
    },
    { immediate: true }
);

// 监听主题色变化，更新卡车图标
watch(
    () => activeSettings.value.themeColor,
    async (newColor) => {
        if (!map.value) return;
        const newTruckImg = await generateTruckIcon(newColor);
        updateMarkerImage(newTruckImg.src);
    },
);

/**
 * 生命周期: 组件挂载
 */
onMounted(async () => {
    // 加载城市坐标数据
    await loadLocationData();
    if (!mapEl.value) return;

    try {
        // 初始化 MapLibre 实例
        const mapInstance = await initializeMap(mapEl.value);
        map.value = markRaw(mapInstance);
        if (!map.value) return;

        const initialTruckImg = await generateTruckIcon(activeSettings.value.themeColor);

        map.value.on("load", async () => {
            // 1. 初始化卡车标记
            initMarker(initialTruckImg.src, settings.value.truckMarkerSize);
            
            // 2. 加载路网二进制数据并通知 RouteController
            const graphData = await initializeGraphData();
            if (graphData) {
                initWorkerData(); // 标记后端服务就绪
            }

            // 3. 设置地图图层与事件监听
            setupRouteLayer();
            initCameraListeners();
            syncMockTruckFromMap(true);
        });

        map.value.on("moveend", () => {
            syncMockTruckFromMap();
        });

        // 处理地图点击: 手动设置目的地
        map.value.on("click", async (e) => {
            const features = map.value!.queryRenderedFeatures(e.point, { layers: ["destination-layer"] });
            if (
                features.length > 0 ||
                !settings.value.isClickingEnabled ||
                !activeTruckCoords.value
            ) {
                return;
            }

            await handleRouteClick(
                [e.lngLat.lng, e.lngLat.lat],
                activeTruckCoords.value,
                activeTruckHeading.value,
                activeRouteScale.value,
                true,
                activeAverageSpeed.value,
            );

            if (isRouteActive.value) disableClicking();
        });

        // 启动遥感数据循环
        startTelemetry(() => onTelemetryUpdate());
    } catch (e) {
        console.error("地图初始化失败:", e);
    }
});

onUnmounted(() => {
    stopTelemetry();
    destroyWorker();
    if (routeTimer) clearTimeout(routeTimer);
    if (uiTimer) clearTimeout(uiTimer);
    if (map.value) {
        map.value.remove();
        map.value = null;
    }
});

/**
 * 每一帧遥感数据更新时的逻辑
 */
function onTelemetryUpdate() {
    if (
        !map.value ||
        !gameConnected.value ||
        !isTruckSpawned.value ||
        !truckCoords.value
    ) {
        return;
    }

    // 相机跟随卡车
    followTruck(truckCoords.value, truckHeading.value);

    // 如果导航激活，更新导航线进度
    if (isRouteActive.value) {
        updateRouteProgress(
            truckCoords.value,
            truckHeading.value,
            scale.value,
            averageSpeed.value,
        );
    }

    const now = Date.now();
    if (showOverSpeedWarning.value) {
        if (overSpeedSince === 0) overSpeedSince = now;
        const sustainedForMs = now - overSpeedSince;
        if (sustainedForMs >= 2500 && now - lastOverSpeedVoiceAt >= 18000) {
            announceOverSpeed();
            lastOverSpeedVoiceAt = now;
        }
    } else {
        overSpeedSince = 0;
    }
}

/**
 * 开始导航模式 (UI 切换)
 */
function onStartNavigation() {
    if (!activeTruckCoords.value) return;
    startNavigationMode(activeTruckCoords.value, activeTruckHeading.value);
    isSheetHidden.value = true;
}

function onSheetClosed() {
    isSheetHidden.value = false;
}

function toggleEnableClicking() {
    isClickingEnabled.value = !isClickingEnabled.value;
    clickingNotificationTrigger.value++;
}

const onResetNorth = () => {
    map.value?.easeTo({ bearing: 0, pitch: 0, duration: 500 });
};

const onZoomIn = () => {
    if (!canUseZoomControls()) return;
    map.value!.zoomIn({ duration: 250 });
};

const onZoomOut = () => {
    if (!canUseZoomControls()) return;
    map.value!.zoomOut({ duration: 250 });
};

const canUseZoomControls = () => {
    if (!map.value) return false;

    const hasZoomInteraction =
        map.value.scrollZoom.isEnabled() ||
        map.value.touchZoomRotate.isEnabled() ||
        map.value.doubleClickZoom.isEnabled();

    if (!hasZoomInteraction) return false;

    const zoom = map.value.getZoom();
    const minZoom = map.value.getMinZoom();
    const maxZoom = map.value.getMaxZoom();

    return zoom >= minZoom && zoom <= maxZoom;
};

const canZoomIn = computed(() => {
    if (!map.value || !canUseZoomControls()) return false;
    return map.value.getZoom() < map.value.getMaxZoom() - 0.001;
});

const canZoomOut = computed(() => {
    if (!map.value || !canUseZoomControls()) return false;
    return map.value.getZoom() > map.value.getMinZoom() + 0.001;
});

const onToggleFullscreen = async () => {
    const target = document.documentElement;

    try {
        if (!document.fullscreenElement) {
            await target.requestFullscreen();
        } else if (document.exitFullscreen) {
            await document.exitFullscreen();
        }

        setTimeout(() => {
            map.value?.resize();
        }, 100);
    } catch (err) {
        console.error("Fullscreen error:", err);
    }
};

const onCancelRoute = () => {
    clearRouteState();
    stopNavigationMode();
    syncMockTruckFromMap(true);
};

const toggleSettingsPanel = () => {
    isSettingsPanelOpened.value = !isSettingsPanelOpened.value;
};
</script>

<template>
    <div
        ref="wrapperEl"
        class="full-page-wrapper"
        :class="{ 'platform-mobile': isMobile }"
    >
        <div ref="mapEl" class="map-container"></div>

        <div class="ui-safe-container">
            <Transition name="ui-layer-fade">
                <div v-show="!isSettingsPanelOpened" class="map-ui-layer">
                    <Transition name="fade">
                        <!-- 加载遮罩 -->
                        <LoadingScreen v-if="loading" :progress="progress" />
                    </Transition>

                    <!-- 顶部状态栏 -->
                    <TopBar
                        v-show="settings.activeUiComponents.includes('topBar')"
                        :fuel="fuel"
                        :game-connected="gameConnected"
                        :game-time="gameTime"
                        :rest-stop-minutes="restStopMinutes"
                        :rest-stop-time="restStoptime"
                        :is-web="isWeb"
                    />

                    <!-- 左侧控制按钮 -->
                    <div class="left-buttons">
                        <HudButton :onClick="goHome">
                            <Icon name="lucide:arrow-left" class="icon" />
                        </HudButton>

                        <HudButton :onClick="toggleSettingsPanel">
                            <Icon name="lucide:settings" class="icon" />
                        </HudButton>
                    </div>

                    <div v-if="!gameConnected" class="offline-badge">
                        <Icon name="lucide:plug-zap-off" class="offline-badge-icon" />
                        <span>Game Offline</span>
                    </div>

                    <!-- 导航步骤卡片 -->
                    <ManeuverCard
                        v-show="isNavigating && activeSettings.hasTurnNavigation"
                        :upcoming-turns="fullRouteDirections"
                        :distance-to-next-turn="nextTurnDistance"
                        :next-instruction="fullRouteDirections[1]?.text || '继续沿路行驶'"
                    />

                    <!-- 通用通知 -->
                    <NotificationGeneral
                        :trigger="clickingNotificationTrigger"
                        :text="isClickingEnabled ? '已开启地图选点' : '已禁用地图选点'"
                    >
                        <template #icon>
                            <Icon v-if="isClickingEnabled" name="lucide:pointer" size="24" color="#4caf50" />
                            <Icon v-else name="lucide:pointer-off" size="24" color="#dd4a34" />
                        </template>
                    </NotificationGeneral>

                    <!-- 路由计算状态通知 -->
                    <NotificationRoute
                        :is-route-found="routeFound"
                        :is-calculating-route="isCalculatingRoute"
                    />

                    <!-- 右侧 HUD 按钮组 -->
                    <div class="hud-buttons">
                        <HudButton v-if="!isElectron" :onClick="onToggleFullscreen">
                            <Icon name="lucide:fullscreen" class="icon" />
                        </HudButton>

                        <HudButton :onClick="onResetNorth">
                            <Icon name="lucide:compass" class="icon" />
                        </HudButton>

                        <HudButton
                            :is-active="isAutoFollowEnabled"
                            :class="{ 'green-icon': isAutoFollowEnabled }"
                            :onClick="toggleAutoFollow"
                        >
                            <Icon v-if="isAutoFollowEnabled" name="lucide:locate-fixed" class="icon" />
                            <Icon v-else name="lucide:locate" class="icon" />
                        </HudButton>

                        <HudButton :onClick="onZoomIn" :disabled="!canZoomIn">
                            <Icon name="lucide:plus" class="icon" />
                        </HudButton>

                        <HudButton :onClick="onZoomOut" :disabled="!canZoomOut">
                            <Icon name="lucide:minus" class="icon" />
                        </HudButton>

                        <HudButton
                            :is-active="isClickingEnabled"
                            :class="isClickingEnabled ? 'green-icon' : 'red-icon'"
                            :onClick="toggleEnableClicking"
                        >
                            <Icon v-if="isClickingEnabled" name="lucide:pointer" class="icon" />
                            <Icon v-else name="lucide:pointer-off" class="icon" />
                        </HudButton>
                    </div>

                    <!-- 限速显示 -->
                    <SpeedLimit
                        v-show="speedLimit > 0 && settings.activeUiComponents.includes('speedLimit')"
                        :truck-speed="truckSpeed"
                        :speed-limit="speedLimit"
                    />

                    <!-- 警告提示 -->
                    <div class="warnings">
                        <WarningSlide
                            :show-if="showOverSpeedWarning"
                            :reset-on="!showOverSpeedWarning"
                            text="您已超速，请注意减速"
                        />
                        <WarningSlide
                            :show-if="hasInGameMarker && !isRouteActive"
                            :reset-on="isRouteActive"
                            text="检测到外部路线: 设置导航点"
                        />
                    </div>

                    <!-- 底部导航详情面板 -->
                    <Transition name="sheet-slide" @after-leave="onSheetClosed">
                        <SheetSlide
                            v-if="isRouteActive"
                            :on-stop-navigation="onCancelRoute"
                            :is-navigating="isNavigating"
                            :on-start-navigation="onStartNavigation"
                            :destination-name="destinationName"
                            v-model:is-sheet-hidden="isSheetHidden"
                            :route-distance="routeDistance"
                            :route-eta="routeEta"
                            :speed-limit="speedLimit"
                            :truck-speed="truckSpeed"
                        />
                    </Transition>
                </div>
            </Transition>

            <!-- 设置面板 -->
            <Transition name="panel-pop">
                <SettingsPanel
                    v-show="isSettingsPanelOpened"
                    :close-panel="toggleSettingsPanel"
                />
            </Transition>
        </div>
    </div>
</template>

<style scoped lang="scss" src="~/assets/scss/scoped/map/map.scss"></style>
