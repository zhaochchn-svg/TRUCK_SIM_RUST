<script lang="ts" setup>
/**
 * 应用主入口
 * 管理游戏选择、地图显示与全局设置初始化
 */
const { settings, initSettings } = useSettings();

// 当前视图状态: chooseGame | map
const currentView = ref<string>("");

onMounted(() => {
    // 1. 初始化持久化设置
    initSettings();

    // 2. 持久化逻辑: 如果之前已选择过游戏，直接进入地图
    if (settings.value.selectedGame) {
        currentView.value = "map";
    } else {
        currentView.value = "chooseGame";
    }
});

/**
 * 切换到地图视图
 */
const launchMap = () => {
    currentView.value = "map";
};

/**
 * 返回到游戏选择页面 (不清除持久化选择，仅切换视图)
 */
const goHome = () => {
    currentView.value = "chooseGame";
};
</script>

<template>
    <div class="app-main-container">
        <!-- 游戏选择视图 -->
        <Transition name="page-fade">
            <ChooseGame
                v-if="currentView === 'chooseGame'"
                :launch-map="launchMap"
                :go-to-desktop-index="() => {}"
            />
        </Transition>

        <!-- 地图导航视图 -->
        <Transition name="page-fade">
            <LazyMap
                v-if="currentView === 'map'"
                :goHome="goHome"
                :key="settings.selectedGame ?? 'none'"
            />
        </Transition>
    </div>
</template>

<style lang="scss">
.app-main-container {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background-color: #000;
}

.page-fade-enter-active,
.page-fade-leave-active {
    transition: opacity 0.3s ease;
}

.page-fade-enter-from,
.page-fade-leave-to {
    opacity: 0;
}
</style>
