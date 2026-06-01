import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";

type BottomNavItem = "home" | "enroll" | "settings";

type AppBottomNavProps = {
  active: BottomNavItem;
  apiBaseUrl?: string;
};

function navigateTo(pathname: "/" | "/enroll" | "/settings", apiBaseUrl?: string) {
  if (apiBaseUrl) {
    router.navigate({ pathname, params: { apiBaseUrl } } as never);
    return;
  }

  router.navigate({ pathname } as never);
}

export function AppBottomNav({ active, apiBaseUrl }: AppBottomNavProps) {
  return (
    <View pointerEvents="box-none" style={styles.wrapper}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigateTo("/", apiBaseUrl)}
          style={[styles.sideItem, active === "home" && styles.activeSideItem]}
        >
          <Text style={styles.sideIcon}>⌂</Text>
          <Text style={[styles.sideLabel, active === "home" && styles.activeSideLabel]}>Home</Text>
        </Pressable>

        <View style={styles.notchSpace} />

        <Pressable
          accessibilityRole="button"
          onPress={() => navigateTo("/settings", apiBaseUrl)}
          style={[styles.sideItem, active === "settings" && styles.activeSideItem]}
        >
          <Text style={styles.sideIcon}>⚙</Text>
          <Text style={[styles.sideLabel, active === "settings" && styles.activeSideLabel]}>Settings</Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => navigateTo("/enroll", apiBaseUrl)}
        style={[styles.enrollButton, active === "enroll" && styles.activeEnrollButton]}
      >
        <Text style={styles.enrollIcon}>＋</Text>
        <Text style={styles.enrollLabel}>Enroll</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  activeEnrollButton: {
    backgroundColor: "#0B5FEA",
  },
  activeSideItem: {
    backgroundColor: "#EAF2FF",
  },
  activeSideLabel: {
    color: "#0B5FEA",
  },
  bar: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 28,
    borderWidth: 1,
    elevation: 12,
    flexDirection: "row",
    height: 68,
    justifyContent: "space-between",
    paddingHorizontal: 16,
    shadowColor: "#0F172A",
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
  },
  enrollButton: {
    alignItems: "center",
    backgroundColor: "#1677FF",
    borderColor: "#F7FAFF",
    borderRadius: 32,
    borderWidth: 5,
    elevation: 16,
    height: 66,
    justifyContent: "center",
    left: "50%",
    marginLeft: -33,
    position: "absolute",
    top: -22,
    width: 66,
  },
  enrollIcon: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "900",
    lineHeight: 23,
  },
  enrollLabel: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "900",
    marginTop: 1,
  },
  notchSpace: {
    width: 74,
  },
  sideIcon: {
    color: "#0F172A",
    fontSize: 22,
    fontWeight: "900",
  },
  sideItem: {
    alignItems: "center",
    borderRadius: 22,
    flex: 1,
    gap: 3,
    height: 50,
    justifyContent: "center",
  },
  sideLabel: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "900",
  },
  wrapper: {
    bottom: 12,
    left: 18,
    position: "absolute",
    right: 18,
  },
});
