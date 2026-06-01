import { StatusBar, StyleSheet, Text, View } from "react-native";
import LottieView from "lottie-react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const emptyNotificationsAnimation = require("../../assets/animations/empty-notifications.json");

export default function NotificationsScreen() {
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <StatusBar backgroundColor="#0F172A" barStyle="light-content" />
      <View style={styles.emptyState}>
        {/* <View style={styles.animationCard}>
          <LottieView
            autoPlay
            loop
            source={emptyNotificationsAnimation}
            style={styles.animation}
          />
        </View> */}
        <View style={styles.copy}>
          <Text style={styles.title}>No notifications yet</Text>
          <Text style={styles.subtitle}>
            Important DSEAS alerts and updates will appear here.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  animation: {
    height: 220,
    width: 220,
  },
  animationCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 42,
    borderWidth: 1,
    elevation: 6,
    height: 260,
    justifyContent: "center",
    shadowColor: "#0F172A",
    shadowOffset: { height: 14, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 26,
    width: 260,
  },
  copy: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 22,
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    gap: 28,
    justifyContent: "center",
    padding: 24,
  },
  screen: {
    backgroundColor: "#F7FAFF",
    flex: 1,
  },
  subtitle: {
    color: "#64748B",
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 310,
    textAlign: "center",
  },
  title: {
    color: "#0F172A",
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: -0.4,
    textAlign: "center",
  },
});
