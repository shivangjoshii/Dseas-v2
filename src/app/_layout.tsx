import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#0F172A" },
        headerTintColor: "#FFFFFF",
        headerTitleAlign: "center",
        headerTitleStyle: { fontWeight: "700" },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="enroll" options={{ title: "Enroll Face" }} />
      <Stack.Screen name="recognize" options={{ title: "Recognize & Mark" }} />
      <Stack.Screen name="detect" options={{ title: "Detect Faces" }} />
      <Stack.Screen name="logs" options={{ title: "Attendance Logs" }} />
    </Stack>
  );
}
