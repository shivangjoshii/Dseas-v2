const { createRunOncePlugin, withMainApplication, withSettingsGradle } = require("@expo/config-plugins");

const ONNX_PACKAGE_IMPORT = "import ai.onnxruntime.reactnative.OnnxruntimePackage";
const ONNX_PACKAGE_REGISTRATION = "add(OnnxruntimePackage())";
const ONNX_SETTINGS_INCLUDE = [
  "include ':onnxruntime-react-native'",
  "project(':onnxruntime-react-native').projectDir = new File(rootProject.projectDir, '../node_modules/onnxruntime-react-native/android')",
].join("\n");

function withOnnxruntimeAndroidFix(config) {
  config = withSettingsGradle(config, (gradleConfig) => {
    if (!gradleConfig.modResults.contents.includes("include ':onnxruntime-react-native'")) {
      gradleConfig.modResults.contents = `${gradleConfig.modResults.contents.trimEnd()}\n\n${ONNX_SETTINGS_INCLUDE}\n`;
    }

    return gradleConfig;
  });

  config = withMainApplication(config, (mainApplicationConfig) => {
    let contents = mainApplicationConfig.modResults.contents;

    if (!contents.includes(ONNX_PACKAGE_IMPORT)) {
      contents = contents.replace(
        "import expo.modules.ApplicationLifecycleDispatcher",
        `${ONNX_PACKAGE_IMPORT}\nimport expo.modules.ApplicationLifecycleDispatcher`,
      );
    }

    if (!contents.includes(ONNX_PACKAGE_REGISTRATION)) {
      contents = contents.replace(
        /PackageList\(this\)\.packages\.apply\s*\{\n/,
        (match) => `${match}          ${ONNX_PACKAGE_REGISTRATION}\n`,
      );
    }

    mainApplicationConfig.modResults.contents = contents;
    return mainApplicationConfig;
  });

  return config;
}

module.exports = createRunOncePlugin(withOnnxruntimeAndroidFix, "with-onnxruntime-android-fix", "1.0.0");
