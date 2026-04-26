<script lang="ts" setup>
const { activeSettings, updateProfile } = useSettings();
const { availableVoices, speak } = useVoiceNavigation();

const hasGuidedNavigation = computed(
    () => activeSettings.value.hasTurnNavigation === true,
);

const hasVoiceNavigation = computed(
    () => activeSettings.value.voiceNavigationEnabled === true,
);

const currentVoiceURI = computed(() => activeSettings.value.voiceURI);
const voiceMode = computed(() => activeSettings.value.voiceMode || "standard");

function toggleGuidedNavigation() {
    updateProfile(
        "hasTurnNavigation",
        hasGuidedNavigation.value ? false : true,
    );
}

function toggleVoiceNavigation() {
    updateProfile(
        "voiceNavigationEnabled",
        hasVoiceNavigation.value ? false : true,
    );
    
    // Test the voice instantly when turned on
    if (!hasVoiceNavigation.value) {
        speak("语音导航已开启");
    }
}

function setVoiceMode(mode: "standard" | "concise") {
    updateProfile("voiceMode", mode);
    speak(mode === "standard" ? "播报模式已切换为标准模式" : "播报模式已切换为简洁模式");
}

function updatePersona(persona: any) {
    updateProfile("voicePersona", persona);
    speak("语音风格切换成功");
}

const personaItems = [
    { label: "标准播报", value: "standard" },
    { label: "沈腾 (幽默搞笑)", value: "shenteng" },
    { label: "刘诗诗 (温柔女神)", value: "liushishi" },
    { label: "杨紫 (俏皮可爱)", value: "yangzi" },
    { label: "周深 (空灵治愈)", value: "zhoushen" },
    { label: "莉莉 (御姐风)", value: "lily_mature" },
    { label: "莉莉 (暧昧风)", value: "lily_flirty" },
    { label: "莉莉 (温柔定制)", value: "lily_gentle" },
    { label: "莉莉 (严厉教导)", value: "lily_strict" },
    { label: "莉莉 (深夜陪伴)", value: "lily_midnight" },
    { label: "莉莉 (超甜撒娇)", value: "lily_sweet" },
];
</script>

<template>
    <div>
        <div class="option setting">
            <div class="option-title">
                <Icon name="lucide:volume-2" size="24" />
                <p>语音播报</p>
            </div>

            <div class="segmented-control" @click="toggleVoiceNavigation">
                <button
                    class="segment-btn"
                    :class="{ active: hasVoiceNavigation }"
                >
                    <span class="label">开启</span>
                </button>

                <button
                    class="segment-btn"
                    :class="{ activeOff: !hasVoiceNavigation }"
                >
                    <span class="label">关闭</span>
                </button>
            </div>
        </div>
        
        <Transition name="page-fade">
            <div v-if="hasVoiceNavigation">
                <div class="option setting">
                    <div class="option-title">
                        <Icon name="lucide:mic" size="24" />
                        <p>导航语音包</p>
                    </div>

                    <USelect
                        :model-value="activeSettings.voicePersona || 'standard'"
                        @update:model-value="(val) => updatePersona(val)"
                        :items="personaItems"
                        variant="none"
                        class="selector"
                        :ui="{
                            trailingIcon: 'shrink-0 size-[20px] text-white !px-6',
                            content: 'bg-[#222e3c] shadow-xl rounded-md max-w-[250px]',
                            item: 'flex items-center justify-between text-[1.4rem] font-BOLD !py-2 !px-3 text-[#f2f2f2] data-[highlighted]:bg-[#3d546e] rounded cursor-pointer transition-colors',
                            itemTrailingIcon: 'text-white',
                        }"
                    />
                </div>

                <div class="option setting">
                    <div class="option-title">
                        <Icon name="lucide:message-square-more" size="24" />
                        <p>播报模式</p>
                    </div>

                    <div class="segmented-control">
                        <button 
                            class="segment-btn" 
                            :class="{ active: voiceMode === 'standard' }"
                            @click="setVoiceMode('standard')"
                        >
                            <span class="label">标准</span>
                        </button>

                        <button 
                            class="segment-btn" 
                            :class="{ active: voiceMode === 'concise' }"
                            @click="setVoiceMode('concise')"
                        >
                            <span class="label">简洁</span>
                        </button>
                    </div>
                </div>

                <IncreaseProfileOption
                    option-title="播报音量"
                    setting-name="voiceVolume"
                    :max-value="1.0"
                    :min-value="0.0"
                    :amount="0.1"
                >
                    <template #icon>
                        <Icon name="lucide:volume-1" size="24" />
                    </template>
                </IncreaseProfileOption>
            </div>
        </Transition>

        <div class="small-separator"></div>

        <div class="option setting">
            <div class="option-title">
                <Icon name="lucide:navigation-2" size="24" />
                <p>路口导航引导</p>
            </div>

            <div class="segmented-control" @click="toggleGuidedNavigation">
                <button
                    class="segment-btn"
                    :class="{ active: hasGuidedNavigation }"
                >
                    <span class="label">开启</span>
                </button>

                <button
                    class="segment-btn"
                    :class="{ activeOff: !hasGuidedNavigation }"
                >
                    <span class="label">关闭</span>
                </button>
            </div>
        </div>

        <IncreaseProfileOption
            option-title="动作引导距离"
            setting-name="maneuverDistance"
            :max-value="10"
            :min-value="0.5"
            :amount="0.5"
            unit="km"
        >
            <template #icon>
                <Icon name="lucide:arrow-up-right" size="24" />
            </template>
        </IncreaseProfileOption>
    </div>
</template>
