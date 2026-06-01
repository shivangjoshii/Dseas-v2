import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type SnackbarTone = "success" | "error" | "info";

export type SnackbarState = {
  message: string;
  tone?: SnackbarTone;
  visible: boolean;
};

type FloatingSnackbarProps = SnackbarState & {
  onDismiss: () => void;
};

const SNACKBAR_DURATION_MS = 2000;

export function FloatingSnackbar({ message, onDismiss, tone = "info", visible }: FloatingSnackbarProps) {
  const insets = useSafeAreaInsets();
  const [translateY] = useState(() => new Animated.Value(-26));
  const [opacity] = useState(() => new Animated.Value(0));
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!visible) {
      translateY.setValue(-26);
      opacity.setValue(0);
      return;
    }

    Animated.parallel([
      Animated.spring(translateY, {
        damping: 19,
        stiffness: 210,
        toValue: 0,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        duration: 160,
        toValue: 1,
        useNativeDriver: true,
      }),
    ]).start();

    const timeout = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, {
          duration: 180,
          toValue: -26,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 160,
          toValue: 0,
          useNativeDriver: true,
        }),
      ]).start(() => onDismissRef.current());
    }, SNACKBAR_DURATION_MS);

    return () => clearTimeout(timeout);
  }, [opacity, translateY, visible]);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrapper,
        {
          opacity,
          top: Math.max(18, insets.top + 68),
          transform: [{ translateY }],
        },
      ]}
    >
      <View style={[styles.snackbar, styles[tone]]}>
        <Text numberOfLines={2} style={styles.message}>
          {message}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  error: {
    backgroundColor: "#DC2626",
  },
  info: {
    backgroundColor: "#0F172A",
  },
  message: {
    color: "#FFFFFF",
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 20,
    textAlign: "center",
  },
  snackbar: {
    borderRadius: 18,
    elevation: 16,
    maxWidth: 340,
    minHeight: 50,
    paddingHorizontal: 18,
    paddingVertical: 14,
    shadowColor: "#0F172A",
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
  },
  success: {
    backgroundColor: "#15803D",
  },
  wrapper: {
    alignItems: "center",
    left: 18,
    position: "absolute",
    right: 18,
    zIndex: 100,
  },
});
