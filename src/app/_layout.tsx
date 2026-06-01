import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0F172A" },
          headerTintColor: "#FFFFFF",
          headerTitleAlign: "center",
          headerTitleStyle: { fontWeight: "700" },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="recognize" options={{ title: "Recognize & Mark" }} />
        <Stack.Screen name="detect" options={{ title: "Detect Faces" }} />
        <Stack.Screen name="logs" options={{ title: "Attendance Logs" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
