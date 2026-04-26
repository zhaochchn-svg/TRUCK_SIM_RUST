<script lang="ts" setup>
const { settings, updateGlobal } = useSettings();

interface Component {
    id: UiComponent;
    title: string;
    description: string;
    iconName: string;
}

const components: Component[] = [
    {
        id: "speed",
        title: "速度",
        description:
            "显示当前卡车的行驶速度及对应单位。",
        iconName: "lucide:gauge",
    },

    {
        id: "fuel",
        title: "燃油",
        description:
            "显示剩余燃油量，燃油不足时会闪烁提醒。",
        iconName: "lucide:fuel",
    },

    {
        id: "sleep",
        title: "休息时间",
        description:
            "显示距离下一次强制休息所需的剩余时间。",
        iconName: "lucide:bed-double",
    },

    {
        id: "time",
        title: "游戏时间",
        description: "显示当前游戏内的时间。",
        iconName: "lucide:clock",
    },

    {
        id: "speedLimit",
        title: "限速标识",
        description:
            "显示当前路段的法定行驶限速。",
        iconName: "lucide:octagon-alert",
    },

    {
        id: "topBar",
        title: "顶部信息栏",
        description: "开启或关闭整个顶部行车信息栏。",
        iconName: "lucide:info",
    },
];

function toggleUiComponent(componentId: UiComponent) {
    const currentList = [...settings.value.activeUiComponents];
    const index = currentList.indexOf(componentId);

    if (index > -1) {
        currentList.splice(index, 1);
    } else {
        currentList.push(componentId);
    }

    updateGlobal("activeUiComponents", currentList);
}
</script>

<template>
    <div class="manage-drive-info-wrapper">
        <div
            class="component"
            v-for="component in components"
            :key="component.id"
            @click="toggleUiComponent(component.id)"
            :class="{
                'is-active': settings.activeUiComponents.includes(component.id),
            }"
        >
            <div class="info">
                <div class="title">
                    <Icon class="icon" :name="component.iconName" />
                    <p>{{ component.title }}</p>
                </div>
                <div class="description">{{ component.description }}</div>
            </div>

            <div
                class="checkmark"
                :class="{
                    'is-active': settings.activeUiComponents.includes(
                        component.id,
                    ),
                }"
            >
                <Icon
                    v-if="settings.activeUiComponents.includes(component.id)"
                    class="icon"
                    :class="{
                        'is-active': settings.activeUiComponents.includes(
                            component.id,
                        ),
                    }"
                    name="lucide:circle-check"
                />

                <Icon
                    v-else
                    class="icon"
                    :class="{
                        'is-active': settings.activeUiComponents.includes(
                            component.id,
                        ),
                    }"
                    name="lucide:circle"
                />
            </div>
        </div>
    </div>

    <div v-if="false">
        <Icon name="lucide:gauge" />
        <Icon name="lucide:fuel" />
        <Icon name="lucide:bed-double" />
        <Icon name="lucide:clock" />
        <Icon name="lucide:octagon-alert" />
        <Icon name="lucide:info" />
    </div>
</template>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/settings/manageDriveInfoPanel.scss"
></style>
