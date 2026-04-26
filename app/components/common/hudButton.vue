<script lang="ts" setup>
defineProps<{
    onClick: () => void;
    isActive?: boolean;
    disabled?: boolean;
}>();
</script>

<template>
    <button
        class="option-btn"
        :disabled="disabled"
        @click.prevent.stop="!disabled && onClick()"
    >
        <slot />
    </button>
</template>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/common/hudButton.scss"
></style>
