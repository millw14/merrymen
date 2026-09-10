plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.kotlin.compose)
}

android {
  namespace = "dev.merrymen.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "dev.merrymen.app"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
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

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      isMinifyEnabled = false
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
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
}
