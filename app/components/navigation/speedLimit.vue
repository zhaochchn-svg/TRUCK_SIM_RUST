<script lang="ts" setup>
const props = defineProps<{
    truckSpeed: number;
    speedLimit: number;
}>();

const { kmToUserUnits } = useUnitConversion();
const { settings } = useSettings();

const truckSpeedConverted = computed(() => kmToUserUnits(props.truckSpeed));
const speedLimitConverted = computed(() => kmToUserUnits(props.speedLimit));

const isOverSpeed = computed(() => {
    return props.speedLimit > 0 && props.truckSpeed > props.speedLimit + 2;
});
</script>

<template>
    <div class="map-speed-overlay">
        <!-- Speed Limit Sign (Left) -->
        <Transition name="slide-fade">
            <div
                v-if="speedLimit !== 0"
                class="speed-limit-sign"
                :class="settings.selectedGame === 'ets2' ? 'eu-sign' : 'us-sign'"
            >
                <div v-if="settings.selectedGame === 'ats'" class="us-sign-label">
                    <span>SPEED</span>
                    <span>LIMIT</span>
                </div>
                <div class="limit-value">{{ speedLimitConverted }}</div>
            </div>
        </Transition>

        <!-- Current Speed Bubble (Right) -->
        <div class="current-speed-bubble" :class="{ 'over-limit': isOverSpeed }">
            <span class="speed-num">{{ truckSpeedConverted }}</span>
            <span class="speed-unit">km/h</span>
        </div>
    </div>
</template>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/navigation/speedLimit.scss"
></style>
