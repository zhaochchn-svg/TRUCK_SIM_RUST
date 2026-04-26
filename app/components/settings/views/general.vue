<script lang="ts" setup>
import { ets2Expansions } from "~/data/ets2/ets2Expansions";
import { atsExpansions } from "~/data/ats/atsExpansions";

const { settings, activeSettings, updateProfile, resetSettings } =
    useSettings();

const isDlcPanelOpened = ref(false);

const isMetric = computed(() => activeSettings.value.units === "metric");
const selectedExpansion = computed(() => {
    return settings.value.selectedGame === "ets2"
        ? ets2Expansions
        : atsExpansions;
});

function toggleUnits() {
    updateProfile("units", isMetric.value ? "imperial" : "metric");
}

function toggleDlcPanel() {
    isDlcPanelOpened.value = !isDlcPanelOpened.value;
}
</script>

<template>
    <div>
        <div class="option setting">
            <div class="option-title">
                <Icon name="lucide:map-plus" size="24" />
                <p>已拥有 DLC</p>
            </div>
            <div class="owned-dlcs">
                <button
                    @click.prevent="toggleDlcPanel"
                    class="nav-btn settings-btn"
                >
                    {{ activeSettings.ownedDlcs.length }} /
                    {{ Object.keys(selectedExpansion).length }}
                    已开启
                </button>
            </div>
        </div>

        <div class="option setting">
            <div class="option-title">
                <Icon name="lucide:ruler" size="24" />
                <p>单位系统</p>
            </div>

            <div class="segmented-control" @click="toggleUnits">
                <button class="segment-btn" :class="{ active: isMetric }">
                    <span class="label">公制</span>
                </button>

                <button class="segment-btn" :class="{ active: !isMetric }">
                    <span class="label">英制</span>
                </button>
            </div>
        </div>

        <div class="small-separator"></div>

        <div class="option setting">
            <div class="option-title">
                <Icon name="lucide:rotate-ccw" size="24" />
                <p>恢复默认设置</p>
            </div>

            <button
                @click.prevent="resetSettings"
                class="nav-btn settings-btn red-color"
            >
                重置
            </button>
        </div>

        <Transition name="panel-pop">
            <PopupPanel
                v-if="isDlcPanelOpened"
                title="选择 DLC"
                @close="toggleDlcPanel"
            >
                <ManageDlcsWindow />
            </PopupPanel>
        </Transition>
    </div>
</template>
