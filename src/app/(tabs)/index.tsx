import { useCallback, useEffect, useMemo, useState } from "react";
import { Animated, Dimensions, Easing, PanResponder, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppIcon } from "@/components/AppIcon";
import { DEFAULT_FACE_API_BASE_URL, normalizeApiBaseUrl } from "@/services/config/faceBackend";
import { getEngineSetting, getFaceDatabase, getUnsyncedAttendanceRecords } from "@/services/storage/database";
import { isNetworkUsable } from "@/services/sync/syncService";

const BACKEND_URL_SETTING = "face_api_base_url";
const POSTER_INTERVAL_MS = 3600;
const POSTER_GAP = 14;
const POSTER_WIDTH = Dimensions.get("window").width - 36;
const POSTER_SLIDE_DISTANCE = POSTER_WIDTH + POSTER_GAP;

const posters = [
  {
    accent: "#22C55E",
    background: "#071B33",
    badge: "Offline Ready",
    metric: "Local AI",
    title: "Face detection, liveness and recognition on device",
    description: "Secure attendance continues at field sites even when network access is unavailable.",
  },
  {
    accent: "#F59E0B",
    background: "#172554",
    badge: "Cloud Sync",
    metric: "AWS Queue",
    title: "Buffered records sync safely when internet returns",
    description: "Attendance is stored locally first, then synced after connectivity is restored.",
  },
];

