package app.agentrelay.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.*
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
    var web = WeakReference<WebView>(null)
    private var localPermission: CompletableFuture<Boolean>? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        RelayNative.initialize(applicationContext)
        RelayNative.activity = WeakReference(this)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val version = WebView.getCurrentWebViewPackage()?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
        if (version < 110) {
            android.app.AlertDialog.Builder(this).setTitle("请更新系统 WebView")
                .setMessage("Relay 需要 Android System WebView 110 或更新版本。请先通过系统或应用商店更新。")
                .setPositiveButton("打开设置") { _, _ ->
                    startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + (WebView.getCurrentWebViewPackage()?.packageName ?: "com.google.android.webview"))))
                }.setNegativeButton("退出") { _, _ -> finish() }.setCancelable(false).show()
        }
    }
    override fun onResume() {
        super.onResume()
        RelayNative.activity = WeakReference(this)
        RelayNative.foreground = true
        RelayNative.active(true)
        RelayNative.visibility(true, consumeTarget())
        AndroidUpdates.resumed()
        val settings = java.io.File(filesDir, "settings.json")
        if (settings.exists() && JSONObject(settings.readText()).optJSONArray("devices")?.length() != 0) RelayNative.startBackground()
    }
    private fun consumeTarget(): String {
        val target = intent.getStringExtra("relayTarget") ?: if (intent.data?.scheme == "relay" && intent.data?.host == "connect") JSONObject().put("uri", intent.dataString).toString() else "{}"
        intent.removeExtra("relayTarget"); intent.data = null
        if (target != "{}") RelayNative.launchTarget = target
        return target
    }
    override fun onPause() {
        RelayNative.foreground = false
        RelayNative.visibility(false, "{}")
        if (!RelayNative.backgroundEnabled) RelayNative.active(false)
        super.onPause()
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (RelayNative.foreground) {
            RelayNative.visibility(true, consumeTarget())
        }
    }
    override fun onDestroy() {
        localPermission?.complete(false)
        if (RelayNative.activity.get() === this) RelayNative.activity.clear()
        super.onDestroy()
    }
    fun requestNotifications(force: Boolean = false) {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("relay", MODE_PRIVATE)
        if (force && prefs.getBoolean("notificationAsked", false)) {
            startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)); return
        }
        if (!force && prefs.getBoolean("notificationAsked", false)) return
        prefs.edit().putBoolean("notificationAsked", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 11)
    }
    fun ensureLocalNetwork(): Boolean {
        if (Build.VERSION.SDK_INT < 37 || applicationInfo.targetSdkVersion < 37 || ContextCompat.checkSelfPermission(this, "android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED) return true
        val future = CompletableFuture<Boolean>()
        runOnUiThread {
            if (localPermission != null) { future.complete(false); return@runOnUiThread }
            localPermission = future
            requestPermissions(arrayOf("android.permission.ACCESS_LOCAL_NETWORK"), 12)
        }
        return future.get(120, TimeUnit.SECONDS)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 12) {
            localPermission?.complete(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
            localPermission = null
        }
        RelayNative.sendEvent("relay:permissions", RelayNative.status().toString())
    }
    fun applyTheme(dark: Boolean) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        window.decorView.setBackgroundColor(Color.parseColor(if (dark) "#202226" else "#f7f8fa"))
    }
}
