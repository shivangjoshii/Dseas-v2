import { Tabs } from "expo-router";

import { AppBottomNav } from "@/components/AppBottomNav";

type TabRoute = {
  key: string;
  name: string;
};

type TabBarProps = {
  state: {
    index: number;
    routes: TabRoute[];
  };
  navigation: {
    dispatch: (action: { payload: { name: string }; type: string }) => void;
  };
};

function getActiveTab(routeName: string) {
  if (routeName === "enroll") {
    return "enroll";
  }

  if (routeName === "settings") {
    return "settings";
  }

  return "home";
}

function CustomTabBar({ state, navigation }: TabBarProps) {
  const activeRoute = state.routes[state.index]?.name ?? "index";
  const jumpTo = (name: string) => {
    navigation.dispatch({
      payload: { name },
      type: "JUMP_TO",
    });
  };

  return (
    <AppBottomNav
      active={getActiveTab(activeRoute)}
      onEnrollPress={() => jumpTo("enroll")}
      onHomePress={() => jumpTo("index")}
      onSettingsPress={() => jumpTo("settings")}
    />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
      }}
      tabBar={(props) => <CustomTabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="enroll" options={{ title: "Enroll" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
