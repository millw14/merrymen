import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.kotlin.compose)
}

/**
 * THE RELEASE KEY LIVES OUTSIDE THIS REPO, and so does everything that unlocks
 * it. A properties file names the keystore (relative to itself) and its
 * passwords:
 *
 *   storeFile=merrymen-release.jks
 *   storePassword=…
 *   keyAlias=merrymen
 *   keyPassword=…
 *
 * It is read from -Pmerrymen.signing=<path>, else $MERRYMEN_SIGNING, else
 * ~/.merrymen-release/keystore.properties. With none of them, assembleRelease
 * builds an UNSIGNED apk, as it always has — CI and every other machine build
 * exactly what they did before. Losing this key means no sideloaded install
 * can ever be updated in place again, so it is backed up, never committed.
 */
val signingFile: File? = listOfNotNull(
  project.findProperty("merrymen.signing") as String?,
  System.getenv("MERRYMEN_SIGNING"),
  "${System.getProperty("user.home")}/.merrymen-release/keystore.properties",
).map(::File).firstOrNull { it.isFile }
val signingKeys: Properties? = signingFile?.let { f -> Properties().apply { f.inputStream().use(::load) } }

android {
  namespace = "dev.merrymen.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "dev.merrymen.app"
    minSdk = 26
    targetSdk = 35
    // 0.2.0 is the first build written against the server as it stood on
    // 2026-09-24. The user-agent carries this name (merrymen-android/0.2.0), so
    // a server log can tell an updated phone from one still on 0.1.0.
    versionCode = 2
    versionName = "0.2.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    // THE ORIGIN IS A BUILD INPUT, not a literal in the code. The gateway host
    // moved once already and three hand-copies had to move with it; this app
    // will not become a fourth. Override with -Pmerrymen.origin=https://…
    buildConfigField(
      "String",
      "DEFAULT_ORIGIN",
      "\"${project.findProperty("merrymen.origin") ?: "https://app.merrymen.dev"}\"",
    )
  }

  signingConfigs {
    if (signingFile != null && signingKeys != null) {
      create("release") {
        storeFile = signingFile.parentFile.resolve(signingKeys.getProperty("storeFile"))
        storePassword = signingKeys.getProperty("storePassword")
        keyAlias = signingKeys.getProperty("keyAlias")
        keyPassword = signingKeys.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      isMinifyEnabled = false
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.findByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  // The dependency-metadata task fails to initialise under the JDK bundled with
  // this Android Studio; the block only feeds Play's dependency report, so
  // turning it off unblocks a release build with no effect on the app.
  dependenciesInfo {
    includeInApk = false
    includeInBundle = false
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