export default function Index() {
  const insets = useSafeAreaInsets();
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_FACE_API_BASE_URL);
  const [posterIndex, setPosterIndex] = useState(0);
  const [serverStatus, setServerStatus] = useState("Configured");
  const [onDeviceStatus, setOnDeviceStatus] = useState("Native engine ready to check");
  const [syncStatus, setSyncStatus] = useState("Offline queue enabled");
  const [scrollY] = useState(() => new Animated.Value(0));
  const [posterTranslateX] = useState(() => new Animated.Value(0));
  const [posterDirection, setPosterDirection] = useState<1 | -1>(1);
  const [posterAnimating, setPosterAnimating] = useState(false);

  const appBarMargin = scrollY.interpolate({
    extrapolate: "clamp",
    inputRange: [0, 64],
    outputRange: [18, 0],
  });
  const appBarRadius = scrollY.interpolate({
    extrapolate: "clamp",
    inputRange: [0, 64],
    outputRange: [24, 0],
  });
  const appBarTop = scrollY.interpolate({
    extrapolate: "clamp",
    inputRange: [0, 64],
    outputRange: [insets.top + 10, 0],
  });
  const appBarHeight = scrollY.interpolate({
    extrapolate: "clamp",
    inputRange: [0, 64],
    outputRange: [56, insets.top + 52],
  });
  const appBarPaddingTop = scrollY.interpolate({
    extrapolate: "clamp",
    inputRange: [0, 64],
    outputRange: [0, insets.top],
  });

  const animatePoster = useCallback(
    (direction: 1 | -1) => {
      if (posterAnimating) {
        return;
      }

      setPosterAnimating(true);
      setPosterDirection(direction);
      posterTranslateX.setValue(direction === 1 ? 0 : -POSTER_SLIDE_DISTANCE);

      Animated.timing(posterTranslateX, {
        duration: 460,
        easing: Easing.out(Easing.cubic),
        toValue: direction === 1 ? -POSTER_SLIDE_DISTANCE : 0,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          setPosterIndex((current) => (current + direction + posters.length) % posters.length);
        }

        posterTranslateX.setValue(0);
        setPosterAnimating(false);
      });
    },
    [posterAnimating, posterTranslateX],
  );

  const posterPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 18 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dx < -36) {
            animatePoster(1);
          } else if (gesture.dx > 36) {
            animatePoster(-1);
          }
        },
      }),
    [animatePoster],
  );

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      await getFaceDatabase();
      const [storedUrl, queueRecords, online] = await Promise.all([
        getEngineSetting(BACKEND_URL_SETTING),
        getUnsyncedAttendanceRecords(20),
        isNetworkUsable().catch(() => false),
      ]);

      if (!mounted) {
        return;
      }

      if (storedUrl) {
        setApiBaseUrl(storedUrl);
        setServerStatus(`Saved: ${storedUrl.replace(/^https?:\/\//, "")}`);
      } else {
        setServerStatus(`Default: ${DEFAULT_FACE_API_BASE_URL.replace(/^https?:\/\//, "")}`);
      }

      setOnDeviceStatus("SCRFD + EdgeFace bundled locally");
      setSyncStatus(
        queueRecords.length > 0
          ? `${queueRecords.length} record${queueRecords.length === 1 ? "" : "s"} waiting`
          : online
            ? "Online path available"
            : "No pending records",
      );
    }

    bootstrap().catch((error) => {
      if (mounted) {
        setSyncStatus(error instanceof Error ? error.message : "Status unavailable");
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      animatePoster(1);
    }, POSTER_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [animatePoster]);

  function openRecognize() {
    router.push({
      pathname: "/recognize",
      params: { apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) },
    } as never);
  }

  const poster = posters[posterIndex];
  const nextPoster = posters[(posterIndex + posterDirection + posters.length) % posters.length];
  const carouselPosters = posterDirection === 1 ? [poster, nextPoster] : [nextPoster, poster];

  return (
    <View style={styles.screen}>
      <StatusBar backgroundColor="#F7FAFF" barStyle="dark-content" />
      <Animated.View
        style={[
          styles.appBar,
          {
            borderRadius: appBarRadius,
            height: appBarHeight,
            marginHorizontal: appBarMargin,
            paddingTop: appBarPaddingTop,
            top: appBarTop,
          },
        ]}
      >
        <View style={styles.appBarSide} />
        <Text style={styles.appBarTitle}>DSEAS</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/notifications")}
          style={styles.notificationButton}
        >
          <AppIcon android="notifications_active" color="#1677FF" fallback="N" ios="bell.fill" size={22} />
        </Pressable>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 104 }]}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: false,
        })}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.welcomeBlock}>
          <Text style={styles.waveEmoji}>👋</Text>
          <View style={styles.welcomeCopy}>
            <Text style={styles.welcomeText}>Welcome to</Text>
            <Text style={styles.welcomeTitle}>NHAI-DSEAS</Text>
          </View>
        </View>

        <View style={styles.posterViewport} {...posterPanResponder.panHandlers}>
          <Animated.View style={[styles.posterTrack, { transform: [{ translateX: posterTranslateX }] }]}>
            {carouselPosters.map((carouselPoster) => (
              <PosterCard key={carouselPoster.title} poster={carouselPoster} />
            ))}
          </Animated.View>
        </View>

        <View style={styles.posterDots}>
          {posters.map((item, index) => (
            <View
              key={item.title}
              style={[styles.posterDot, index === posterIndex && { backgroundColor: item.accent, width: 28 }]}
            />
          ))}
        </View>

        <Pressable accessibilityRole="button" onPress={openRecognize} style={styles.recognizeCard}>
          <View style={styles.recognizeIcon}>
            <AppIcon android="person_search" color="#1677FF" fallback="ID" ios="person.crop.circle.badge.checkmark" size={28} />
          </View>
          <View style={styles.recognizeCopy}>
            <Text style={styles.recognizeTitle}>Recognition & Mark</Text>
            <Text style={styles.recognizeSubtitle}>Identify enrolled faces and mark attendance securely.</Text>
          </View>
          <AppIcon android="chevron_right" color="#1677FF" fallback=">" ios="chevron.right" size={24} />
        </Pressable>

        <View style={styles.statusPanel}>
          <Text style={styles.sectionTitle}>System Status</Text>
          <StatusRow label="Server Status" value={serverStatus} tone="blue" />
          <StatusRow label="On Device Engine Status" value={onDeviceStatus} tone="green" />
          <StatusRow label="Sync Status" value={syncStatus} tone="amber" />
        </View>

        <View style={styles.nhaiBlock}>
          <Text style={styles.nhaiTitle}>Built for NHAI</Text>
          <Text numberOfLines={2} style={styles.nhaiSubtitle}>
            Secure, offline-first digital enforcement and attendance support for field operations.
          </Text>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone: "blue" | "green" | "amber" }) {
  return (
    <View style={styles.statusRow}>
      <View style={[styles.statusDot, styles[`${tone}Dot`]]} />
      <View style={styles.statusCopy}>
        <Text style={styles.statusLabel}>{label}</Text>
        <Text numberOfLines={1} style={styles.statusValue}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function PosterCard({ poster }: { poster: (typeof posters)[number] }) {
  return (
    <View style={[styles.poster, { backgroundColor: poster.background }]}>
      <View style={[styles.posterGlow, { backgroundColor: poster.accent }]} />
      <View style={[styles.posterOrb, { borderColor: poster.accent }]} />
      <View style={styles.posterTopRow}>
        <Text style={[styles.posterBadge, { color: poster.accent }]}>{poster.badge}</Text>
        <Text style={styles.posterMetric}>{poster.metric}</Text>
      </View>
      <Text numberOfLines={2} style={styles.posterTitle}>
        {poster.title}
      </Text>
      <Text numberOfLines={2} style={styles.posterDescription}>
        {poster.description}
      </Text>
      <View style={styles.posterFooter}>
        <View style={styles.posterMiniCard}>
          <Text style={styles.posterMiniValue}>320</Text>
          <Text style={styles.posterMiniLabel}>Face frame</Text>
        </View>
        <View style={styles.posterMiniCard}>
          <Text style={styles.posterMiniValue}>ONNX</Text>
          <Text style={styles.posterMiniLabel}>Local engine</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  amberDot: {
    backgroundColor: "#F59E0B",
  },
  appBar: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.94)",
    borderColor: "rgba(226,232,240,0.86)",
    borderWidth: 1,
    elevation: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    left: 0,
    paddingHorizontal: 14,
    position: "absolute",
    right: 0,
    shadowColor: "#0F172A",
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 22,
    zIndex: 20,
  },
  appBarSide: {
    height: 42,
    width: 42,
  },
  appBarTitle: {
    color: "#0F172A",
    fontSize: 18,
    
    fontWeight: "900",
    letterSpacing: 3,
  },
  blueDot: {
    backgroundColor: "#1677FF",
  },
  container: {
    gap: 18,
    padding: 18,
    paddingBottom: 150,
  },
  greenDot: {
    backgroundColor: "#22C55E",
  },
  nhaiBlock: {
    backgroundColor: "#0F172A",
    borderRadius: 28,
    gap: 8,
    padding: 22,
  },
  nhaiSubtitle: {
    color: "#CBD5E1",
    fontSize: 15,
    lineHeight: 22,
  },
  nhaiTitle: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: -0.8,
  },
  notificationButton: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderColor: "#D8E8FF",
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  poster: {
    borderRadius: 32,
    elevation: 8,
    height: 226,
    overflow: "hidden",
    padding: 18,
    shadowColor: "#0F172A",
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 28,
    width: POSTER_WIDTH,
  },
  posterBadge: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 8,
    textTransform: "uppercase",
  },
  posterDescription: {
    color: "#D7E3F7",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
    maxWidth: "88%",
  },
  posterDot: {
    backgroundColor: "#CBD5E1",
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  posterDots: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: -8,
  },
  posterFooter: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  posterGlow: {
    borderRadius: 120,
    height: 190,
    opacity: 0.18,
    position: "absolute",
    right: -58,
    top: -62,
    width: 190,
  },
  posterMetric: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
    opacity: 0.78,
  },
  posterMiniCard: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  posterMiniLabel: {
    color: "#C7D2FE",
    fontSize: 11,
    fontWeight: "800",
    marginTop: 2,
  },
  posterMiniValue: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900",
  },
  posterOrb: {
    borderRadius: 76,
    borderWidth: 22,
    bottom: -60,
    height: 152,
    opacity: 0.2,
    position: "absolute",
    right: -38,
    width: 152,
  },
  posterTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: -0.5,
    lineHeight: 25,
    marginTop: 14,
    maxWidth: "92%",
  },
  posterTopRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  posterTrack: {
    flexDirection: "row",
    gap: POSTER_GAP,
  },
  posterViewport: {
    borderRadius: 32,
    height: 226,
    overflow: "hidden",
    width: "100%",
  },
  recognizeCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 26,
    borderWidth: 1,
    elevation: 4,
    flexDirection: "row",
    gap: 14,
    padding: 18,
    shadowColor: "#0F172A",
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  recognizeCopy: {
    flex: 1,
    gap: 4,
  },
  recognizeIcon: {
    alignItems: "center",
    backgroundColor: "#EAF2FF",
    borderRadius: 22,
    height: 54,
    justifyContent: "center",
    width: 54,
  },
  recognizeSubtitle: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 19,
  },
  recognizeTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900",
  },
  screen: {
    backgroundColor: "#F7FAFF",
    flex: 1,
  },
  sectionTitle: {
    color: "#0F172A",
    fontSize: 17,
    fontWeight: "900",
    marginBottom: 4,
  },
  statusCopy: {
    flex: 1,
    gap: 2,
  },
  statusDot: {
    borderRadius: 8,
    height: 16,
    width: 16,
  },
  statusLabel: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "900",
  },
  statusPanel: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 26,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  statusValue: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 18,
  },
  wave: {
    color: "#1677FF",
    fontSize: 15,
    fontWeight: "900",
  },
  waveEmoji: {
    fontSize: 34,
    lineHeight: 40,
  },
  welcomeBlock: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 2,
  },
  welcomeCopy: {
    gap: 0,
  },
  welcomeText: {
    color: "#64748B",
    fontSize: 15,
    fontWeight: "800",
  },
  welcomeTitle: {
    color: "#0F172A",
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: -0.8,
  },
});
