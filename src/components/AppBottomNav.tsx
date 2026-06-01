import { Pressable, StyleSheet, Text, View } from "react-native";

import { AppIcon } from "@/components/AppIcon";

type BottomNavItem = "home" | "enroll" | "settings";

type AppBottomNavProps = {
  active: BottomNavItem;
  onHomePress: () => void;
  onEnrollPress: () => void;
  onSettingsPress: () => void;
};

export function AppBottomNav({ active, onHomePress, onEnrollPress, onSettingsPress }: AppBottomNavProps) {
  return (
    <View pointerEvents="box-none" style={styles.wrapper}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          onPress={onHomePress}
          style={[styles.sideItem, active === "home" && styles.activeSideItem]}
        >
          <AppIcon android="home" color={active === "home" ? "#0B5FEA" : "#0F172A"} fallback="H" ios="house.fill" size={23} />
          <Text style={[styles.sideLabel, active === "home" && styles.activeSideLabel]}>Home</Text>
        </Pressable>

        <View style={styles.notchSpace} />

        <Pressable
          accessibilityRole="button"
          onPress={onSettingsPress}
          style={[styles.sideItem, active === "settings" && styles.activeSideItem]}
        >
          <AppIcon
            android="settings"
            color={active === "settings" ? "#0B5FEA" : "#0F172A"}
            fallback="S"
            ios="gearshape.fill"
            size={23}
          />
          <Text style={[styles.sideLabel, active === "settings" && styles.activeSideLabel]}>Settings</Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onEnrollPress}
        style={[styles.enrollButton, active === "enroll" && styles.activeEnrollButton]}
      >
        <AppIcon android="person_add" color="#FFFFFF" fallback="+" ios="person.crop.circle.badge.plus" size={24} />
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
  enrollLabel: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "900",
    marginTop: 1,
  },
  notchSpace: {
    width: 74,
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
