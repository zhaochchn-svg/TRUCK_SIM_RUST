<script lang="ts" setup>
import type { TelemetryEventNotification } from "~/types";

const props = defineProps<{
    items: TelemetryEventNotification[];
}>();

const activeItem = ref<TelemetryEventNotification | null>(null);
const isVisible = ref(false);
const animationKey = ref(0);

const durationSeconds = computed(() => {
    const item = activeItem.value;
    if (!item) return 8;

    const textLength = item.title.length + item.detail.length;
    return Math.min(16, Math.max(8, textLength * 0.16));
});

watch(
    () => props.items[0]?.id,
    () => {
        const nextItem = props.items[0];
        if (!nextItem) return;

        activeItem.value = nextItem;
        isVisible.value = true;
        animationKey.value++;
    },
);

function onTickerAnimationEnd() {
    isVisible.value = false;
}
</script>

<template>
    <Transition name="telemetry-ticker-fade">
        <div
            v-if="isVisible && activeItem"
            class="telemetry-event-ticker"
            aria-live="polite"
        >
            <div class="ticker-mask">
                <div
                    :key="animationKey"
                    class="ticker-track"
                    :style="{ '--ticker-duration': `${durationSeconds}s` }"
                    @animationend="onTickerAnimationEnd"
                >
                    <div class="ticker-item" :class="activeItem.category">
                        <span class="event-badge">
                            {{ activeItem.category === "finance" ? "财务" : "物流" }}
                        </span>
                        <Icon :name="activeItem.icon" class="event-icon" />
                        <strong>{{ activeItem.title }}</strong>
                        <span>{{ activeItem.detail }}</span>
                    </div>
                </div>
            </div>
        </div>
    </Transition>
</template>

<style scoped lang="scss">
.telemetry-event-ticker {
    position: absolute;
    top: calc($game-info-bar-height + 1.1rem);
    left: 50%;
    z-index: 12;
    width: min(820px, calc(100vw - 8rem));
    height: 42px;
    pointer-events: none;
    transform: translateX(-50%);
}

.ticker-mask {
    overflow: hidden;
    width: 100%;
    height: 100%;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    background: rgba(15, 23, 42, 0.86);
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
    backdrop-filter: blur(12px);
}

.ticker-track {
    display: inline-flex;
    align-items: center;
    width: max-content;
    height: 100%;
    padding-left: 100%;
    animation: ticker-scroll var(--ticker-duration, 8s) linear 1 both;
    will-change: transform;
}

.ticker-item {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    height: 30px;
    padding: 0 0.75rem;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.08);
    color: #f8fafc;
    font-size: 0.86rem;
    font-weight: 600;
    letter-spacing: 0;
    white-space: nowrap;
}

.ticker-item.finance .event-badge {
    background: rgba(251, 191, 36, 0.18);
    color: #fde68a;
}

.ticker-item.logistics .event-badge {
    background: rgba(56, 189, 248, 0.18);
    color: #bae6fd;
}

.event-badge {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 0.4rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 700;
}

.event-icon {
    flex: 0 0 auto;
    width: 1rem;
    height: 1rem;
}

@keyframes ticker-scroll {
    from {
        transform: translateX(0);
    }

    to {
        transform: translateX(-100%);
    }
}

.telemetry-ticker-fade-enter-active,
.telemetry-ticker-fade-leave-active {
    transition:
        opacity 0.18s ease,
        transform 0.18s ease;
}

.telemetry-ticker-fade-enter-from,
.telemetry-ticker-fade-leave-to {
    opacity: 0;
    transform: translate(-50%, -8px);
}

@media (orientation: portrait) {
    .telemetry-event-ticker {
        top: calc($game-info-bar-height + 1rem);
        width: calc(100vw - 1.5rem);
    }
}
</style>
