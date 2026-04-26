<script lang="ts" setup>
const props = defineProps<{
    launchMap: () => void;
    goToDesktopIndex: () => void;
}>();
const { selectedGame, commitSelection } = useGameSelection();
const { isWeb, isElectron } = usePlatform();

const handleStart = () => {
    commitSelection();
    props.launchMap();
};
</script>

<template>
    <div class="choose-game-section">
        <div class="top-tagline">
            <button
                v-show="isElectron"
                @click="goToDesktopIndex"
                class="back-btn"
            >
                <Icon name="lucide:arrow-left" size="22" />
            </button>

            <Icon name="lucide:earth" class="icon" size="22" />
            <span>选择游戏</span>
        </div>

        <div class="game-selection" :style="{ width: isWeb ? '80%' : '85%' }">
            <div class="select-btns">
                <GameSelection
                    v-model="selectedGame"
                    :width="isWeb ? 450 : 950"
                />
            </div>
        </div>

        <button
            :disabled="!selectedGame"
            @click.prevent="handleStart"
            class="btn nav-btn"
            autofocus
        >
            <span>开始导航</span>
            <Icon name="lucide:map-pinned" size="20" />
        </button>

        <div class="footer-actions">
            <button class="clear-cache-btn" @click="onClearCache">
                <Icon name="lucide:trash-2" size="16" />
                <span>清除所有缓存与设置</span>
            </button>
        </div>
    </div>
</template>

<script lang="ts">
export default {
    methods: {
        onClearCache() {
            if (confirm("确定要清除所有设置和缓存吗？这将重置应用到初始状态。")) {
                localStorage.clear();
                window.location.reload();
            }
        }
    }
}
</script>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/layouts/chooseGame.scss"
></style>
