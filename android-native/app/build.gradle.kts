import java.net.URI

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.kotlin.compose)
}

// This string is compiled into the app. Accept only an origin, never a URL
// containing credentials, a page, or Java string escapes.
val configuredOrigin = providers.gradleProperty("merrymen.origin")
  .orElse("https://app.merrymen.dev").get().trim()
val originUri = runCatching { URI(configuredOrigin) }.getOrNull()
  ?: throw GradleException("merrymen.origin must be a valid HTTP(S) origin.")
require(
  originUri.scheme?.lowercase() in setOf("http", "https") &&
    originUri.host != null && originUri.rawUserInfo == null &&
    originUri.rawPath in setOf("", "/") && originUri.rawQuery == null &&
    originUri.rawFragment == null && (originUri.port == -1 || originUri.port in 1..65535),
) { "merrymen.origin must be an HTTP(S) origin without credentials, a path, query, or fragment." }
val apiOrigin = "${originUri.scheme.lowercase()}://${originUri.rawAuthority}"
val developmentHost = originUri.host.lowercase() in setOf("localhost", "10.0.2.2")
require(originUri.scheme.equals("https", ignoreCase = true) || developmentHost) {
  "Plain HTTP is allowed only for localhost or the Android emulator (10.0.2.2)."
}

// Do not put signing credentials in gradle.properties, command-line arguments,
// or source control. A developer can compile and test without the upload key.
val signingEnvNames = listOf(
  "MERRYMEN_ANDROID_KEYSTORE",
  "MERRYMEN_ANDROID_STORE_PASSWORD",
  "MERRYMEN_ANDROID_KEY_ALIAS",
  "MERRYMEN_ANDROID_KEY_PASSWORD",
)
val signingInputs = signingEnvNames.associateWith { providers.environmentVariable(it).orNull }
val hasSigning = signingInputs.values.any { it != null }
require(!hasSigning || signingInputs.values.all { !it.isNullOrBlank() }) {
  "Android signing is incomplete. Supply all four MERRYMEN_ANDROID signing environment variables, or unset all four."
}
val uploadKeystore = signingInputs["MERRYMEN_ANDROID_KEYSTORE"]?.let { file(it) }

android {
  namespace = "dev.merrymen.app"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.merrymen.app"
    minSdk = 26
    targetSdk = 36
    // Http.kt derives the user-agent version from BuildConfig.VERSION_NAME.
    versionCode = 3
    versionName = "0.3.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    // THE ORIGIN IS A BUILD INPUT, not a literal in the code. The gateway host
    // moved once already and three hand-copies had to move with it; this app
    // will not become a fourth. Override with -Pmerrymen.origin=https://…
    buildConfigField(
      "String",
      "DEFAULT_ORIGIN",
      "\"$apiOrigin\"",
    )
  }

  signingConfigs {
    if (hasSigning) create("upload") {
      storeFile = uploadKeystore
      storePassword = signingInputs["MERRYMEN_ANDROID_STORE_PASSWORD"]
      keyAlias = signingInputs["MERRYMEN_ANDROID_KEY_ALIAS"]
      keyPassword = signingInputs["MERRYMEN_ANDROID_KEY_PASSWORD"]
    }
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      isMinifyEnabled = false
    }
    release {
      if (hasSigning) signingConfig = signingConfigs.getByName("upload")
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  // Include SDK metadata for Play's dependency checks. Generation is verified
  // with this project's JDK 17 toolchain; the former JDK workaround is retired.
  dependenciesInfo {
    includeInApk = true
    includeInBundle = true
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures {
    compose = true
    buildConfig = true
  }
  packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }

  // JVM UNIT TESTS RUN THE REAL CLIENT, not a mock of it: MerrymenApi against a
  // MockWebServer, the models against captured production answers. Anything
  // they touch from android.jar (a Log line, a TextUtils call) returns its
  // default instead of throwing "not mocked", so a test fails on behaviour
  // rather than on the platform stub.
  testOptions { unitTests.isReturnDefaultValues = true }
}

// No unsigned or cleartext release can be packaged by the normal APK/AAB paths.
// Keep compilation, lint and JVM tests available to contributors without keys.
val validatePlayRelease by tasks.registering {
  group = "verification"
  description = "Requires an HTTPS origin and externally supplied upload signing for a release."
  doLast {
    check(originUri.scheme.equals("https", ignoreCase = true) && !developmentHost &&
      originUri.host.lowercase() !in setOf("127.0.0.1", "[::1]")) {
      "A release requires an HTTPS server origin reachable by users, not a local development origin."
    }
    check(hasSigning) {
      "Release packaging requires all four MERRYMEN_ANDROID signing environment variables. See RELEASING.md."
    }
    check(uploadKeystore?.isFile == true && uploadKeystore.canRead()) {
      "MERRYMEN_ANDROID_KEYSTORE must point to a readable upload keystore file."
    }
  }
}
tasks.matching {
  it.name in setOf("packageRelease", "packageReleaseBundle", "signReleaseBundle", "bundleRelease", "assembleRelease", "installRelease")
}.configureEach { dependsOn(validatePlayRelease) }

// Mirror tests read these sibling sources directly. Declare them so a shared
// contract change invalidates Gradle's test cache even when Kotlin is unchanged.
tasks.withType<Test>().configureEach {
  inputs.files(
    rootProject.file("../web/src/lib/live-blocker.ts"),
    rootProject.file("../web/src/lib/chat-commands.ts"),
    rootProject.file("../web/src/terminal/screens/Settings.tsx"),
    rootProject.file("../worker/src/thesis-policy.ts"),
    rootProject.file("../packages/core/src/risk-level.ts"),
  ).withPropertyName("sharedMirrorContracts")
    .withPathSensitivity(PathSensitivity.RELATIVE)
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  // Refreshing only while a screen is RESUMED (the feed every 10s, the room
  // every 3s) needs LocalLifecycleOwner and repeatOnLifecycle from here. Compose
  // already pulls it in transitively; declaring it means a screen that imports
  // it does not depend on another library's dependency list.
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.navigation.compose)
  implementation(libs.androidx.datastore.preferences)
  // Custom Tabs, for opening an owner's X profile in the user's own browser
  // rather than in the WebView reserved for signature ceremonies.
  implementation(libs.androidx.browser)

  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.ui.graphics)
  implementation(libs.compose.ui.tooling.preview)
  implementation(libs.compose.material3)
  implementation(libs.compose.material.icons)
  debugImplementation(libs.compose.ui.tooling)

  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)
  // No Retrofit: MerrymenApi is hand-rolled over OkHttp because the origin is a
  // RUNTIME value (hosted / staging / a laptop) and Retrofit fixes its base URL
  // when the instance is built.
  implementation(libs.okhttp)
  implementation(libs.okhttp.logging)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  // The same OkHttp version as the app, so a test exercises the client that ships.
  testImplementation(libs.okhttp.mockwebserver)
}
