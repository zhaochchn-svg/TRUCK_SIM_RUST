<script lang="ts" setup>
import { computed, nextTick, ref, watch } from "vue";
import type { PoiSearchResult, PoiSearchResultType } from "~/composables/CityData";

const props = defineProps<{
    isOpen: boolean;
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "select", result: PoiSearchResult): void;
}>();

const { searchPoi } = useCityData();

const maxResults = 50;
const query = ref("");
const selectedIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

const response = computed(() => searchPoi(query.value, maxResults));
const results = computed(() => response.value.results);
const hasQuery = computed(() => query.value.trim().length >= 2);
const hasOverflow = computed(() => response.value.total > maxResults);

watch(
    () => props.isOpen,
    async (isOpen) => {
        selectedIndex.value = 0;
        if (!isOpen) return;

        await nextTick();
        inputEl.value?.focus();
        inputEl.value?.select();
    },
);

watch(results, () => {
    selectedIndex.value = 0;
});

function closePanel() {
    emit("close");
}

function clearQuery() {
    query.value = "";
    selectedIndex.value = 0;
    inputEl.value?.focus();
}

function selectResult(result: PoiSearchResult) {
    emit("select", result);
}

function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
    }

    if (!results.value.length) return;

    if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
    } else if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex.value =
            (selectedIndex.value - 1 + results.value.length) %
            results.value.length;
    } else if (event.key === "Enter") {
        event.preventDefault();
        selectResult(results.value[selectedIndex.value]!);
    }
}

function getResultIcon(type: PoiSearchResultType) {
    if (type === "company") return "lucide:warehouse";
    if (type === "city") return "lucide:building-2";
    return "lucide:map-pin";
}

function getResultTypeLabel(type: PoiSearchResultType) {
    if (type === "company") return "公司";
    if (type === "city") return "城市";
    return "地点";
}
</script>

<template>
    <Transition name="poi-search-pop">
        <section
            v-if="isOpen"
            class="poi-search-panel"
            @click.stop
            @pointerdown.stop
        >
            <div class="poi-search-input-row">
                <Icon name="lucide:search" class="search-icon" />
                <input
                    ref="inputEl"
                    v-model="query"
                    class="poi-search-input"
                    type="search"
                    placeholder="搜索城市、公司、地点"
                    autocomplete="off"
                    spellcheck="false"
                    @keydown="onKeydown"
                />
                <button
                    v-if="query"
                    class="icon-btn"
                    type="button"
                    title="清空"
                    @click.prevent="clearQuery"
                >
                    <Icon name="lucide:circle-x" />
                </button>
                <button
                    class="icon-btn"
                    type="button"
                    title="关闭"
                    @click.prevent="closePanel"
                >
                    <Icon name="lucide:x" />
                </button>
            </div>

            <div v-if="hasQuery" class="poi-search-results">
                <div v-if="hasOverflow" class="poi-search-count">
                    显示 {{ maxResults }} / {{ response.total }}
                </div>

                <button
                    v-for="(result, index) in results"
                    :key="result.id"
                    class="poi-search-result"
                    :class="{ selected: index === selectedIndex }"
                    type="button"
                    @mouseenter="selectedIndex = index"
                    @click.prevent="selectResult(result)"
                >
                    <span class="result-icon" :class="`type-${result.type}`">
                        <Icon :name="getResultIcon(result.type)" />
                    </span>
                    <span class="result-main">
                        <span class="result-title">{{ result.label }}</span>
                        <span v-if="result.subtitle" class="result-subtitle">
                            {{ result.subtitle }}
                        </span>
                    </span>
                    <span class="result-type">
                        {{ getResultTypeLabel(result.type) }}
                    </span>
                </button>

                <div v-if="results.length === 0" class="poi-search-empty">
                    未找到匹配地点
                </div>
            </div>
        </section>
    </Transition>
</template>

<style scoped lang="scss">
.poi-search-panel {
    position: absolute;
    top: calc($game-info-bar-height + 1.8rem);
    left: calc(10px + var(--hud-btn-size) + 0.9rem);
    z-index: 12;
    width: min(430px, calc(100vw - 132px));
    max-height: min(520px, calc(100dvh - 140px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    background: rgba(20, 29, 38, 0.94);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
    backdrop-filter: blur(14px);
    pointer-events: auto;
}

.poi-search-input-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.55rem;
    min-height: 48px;
    padding: 0 0.7rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.search-icon {
    width: 20px;
    height: 20px;
    color: #7dd3fc;
}

.poi-search-input {
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: #f8fafc;
    font: 600 0.98rem/1.2 inherit;
    letter-spacing: 0;

    &::placeholder {
        color: rgba(226, 232, 240, 0.56);
    }

    &::-webkit-search-cancel-button {
        display: none;
    }
}

.icon-btn {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    color: rgba(248, 250, 252, 0.76);
    background: transparent;
    cursor: pointer;

    svg {
        width: 18px;
        height: 18px;
    }

    @media (hover: hover) {
        &:hover {
            color: #ffffff;
            background: rgba(255, 255, 255, 0.1);
        }
    }
}

.poi-search-results {
    overflow-y: auto;
    padding: 0.35rem;
}

.poi-search-count {
    padding: 0.35rem 0.55rem 0.45rem;
    color: #fbbf24;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0;
}

.poi-search-result {
    width: 100%;
    min-height: 54px;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    padding: 0.45rem 0.55rem;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #f8fafc;
    text-align: left;
    cursor: pointer;

    &.selected {
        background: rgba(125, 211, 252, 0.15);
    }
}

.result-icon {
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.08);

    svg {
        width: 19px;
        height: 19px;
    }

    &.type-company {
        color: #f59e0b;
    }

    &.type-city {
        color: #7dd3fc;
    }

    &.type-scenery {
        color: #86efac;
    }
}

.result-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
}

.result-title,
.result-subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0;
}

.result-title {
    color: #ffffff;
    font-size: 0.94rem;
    font-weight: 800;
    line-height: 1.18;
}

.result-subtitle {
    color: rgba(226, 232, 240, 0.68);
    font-size: 0.78rem;
    font-weight: 600;
}

.result-type {
    align-self: center;
    padding: 0.18rem 0.38rem;
    border-radius: 5px;
    color: rgba(226, 232, 240, 0.78);
    background: rgba(255, 255, 255, 0.08);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0;
    white-space: nowrap;
}

.poi-search-empty {
    padding: 1.1rem 0.8rem 1.25rem;
    color: rgba(226, 232, 240, 0.68);
    font-size: 0.9rem;
    font-weight: 700;
    text-align: center;
}

.poi-search-pop-enter-active,
.poi-search-pop-leave-active {
    transition:
        opacity 0.16s ease,
        transform 0.16s ease;
}

.poi-search-pop-enter-from,
.poi-search-pop-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

@media (orientation: portrait) {
    .poi-search-panel {
        top: calc($game-info-bar-height + 1.8rem);
        width: calc(100vw - 132px);
        max-height: min(440px, calc(100dvh - 150px));
    }
}
</style>
