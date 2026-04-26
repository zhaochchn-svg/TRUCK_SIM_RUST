<script lang="ts" setup>
const { activeSettings, updateProfile } = useSettings();

type profileKeys = keyof GameProfile;

let holdTimer: ReturnType<typeof setTimeout> | null = null;
let repeatInterval: ReturnType<typeof setInterval> | null = null;

const props = defineProps<{
    optionTitle: string;
    settingName: profileKeys;

    maxValue: number;
    minValue: number;

    amount: number;
    unit?: string;
}>();

const currentSize = computed(() => {
    const val = activeSettings.value[props.settingName];
    return (val !== undefined && val !== null) ? val : 1.5;
});

const isAtMaxValue = computed(
    () => (currentSize.value as number) >= props.maxValue,
);
const isAtMinValue = computed(
    () => (currentSize.value as number) <= props.minValue,
);

function updateSize(mode: "+" | "-") {
    const currentVal = (activeSettings.value[props.settingName] as number) || 1.5;
    let nextValue =
        mode === "-" ? currentVal - props.amount : currentVal + props.amount;

    nextValue = Math.round(nextValue * 100) / 100;

    if (mode === "-") {
        if (isAtMinValue.value) return;
        updateProfile(props.settingName, nextValue);
    } else {
        if (isAtMaxValue.value) return;
        updateProfile(props.settingName, nextValue);
    }
}

function startHold(mode: "+" | "-") {
    updateSize(mode);

    holdTimer = setTimeout(() => {
        repeatInterval = setInterval(() => {
            updateSize(mode);
        }, 80);
    }, 400);
}

function stopHold() {
    if (holdTimer) clearTimeout(holdTimer);
    if (repeatInterval) clearInterval(repeatInterval);
}
</script>

<template>
    <div class="option setting">
        <div class="option-title">
            <slot name="icon"></slot>
            <p>{{ optionTitle }}</p>
        </div>
        <div class="increase-option">
            <button
                class="settings-btn default-color increase-decrease"
                @click.prevent="updateSize('-')"
                @mousedown="startHold('-')"
                @mouseup="stopHold"
                @mouseleave="stopHold"
                @touchstart.prevent="startHold('-')"
                @touchend="stopHold"
            >
                <Icon name="lucide:minus" />
            </button>

            <div>
                <span>{{ currentSize }} {{ unit }}</span>
            </div>

            <button
                class="settings-btn default-color increase-decrease"
                @click.prevent="updateSize('+')"
                @mousedown="startHold('+')"
                @mouseup="stopHold"
                @mouseleave="stopHold"
                @touchstart.prevent="startHold('+')"
                @touchend="stopHold"
            >
                <Icon name="lucide:plus" />
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
.increase-option {
    display: flex;
    gap: 1.2rem;
    align-items: center;

    span {
        font-size: 1.6rem;
        font-weight: 700;
        min-width: 4rem;
        text-align: center;
        display: inline-block;
    }
}
</style>
