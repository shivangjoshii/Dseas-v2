import { StyleSheet, Text, type TextStyle, type ViewStyle } from "react-native";
import { SymbolView } from "expo-symbols";

type AppIconProps = {
  android: string;
  ios: string;
  color?: string;
  fallback?: string;
  size?: number;
  style?: ViewStyle;
};

export function AppIcon({ android, ios, color = "#0F172A", fallback = "•", size = 22, style }: AppIconProps) {
  return (
    <SymbolView
      fallback={<Text style={[styles.fallback, { color, fontSize: size } as TextStyle]}>{fallback}</Text>}
      name={{ android, ios, web: android } as never}
      size={size}
      style={style}
      tintColor={color}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    fontWeight: "900",
    lineHeight: 24,
    textAlign: "center",
  },
});
